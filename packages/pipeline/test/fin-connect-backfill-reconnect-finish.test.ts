/**
 * C1-06: a reconnect during a live listing run (its quota sleep) sets the mailbox back to 'pending',
 * and the resume event is skipped by the per-mailbox singleton. When that run finishes its listing,
 * finishBackfillListing must still mark the import done while the mailbox holds the lease, instead
 * of leaving it 'pending' (rows undrained) until the lease expires and it is listed all over again.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { admitBackfill, finishBackfillListing } from "../src/backfill";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

describe.skipIf(!HAS_DB)("finishing a listing after a reconnect re-queued it", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let deps: PipelineDeps;

  const reset = async () => {
    await owner.query("UPDATE mailbox SET backfill_state = 'done' WHERE backfill_state IN ('pending', 'running')");
    await owner.query("UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL");
    await owner.query("DELETE FROM usage_ledger WHERE resource IN ('backfill.started', 'vercel.cpu_s')");
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    deps = { pool, tickEvery: 30, governorLevel: async () => 0, tokens: null, log: () => {} } as unknown as PipelineDeps;
  });
  afterAll(async () => {
    if (owner) {
      await reset();
      await owner.end();
    }
    await pool?.end();
  });
  beforeEach(reset);

  async function mailbox() {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'friend')", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, backfill_requested_at)
         VALUES ($1, 'gmail', $2, $3, 'active', 'pending', now() - interval '10 minutes') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      return r.rows[0]!.id;
    });
    return { mailboxId, userId };
  }
  const stateOf = async (id: string) =>
    (await owner.query<{ s: string; p: Record<string, unknown> }>("SELECT backfill_state AS s, backfill_progress AS p FROM mailbox WHERE id = $1", [id])).rows[0];

  it("marks the import done when the reconnect left it 'pending' while it still holds the lease", async () => {
    const mb = await mailbox();
    expect(await admitBackfill(deps, mb)).toMatchObject({ kind: "admitted" });
    // What connect.ts does on reconnect of an interrupted import: back to 'pending', admission mark kept.
    await owner.query(
      `UPDATE mailbox SET backfill_state = 'pending',
              backfill_progress = backfill_progress || jsonb_build_object('admittedAt', coalesce(backfill_progress->'admittedAt', to_jsonb(now())))
       WHERE id = $1`,
      [mb.mailboxId],
    );
    await finishBackfillListing(deps, mb, 1_700_000_000);
    const s = await stateOf(mb.mailboxId);
    expect(s?.s).toBe("done");
    expect(s?.p.newSendersBefore).toBe(1_700_000_000);
    expect(s?.p).not.toHaveProperty("admittedAt");
  });

  it("leaves a queued mailbox that does not hold the lease alone", async () => {
    const mb = await mailbox();
    await finishBackfillListing(deps, mb, 1_700_000_000);
    expect((await stateOf(mb.mailboxId))?.s).toBe("pending");
  });
});
