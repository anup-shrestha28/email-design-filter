/**
 * The drain's store (storeQueuedEmail) locks the message's ledger row with its FIRST statement and
 * holds it until commit; applyPollDelta takes the same lock. These tests pause the drain right
 * after that ledger read and run the poll during the pause, so they fail if the store's
 * `FOR UPDATE` is dropped (the poll would then stash a label delta the drain already read past, or
 * delete a ledger row whose email the drain then commits as an orphan).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { storeQueuedEmail } from "../src/store/email";
import { applyPollDelta, type PollDelta } from "../src/store/sync";
import type { EmailRecord } from "../src/store/record";
import { appRwUrl, HAS_DB } from "./env";

type PoolClient = pg.PoolClient;

function record(userId: string, mailboxId: string, over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    mailboxId,
    userId,
    providerMessageId: over.providerMessageId ?? randomUUID().replaceAll("-", "").slice(0, 16),
    providerThreadId: null,
    historyId: "1000",
    receivedAt: new Date("2026-09-20T10:00:00Z"),
    subject: "30% off everything",
    fromAddress: "hello@northwind.example",
    fromName: "Northwind",
    snippet: "Our autumn sale…",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    sizeBytes: 40000,
    htmlBytes: 30000,
    language: "en",
    securitySensitive: false,
    isSubscription: true,
    subscriptionScore: 90,
    primaryType: "promotional",
    subtype: "sale",
    secondaryTags: [],
    typeConfidence: 0.9,
    typeSource: "rule",
    importance: "normal",
    importanceScore: 20,
    importanceReasons: ["type:promotional"],
    importanceExpiresAt: null,
    listId: null,
    oneClickUnsubscribe: true,
    authResult: "pass",
    suspicious: false,
    espPlatform: "Klaviyo",
    trackerCount: 1,
    utmCampaign: "autumn",
    designStatus: "done",
    designSource: "static",
    designAiState: "pending",
    designScore: null,
    designBand: null,
    designCapped: null,
    designProvisional: null,
    designIssues: [],
    designConfidence: null,
    fontSource: "static",
    fontFamilies: ["Montserrat"],
    usesWebFonts: true,
    deals: [
      { kind: "percent_off", value: 30, currency: null, isUpTo: false, minSpend: null, code: "AUTUMN30", startsAt: null, endsAt: new Date("2026-09-21T06:59:59Z"), endsAtConfidence: 0.9, source: "regex" },
    ],
    searchText: "30% off everything Northwind hello@northwind.example",
    sender: { address: "hello@northwind.example", displayName: "Northwind", domain: "northwind.example", espPlatform: "Klaviyo", listUnsubscribe: { https: ["https://northwind.example/u"], mailto: [] }, oneClick: true, authSummary: { trust: "trusted" } },
    templateSimhash: "123456789",
    analysis: {
      scoringVersion: "test", rendererVersion: null, features: { v: 1 }, checks: [], pillarScores: [], rawScore: null, caps: [],
      confidence: 0.225, trust: {}, scoreSummary: { coverage: "static" }, aiReview: null, aiModel: null, renderRefEmailId: null,
      rendererHost: null, chromiumVersion: null, renderMs: null,
    },
    ...over,
  };
}

/** `c`, but the first ledger read resolves only after `pause()` has run (the drain is mid-store). */
function pausedAfterLedgerRead(c: PoolClient, pause: () => Promise<void>): PoolClient {
  let paused = false;
  return new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (...args: unknown[]) => {
          const res = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (!paused && typeof args[0] === "string" && args[0].includes("FROM message_ledger")) {
            paused = true;
            await pause();
          }
          return res;
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe.skipIf(!HAS_DB)("drain store vs poll: the poll runs between the drain's ledger read and its commit (fin-store)", () => {
  let pool: pg.Pool;
  let userId: string;
  let mailboxId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    userId = `u_${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      return r.rows[0]!.id;
    });
  });
  afterAll(async () => {
    // Leave no active mailbox (and so no due ledger row) for the suites sharing this database.
    if (userId) await withUser(pool, userId, (_db, c) => c.query("DELETE FROM mailbox WHERE user_id = $1", [userId]));
    await pool?.end();
  });

  const ctx = () => ({ userId, mailboxId, source: "sync" as const, nextPollAt: new Date(Date.now() + 1_800_000) });
  const queued = (id: string) =>
    withUser(pool, userId, (_db, c) =>
      c.query(`INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1,$2,$3,'pending_full','sync')`, [mailboxId, userId, id]),
    );
  const poll = (delta: PollDelta) => withUser(pool, userId, (_db, c) => applyPollDelta(c, ctx(), delta));

  /** The drain stores `r`; the poll starts right after the drain's ledger read and gets 300 ms to run. */
  async function storeWithPollMidway(r: EmailRecord, delta: PollDelta): Promise<{ stored: boolean }> {
    const c1 = await pool.connect();
    let running: Promise<unknown> | null = null;
    try {
      await c1.query("BEGIN");
      await c1.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const drain = pausedAfterLedgerRead(c1, async () => {
        running = poll(delta);
        running.catch(() => undefined);
        await new Promise((res) => setTimeout(res, 300)); // the poll waits on the ledger row lock (or, unlocked, finishes)
      });
      const stored = (await storeQueuedEmail(drain, r)) !== null;
      await c1.query("COMMIT");
      await running;
      return { stored };
    } finally {
      c1.release();
    }
  }
  const emailOf = async (id: string) =>
    (await withUser(pool, userId, (_db, c) =>
      c.query<{ is_unread: boolean; in_trash: boolean }>("SELECT is_unread, in_trash FROM email WHERE mailbox_id = $1 AND provider_message_id = $2", [mailboxId, id]),
    )).rows[0];
  const ledgerOf = async (id: string) =>
    (await withUser(pool, userId, (_db, c) =>
      c.query<{ state: string }>("SELECT state FROM message_ledger WHERE mailbox_id = $1 AND provider_message_id = $2", [mailboxId, id]),
    )).rows[0];

  it("a label change (read, trashed) arriving mid-store is applied to the stored email, not lost", async () => {
    const r = record(userId, mailboxId, { providerMessageId: `fin-lock-label-${randomUUID().slice(0, 8)}` });
    await queued(r.providerMessageId);
    const { stored } = await storeWithPollMidway(r, {
      added: [], deleted: [], newCursor: "1", incomplete: false,
      labelChanges: [{ id: r.providerMessageId, add: ["TRASH"], remove: ["UNREAD"], historyId: "2000" }],
    });
    expect(stored).toBe(true);
    expect(await emailOf(r.providerMessageId)).toEqual({ is_unread: false, in_trash: true });
  });

  it("a Gmail deletion arriving mid-store removes the email and its ledger row (no orphan)", async () => {
    const r = record(userId, mailboxId, { providerMessageId: `fin-lock-del-${randomUUID().slice(0, 8)}` });
    await queued(r.providerMessageId);
    await storeWithPollMidway(r, { added: [], deleted: [r.providerMessageId], labelChanges: [], newCursor: "1", incomplete: false });
    expect(await emailOf(r.providerMessageId)).toBeUndefined();
    expect(await ledgerOf(r.providerMessageId)).toBeUndefined();
  });
});
