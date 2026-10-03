/**
 * R1-17 follow-up: at the governor's 350 MB ingest pause (FREE-TIER.md §8.3) a new first import
 * is not admitted — its listing would fill the ledger with rows the paused drain never processes.
 * It stays queued and starts once storage drops.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { admitBackfill } from "../src/backfill";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

describe.skipIf(!HAS_DB)("backfill admission under the storage ingest pause", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let saved: unknown = null;
  const setGovernor = (value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    saved =
      (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ??
      null;
    // The queue, the lease and the usage counter are global: start from an empty queue.
    await owner.query(
      "UPDATE mailbox SET backfill_state = 'done' WHERE backfill_state IN ('pending', 'running')",
    );
    await owner.query(
      "UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL",
    );
    await owner.query("DELETE FROM usage_ledger WHERE resource = 'backfill.started'");
  });
  afterAll(async () => {
    if (owner) {
      if (saved === null) await owner.query("DELETE FROM app_setting WHERE key = 'governor'");
      else await setGovernor(saved);
      await owner.query(
        "UPDATE mailbox SET backfill_state = 'done' WHERE backfill_state IN ('pending', 'running')",
      );
      await owner.query(
        "UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL",
      );
      await owner.query("DELETE FROM usage_ledger WHERE resource = 'backfill.started'");
      await owner.end();
    }
    await pool?.end();
  });

  it("stays queued while ingest is paused and is admitted once it clears", async () => {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'friend')", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, backfill_requested_at)
         VALUES ($1, 'gmail', $2, $3, 'active', 'pending', now() - interval '10 minutes') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      return r.rows[0]!.id;
    });
    const deps = {
      pool,
      tickEvery: 30,
      governorLevel: async () => 0,
      tokens: null,
    } as unknown as PipelineDeps;
    const mb = { mailboxId, userId };

    await setGovernor({ level: 0, actions: { noAnalysisRows: true, ingestPaused: true } });
    expect(await admitBackfill(deps, mb)).toEqual({ kind: "queued", why: "governor" });
    const state = await owner.query<{ backfill_state: string }>(
      "SELECT backfill_state FROM mailbox WHERE id = $1",
      [mailboxId],
    );
    expect(state.rows[0]?.backfill_state).toBe("pending");
    const lease = await owner.query<{ m: string | null }>(
      "SELECT backfill_lease_mailbox AS m FROM system_state",
    );
    expect(lease.rows[0]?.m).toBeNull();

    await setGovernor({ level: 0, actions: { noAnalysisRows: true } });
    expect((await admitBackfill(deps, mb)).kind).toBe("admitted");
  });
});
