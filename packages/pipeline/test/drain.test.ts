/**
 * The ledger drain end to end (FREE-TIER.md §4.6; DESIGN.md §5.5, §7.2) against a real Postgres 18
 * with RLS, real fixture emails and a scripted Gmail client: metadata-first for Primary-tab mail,
 * no body fetch for people the user writes to, raw → format=full fallback, and the failure rules.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { parseMime } from "@edf/core";
import { ensureQuotaRow, GmailError, MAX_ATTEMPTS, OAuthError, TokenIntegrityError, type GmailClient, type GmailMessage } from "@edf/gmail";
import { KeyServiceError } from "@edf/crypto";
import { CLAIM_HTML_CHARS, drain } from "../src/drain";
import { applyPollDelta } from "../src/store/sync";
import { errorCode } from "../src/poll";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

const FIXTURES = new URL("../../../fixtures/emails/", import.meta.url);
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** Header block of an .eml, unfolded — what Gmail returns for format=metadata. */
function headersOf(raw: Uint8Array): Array<{ name: string; value: string }> {
  const text = Buffer.from(raw).toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const block = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  return block.split(/\r?\n/).flatMap((line) => {
    const i = line.indexOf(":");
    return i > 0 ? [{ name: line.slice(0, i), value: line.slice(i + 1).trim() }] : [];
  });
}

type Behaviour = { labelIds: string[]; raw: Uint8Array; rawError?: GmailError; getError?: Error };
type Call = { method: "get" | "list" | "attachment"; id?: string; format?: string; q?: string };

