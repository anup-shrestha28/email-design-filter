/**
 * R1-18: FREE-TIER.md §4.9 — `inngest_paused` is set when a send fails with a quota/paused error, OR
 * when `last_tick_at` is more than 90 minutes old. Only the first was implemented, and paused
 * Inngest functions (auto-paused after repeated failures, or stopped at the monthly quota) still
 * accept events, so sync-on-open never ran its inline drain and mail moved only with the daily
 * cron. A stale tick now counts as paused, and the flag is saved (the next tick clears it).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { ensureQuotaRow, type GmailClient, type GmailMessage } from "@edf/gmail";
import { heartbeat, syncOnOpen } from "../src/tick";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

const FIXTURES = new URL("../../../fixtures/emails/", import.meta.url);

describe.skipIf(!HAS_DB)("sync-on-open while the tick is stale", () => {
  let pool: pg.Pool;
  let saved: { last_tick_at: Date | null; inngest_paused: boolean } | undefined;
  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    saved = await withSystem(
      pool,
      async (_db, c) =>
        (
          await c.query<{ last_tick_at: Date | null; inngest_paused: boolean }>(
            "SELECT last_tick_at, inngest_paused FROM system_state",
          )
        ).rows[0],
    );
  });
  afterAll(async () => {
    if (saved) {
      const s = saved;
      await withSystem(pool, (_db, c) =>
        c.query("UPDATE system_state SET last_tick_at = $1, inngest_paused = $2", [
          s.last_tick_at,
          s.inngest_paused,
        ]),
      );
    }
    await pool?.end();
  });

  const setTick = (minutesAgo: number) =>
    withSystem(pool, (_db, c) =>
      c.query(
        "UPDATE system_state SET last_tick_at = now() - make_interval(mins => $1), inngest_paused = false",
        [minutesAgo],
      ),
    );
  const pausedFlag = () =>
    withSystem(pool, async (_db, c) =>
      Boolean(
        (await c.query<{ p: boolean }>("SELECT inngest_paused AS p FROM system_state")).rows[0]?.p,
      ),
    );

  async function setup(raw: Uint8Array) {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    await withUser(pool, userId, async (db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      // Synced a moment ago: sync-on-open polls nothing, so only the inline drain can store mail.
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id, last_synced_at)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1, now()) RETURNING id`,
        [userId, randomUUID(), `${userId}@example.com`],
      );
      await ensureQuotaRow(db, m.rows[0]!.id);
      await c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1, $2, 'promo1', 'pending_full', 'sync')`,
        [m.rows[0]!.id, userId],
      );
    });
    const client = {
      async messagesGet(id: string): Promise<GmailMessage> {
        return {
          id,
          threadId: id,
          labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
          snippet: "",
          historyId: "5000",
          internalDate: String(Date.parse("2026-09-25T14:02:15Z")),
          sizeEstimate: raw.byteLength,
          raw: Buffer.from(raw).toString("base64url"),
        } as GmailMessage;
      },
      async messagesList() {
        return { resultSizeEstimate: 0 };
      },
    } as unknown as GmailClient;
    const deps = {
      pool,
      tokens: null,
      tickEvery: 30,
      governorLevel: async () => 0,
      gmailFor: () => client,
    } as unknown as PipelineDeps;
    return { userId, deps };
  }

  const raw = async () => new Uint8Array(await readFile(new URL("01-promo-retail.eml", FIXTURES)));

  it("a tick more than 90 minutes old counts as paused: the inline drain runs and the flag is saved", async () => {
    const { userId, deps } = await setup(await raw());
    await setTick(120);
    const r = await syncOnOpen(deps, { userId, role: "owner" });
    expect(r.inlineDrained).toBe(1);
    expect(r.syncing).toBe(false);
    expect(await pausedFlag()).toBe(true);
    // The next successful tick clears it.
    await heartbeat(deps, "last_tick_at");
    expect(await pausedFlag()).toBe(false);
  });

  it("a recent tick leaves the drain to Inngest", async () => {
    const { userId, deps } = await setup(await raw());
    await setTick(20);
    const r = await syncOnOpen(deps, { userId, role: "owner" });
    expect(r.inlineDrained).toBe(0);
    expect(r.syncing).toBe(true);
    expect(await pausedFlag()).toBe(false);
    // Leave no due row behind for other suites' global drains.
    await withUser(pool, userId, (_db, c) =>
      c.query("DELETE FROM message_ledger WHERE user_id = $1", [userId]),
    );
  });
});
