/**
 * R1-27: backfill admission enforces the two FREE-TIER.md §4.5 rules it used to skip —
 *  - the owner's 180-day window only with ≤ 5 active users (otherwise the import is 90 days);
 *  - a backfill starts only if the calibrated rolling-30-day Vercel CPU, plus the import's projected
 *    cost, plus a 500 CPU-s reserve stays under 75% of the self-cap; otherwise it stays queued.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import {
  admitBackfill,
  backfillCpuFits,
  backfillWindowFor,
  projectedBackfillCpuS,
} from "../src/backfill";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

describe("backfill admission rules (pure)", () => {
  it("friends always get 30 days; the owner's 180 falls to 90 above 5 active users", () => {
    expect(backfillWindowFor("friend", 180, 1)).toBe(30);
    expect(backfillWindowFor("owner", 180, 5)).toBe(180);
    expect(backfillWindowFor("owner", 180, 6)).toBe(90);
    expect(backfillWindowFor("owner", 90, 20)).toBe(90);
    expect(backfillWindowFor("owner", 30, 20)).toBe(30);
  });

  it("projects about 0.1 CPU-s per fetch and admits only under 75% of the self-cap with the reserve", () => {
    expect(projectedBackfillCpuS(90)).toBeCloseTo(524, 0);
    // Self-cap 8,640 → 75% = 6,480. A 30-day import projects 175; with the 500 reserve: 675.
    expect(backfillCpuFits(0, 30)).toBe(true);
    expect(backfillCpuFits(5_700, 30)).toBe(true);
    expect(backfillCpuFits(5_900, 30)).toBe(false);
    // The same usage still fits a short import but not a 180-day one (≈ 1,048 CPU-s).
    expect(backfillCpuFits(5_000, 30)).toBe(true);
    expect(backfillCpuFits(5_000, 180)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("backfill admission against the DB", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let deps: PipelineDeps;
  let savedCalibration: unknown = null;

  const reset = async () => {
    await owner.query("UPDATE mailbox SET backfill_state = 'done' WHERE backfill_state IN ('pending', 'running')");
    await owner.query("UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL");
    await owner.query("DELETE FROM usage_ledger WHERE resource IN ('backfill.started', 'vercel.cpu_s')");
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    deps = { pool, tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    savedCalibration = (await owner.query("SELECT value FROM app_setting WHERE key = 'calibration'")).rows[0]?.value ?? null;
    await owner.query("DELETE FROM app_setting WHERE key = 'calibration'");
  });
  afterAll(async () => {
    if (owner) {
      await reset();
      if (savedCalibration !== null) {
        await owner.query(
          `INSERT INTO app_setting (key, value) VALUES ('calibration', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify(savedCalibration)],
        );
      }
      await owner.end();
    }
    await pool?.end();
  });
  beforeEach(reset);

  async function user(role: "owner" | "friend", window: number, backfillState: "pending" | "done") {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    // The owner row's role is set by the owner connection (app_rw may only create friends).
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'friend')", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, backfill_requested_at)
         VALUES ($1, 'gmail', $2, $3, 'active', $4, now() - interval '10 minutes') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`, backfillState],
      );
      return r.rows[0]!.id;
    });
    await owner.query("UPDATE user_settings SET role = $2, backfill_window_days = $3 WHERE user_id = $1", [userId, role, window]);
    return { mailboxId, userId };
  }

  it("imports 90 days instead of the owner's 180 when more than 5 users are active", async () => {
    for (let i = 0; i < 6; i++) await user("friend", 30, "done");
    const mb = await user("owner", 180, "pending");
    const r = await admitBackfill(deps, mb);
    expect(r).toMatchObject({ kind: "admitted", windowDays: 90 });
    const p = await owner.query<{ w: number }>("SELECT (backfill_progress->>'windowDays')::int AS w FROM mailbox WHERE id = $1", [mb.mailboxId]);
    expect(p.rows[0]?.w).toBe(90);
    // Resetting the owner role keeps later suites' single-owner assumptions intact.
    await owner.query("UPDATE user_settings SET role = 'friend' WHERE user_id = $1", [mb.userId]);
  });

  it("stays queued while the calibrated Vercel CPU projection does not fit, and starts once it does", async () => {
    const mb = await user("friend", 30, "pending");
    // 4,000 metered × the default 1.5 calibration = 6,000; + 175 projected + 500 reserve ≥ 6,480.
    await owner.query("SELECT add_usage(current_date, 'vercel.cpu_s', 4000)");
    expect(await admitBackfill(deps, mb)).toEqual({ kind: "queued", why: "cpu_budget" });
    const lease = await owner.query<{ m: string | null }>("SELECT backfill_lease_mailbox AS m FROM system_state");
    expect(lease.rows[0]?.m).toBeNull();
    const started = await owner.query<{ n: string | null }>("SELECT sum(amount) AS n FROM usage_ledger WHERE resource = 'backfill.started'");
    expect(Number(started.rows[0]?.n ?? 0)).toBe(0);
    const state = await owner.query<{ s: string }>("SELECT backfill_state AS s FROM mailbox WHERE id = $1", [mb.mailboxId]);
    expect(state.rows[0]?.s).toBe("pending");

    await owner.query("DELETE FROM usage_ledger WHERE resource = 'vercel.cpu_s'");
    expect(await admitBackfill(deps, mb)).toMatchObject({ kind: "admitted", windowDays: 30 });
  });
});
