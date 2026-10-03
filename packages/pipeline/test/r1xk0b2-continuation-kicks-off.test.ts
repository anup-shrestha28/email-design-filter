/**
 * R1-19 (continuation kicks): FREE-TIER.md §8.3 — at the Inngest soft line (or L3) continuation
 * kicks are off. The governor computed `continuationKicksOff`, but takeContinuationKick applied only
 * the 6-per-hour cap, so a backlog kept spending executions the governor meant to save.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { takeContinuationKick } from "../src/tick";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

describe.skipIf(!HAS_DB)("continuation kicks under the governor", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let saved: unknown = null;
  let userId = "";
  const setGovernor = (value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 2 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    saved =
      (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ??
      null;
    // At least one eligible ledger row, so only the governor can refuse the kick.
    userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    await withUser(pool, userId, async (_db, c) => {
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      await c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1, $2, 'kick-gov', 'pending', 'sync')`,
        [m.rows[0]!.id, userId],
      );
    });
  });
  afterAll(async () => {
    if (userId)
      await withUser(pool, userId, (_db, c) =>
        c.query("DELETE FROM message_ledger WHERE user_id = $1", [userId]),
      );
    if (owner) {
      if (saved === null) await owner.query("DELETE FROM app_setting WHERE key = 'governor'");
      else await setGovernor(saved);
      await owner.end();
    }
    await pool?.end();
  });

  const deps = () =>
    ({
      pool,
      tickEvery: 30,
      governorLevel: async () => 0,
      tokens: null,
    }) as unknown as PipelineDeps;
  const freshWindow = () =>
    withSystem(pool, (_db, c) =>
      c.query("UPDATE system_state SET kick_window_start = NULL, kick_count = 0"),
    );

  it("refuses the kick while the governor has continuation kicks off, and at L3", async () => {
    await freshWindow();
    await setGovernor({ level: 0, actions: { continuationKicksOff: true } });
    expect(await takeContinuationKick(deps(), 5)).toBe(false);
    await setGovernor({ level: 3, actions: {} });
    expect(await takeContinuationKick(deps(), 5)).toBe(false);
    // Nothing was counted against the hourly cap.
    const n = await withSystem(
      pool,
      async (_db, c) =>
        (await c.query<{ n: number }>("SELECT kick_count AS n FROM system_state")).rows[0]?.n,
    );
    expect(n).toBe(0);
  });

  it("allows it again once the switch is off", async () => {
    await freshWindow();
    await setGovernor({ level: 0, actions: { continuationKicksOff: false } });
    expect(await takeContinuationKick(deps(), 5)).toBe(true);
  });
});
