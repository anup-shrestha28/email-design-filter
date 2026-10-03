/**
 * The worst-case reservation is an upper bound on what a request can be billed (FREE-TIER.md §6.5
 * layer 3: "exact input from count_tokens, with the cached prefix priced as a cache write"):
 *  - every count_tokens call carries the request's `output_config` (a structured-output format adds
 *    system text of its own, billed as input);
 *  - a cached system prompt is measured, not assumed, and priced as a cache write.
 * count_tokens is a stand-in that charges for every character it is sent, including 800 characters
 * for an output format, so a count made without the format, or a guessed prefix, reserves too little.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { priceRequest } from "@edf/budget";
import { LLM_CLASSIFY_MAX_TOKENS } from "@edf/core";
import { AI_MAX_TOKENS } from "@edf/design";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { reviewRealtime, submitClassificationBatch, submitDesignReviewBatch } from "../src/ai";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

const FORMAT_CHARS = 800;

type CountParams = { system?: unknown; messages: unknown; output_config?: unknown };
type CreateParams = { system: unknown; messages: unknown; output_config?: unknown };

const chars = (x: unknown) => (x === undefined ? 0 : JSON.stringify(x).length);
/** What the stand-in bills for a request: every character it carries, plus the output format's system text. */
const billed = (p: CountParams) => Math.ceil((chars(p.system) + chars(p.messages) + (p.output_config ? FORMAT_CHARS : 0)) / 4);
/** The billed tokens up to and including the system prompt (the cache-write prefix). */
const billedPrefix = (p: CreateParams) => Math.ceil((chars(p.system) + (p.output_config ? FORMAT_CHARS : 0)) / 4);

