/**
 * Pure mapping of history deltas and the DB-backed continuation-kick cap (FREE-TIER.md §4.2).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import type { HistoryDelta } from "@edf/gmail";
import { toPollDelta } from "../src/poll";
import { takeContinuationKick, CONTINUATION_KICKS_PER_HOUR } from "../src/tick";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

const d = (over: Partial<HistoryDelta>): HistoryDelta => ({
  messageId: "m1",
  threadId: null,
  historyId: "100",
  action: "insert",
  skipReason: null,
  added: true,
  labelIds: ["INBOX"],
  labelsAdded: [],
  labelsRemoved: [],
  refetch: false,
  ...over,
});

describe("toPollDelta", () => {
  it("maps inserts, spam skips, deletes, label changes and spam rescues", () => {
    const delta = toPollDelta(
      [
        d({ messageId: "a", action: "insert", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
        d({ messageId: "b", action: "insert", labelIds: null }),
        d({ messageId: "c", action: "skip", skipReason: "spam", labelIds: ["SPAM"] }),
        d({ messageId: "dr", action: "skip", skipReason: "draft", labelIds: ["DRAFT"] }),
        d({ messageId: "x", action: "delete" }),
        d({ messageId: "l", action: "labels", added: false, labelsAdded: ["STARRED"], labelsRemoved: ["UNREAD"], historyId: "150" }),
        d({ messageId: "r", action: "labels", added: false, refetch: true, labelsRemoved: [], labelsAdded: ["INBOX"], historyId: "160" }),
        d({ messageId: "n", action: "labels", added: false, labelsAdded: [], labelsRemoved: [] }),
      ],
      "200",
      false,
    );
    expect(delta.added).toEqual([
      { id: "a", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] },
      { id: "b", labelIds: [] },
      { id: "c", labelIds: ["SPAM"] },
    ]);
    expect(delta.deleted).toEqual(["x"]);
    expect(delta.labelChanges).toEqual([
      { id: "l", add: ["STARRED"], remove: ["UNREAD"], historyId: "150" },
      { id: "r", add: ["INBOX"], remove: ["SPAM"], historyId: "160" },
    ]);
    expect(delta.newCursor).toBe("200");
    expect(delta.incomplete).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("continuation kicks", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("need progress and eligible rows, and are capped per hour", async () => {
    const deps = { pool, tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    // Guarantee at least one eligible ledger row (pending, attempt time NULL, active mailbox).
    const userId = `u_${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    await withUser(pool, userId, async (_db, c) => {
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      await c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1, $2, 'kick-1', 'pending', 'sync')`,
        [m.rows[0]!.id, userId],
      );
    });
    // No progress → no kick, even with eligible rows.
    expect(await takeContinuationKick(deps, 0)).toBe(false);
    // Fresh window → kicks are allowed until the hourly cap, then refused.
    await withSystem(pool, (_db, c) => c.query("UPDATE system_state SET kick_window_start = NULL, kick_count = 0"));
    for (let i = 0; i < CONTINUATION_KICKS_PER_HOUR; i++) expect(await takeContinuationKick(deps, 5)).toBe(true);
    expect(await takeContinuationKick(deps, 5)).toBe(false);
    // A window older than an hour resets the count.
    await withSystem(pool, (_db, c) => c.query("UPDATE system_state SET kick_window_start = now() - interval '61 minutes'"));
    expect(await takeContinuationKick(deps, 5)).toBe(true);
  });
});
