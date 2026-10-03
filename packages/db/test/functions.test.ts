/**
 * FREE-TIER.md §10 definer functions: they work without a tenant context, return minimal
 * columns, and implement the documented predicates (incl. the NULL next_attempt_at fix).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { withSystem, withUser } from "../src/client";
import { mailbox, messageLedger, renderRequest } from "../src/schema";
import { HAS_DB } from "./env";
import { appPool, createEmail, createMailbox, createUser, ownerPool, rejectsWithPg } from "./helpers";

describe.skipIf(!HAS_DB)("definer functions", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;

  beforeAll(async () => {
    pool = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  it("list_mailboxes_due_for_poll: active + due (or incomplete) + no live lease", async () => {
    const u = await createUser(pool);
    const ids = await withUser(pool, u, async (db) => ({
      due: await createMailbox(db, u, { nextPollAt: new Date(Date.now() - 1000) }),
      never: await createMailbox(db, u, { nextPollAt: null }),
      future: await createMailbox(db, u, { nextPollAt: new Date(Date.now() + 3_600_000) }),
      incomplete: await createMailbox(db, u, { nextPollAt: new Date(Date.now() + 3_600_000), pollIncomplete: true }),
      leased: await createMailbox(db, u, { nextPollAt: new Date(0), syncLeaseUntil: new Date(Date.now() + 60_000) }),
      paused: await createMailbox(db, u, { nextPollAt: new Date(0), status: "needs_reauth" }),
    }));
    const rows = await withSystem(pool, async (_db, c) => (await c.query("SELECT * FROM list_mailboxes_due_for_poll(500)")).rows);
    const got = new Set(rows.map((r) => r.mailbox_id));
    expect(got.has(ids.due)).toBe(true);
    expect(got.has(ids.never)).toBe(true);
    expect(got.has(ids.incomplete)).toBe(true);
    expect(got.has(ids.future)).toBe(false);
    expect(got.has(ids.leased)).toBe(false);
    expect(got.has(ids.paused)).toBe(false);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["mailbox_id", "user_id"]);
    // Incomplete polls come first.
    expect(rows[0]?.mailbox_id).toBe(ids.incomplete);
  });

  it("count_drain_eligible / list_drain_batch: NULL attempt time is eligible; backoff and queued backfills are not; new mail first, round-robin", async () => {
    const u = await createUser(pool);
    const { a, b, queued } = await withUser(pool, u, async (db) => ({
      a: await createMailbox(db, u, { backfillState: "running" }),
      b: await createMailbox(db, u, { backfillState: "done" }),
      queued: await createMailbox(db, u, { backfillState: "pending" }),
    }));
    const before = Number((await pool.query("SELECT count_drain_eligible() AS n")).rows[0].n);
    await withUser(pool, u, async (db) => {
      const row = (mailboxId: string, id: string, source: "sync" | "backfill", nextAttemptAt: Date | null = null) => ({
        mailboxId, userId: u, providerMessageId: id, state: "pending" as const, source, nextAttemptAt,
      });
      await db.insert(messageLedger).values([
        row(a, "a-bf-1", "backfill"),
        row(a, "a-bf-2", "backfill"),
        row(a, "a-sync-1", "sync"),
        row(b, "b-sync-1", "sync"),
        row(b, "b-sync-2", "sync"),
        row(b, "b-backoff", "sync", new Date(Date.now() + 600_000)),
        row(queued, "q-bf-1", "backfill"),
        row(queued, "q-sync-1", "sync"),
      ]);
    });
    const eligible = Number((await pool.query("SELECT count_drain_eligible() AS n")).rows[0].n) - before;
    expect(eligible).toBe(6); // excludes b-backoff and q-bf-1
    const batch = (await withSystem(pool, async (_db, c) => (await c.query("SELECT * FROM list_drain_batch(2000)")).rows))
      .filter((r) => r.user_id === u)
      .map((r) => r.provider_message_id);
    expect(batch).not.toContain("b-backoff");
    expect(batch).not.toContain("q-bf-1");
    // All new-mail rows precede backfill rows, and mailboxes alternate.
    const firstBackfill = batch.findIndex((id) => id.includes("-bf-"));
    expect(batch.slice(0, firstBackfill).every((id) => id.includes("sync"))).toBe(true);
    expect(new Set(batch.slice(0, 3).map((id) => id[0]))).toEqual(new Set(["a", "b", "q"]));
  });

  it("list_render_due groups queued requests per user with on-demand counts", async () => {
    const u = await createUser(pool);
    const e1 = await withUser(pool, u, async (db) => {
      const m = await createMailbox(db, u);
      const first = await createEmail(db, u, m);
      const second = await createEmail(db, u, m);
      await db.insert(renderRequest).values([
        { userId: u, emailId: first, kind: "on_demand" },
        { userId: u, emailId: second, kind: "fill" },
      ]);
      return first;
    });
    // One active request per email.
    await rejectsWithPg(
      withUser(pool, u, (db) => db.insert(renderRequest).values({ userId: u, emailId: e1, kind: "fill" })),
      /duplicate key/,
    );
    const due = await withSystem(pool, async (_db, c) => (await c.query("SELECT * FROM list_render_due(100)")).rows);
    const mine = due.find((r) => r.user_id === u);
    expect(mine).toMatchObject({ queued_count: "2", on_demand_count: "1" });
  });

  it("lookup_email_owner returns only the user id, with no tenant context", async () => {
    const u = await createUser(pool);
    const e = await withUser(pool, u, async (db) => createEmail(db, u, await createMailbox(db, u)));
    const r = await withSystem(pool, async (_db, c) => (await c.query("SELECT lookup_email_owner($1) AS u", [e])).rows[0]);
    expect(r.u).toBe(u);
  });

  it("reserve_llm enforces global, monthly and daily caps atomically, in the caller's tenant context only", async () => {
    const u = await createUser(pool);
    const day = "2031-03-15"; // an isolated period
    const reserve = (usd: number, caps: [number, number, number] = [1, 0.5, 0.1]) =>
      withUser(pool, u, async (_db, c) =>
        (await c.query("SELECT reserve_llm($1, $2, $3::date, $4, $5, $6) AS ok", [u, usd, day, ...caps])).rows[0].ok as boolean,
      );
    expect(await reserve(0.06)).toBe(true);
    expect(await reserve(0.05)).toBe(false); // day cap 0.10
    expect(await reserve(0.04)).toBe(true);
    await expect(
      withSystem(pool, (_db, c) => c.query("SELECT reserve_llm($1, 0.01, $2::date, 1, 1, 1)", [u, day])),
    ).rejects.toThrow(/tenant context mismatch/);
    await expect(pool.query("UPDATE llm_budget SET reserved_usd = 0")).rejects.toThrow(/permission denied/);

    // Concurrency: 40 parallel reservations of $0.01 against a fresh $0.25 global cap never overshoot.
    const users = await Promise.all(Array.from({ length: 4 }, () => createUser(pool)));
    const day2 = "2031-04-02";
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const uid = users[i % users.length]!;
        return withUser(pool, uid, async (_db, c) =>
          (await c.query("SELECT reserve_llm($1, 0.01, $2::date, 0.25, 1, 1) AS ok", [uid, day2])).rows[0].ok as boolean,
        );
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(25);
    const g = await pool.query("SELECT reserved_usd FROM llm_budget_global WHERE period = '2031-04-01'");
    expect(Number(g.rows[0].reserved_usd)).toBeCloseTo(0.25, 4);
  });

  it("settle_llm releases the unused part of a reservation", async () => {
    const u = await createUser(pool);
    const day = "2031-05-10";
    await withUser(pool, u, async (_db, c) => {
      await c.query("SELECT reserve_llm($1, 0.08, $2::date, 5, 1, 1)", [u, day]);
      await c.query("SELECT settle_llm($1, 0.08, 0.03, $2::date)", [u, day]);
      const r = await c.query("SELECT scope, reserved_usd FROM llm_budget WHERE user_id = $1 ORDER BY scope", [u]);
      expect(r.rows.map((x) => Number(x.reserved_usd))).toEqual([0.03, 0.03]);
    });
  });

  it("add_usage aggregates per (day, resource); app_rw cannot rewrite the ledger", async () => {
    await pool.query("SELECT add_usage('2031-01-01', 'vercel.cpu_s', 1.5)");
    await pool.query("SELECT add_usage('2031-01-01', 'vercel.cpu_s', 2.25)");
    const r = await pool.query("SELECT amount FROM usage_ledger WHERE day = '2031-01-01' AND resource = 'vercel.cpu_s'");
    expect(Number(r.rows[0].amount)).toBeCloseTo(3.75);
    await expect(pool.query("UPDATE usage_ledger SET amount = 0")).rejects.toThrow(/permission denied/);
    await expect(pool.query("SELECT add_usage('2031-01-01', 'x', -1)")).rejects.toThrow(/invalid amount/);
  });

  it("mark_neon_awake ORs minutes into the day bitmap", async () => {
    await pool.query("SELECT mark_neon_awake('2031-02-02', ARRAY[0, 1, 2]::int[])");
    await pool.query("SELECT mark_neon_awake('2031-02-02', ARRAY[2, 3, 1439]::int[])");
    const r = await pool.query("SELECT bit_count(minutes)::int AS n FROM neon_awake WHERE day = '2031-02-02'");
    expect(r.rows[0].n).toBe(5);
    await expect(pool.query("SELECT mark_neon_awake('2031-02-02', ARRAY[1440]::int[])")).rejects.toThrow(/out of range/);
  });

  it("system tables have the documented privileges", async () => {
    await expect(pool.query("DELETE FROM app_error")).rejects.toThrow(/permission denied/);
    await expect(pool.query("INSERT INTO app_setting (key, value) VALUES ('x', '1')")).rejects.toThrow(/permission denied/);
    await pool.query("UPDATE system_state SET last_tick_at = now()");
    await pool.query("INSERT INTO app_error (job, code) VALUES ('test', 'x')");
    const purged = await pool.query("SELECT purge_system_rows() AS r");
    expect(purged.rows[0].r).toHaveProperty("app_error");
  });

  it("sandbox_metered dedupes VM names; the app can add but never rewrite or delete; purge keeps 14 days", async () => {
    const name = `sbx_${Date.now()}`;
    const ins = (n: string) =>
      pool.query("INSERT INTO sandbox_metered (name, created_at) VALUES ($1, now()) ON CONFLICT (name) DO NOTHING RETURNING name", [n]);
    expect((await ins(name)).rowCount).toBe(1);
    expect((await ins(name)).rowCount).toBe(0); // second sweep: already metered
    await expect(pool.query("DELETE FROM sandbox_metered")).rejects.toThrow(/permission denied/);
    await expect(pool.query("UPDATE sandbox_metered SET metered_at = now()")).rejects.toThrow(/permission denied/);
    await owner.query("INSERT INTO sandbox_metered (name, created_at, metered_at) VALUES ($1, now(), now() - interval '15 days')", [`${name}_old`]);
    const purged = await pool.query("SELECT purge_system_rows() AS r");
    expect(purged.rows[0].r.sandbox_metered).toBeGreaterThanOrEqual(1);
    const left = await pool.query("SELECT name FROM sandbox_metered WHERE name LIKE $1 ORDER BY name", [`${name}%`]);
    expect(left.rows.map((r) => r.name)).toEqual([name]);
  });

  it("the importance boost sweep lists lapsed rows across tenants", async () => {
    const u = await createUser(pool);
    const e = await withUser(pool, u, async (db) =>
      createEmail(db, u, await createMailbox(db, u), { importanceExpiresAt: new Date(Date.now() - 1000) }),
    );
    const rows = await withSystem(pool, async (_db, c) => (await c.query("SELECT * FROM list_importance_expired(1000)")).rows);
    expect(rows.map((r) => r.email_id)).toContain(e);
  });

  it("mailbox status predicate helpers exist for purge and backfill queues", async () => {
    const u = await createUser(pool);
    const [a, b] = await withUser(pool, u, async (db) => [
      await createMailbox(db, u, { status: "disconnecting" }),
      await createMailbox(db, u, { backfillState: "pending", backfillRequestedAt: new Date() }),
    ]);
    const purge = await withSystem(pool, async (_db, c) => (await c.query("SELECT * FROM list_mailboxes_for_purge(100)")).rows);
    expect(purge.map((r) => r.mailbox_id)).toContain(a);
    const queue = await withSystem(pool, async (_db, c) => (await c.query("SELECT * FROM list_backfill_queue(100)")).rows);
    expect(queue.map((r) => r.mailbox_id)).toContain(b);
    // Direct reads of other tenants' mailboxes still see nothing.
    const direct = await withSystem(pool, (db) => db.select().from(mailbox).where(sql`true`));
    expect(direct).toHaveLength(0);
  });

  it("system_overview returns aggregate counts to the owner only", async () => {
    const own = await createUser(pool, "owner");
    const friend = await createUser(pool);
    await withUser(pool, friend, async (db) => {
      await createMailbox(db, friend, { status: "needs_reauth" });
      await createMailbox(db, friend, { backfillState: "running" });
    });
    const overview = async (u: string) =>
      withUser(pool, u, async (_db, c) => (await c.query("SELECT * FROM system_overview()")).rows[0] as Record<string, unknown>);
    const row = await overview(own);
    expect(Object.keys(row).sort()).toEqual(
      ["ledger_failed", "ledger_pending", "mailboxes_active", "mailboxes_backfilling", "mailboxes_needs_reauth", "mailboxes_total", "users"].sort(),
    );
    expect(Number(row.users)).toBeGreaterThanOrEqual(2);
    expect(Number(row.mailboxes_needs_reauth)).toBeGreaterThanOrEqual(1);
    expect(Number(row.mailboxes_backfilling)).toBeGreaterThanOrEqual(1);
    await rejectsWithPg(overview(friend), /owner only/);
    await rejectsWithPg(withSystem(pool, (_db, c) => c.query("SELECT * FROM system_overview()")), /owner only/);
  });

  it("alerts.sent is seeded so raiseAlert can record re-notify times", async () => {
    const r = await withSystem(pool, (_db, c) => c.query("SELECT value FROM app_setting WHERE key = 'alerts.sent'"));
    expect(r.rows[0]?.value).toEqual({});
  });
});