/** A scripted Gmail: one entry per message id; `sentTo` is who the user has written to. */
function fakeGmail(messages: Map<string, Behaviour>, sentTo: string[] = []) {
  const calls: Call[] = [];
  const base = (id: string, b: Behaviour) => ({
    id,
    threadId: id,
    labelIds: b.labelIds,
    snippet: "",
    historyId: "5000",
    internalDate: String(Date.parse("2026-09-25T14:02:15Z")),
    sizeEstimate: b.raw.byteLength,
  });
  const client = {
    async messagesGet(id: string, p: { format: string }): Promise<GmailMessage> {
      calls.push({ method: "get", id, format: p.format });
      const b = messages.get(id);
      if (!b) throw new GmailError("not_found", { method: "users.messages.get", status: 404 });
      if (b.getError) throw b.getError;
      if (p.format === "metadata") return { ...base(id, b), payload: { mimeType: "multipart/alternative", headers: headersOf(b.raw) } } as GmailMessage;
      if (p.format === "raw") {
        if (b.rawError) throw b.rawError;
        return { ...base(id, b), raw: b64url(b.raw) } as GmailMessage;
      }
      // format=full: the parsed MIME tree (text + html parts inline).
      const parsed = await parseMime(b.raw);
      const parts = [
        ...(parsed.text ? [{ partId: "0", mimeType: "text/plain", headers: [], body: { size: parsed.text.length, data: b64url(parsed.text) } }] : []),
        ...(parsed.html ? [{ partId: "1", mimeType: "text/html", headers: [], body: { size: parsed.html.length, data: b64url(parsed.html) } }] : []),
      ];
      return { ...base(id, b), payload: { partId: "", mimeType: "multipart/alternative", headers: headersOf(b.raw), parts } } as GmailMessage;
    },
    async messagesList(p: { q: string }) {
      calls.push({ method: "list", q: p.q });
      const hit = sentTo.some((a) => p.q.toLowerCase().includes(a.toLowerCase()));
      return hit ? { messages: [{ id: "sent1", threadId: "sent1" }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 };
    },
    async attachmentsGet(id: string) {
      calls.push({ method: "attachment", id });
      throw new GmailError("not_found", { method: "users.messages.attachments.get", status: 404 });
    },
  };
  return { client: client as unknown as GmailClient, calls };
}

const fixture = async (name: string) => new Uint8Array(await readFile(new URL(`${name}.eml`, FIXTURES)));

/** A promo with a large HTML part (analysed only after its attempt is recorded, see CLAIM_HTML_CHARS). */
function bigPromo(): Uint8Array {
  const rows = "<tr><td class=\"item\">Trail runner, now 20% off</td></tr>".repeat(Math.ceil((CLAIM_HTML_CHARS + 10_000) / 50));
  const html = `<html><body><table>${rows}</table><p><a href="https://acme-shop.example/u">Unsubscribe</a></p></body></html>`;
  return new TextEncoder().encode(
    [
      "From: Acme Deals <deals@acme-shop.example>",
      "To: owner@example.com",
      "Subject: The fall sale is on",
      "Date: Fri, 25 Sep 2026 14:02:15 +0000",
      "Message-ID: <big-1@acme-shop.example>",
      "List-Unsubscribe: <https://acme-shop.example/u>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
    ].join("\r\n"),
  );
}

/** The pool, except that `connect` first runs `before` (which may hang or throw like a dying step). */
function interceptConnect(pool: pg.Pool, before: () => Promise<void>): pg.Pool {
  return new Proxy(pool, {
    get(t, k) {
      if (k === "connect") {
        return async () => {
          await before();
          return t.connect();
        };
      }
      const v = Reflect.get(t, k) as unknown;
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe.skipIf(!HAS_DB)("drain (end to end)", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function setup(address: string): Promise<{ userId: string; mailboxId: string }> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1) RETURNING id`,
        [userId, randomUUID(), address],
      );
      await ensureQuotaRow(db, m.rows[0]!.id);
      return m.rows[0]!.id;
    });
    return { userId, mailboxId };
  }

  async function queue(userId: string, mailboxId: string, rows: Array<{ id: string; state: "pending" | "pending_full"; attempts?: number }>) {
    await withUser(pool, userId, async (_db, c) => {
      for (const r of rows) {
        await c.query(
          `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source, attempts) VALUES ($1, $2, $3, $4, 'sync', $5)`,
          [mailboxId, userId, r.id, r.state, r.attempts ?? 0],
        );
      }
    });
  }

  async function ledger(userId: string) {
    return withUser(pool, userId, async (_db, c) => {
      const r = await c.query<{ provider_message_id: string; state: string; reason: string | null; attempts: number; next_attempt_at: Date | null }>(
        "SELECT provider_message_id, state, reason, attempts, next_attempt_at FROM message_ledger WHERE user_id = $1",
        [userId],
      );
      return new Map(r.rows.map((x) => [x.provider_message_id, x]));
    });
  }

  const depsWith = (client: GmailClient): PipelineDeps =>
    ({ pool, tokens: null, tickEvery: 30, governorLevel: async () => 0, gmailFor: () => client }) as unknown as PipelineDeps;

  it("stores category mail from raw, fetches Primary-tab mail metadata-first, and never fetches the body of mail from people the user writes to", async () => {
    const { userId, mailboxId } = await setup("owner@example.com");
    const gmail = fakeGmail(
      new Map([
        ["promo1", { labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], raw: await fixture("01-promo-retail") }],
        ["news1", { labelIds: ["INBOX", "UNREAD"], raw: await fixture("02-newsletter-editorial") }],
        ["friend1", { labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], raw: await fixture("20-personal-human") }],
      ]),
      ["sam.rivera@gmail.com"],
    );
    await queue(userId, mailboxId, [
      { id: "promo1", state: "pending_full" },
      { id: "news1", state: "pending" },
      { id: "friend1", state: "pending" },
    ]);

    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 50, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 3, stored: 2, skipped: 1, retried: 0, failed: 0, stoppedReason: "done" });

    const l = await ledger(userId);
    expect(l.get("promo1")?.state).toBe("stored");
    expect(l.get("news1")?.state).toBe("stored");
    expect(l.get("friend1")).toMatchObject({ state: "skipped", reason: "personal" });

    // Category mail goes straight to raw; the newsletter's list headers skip the prior-contact check.
    const formats = (id: string) => gmail.calls.filter((c) => c.id === id).map((c) => c.format);
    expect(formats("promo1")).toEqual(["raw"]);
    expect(formats("news1")).toEqual(["metadata", "raw"]);
    // The personal message: headers only, one `in:sent` check, and no body fetch at all.
    expect(formats("friend1")).toEqual(["metadata"]);
    expect(gmail.calls.filter((c) => c.method === "list")).toHaveLength(1);

    const emails = await withUser(pool, userId, async (_db, c) =>
      (await c.query<{ provider_message_id: string; primary_type: string; is_subscription: boolean; from_address: string }>(
        "SELECT provider_message_id, primary_type, is_subscription, from_address FROM email WHERE user_id = $1 ORDER BY provider_message_id",
        [userId],
      )).rows,
    );
    expect(emails).toEqual([
      expect.objectContaining({ provider_message_id: "news1", primary_type: "newsletter", is_subscription: true, from_address: "weekly@fieldnotes.example" }),
      expect.objectContaining({ provider_message_id: "promo1", primary_type: "promotional", is_subscription: true, from_address: "hello@northwind-outfitters.com" }),
    ]);
  });

  it("still fetches automated Primary-tab mail from an address the user once wrote to (header hard signals beat the personal override)", async () => {
    const { userId, mailboxId } = await setup("invitee@example.com");
    // No list or ESP headers, but a no-reply sender: automated from the headers alone.
    const gmail = fakeGmail(
      new Map([["invite1", { labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], raw: await fixture("10-event-invitation-calendar") }]]),
      ["calendar-noreply@meetwise.example"], // the user once replied to an invitation
    );
    await queue(userId, mailboxId, [{ id: "invite1", state: "pending" }]);
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ stored: 1, skipped: 0 });
    expect(gmail.calls.filter((c) => c.method === "list")).toHaveLength(0); // no prior-contact check needed
    expect(gmail.calls.map((c) => c.format).filter(Boolean)).toEqual(["metadata", "raw"]);
    const row = await withUser(pool, userId, async (_db, c) =>
      (await c.query<{ primary_type: string }>("SELECT primary_type FROM email WHERE user_id = $1", [userId])).rows[0],
    );
    expect(row?.primary_type).toBe("event");
  });

  it("falls back to format=full when the raw message is too large", async () => {
    const { userId, mailboxId } = await setup("fallback@example.com");
    const gmail = fakeGmail(
      new Map([
        [
          "big1",
          {
            labelIds: ["INBOX", "CATEGORY_UPDATES"],
            raw: await fixture("15-product-update-release-notes"),
            rawError: new GmailError("too_large", { method: "users.messages.get" }),
          },
        ],
      ]),
    );
    await queue(userId, mailboxId, [{ id: "big1", state: "pending_full" }]);
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ stored: 1, skipped: 0, stoppedReason: "done" });
    expect(gmail.calls.map((c) => c.format)).toEqual(["raw", "full"]);
    const row = await withUser(pool, userId, async (_db, c) =>
      (await c.query<{ primary_type: string }>("SELECT primary_type FROM email WHERE user_id = $1", [userId])).rows[0],
    );
    expect(row?.primary_type).toBe("product_update");
  });

  it("one user's drain is not crowded out by other mailboxes' due rows", async () => {
    // Ten other mailboxes each with a due row sort ahead of this user's second and third rows
    // (list_drain_batch interleaves mailboxes), so a batch cut at maxRows before the user filter
    // would hold at most this user's first row.
    const other = await setup("other0@example.com");
    const otherMailboxes = [other.mailboxId];
    await withUser(pool, other.userId, async (db, c) => {
      for (let i = 1; i < 10; i++) {
        const m = await c.query<{ id: string }>(
          `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
           VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1) RETURNING id`,
          [other.userId, randomUUID(), `other${i}@example.com`],
        );
        await ensureQuotaRow(db, m.rows[0]!.id);
        otherMailboxes.push(m.rows[0]!.id);
      }
    });
    for (const id of otherMailboxes) await queue(other.userId, id, [{ id: `other-${id}`, state: "pending_full" }]);
    const { userId, mailboxId } = await setup("crowded@example.com");
    const raw = await fixture("01-promo-retail");
    const gmail = fakeGmail(
      new Map(["c1", "c2", "c3"].map((id) => [id, { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], raw }] as const)),
    );
    await queue(userId, mailboxId, ["c1", "c2", "c3"].map((id) => ({ id, state: "pending_full" as const })));
    try {
      const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
      expect(res).toMatchObject({ processed: 3, stored: 3, stoppedReason: "done" });
      expect(new Set(gmail.calls.map((c) => c.id))).toEqual(new Set(["c1", "c2", "c3"]));
    } finally {
      // Leave no due rows or extra active user behind for later tests (AI caps count active users).
      await withUser(pool, other.userId, (_db, c) => c.query("DELETE FROM mailbox WHERE user_id = $1", [other.userId]));
    }
  });

  it("skips mail deleted in Gmail, backs off transient errors, and fails a row after its last attempt", async () => {
    const { userId, mailboxId } = await setup("failures@example.com");
    const raw = await fixture("01-promo-retail");
    const server = () => new GmailError("server", { method: "users.messages.get", status: 503 });
    const gmail = fakeGmail(
      new Map([
        ["flaky1", { labelIds: ["INBOX"], raw, getError: server() }],
        ["dying1", { labelIds: ["INBOX"], raw, getError: server() }],
      ]),
    );
    await queue(userId, mailboxId, [
      { id: "gone1", state: "pending_full" },
      { id: "flaky1", state: "pending_full" },
      { id: "dying1", state: "pending_full", attempts: MAX_ATTEMPTS },
    ]);
    const before = Date.now();
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 3, stored: 0, skipped: 1, retried: 1, failed: 1, stoppedReason: "done" });

    const l = await ledger(userId);
    expect(l.get("gone1")).toMatchObject({ state: "skipped", reason: "gmail_error" });
    const flaky = l.get("flaky1")!;
    expect(flaky.state).toBe("pending_full"); // still queued, retried later
    expect(flaky.attempts).toBe(1);
    expect(flaky.next_attempt_at!.getTime()).toBeGreaterThan(before);
    expect(l.get("dying1")).toMatchObject({ state: "failed", attempts: MAX_ATTEMPTS + 1 });
  });

  it("stops on Gmail's daily limit without spending an attempt", async () => {
    const { userId, mailboxId } = await setup("daily@example.com");
    const gmail = fakeGmail(
      new Map([
        ["d1", { labelIds: ["INBOX"], raw: await fixture("01-promo-retail"), getError: new GmailError("daily_limit", { method: "users.messages.get", status: 403 }) }],
      ]),
    );
    await queue(userId, mailboxId, [{ id: "d1", state: "pending_full" }]);
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 0, stoppedReason: "daily_limit" });
    expect((await ledger(userId)).get("d1")).toMatchObject({ state: "pending_full", attempts: 0, next_attempt_at: null });
  });

  it.each([
    ["Google's token endpoint is down", () => new OAuthError("other", { operation: "refresh", status: 503 })],
    ["edf-keys refuses the unwrap (rate limit)", () => new KeyServiceError("http_429")],
    ["the stored mailbox key won't open", () => new TokenIntegrityError("m", "dek")],
  ] as const)("no access token (%s): the mailbox is deferred after one try, no row spends an attempt", async (_name, make) => {
    const { userId, mailboxId } = await setup(`token-${randomUUID().slice(0, 6)}@example.com`);
    const raw = await fixture("01-promo-retail");
    const ids = ["t1", "t2", "t3", "t4", "t5"];
    // Every Gmail call first asks the token provider, which throws: no message is ever reached.
    const gmail = fakeGmail(new Map(ids.map((id) => [id, { labelIds: ["INBOX"], raw, getError: make() }])));
    await queue(userId, mailboxId, ids.map((id) => ({ id, state: "pending_full" as const })));
    const since = (await pool.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]!.t;
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 0, retried: 0, failed: 0, deferredMailboxes: 1, stoppedReason: "done" });
    expect(gmail.calls).toHaveLength(1);
    const l = await ledger(userId);
    for (const id of ids) expect(l.get(id)).toMatchObject({ state: "pending_full", attempts: 0, next_attempt_at: null });
    const mb = await withUser(pool, userId, (_db, c) => c.query<{ status: string }>("SELECT status FROM mailbox WHERE id = $1", [mailboxId]));
    expect(mb.rows[0]?.status).toBe("active");
    // Rows no longer fail, so a token that stays broken must still be visible: one app_error per run.
    const errs = await pool.query<{ job: string; code: string }>(
      "SELECT job, code FROM app_error WHERE detail_code = 'token_deferred' AND at >= $1",
      [since],
    );
    expect(errs.rows).toEqual([{ job: "drain", code: errorCode(make()) }]);
  });

  it("a Workspace admin block (admin_policy_enforced) is not retried: the mailbox is paused, its rows untouched", async () => {
    const { userId, mailboxId } = await setup("blocked@example.com");
    const raw = await fixture("01-promo-retail");
    const blocked = () => new OAuthError("admin_policy_enforced", { operation: "refresh", status: 400, code: "admin_policy_enforced" });
    const gmail = fakeGmail(new Map(["b1", "b2", "b3"].map((id) => [id, { labelIds: ["INBOX"], raw, getError: blocked() }])));
    await queue(userId, mailboxId, ["b1", "b2", "b3"].map((id) => ({ id, state: "pending_full" as const })));
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 0, retried: 0, deferredMailboxes: 1 });
    expect(gmail.calls).toHaveLength(1);
    const mb = await withUser(pool, userId, (_db, c) =>
      c.query<{ status: string; status_reason: string | null }>("SELECT status, status_reason FROM mailbox WHERE id = $1", [mailboxId]),
    );
    expect(mb.rows[0]).toEqual({ status: "paused", status_reason: "admin_policy" });
    for (const r of (await ledger(userId)).values()) expect(r).toMatchObject({ state: "pending_full", attempts: 0 });
  });

  it("a message deleted in Gmail while the drain fetches it is not stored (no orphan email)", async () => {
    const { userId, mailboxId } = await setup("deleted-meanwhile@example.com");
    const gmail = fakeGmail(new Map([["del1", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], raw: await fixture("01-promo-retail") }]]));
    const get = gmail.client.messagesGet.bind(gmail.client);
    // A sync-on-open poll commits the deletion while the fetch is in flight.
    (gmail.client as { messagesGet: typeof get }).messagesGet = async (id, p) => {
      await withUser(pool, userId, (_db, c) =>
        applyPollDelta(c, { userId, mailboxId, source: "sync", nextPollAt: new Date() }, { added: [], deleted: [id], labelChanges: [], newCursor: "2", incomplete: false }),
      );
      return get(id, p);
    };
    await queue(userId, mailboxId, [{ id: "del1", state: "pending_full" }]);
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 1, stored: 0, skipped: 1 });
    const e = await withUser(pool, userId, (_db, c) => c.query("SELECT 1 FROM email WHERE mailbox_id = $1", [mailboxId]));
    expect(e.rowCount).toBe(0);
    expect((await ledger(userId)).size).toBe(0);
  });

  it("defers a mailbox whose quota bucket is empty, leaving its rows untouched and making no Gmail calls", async () => {
    const { userId, mailboxId } = await setup("quota@example.com");
    await withUser(pool, userId, (_db, c) => c.query("UPDATE gmail_quota SET tokens = 0, updated_at = now() + interval '1 hour' WHERE mailbox_id = $1", [mailboxId]));
    const gmail = fakeGmail(new Map([["q1", { labelIds: ["INBOX"], raw: await fixture("01-promo-retail") }]]));
    await queue(userId, mailboxId, [{ id: "q1", state: "pending_full" }]);
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 0, deferredMailboxes: 1, stoppedReason: "done" });
    expect(gmail.calls).toHaveLength(0);
    expect((await ledger(userId)).get("q1")).toMatchObject({ state: "pending_full", attempts: 0 });
  });

  const attemptsOf = async (userId: string, mailboxId: string, id: string) =>
    (
      await withUser(pool, userId, (_db, c) =>
        c.query<{ attempts: number }>("SELECT attempts FROM message_ledger WHERE mailbox_id = $1 AND provider_message_id = $2", [mailboxId, id]),
      )
    ).rows[0]?.attempts ?? 0;

  it("large HTML: the attempt is recorded before analysis, so a step killed mid-analysis does not keep the row first in every batch", async () => {
    const { userId, mailboxId } = await setup(`claim-${randomUUID().slice(0, 6)}@example.com`);
    const gmail = fakeGmail(new Map([["big1", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], raw: bigPromo() }]]));
    await queue(userId, mailboxId, [{ id: "big1", state: "pending_full" }]);
    // The step "dies" at its first database call after the attempt was recorded (it never returns).
    let died!: () => void;
    const dead = new Promise<"died">((r) => (died = () => r("died")));
    const dying = interceptConnect(pool, async () => {
      if ((await attemptsOf(userId, mailboxId, "big1")) >= 1) {
        died();
        await new Promise(() => {});
      }
    });
    const run = drain({ ...depsWith(gmail.client), pool: dying }, { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(await Promise.race([dead, run.then(() => "finished" as const)])).toBe("died");

    const row = (await ledger(userId)).get("big1")!;
    expect(row).toMatchObject({ state: "pending_full", attempts: 1 });
    expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    const batch = await withSystem(pool, (_db, c) => c.query<{ provider_message_id: string }>("SELECT provider_message_id FROM list_drain_batch(2000)"));
    expect(batch.rows.map((r) => r.provider_message_id)).not.toContain("big1");
  });

  it("small HTML is claimed too: its analysis cost is not a function of its size", async () => {
    const { userId, mailboxId } = await setup(`claim-small-${randomUUID().slice(0, 6)}@example.com`);
    const raw = await fixture("01-promo-retail");
    expect(raw.length).toBeLessThan(200_000);
    const gmail = fakeGmail(new Map([["small1", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], raw }]]));
    await queue(userId, mailboxId, [{ id: "small1", state: "pending_full" }]);
    let died!: () => void;
    const dead = new Promise<"died">((r) => (died = () => r("died")));
    const dying = interceptConnect(pool, async () => {
      if ((await attemptsOf(userId, mailboxId, "small1")) >= 1) {
        died();
        await new Promise(() => {});
      }
    });
    const run = drain({ ...depsWith(gmail.client), pool: dying }, { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(await Promise.race([dead, run.then(() => "finished" as const)])).toBe("died");
    const row = (await ledger(userId)).get("small1")!;
    expect(row).toMatchObject({ state: "pending_full", attempts: 1 });
    expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("large HTML whose earlier claimed attempts all died is failed without being analysed again", async () => {
    const { userId, mailboxId } = await setup(`claim-dead-${randomUUID().slice(0, 6)}@example.com`);
    const gmail = fakeGmail(new Map([["big2", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], raw: bigPromo() }]]));
    await queue(userId, mailboxId, [{ id: "big2", state: "pending_full", attempts: MAX_ATTEMPTS + 1 }]);
    const res = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(res).toMatchObject({ processed: 1, stored: 0, failed: 1 });
    expect((await ledger(userId)).get("big2")).toMatchObject({ state: "failed", attempts: MAX_ATTEMPTS + 1 });
    const e = await withUser(pool, userId, (_db, c) => c.query("SELECT 1 FROM email WHERE mailbox_id = $1", [mailboxId]));
    expect(e.rowCount).toBe(0);
  });

  it("large HTML: a claimed row the run could not finish (database gone) is released without spending an attempt; a healthy run stores it", async () => {
    const { userId, mailboxId } = await setup(`claim-stop-${randomUUID().slice(0, 6)}@example.com`);
    const gmail = fakeGmail(new Map([["big3", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], raw: bigPromo() }]]));
    await queue(userId, mailboxId, [{ id: "big3", state: "pending_full" }]);
    let failed = false;
    const flaky = interceptConnect(pool, async () => {
      if (!failed && (await attemptsOf(userId, mailboxId, "big3")) >= 1) {
        failed = true;
        throw new Error("Connection terminated unexpectedly");
      }
    });
    const res = await drain({ ...depsWith(gmail.client), pool: flaky }, { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(failed).toBe(true);
    expect(res.stoppedReason).toBe("database");
    expect((await ledger(userId)).get("big3")).toMatchObject({ state: "pending_full", attempts: 0, next_attempt_at: null });

    const ok = await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    expect(ok).toMatchObject({ stored: 1 });
  });
});
