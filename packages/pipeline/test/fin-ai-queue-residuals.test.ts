/**
 * Residual fixes in the AI queue and the render plan:
 *  - C1-00: the classification prep budget counts from the start of the tick's "ai" step
 *    (`startedAt`), and a message that fails to parse or prepare keeps its rule-based type instead of
 *    being fetched from Gmail again on every tick;
 *  - C1-01: a 'submitting' row is adopted even when Anthropic's clock runs a little behind the DB's;
 *  - C1-04: adoption reads more than one listing page, so a row with more than 20 newer batches is
 *    still matched on the tick;
 *  - R1-19: while renders are nightly-only (Inngest soft cap), an on-demand trigger plans nothing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Core from "@edf/core";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { collectBatches, submitClassificationBatch } from "../src/ai";
import { planFrom } from "../src/render-plan";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

const parseFails = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("@edf/core", async (importOriginal) => {
  const real = await importOriginal<typeof Core>();
  return {
    ...real,
    parseMime: async (raw: Uint8Array) => {
      if (raw.length === parseFails.bytes) throw new TypeError("unparseable message");
      return real.parseMime(raw);
    },
  };
});

describe("planFrom while renders are nightly-only (R1-19)", () => {
  const users = [
    { user_id: "owner", role: "owner" as const, mailboxes: 1 },
    { user_id: "friend", role: "friend" as const, mailboxes: 1 },
  ];
  const due = [
    { user_id: "owner", queued_count: "1", on_demand_count: "1", oldest_at: new Date() },
    { user_id: "friend", queued_count: "1", on_demand_count: "1", oldest_at: new Date() },
  ];
  const gov = { level: 0, actions: { rendersNightlyOnly: true } as never };

  it("an on-demand trigger plans nothing; the nightly run still renders the queued requests", () => {
    expect(planFrom({ trigger: "on_demand", gov, aiPaused: false, due, users, now: Date.now() })).toEqual([]);
    const nightly = planFrom({ trigger: "nightly", gov, aiPaused: false, due, users, now: Date.now() });
    expect(nightly.map((p) => p.userId).sort()).toEqual(["friend", "owner"]);
    expect(planFrom({ trigger: "on_demand", gov: { level: 0, actions: {} }, aiPaused: false, due, users, now: Date.now() })).toHaveLength(2);
  });
});

describe.skipIf(!HAS_DB)("AI queue residuals", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
  });
  afterAll(async () => {
    await pool?.end();
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
  async function seedPending(u: { userId: string; mailboxId: string }, n: number): Promise<string[]> {
    return withUser(pool, u.userId, async (_db, c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, label_ids, search_tsv, created_at)
         SELECT $1, $2, md5(random()::text || g::text), 100, now(), 'Hello', true, 'promotional', 'pending', ARRAY['INBOX'],
                to_tsvector('simple', 'hello'), now() - interval '9 days' - make_interval(secs => $3 - g)
         FROM generate_series(1, $3) g RETURNING id`,
        [u.userId, u.mailboxId, n],
      )).rows.map((r) => r.id),
    );
  }
  const typeSource = (u: string, id: string) =>
    withUser(pool, u, async (_db, c) => (await c.query<{ t: string }>("SELECT type_source AS t FROM email WHERE id = $1", [id])).rows[0]?.t);
  const batchState = (id: string) =>
    withSystem(pool, async (_db, c) => (await c.query<{ state: string; anthropic_batch_id: string | null }>("SELECT state, anthropic_batch_id FROM ai_batch WHERE id = $1", [id])).rows[0]);
  const classifyDeps = (anthropic: unknown, fetched: string[], raw: Uint8Array) =>
    ({
      pool,
      anthropic,
      now: () => new Date(),
      tickEvery: 30,
      governorLevel: async () => 0,
      tokens: null,
      rawSourceFor: ({ userId }: { userId: string }) => async () => {
        fetched.push(userId);
        return raw;
      },
    }) as unknown as PipelineDeps;

  it("C1-00: the prep budget counts from the step's start, so a long collect leaves no time to fetch", async () => {
    const u = await seedUser();
    const [id] = await seedPending(u, 1);
    const fetched: string[] = [];
    const anthropic = { messages: { countTokens: async () => ({ input_tokens: 1000 }), batches: { create: async () => ({ id: "x" }) } } };
    // The step began 3 minutes ago (collectBatches took that long): the 120 s budget is used up.
    const r = await submitClassificationBatch(classifyDeps(anthropic, fetched, new Uint8Array(3)), { startedAt: Date.now() - 180_000 });
    expect(r).toEqual({ queued: 0 });
    expect(fetched).toEqual([]);
    expect(await typeSource(u.userId, id!)).toBe("pending");
    await withUser(pool, u.userId, (_db, c) => c.query("UPDATE email SET type_source = 'rule' WHERE id = $1", [id]));
  });

  it("C1-00: a message that fails to parse keeps its rule-based type instead of being fetched every tick", async () => {
    const u = await seedUser();
    const [id] = await seedPending(u, 1);
    const fetched: string[] = [];
    parseFails.bytes = 7;
    const anthropic = { messages: { countTokens: async () => ({ input_tokens: 1000 }), batches: { create: async () => ({ id: "x" }) } } };
    try {
      await submitClassificationBatch(classifyDeps(anthropic, fetched, new Uint8Array(7)));
      expect(fetched).toContain(u.userId);
      expect(await typeSource(u.userId, id!)).toBe("rule");
    } finally {
      parseFails.bytes = 0;
      await withUser(pool, u.userId, (_db, c) => c.query("UPDATE email SET type_source = 'rule' WHERE id = $1", [id]));
    }
  });

  async function seedSubmitting(minutesAgo: number): Promise<{ batchId: string; createdAt: Date }> {
    const batchId = randomUUID();
    const r = await withSystem(pool, async (_db, c) =>
      c.query<{ created_at: Date }>(
        "INSERT INTO ai_batch (id, purpose, state, reserved_usd, item_count, created_at) VALUES ($1, 'classify', 'submitting', 0, 3, now() - make_interval(mins => $2)) RETURNING created_at",
        [batchId, minutesAgo],
      ),
    );
    return { batchId, createdAt: r.rows[0]!.created_at };
  }
  const counts = (n: number) => ({ processing: n, succeeded: 0, errored: 0, canceled: 0, expired: 0 });
  const retire = (id: string) => withSystem(pool, (_db, c) => c.query("UPDATE ai_batch SET state = 'failed', ended_at = now() WHERE id = $1", [id]));

  it("C1-01: a batch whose created_at is a little before its row's (Anthropic's clock behind) is adopted", async () => {
    const { batchId, createdAt } = await seedSubmitting(35);
    const anthropicId = `msgbatch_${randomUUID()}`;
    const anthropic = {
      messages: {
        batches: {
          list: async () => ({
            data: [{ id: anthropicId, created_at: new Date(createdAt.getTime() - 90_000).toISOString(), request_counts: counts(3) }],
            has_more: false,
          }),
          retrieve: async () => ({ processing_status: "in_progress" }),
        },
      },
    };
    try {
      await collectBatches({ pool, anthropic, now: () => new Date(), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps);
      expect(await batchState(batchId)).toEqual({ state: "submitted", anthropic_batch_id: anthropicId });
    } finally {
      await retire(batchId);
    }
  });

  it("C1-01: the skew window never adopts a batch another (finished) row already owns", async () => {
    const { batchId, createdAt } = await seedSubmitting(35);
    const ownedId = `msgbatch_${randomUUID()}`;
    const finishedRow = randomUUID();
    await withSystem(pool, (_db, c) =>
      c.query(
        "INSERT INTO ai_batch (id, purpose, state, reserved_usd, item_count, anthropic_batch_id, created_at, ended_at) VALUES ($1, 'design_review', 'ended', 0, 3, $2, $3::timestamptz - interval '2 minutes', now())",
        [finishedRow, ownedId, createdAt.toISOString()],
      ),
    );
    const anthropic = {
      messages: {
        batches: {
          list: async () => ({
            data: [{ id: ownedId, created_at: new Date(createdAt.getTime() - 120_000).toISOString(), request_counts: counts(3) }],
            has_more: false,
          }),
          retrieve: async () => ({ processing_status: "in_progress" }),
        },
      },
    };
    try {
      await collectBatches({ pool, anthropic, now: () => new Date(), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps);
      // No batch exists for it and the listing reaches back past it: released, not stuck 'submitting'.
      expect(await batchState(batchId)).toEqual({ state: "failed", anthropic_batch_id: null });
      expect(await batchState(finishedRow)).toEqual({ state: "ended", anthropic_batch_id: ownedId });
    } finally {
      await retire(batchId);
    }
  });

  it("C1-04: a row with more than 20 newer batches is matched from the next listing page", async () => {
    const { batchId, createdAt } = await seedSubmitting(35);
    const anthropicId = `msgbatch_${randomUUID()}`;
    const newer = Array.from({ length: 20 }, (_, i) => ({
      id: `msgbatch_newer_${i}_${randomUUID()}`,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      request_counts: counts(9),
    }));
    const older = [{ id: anthropicId, created_at: new Date(createdAt.getTime() + 2_000).toISOString(), request_counts: counts(3) }];
    const calls: Array<string | undefined> = [];
    const anthropic = {
      messages: {
        batches: {
          list: async (q: { after_id?: string }) => {
            calls.push(q.after_id);
            return q.after_id === newer.at(-1)!.id ? { data: older, has_more: true } : { data: newer, has_more: true };
          },
          retrieve: async () => ({ processing_status: "in_progress" }),
        },
      },
    };
    try {
      await collectBatches({ pool, anthropic, now: () => new Date(), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps);
      expect(await batchState(batchId)).toEqual({ state: "submitted", anthropic_batch_id: anthropicId });
      expect(calls[0]).toBeUndefined();
      expect(calls).toContain(newer.at(-1)!.id);
    } finally {
      await retire(batchId);
    }
  });
});
