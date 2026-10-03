/**
 * AI spend settlement (FREE-TIER.md §6.5 layer 3): a batch item is settled once, against the day
 * its reservation was made, even when collection is interrupted and retried or the batch ends in
 * the next month; real-time reviews settle against their reservation day too. A result is applied
 * in the same transaction that settles it, so a crash in between loses neither.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { collectBatches, reviewRealtime, submitBatch } from "../src/ai";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

const USAGE = { input_tokens: 1000, output_tokens: 500 };
const ACTUAL_BATCH = 0.0088; // (1,000 × $5 + 500 × $25) / 1e6 / 2, rounded up
const ACTUAL_REALTIME = 0.0175;

describe.skipIf(!HAS_DB)("AI settlement", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function seedUser(): Promise<{ userId: string; emailId: string }> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const emailId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      const e = await c.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, search_tsv)
         VALUES ($1, $2, $3, 100, now(), 'Hello', true, 'promotional', 'pending', to_tsvector('simple', 'hello')) RETURNING id`,
        [userId, m.rows[0]!.id, randomUUID().replaceAll("-", "").slice(0, 16)],
      );
      return e.rows[0]!.id;
    });
    return { userId, emailId };
  }

  const reserve = (u: string, usd: number, day: string) =>
    withUser(pool, u, async (_db, c) =>
      (await c.query<{ ok: boolean }>("SELECT reserve_llm($1, $2, $3::date, 100, 100, 100) AS ok", [u, usd, day])).rows[0]!.ok,
    );
  const global = async (period: string) =>
    Number((await pool.query("SELECT reserved_usd FROM llm_budget_global WHERE period = $1", [period])).rows[0]?.reserved_usd ?? 0);
  const budget = (u: string) =>
    withUser(pool, u, async (_db, c) =>
      Object.fromEntries(
        (await c.query<{ k: string; v: string }>("SELECT scope || ':' || day::text AS k, reserved_usd AS v FROM llm_budget WHERE user_id = $1", [u]))
          .rows.map((r) => [r.k, Number(r.v)]),
      ),
    );

  it("collectBatches settles each item once, against its reservation day, when retried after a failure", async () => {
    let now = new Date("2041-03-31T23:50:00Z");
    const a = await seedUser();
    const worst = 0.05;
    expect(await reserve(a.userId, worst, "2041-03-31")).toBe(true);

    const batchId = randomUUID();
    const cid = `cl_${a.emailId.replaceAll("-", "")}_${batchId.replaceAll("-", "").slice(-10)}`;
    const anthropicId = `msgbatch_${randomUUID()}`;
    let failMidStream = true;
    const anthropic = {
      messages: {
        batches: {
          create: async () => ({ id: anthropicId }),
          list: async () => ({ data: [] }),
          retrieve: async (id: string) => ({ processing_status: id === anthropicId ? "ended" : "in_progress" }),
          results: async function* () {
            yield { custom_id: cid, result: { type: "succeeded", message: { usage: USAGE, content: [], stop_reason: "refusal" } } };
            if (failMidStream) throw new Error("stream reset");
          },
        },
      },
    } as unknown as Anthropic;
    const deps = { pool, anthropic, now: () => now, tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;

    await submitBatch(deps, batchId, "classify", [
      { cid, userId: a.userId, emailId: a.emailId, templateId: null, worst, day: "2041-03-31", params: {} as Anthropic.MessageCreateParamsNonStreaming },
    ]);
    // Someone else reserves in April before the batch is collected.
    const b = await seedUser();
    expect(await reserve(b.userId, 0.2, "2041-04-01")).toBe(true);

    now = new Date("2041-04-01T00:30:00Z");
    await expect(collectBatches(deps)).rejects.toThrow(/stream reset/);
    failMidStream = false;
    expect((await collectBatches(deps)).ended).toBe(1);

    expect(await global("2041-03-01")).toBe(ACTUAL_BATCH);
    expect(await global("2041-04-01")).toBe(0.2);
    expect(await budget(a.userId)).toEqual({ "month:2041-03-01": ACTUAL_BATCH, "day:2041-03-31": ACTUAL_BATCH });
    const usage = await withUser(pool, a.userId, async (_db, c) =>
      (await c.query<{ requests: number }>("SELECT requests FROM llm_usage WHERE user_id = $1", [a.userId])).rows,
    );
    expect(usage).toEqual([{ requests: 1 }]);
    const batch = await withSystem(pool, async (_db, c) =>
      (await c.query<{ state: string; settled_usd: string }>("SELECT state, settled_usd FROM ai_batch WHERE id = $1", [batchId])).rows[0],
    );
    expect(batch).toEqual({ state: "ended", settled_usd: String(ACTUAL_BATCH) });
  });

  it("a crash before the result is committed leaves the item to be settled and applied by the retry", async () => {
    const a = await seedUser();
    expect(await reserve(a.userId, 0.05, "2041-08-10")).toBe(true);
    const batchId = randomUUID();
    const cid = `cl_${a.emailId.replaceAll("-", "")}_${batchId.replaceAll("-", "").slice(-10)}`;
    const anthropicId = `msgbatch_${randomUUID()}`;
    const anthropic = {
      messages: {
        batches: {
          create: async () => ({ id: anthropicId }),
          list: async () => ({ data: [] }),
          retrieve: async (id: string) => ({ processing_status: id === anthropicId ? "ended" : "in_progress" }),
          results: async function* () {
            yield { custom_id: cid, result: { type: "succeeded", message: { usage: USAGE, content: [], stop_reason: "refusal" } } };
          },
        },
      },
    } as unknown as Anthropic;
    // The connection is lost at the commit of the transaction that applies the result.
    const crashing = createPool({ connectionString: appRwUrl(), max: 4 });
    let crash = true;
    const wrapped = new WeakSet<pg.PoolClient>();
    const connect = crashing.connect.bind(crashing) as () => Promise<pg.PoolClient>;
    crashing.connect = (async () => {
      const c = await connect();
      if (!wrapped.has(c)) {
        wrapped.add(c);
        const query = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
        let applying = false;
        c.query = (async (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          if (text.includes("type_source = 'rule'")) applying = true;
          if (text === "COMMIT" && applying) {
            applying = false;
            if (crash) {
              crash = false;
              await query("ROLLBACK");
              throw new Error("connection lost");
            }
          }
          return query(...args);
        }) as typeof c.query;
      }
      return c;
    }) as typeof crashing.connect;
    try {
      const deps = { pool: crashing, anthropic, now: () => new Date("2041-08-10T12:00:00Z"), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
      await submitBatch(deps, batchId, "classify", [
        { cid, userId: a.userId, emailId: a.emailId, templateId: null, worst: 0.05, day: "2041-08-10", params: {} as Anthropic.MessageCreateParamsNonStreaming },
      ]);
      await collectBatches(deps).catch(() => undefined);
      expect(crash).toBe(false);
      await collectBatches(deps);
    } finally {
      await crashing.end();
    }
    const email = await withUser(pool, a.userId, async (_db, c) =>
      (await c.query<{ type_source: string }>("SELECT type_source FROM email WHERE id = $1", [a.emailId])).rows[0],
    );
    expect(email).toEqual({ type_source: "rule" });
    expect(await budget(a.userId)).toEqual({ "month:2041-08-01": ACTUAL_BATCH, "day:2041-08-10": ACTUAL_BATCH });
    const usage = await withUser(pool, a.userId, async (_db, c) =>
      (await c.query<{ requests: number }>("SELECT requests FROM llm_usage WHERE user_id = $1", [a.userId])).rows,
    );
    expect(usage).toEqual([{ requests: 1 }]);
  });

  /** An ended batch with one succeeded item; results streams wait at `gate` before yielding it. */
  const endedBatch = (cid: string, anthropicId: string, gate: () => Promise<void> = async () => {}) =>
    ({
      messages: {
        batches: {
          create: async () => ({ id: anthropicId }),
          list: async () => ({ data: [] }),
          retrieve: async (id: string) => ({ processing_status: id === anthropicId ? "ended" : "in_progress" }),
          results: async function* () {
            await gate();
            yield { custom_id: cid, result: { type: "succeeded", message: { usage: USAGE, content: [], stop_reason: "refusal" } } };
          },
        },
      },
    }) as unknown as Anthropic;

  it("two collections at once, then a third, settle and apply an item once", async () => {
    const a = await seedUser();
    expect(await reserve(a.userId, 0.05, "2041-09-10")).toBe(true);
    const batchId = randomUUID();
    const cid = `cl_${a.emailId.replaceAll("-", "")}_${batchId.replaceAll("-", "").slice(-10)}`;
    // The first two collections hand out the item together, so both find it unsettled.
    let waiting = 0;
    let release = () => {};
    const both = new Promise<void>((r) => (release = r));
    const anthropic = endedBatch(cid, `msgbatch_${randomUUID()}`, async () => {
      if (++waiting === 2) release();
      if (waiting <= 2) await both;
    });
    const deps = { pool, anthropic, now: () => new Date("2041-09-10T12:00:00Z"), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    await submitBatch(deps, batchId, "classify", [
      { cid, userId: a.userId, emailId: a.emailId, templateId: null, worst: 0.05, day: "2041-09-10", params: {} as Anthropic.MessageCreateParamsNonStreaming },
    ]);
    const runs = await Promise.all([collectBatches(deps), collectBatches(deps)]);
    runs.push(await collectBatches(deps));
    expect(runs.reduce((n, r) => n + r.applied, 0)).toBe(1);
    expect(await global("2041-09-01")).toBe(ACTUAL_BATCH);
    expect(await budget(a.userId)).toEqual({ "month:2041-09-01": ACTUAL_BATCH, "day:2041-09-10": ACTUAL_BATCH });
    const usage = await withUser(pool, a.userId, async (_db, c) =>
      (await c.query<{ requests: number }>("SELECT requests FROM llm_usage WHERE user_id = $1", [a.userId])).rows,
    );
    expect(usage).toEqual([{ requests: 1 }]);
  });

  it("saving a result doesn't hold the month's global budget lock", async () => {
    const a = await seedUser();
    const b = await seedUser();
    expect(await reserve(a.userId, 0.05, "2041-10-10")).toBe(true);
    const batchId = randomUUID();
    const cid = `cl_${a.emailId.replaceAll("-", "")}_${batchId.replaceAll("-", "").slice(-10)}`;
    const anthropic = endedBatch(cid, `msgbatch_${randomUUID()}`);
    // While the result is being applied, another user reserves; it must not wait for the lock.
    const probing = createPool({ connectionString: appRwUrl(), max: 4 });
    const probes: Array<boolean | string> = [];
    const wrapped = new WeakSet<pg.PoolClient>();
    const connect = probing.connect.bind(probing) as () => Promise<pg.PoolClient>;
    probing.connect = (async () => {
      const c = await connect();
      if (!wrapped.has(c)) {
        wrapped.add(c);
        const query = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
        c.query = (async (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          if (text.includes("type_source = 'rule'")) {
            probes.push(
              await withUser(pool, b.userId, async (_db, pc) => {
                await pc.query("SET LOCAL lock_timeout = '2s'");
                return (await pc.query<{ ok: boolean }>("SELECT reserve_llm($1, 0.01, '2041-10-10'::date, 100, 100, 100) AS ok", [b.userId])).rows[0]!.ok;
              }).catch((err: unknown) => String(err)),
            );
          }
          return query(...args);
        }) as typeof c.query;
      }
      return c;
    }) as typeof probing.connect;
    try {
      const deps = { pool: probing, anthropic, now: () => new Date("2041-10-10T12:00:00Z"), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
      await submitBatch(deps, batchId, "classify", [
        { cid, userId: a.userId, emailId: a.emailId, templateId: null, worst: 0.05, day: "2041-10-10", params: {} as Anthropic.MessageCreateParamsNonStreaming },
      ]);
      expect((await collectBatches(deps)).applied).toBe(1);
    } finally {
      await probing.end();
    }
    expect(probes).toEqual([true]);
    expect(await global("2041-10-01")).toBe(ACTUAL_BATCH + 0.01);
  });

  it("a rejected batch submission (4xx) releases each item once", async () => {
    const a = await seedUser();
    expect(await reserve(a.userId, 0.05, "2041-05-02")).toBe(true);
    const batchId = randomUUID();
    const cid = `cl_${a.emailId.replaceAll("-", "")}_${batchId.replaceAll("-", "").slice(-10)}`;
    const anthropic = {
      messages: { batches: { create: async () => Promise.reject(Object.assign(new Error("invalid request"), { status: 400 })) } },
    } as unknown as Anthropic;
    const deps = { pool, anthropic, now: () => new Date("2041-05-02T10:00:00Z"), tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    await expect(
      submitBatch(deps, batchId, "classify", [
        { cid, userId: a.userId, emailId: a.emailId, templateId: null, worst: 0.05, day: "2041-05-02", params: {} as Anthropic.MessageCreateParamsNonStreaming },
      ]),
    ).rejects.toThrow(/invalid request/);
    expect(await global("2041-05-01")).toBe(0);
    const item = await withUser(pool, a.userId, async (_db, c) =>
      (await c.query<{ settled_usd: string; reserved_day: string }>("SELECT settled_usd, reserved_day::text FROM ai_batch_item WHERE custom_id = $1", [cid])).rows[0],
    );
    expect(item).toEqual({ settled_usd: "0.0000", reserved_day: "2041-05-02" });
  });

  it("reviewRealtime settles against the reservation day when the call ends after midnight", async () => {
    let now = new Date("2041-06-30T23:59:50Z");
    const a = await seedUser();
    const anthropic = {
      messages: {
        countTokens: async () => ({ input_tokens: 1000 }),
        create: async () => {
          now = new Date("2041-07-01T00:00:40Z");
          return { usage: USAGE, content: [], stop_reason: "refusal" };
        },
      },
    } as unknown as Anthropic;
    const deps = { pool, anthropic, now: () => now, tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    await reviewRealtime(deps, {
      userId: a.userId,
      emailId: a.emailId,
      hierarchyProxies: [],
      tiles: { desktop: [], mobile: null },
      subject: "Hello",
      type: "promotional",
      ctaBox: null,
      visibleText: "hello",
    });
    expect(await global("2041-06-01")).toBe(ACTUAL_REALTIME);
    expect(await global("2041-07-01")).toBe(0);
    expect(await budget(a.userId)).toEqual({ "month:2041-06-01": ACTUAL_REALTIME, "day:2041-06-30": ACTUAL_REALTIME });
  });
});