function fakeAnthropic(onCreate: (p: CreateParams) => void) {
  const counts: CountParams[] = [];
  const anthropicId = `msgbatch_${randomUUID()}`;
  const client = {
    messages: {
      countTokens: async (p: CountParams) => {
        counts.push(p);
        return { input_tokens: billed(p) };
      },
      create: async (p: CreateParams) => {
        onCreate(p);
        return { usage: { input_tokens: billed(p), output_tokens: 10 }, content: [], stop_reason: "refusal" };
      },
      batches: {
        create: async (b: { requests: Array<{ custom_id: string; params: CreateParams }> }) => {
          for (const r of b.requests) onCreate(r.params);
          return { id: anthropicId };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, counts, anthropicId };
}

const RAW = new TextEncoder().encode(
  [
    "From: Northwind <news@northwind.example>",
    "To: someone@gmail.example",
    "Subject: Our autumn catalogue is here",
    "List-Unsubscribe: <https://northwind.example/u/abc>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "List-Id: Northwind news <news.northwind.example>",
    "Precedence: bulk",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<html><body><h1>Autumn catalogue</h1><p>New jackets, boots and scarves for the season.</p>` +
      `<a href="https://northwind.example/catalogue">Browse the catalogue</a>` +
      `<p><a href="https://northwind.example/u/abc">Unsubscribe</a></p></body></html>`,
    "",
  ].join("\r\n"),
);

describe.skipIf(!HAS_DB)("AI worst-case reservations", () => {
  let pool: pg.Pool;
  let admin: pg.Pool; // RLS-exempt, for parking queue rows other test files left behind

  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    admin = createPool({ connectionString: OWNER_URL, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  async function seedUser(): Promise<{ userId: string; mailboxId: string }> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'owner')", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      return m.rows[0]!.id;
    });
    return { userId, mailboxId };
  }

  async function seedEmails(u: { userId: string; mailboxId: string }, n: number, typeSource: "pending" | "rule"): Promise<string[]> {
    return withUser(pool, u.userId, async (_db, c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, label_ids, search_tsv, created_at)
         SELECT $1, $2, md5(random()::text || g::text), 100, now(), 'Hello', true, 'promotional', $4, ARRAY['INBOX'],
                to_tsvector('simple', 'hello'), now() - interval '1 hour' - make_interval(secs => $3 - g)
         FROM generate_series(1, $3) g RETURNING id`,
        [u.userId, u.mailboxId, n, typeSource],
      );
      return r.rows.map((x) => x.id);
    });
  }

  const reservedOf = (u: string) =>
    withUser(pool, u, async (_db, c) =>
      (await c.query<{ reserved_usd: string }>("SELECT reserved_usd FROM ai_batch_item WHERE user_id = $1", [u])).rows.map((r) => Number(r.reserved_usd)),
    );
  const endBatch = (anthropicId: string) =>
    withSystem(pool, (_db, c) => c.query("UPDATE ai_batch SET state = 'ended', ended_at = now() WHERE anthropic_batch_id = $1", [anthropicId]));

  /** The reservation covers the worst case of the request actually sent, and exceeds it by rounding only. */
  function expectUpperBound(reserved: number[], sent: CreateParams[], maxTokens: number) {
    expect(reserved).toHaveLength(sent.length);
    const worst = sent.map((p) =>
      priceRequest({ inputTokens: billed(p), cachedPrefixTokens: billedPrefix(p), cacheTtl: "1h", maxTokens, batch: true }),
    );
    for (let i = 0; i < sent.length; i++) {
      expect(reserved[i], `item ${i}`).toBeGreaterThanOrEqual(worst[i]!);
      expect(reserved[i]! - worst[i]!, `item ${i}`).toBeLessThanOrEqual(0.0002);
    }
  }

  it("a cached classification batch reserves at least the billed input (output format included) with the measured prefix as a cache write", async () => {
    // The classification queue is global: mail other test files left pending would join this batch.
    await admin.query("UPDATE email SET type_source = 'rule' WHERE type_source = 'pending'");
    const u = await seedUser();
    await seedEmails(u, 12, "pending"); // ≥ 10: the system prompt is cached
    const sent: CreateParams[] = [];
    const ai = fakeAnthropic((p) => sent.push(p));
    const deps = {
      pool,
      anthropic: ai.client,
      now: () => new Date("2042-06-10T12:00:00Z"),
      tickEvery: 30,
      governorLevel: async () => 0,
      tokens: null,
      rawSourceFor: () => async () => RAW,
    } as unknown as PipelineDeps;
    try {
      expect(await submitClassificationBatch(deps)).toEqual({ queued: 12 });
      expect(sent[0]!.output_config).toBeDefined();
      for (const c of ai.counts) expect(c.output_config).toEqual(sent[0]!.output_config);
      expectUpperBound(await reservedOf(u.userId), sent, LLM_CLASSIFY_MAX_TOKENS);
    } finally {
      await withUser(pool, u.userId, (_db, c) => c.query("UPDATE email SET type_source = 'rule' WHERE user_id = $1", [u.userId]));
      await endBatch(ai.anthropicId);
    }
  });

  it("a cached design-review batch reserves at least the billed input with the measured prefix as a cache write", async () => {
    const u = await seedUser();
    const ids = await seedEmails(u, 3, "rule"); // ≥ 3: the system prompt is cached
    const tpl = await withUser(pool, u.userId, async (_db, c) => {
      const s = await c.query<{ id: string }>(
        `INSERT INTO sender (user_id, address, domain, first_seen_at, last_seen_at) VALUES ($1, 'n@northwind.example', 'northwind.example', now(), now()) RETURNING id`,
        [u.userId],
      );
      return (await c.query<{ id: string }>(
        `INSERT INTO email_template (user_id, sender_id, simhash, first_seen_at, last_seen_at) VALUES ($1, $2, 1, now(), now()) RETURNING id`,
        [u.userId, s.rows[0]!.id],
      )).rows[0]!.id;
    });
    const sent: CreateParams[] = [];
    const ai = fakeAnthropic((p) => sent.push(p));
    const deps = { pool, anthropic: ai.client, now: () => new Date("2042-06-11T12:00:00Z"), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    const input = { tiles: { desktop: [], mobile: null }, subject: "Hello", type: "promotional" as const, ctaBox: null, visibleText: "hello" };
    try {
      expect(await submitDesignReviewBatch(deps, ids.map((emailId) => ({ userId: u.userId, emailId, templateId: tpl, input })))).toEqual({ queued: 3 });
      expect(sent[0]!.output_config).toBeDefined();
      for (const c of ai.counts) expect(c.output_config).toEqual(sent[0]!.output_config);
      expectUpperBound(await reservedOf(u.userId), sent, AI_MAX_TOKENS);
    } finally {
      await endBatch(ai.anthropicId);
    }
  });

  it("a real-time review counts its input with the output format it sends", async () => {
    const u = await seedUser();
    const [emailId] = await seedEmails(u, 1, "rule");
    const sent: CreateParams[] = [];
    const ai = fakeAnthropic((p) => sent.push(p));
    const deps = { pool, anthropic: ai.client, now: () => new Date("2042-06-12T12:00:00Z"), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    await reviewRealtime(deps, {
      userId: u.userId,
      emailId: emailId!,
      hierarchyProxies: [],
      tiles: { desktop: [], mobile: null },
      subject: "Hello",
      type: "promotional",
      ctaBox: null,
      visibleText: "hello",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.output_config).toBeDefined();
    expect(ai.counts).toHaveLength(1);
    expect(billed(ai.counts[0]!)).toBe(billed(sent[0]!));
  });
});
