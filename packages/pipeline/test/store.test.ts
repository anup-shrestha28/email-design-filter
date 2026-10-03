/**
 * Transactional store + poll-delta application against a real Postgres 18 with RLS.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { saveAnalysis, storeEmail, storeQueuedEmail, type DesignColumns } from "../src/store/email";
import { applyPollDelta } from "../src/store/sync";
import { pollMailbox, toPollDelta } from "../src/poll";
import { ensureQuotaRow, GmailError, pollHistory, type GmailClient, type HistoryDelta } from "@edf/gmail";
import type { PipelineDeps } from "../src/deps";
import type { EmailRecord } from "../src/store/record";
import { appRwUrl, HAS_DB } from "./env";

/**
 * Leave no active mailbox (and so no due ledger row) behind: the other suites share this database
 * (fileParallelism is false) and drain.test.ts reads the global list_drain_batch, so rows this file
 * leaves pending would be picked up by whichever suite runs next.
 */
async function dropMailboxes(pool: pg.Pool, userIds: Iterable<string>): Promise<void> {
  for (const id of userIds) await withUser(pool, id, (_db, c) => c.query("DELETE FROM mailbox WHERE user_id = $1", [id]));
}

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

describe.skipIf(!HAS_DB)("store", () => {
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
    if (userId) await dropMailboxes(pool, [userId]);
    await pool?.end();
  });

  it("stores an email with sender, template, deals and analysis; aggregates count only real inserts", async () => {
    const r = record(userId, mailboxId);
    await withUser(pool, userId, (_db, c) =>
      c.query(`INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1,$2,$3,'pending_full','sync')`, [mailboxId, userId, r.providerMessageId]),
    );
    const first = await withUser(pool, userId, (_db, c) => storeEmail(c, r));
    expect(first.inserted).toBe(true);
    const again = await withUser(pool, userId, (_db, c) => storeEmail(c, r));
    expect(again.inserted).toBe(false);
    expect(again.emailId).toBe(first.emailId);
    const s = await withUser(pool, userId, (_db, c) => c.query("SELECT email_count, unread_count, type_distribution FROM sender WHERE id = $1", [first.senderId]));
    expect(s.rows[0]).toMatchObject({ email_count: 1, unread_count: 1, type_distribution: { promotional: 1 } });
    const d = await withUser(pool, userId, (_db, c) => c.query("SELECT count(*)::int AS n FROM deal WHERE email_id = $1", [first.emailId]));
    expect(d.rows[0].n).toBe(1);
    const l = await withUser(pool, userId, (_db, c) => c.query("SELECT state FROM message_ledger WHERE provider_message_id = $1", [r.providerMessageId]));
    expect(l.rows[0].state).toBe("stored");
  });

  it("a later render, template upgrade or AI review (trust null) keeps the ingest trust badge", async () => {
    const badge = { state: "trusted", dmarc: "pass" };
    const r = record(userId, mailboxId, { analysis: { ...record(userId, mailboxId).analysis!, trust: badge } });
    const { emailId } = await withUser(pool, userId, (_db, c) => storeEmail(c, r));
    const later = { ...r.analysis!, trust: null, scoreSummary: { coverage: "render" } };
    const design: DesignColumns = {
      designStatus: "done", designSource: "render", designAiState: "pending", designScore: 70, designBand: "good", designCapped: false,
      designProvisional: false, designIssues: [], designConfidence: "medium", fontSource: "render", fontFamilies: [], usesWebFonts: false,
    };
    const saved = await withUser(pool, userId, (_db, c) => saveAnalysis(c, { emailId, userId, analysis: later, design, force: true }));
    expect(saved).toBe(true);
    const a = await withUser(pool, userId, (_db, c) =>
      c.query<{ trust: unknown; score_summary: unknown }>("SELECT trust, score_summary FROM email_analysis WHERE email_id = $1", [emailId]),
    );
    expect(a.rows[0]).toEqual({ trust: badge, score_summary: { coverage: "render" } });
  });

  it("a re-ingest restores a trust badge lost to JSON null without downgrading the render", async () => {
    const badge = { state: "trusted", dmarc: "pass" };
    const r = record(userId, mailboxId, { analysis: { ...record(userId, mailboxId).analysis!, trust: badge } });
    const { emailId } = await withUser(pool, userId, (_db, c) => storeEmail(c, r));
    const design: DesignColumns = {
      designStatus: "done", designSource: "render", designAiState: "pending", designScore: 70, designBand: "good", designCapped: false,
      designProvisional: false, designIssues: [], designConfidence: "medium", fontSource: "render", fontFamilies: [], usesWebFonts: false,
    };
    await withUser(pool, userId, (_db, c) =>
      saveAnalysis(c, { emailId, userId, analysis: { ...r.analysis!, trust: null, scoreSummary: { coverage: "render" } }, design, force: true }),
    );
    // What an older build left behind: the badge overwritten with a JSON null.
    await withUser(pool, userId, (_db, c) => c.query("UPDATE email_analysis SET trust = 'null'::jsonb WHERE email_id = $1", [emailId]));
    await withUser(pool, userId, (_db, c) => storeEmail(c, { ...r, historyId: "1100" }));
    const a = await withUser(pool, userId, (_db, c) =>
      c.query<{ trust: unknown; score_summary: unknown }>("SELECT trust, score_summary FROM email_analysis WHERE email_id = $1", [emailId]),
    );
    expect(a.rows[0]).toEqual({ trust: badge, score_summary: { coverage: "render" } });
  });

  it("matches templates within Hamming distance 3 and creates a new one beyond", async () => {
    const a = await withUser(pool, userId, (_db, c) => storeEmail(c, record(userId, mailboxId, { templateSimhash: "1000" })));
    // 1000 xor 1007 = 7 → 3 bits
    const b = await withUser(pool, userId, (_db, c) => storeEmail(c, record(userId, mailboxId, { templateSimhash: "1007" })));
    // 1000 xor 1015 = 15 → 4 bits → different template
    const cc = await withUser(pool, userId, (_db, c) => storeEmail(c, record(userId, mailboxId, { templateSimhash: "1015" })));
    expect(b.templateId).toBe(a.templateId);
    expect(cc.templateId).not.toBe(a.templateId);
    expect(b.templateSeenCount).toBe(2);
  });

  it("never lets an older fetch overwrite newer state, and keeps user corrections and triage", async () => {
    const r = record(userId, mailboxId, { historyId: "2000" });
    const stored = await withUser(pool, userId, (_db, c) => storeEmail(c, r));
    await withUser(pool, userId, (_db, c) =>
      c.query("UPDATE email SET primary_type = 'newsletter', type_source = 'user', done_at = now() WHERE id = $1", [stored.emailId]),
    );
    await withUser(pool, userId, (_db, c) => storeEmail(c, { ...r, historyId: "1500", subject: "older" }));
    await withUser(pool, userId, (_db, c) => storeEmail(c, { ...r, historyId: "2500", subject: "newer" }));
    const row = await withUser(pool, userId, (_db, c) => c.query("SELECT subject, primary_type, type_source, done_at FROM email WHERE id = $1", [stored.emailId]));
    expect(row.rows[0]).toMatchObject({ subject: "newer", primary_type: "newsletter", type_source: "user" });
    expect(row.rows[0].done_at).not.toBeNull();
  });

  it("applies a label delta stashed before the row existed when it is newer", async () => {
    const r = record(userId, mailboxId, { historyId: "3000" });
    await withUser(pool, userId, (_db, c) =>
      c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source, pending_label_delta, delta_history_id)
         VALUES ($1,$2,$3,'pending','sync',$4,3100)`,
        [mailboxId, userId, r.providerMessageId, JSON.stringify({ add: ["STARRED"], remove: ["UNREAD"] })],
      ),
    );
    const s = await withUser(pool, userId, (_db, c) => storeEmail(c, r));
    const row = await withUser(pool, userId, (_db, c) => c.query("SELECT is_unread, is_starred, gmail_history_id::text AS h FROM email WHERE id = $1", [s.emailId]));
    expect(row.rows[0]).toEqual({ is_unread: false, is_starred: true, h: "3100" });
  });

  it("applies poll deltas: ledger rows (spam skipped, category full), race-safe labels, stash, deletes, cursor CAS", async () => {
    const stored = await withUser(pool, userId, (_db, c) => storeEmail(c, record(userId, mailboxId, { providerMessageId: "stored-1", historyId: "4000" })));
    await withUser(pool, userId, (_db, c) =>
      c.query(`INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1,$2,'pend-1','pending','sync')`, [mailboxId, userId]),
    );
    const res = await withUser(pool, userId, (_db, c) =>
      applyPollDelta(c, { userId, mailboxId, source: "sync", nextPollAt: new Date(Date.now() + 1_800_000) }, {
        added: [
          { id: "new-cat", labelIds: ["INBOX", "CATEGORY_UPDATES"] },
          { id: "new-primary", labelIds: ["INBOX"] },
          { id: "new-spam", labelIds: ["SPAM"] },
          { id: "new-draft", labelIds: ["DRAFT"] },
          { id: "gone", labelIds: ["INBOX"] },
        ],
        deleted: ["gone"],
        labelChanges: [
          { id: "stored-1", add: [], remove: ["UNREAD"], historyId: "4100" },
          { id: "stored-1", add: ["UNREAD"], remove: [], historyId: "3900" }, // older → ignored
          { id: "pend-1", add: ["STARRED"], remove: [], historyId: "4200" },
          { id: "unknown", add: ["STARRED"], remove: [], historyId: "4300" },
        ],
        newCursor: "5000",
        incomplete: false,
      }),
    );
    expect(res.inserted).toBe(3);
    expect(res.labelUpdates).toBe(1);
    expect(res.stashed).toBe(1);
    expect(res.cursorMoved).toBe(true);
    const ledger = await withUser(pool, userId, (_db, c) =>
      c.query("SELECT provider_message_id AS id, state, reason FROM message_ledger WHERE provider_message_id LIKE 'new-%' ORDER BY 1"),
    );
    expect(ledger.rows).toEqual([
      { id: "new-cat", state: "pending_full", reason: null },
      { id: "new-primary", state: "pending", reason: null },
      { id: "new-spam", state: "skipped", reason: "spam" },
    ]);
    const e = await withUser(pool, userId, (_db, c) => c.query("SELECT is_unread FROM email WHERE id = $1", [stored.emailId]));
    expect(e.rows[0].is_unread).toBe(false);
    // Cursor never moves backwards.
    const back = await withUser(pool, userId, (_db, c) =>
      applyPollDelta(c, { userId, mailboxId, source: "sync", nextPollAt: new Date() }, { added: [], deleted: [], labelChanges: [], newCursor: "4000", incomplete: false }),
    );
    expect(back.cursorMoved).toBe(false);
    // "Not spam" rescues a skipped spam row for refetch.
    const rescue = await withUser(pool, userId, (_db, c) =>
      applyPollDelta(c, { userId, mailboxId, source: "sync", nextPollAt: new Date() }, {
        added: [], deleted: [], labelChanges: [{ id: "new-spam", add: ["INBOX"], remove: ["SPAM"], historyId: "5100" }], newCursor: "5100", incomplete: false,
      }),
    );
    expect(rescue.refetch).toBe(1);
  });

  it("a re-read messagesAdded merged with a later trash/read change still updates the stored email", async () => {
    // Stored before the poll reached its messagesAdded record (re-read multi-page poll, or listed by
    // the backfill/resync first); the user then trashed and read it in Gmail.
    const id = `reread-${randomUUID().slice(0, 8)}`;
    await withUser(pool, userId, (_db, c) =>
      c.query(`INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1,$2,$3,'pending_full','sync')`, [mailboxId, userId, id]),
    );
    await withUser(pool, userId, (_db, c) => storeQueuedEmail(c, record(userId, mailboxId, { providerMessageId: id, historyId: "5000" })));
    const gmail = {
      async historyList() {
        return {
          historyId: "5300",
          history: [
            { id: "4900", messagesAdded: [{ message: { id, threadId: id, labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] } }] },
            { id: "5200", labelsAdded: [{ message: { id, threadId: id }, labelIds: ["TRASH"] }] },
            { id: "5250", labelsRemoved: [{ message: { id, threadId: id }, labelIds: ["UNREAD", "INBOX"] }] },
          ],
        };
      },
    } as unknown as Pick<GmailClient, "historyList">;
    const polled = await pollHistory(gmail, { startHistoryId: "4800", maxPages: 1, deadlineMs: Date.now() + 10_000 });
    expect(polled.records.map((r) => r.action)).toEqual(["insert"]);
    const delta = toPollDelta(polled.records, polled.newCursor, polled.complete);
    await withUser(pool, userId, (_db, c) =>
      applyPollDelta(c, { userId, mailboxId, source: "sync", nextPollAt: new Date(Date.now() + 1_800_000) }, delta),
    );
    const row = await withUser(pool, userId, (_db, c) =>
      c.query("SELECT is_unread, in_trash, label_ids, gmail_history_id::text AS h FROM email WHERE mailbox_id = $1 AND provider_message_id = $2", [mailboxId, id]),
    );
    expect(row.rows[0]).toMatchObject({ is_unread: false, in_trash: true, h: "5250" });
    expect(row.rows[0].label_ids).not.toContain("INBOX");
  });

  describe("a poll running alongside the drain's store (same message)", () => {
    const ctx = () => ({ userId, mailboxId, source: "sync" as const, nextPollAt: new Date(Date.now() + 1_800_000) });
    const queued = async (id: string) =>
      withUser(pool, userId, (_db, c) =>
        c.query(`INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1,$2,$3,'pending_full','sync')`, [mailboxId, userId, id]),
      );
    /** Run the drain's store in an open transaction, start `poll` while it is uncommitted, then commit. */
    async function interleave(r: EmailRecord, poll: () => Promise<unknown>): Promise<void> {
      const c1 = await pool.connect();
      try {
        await c1.query("BEGIN");
        await c1.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        expect(await storeQueuedEmail(c1, r)).not.toBeNull();
        const running = poll();
        await new Promise((res) => setTimeout(res, 300)); // the poll is now waiting on (or past) the ledger row
        await c1.query("COMMIT");
        await running;
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

    it("a label change (read, trashed) seen while the email is being stored is applied, not lost", async () => {
      const r = record(userId, mailboxId, { providerMessageId: `race-label-${randomUUID().slice(0, 8)}` });
      await queued(r.providerMessageId);
      await interleave(r, () =>
        withUser(pool, userId, (_db, c) =>
          applyPollDelta(c, ctx(), {
            added: [], deleted: [], newCursor: "1", incomplete: false,
            labelChanges: [{ id: r.providerMessageId, add: ["TRASH"], remove: ["UNREAD"], historyId: "2000" }],
          }),
        ),
      );
      expect(await emailOf(r.providerMessageId)).toEqual({ is_unread: false, in_trash: true });
    });

    it("a message deleted in Gmail while it is being stored is removed with its ledger row (no orphan email)", async () => {
      const r = record(userId, mailboxId, { providerMessageId: `race-del-${randomUUID().slice(0, 8)}` });
      await queued(r.providerMessageId);
      await interleave(r, () =>
        withUser(pool, userId, (_db, c) => applyPollDelta(c, ctx(), { added: [], deleted: [r.providerMessageId], labelChanges: [], newCursor: "1", incomplete: false })),
      );
      expect(await emailOf(r.providerMessageId)).toBeUndefined();
      expect(await ledgerOf(r.providerMessageId)).toBeUndefined();
    });

    it("a message whose ledger row a poll already deleted is not stored", async () => {
      const r = record(userId, mailboxId, { providerMessageId: `race-gone-${randomUUID().slice(0, 8)}` });
      await queued(r.providerMessageId);
      await withUser(pool, userId, (_db, c) => applyPollDelta(c, ctx(), { added: [], deleted: [r.providerMessageId], labelChanges: [], newCursor: "1", incomplete: false }));
      expect(await withUser(pool, userId, (_db, c) => storeQueuedEmail(c, r))).toBeNull();
      expect(await emailOf(r.providerMessageId)).toBeUndefined();
    });
  });
});

describe.skipIf(!HAS_DB)("maintenance", () => {
  it("recomputes sender aggregates, compacts features (sparing exemplars), queues samples, applies retention", async () => {
    const { recomputeSenderAggregates, compactFeatures, queueTemplateSamples, applyRetention, deleteOrphanSenders } = await import("../src/maintenance");
    const pool = createPool({ connectionString: appRwUrl(), max: 2 });
    const userId = `u_${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      return r.rows[0]!.id;
    });
    const fresh = await withUser(pool, userId, (_db, c) => storeEmail(c, record(userId, mailboxId, { receivedAt: new Date() })));
    const old = await withUser(pool, userId, (_db, c) =>
      storeEmail(c, record(userId, mailboxId, { receivedAt: new Date(Date.now() - 400 * 86_400_000), templateSimhash: "999999" })),
    );
    await withUser(pool, userId, async (_db, c) => {
      await c.query("UPDATE email SET is_unread = false WHERE id = $1", [fresh.emailId]);
      await c.query("UPDATE email_analysis SET analyzed_at = now() - interval '40 days'");
      expect(await recomputeSenderAggregates(c, userId)).toBeGreaterThan(0);
      const s = await c.query("SELECT email_count, read_rate_60d FROM sender WHERE id = $1", [fresh.senderId]);
      expect(s.rows[0].email_count).toBe(2);
      expect(s.rows[0].read_rate_60d).toBe(1);
      // Exemplar spared from compaction.
      await c.query("UPDATE email_template SET exemplar_email_id = $1, exemplar_rendered_at = now() WHERE id = $2", [fresh.emailId, fresh.templateId]);
      expect(await compactFeatures(c, userId, 30)).toBe(1);
      const f = await c.query("SELECT email_id, features IS NULL AS compacted FROM email_analysis ORDER BY compacted");
      expect(f.rows.find((r) => r.email_id === fresh.emailId)?.compacted).toBe(false);
      expect(await applyRetention(c, userId, { emailDays: 365, featureDays: 30 })).toBe(1);
      const gone = await c.query("SELECT count(*)::int AS n FROM email WHERE id = $1", [old.emailId]);
      expect(gone.rows[0].n).toBe(0);
      await c.query("UPDATE email_template SET exemplar_rendered_at = NULL");
      expect(await queueTemplateSamples(c, userId, 10)).toBe(1);
      expect(await deleteOrphanSenders(c, userId)).toBe(0);
    });
    await dropMailboxes(pool, [userId]);
    await pool.end();
  });
});

describe("toPollDelta", () => {
  const rec = (over: Partial<HistoryDelta>): HistoryDelta => ({
    messageId: "m1", threadId: "m1", historyId: "700", action: "insert", skipReason: null, added: true,
    labelIds: [], labelsAdded: [], labelsRemoved: [], refetch: false, ...over,
  });
  it("keeps the label changes merged into an added record (insert and spam), drops them for drafts", () => {
    const d = toPollDelta(
      [
        rec({ messageId: "a", labelIds: ["TRASH"], labelsAdded: ["TRASH"], labelsRemoved: ["UNREAD"] }),
        rec({ messageId: "s", action: "skip", skipReason: "spam", labelIds: ["SPAM"], labelsAdded: ["SPAM"], labelsRemoved: ["INBOX"] }),
        rec({ messageId: "d", action: "skip", skipReason: "draft", labelIds: ["DRAFT"], labelsAdded: ["STARRED"] }),
        rec({ messageId: "n", labelIds: ["INBOX"] }),
      ],
      "800",
      true,
    );
    expect(d.added.map((a) => a.id)).toEqual(["a", "s", "n"]);
    expect(d.labelChanges).toEqual([
      { id: "a", add: ["TRASH"], remove: ["UNREAD"], historyId: "700" },
      { id: "s", add: ["SPAM"], remove: ["INBOX"], historyId: "700" },
    ]);
  });
});

describe.skipIf(!HAS_DB)("pollMailbox: import storms and resync", () => {
  let pool: pg.Pool;
  const users: string[] = [];
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
  });
  afterAll(async () => {
    if (pool) await dropMailboxes(pool, users);
    await pool?.end();
  });

  async function mailbox(historyId: string, lastSyncedDaysAgo: number): Promise<{ userId: string; mailboxId: string }> {
    const userId = `u_${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    users.push(userId);
    const mailboxId = await withUser(pool, userId, async (db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id, last_synced_at)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done', $4::numeric, now() - make_interval(days => $5)) RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`, historyId, lastSyncedDaysAgo],
      );
      await ensureQuotaRow(db, r.rows[0]!.id);
      return r.rows[0]!.id;
    });
    return { userId, mailboxId };
  }
  async function stored(userId: string, mailboxId: string, id: string, over: Partial<EmailRecord> = {}) {
    await withUser(pool, userId, (_db, c) =>
      storeEmail(c, record(userId, mailboxId, { providerMessageId: id, receivedAt: new Date(Date.now() - 2 * 86_400_000), historyId: "100", ...over })),
    );
  }
  const depsFor = (client: unknown): PipelineDeps =>
    ({ pool, tokens: null, tickEvery: 30, governorLevel: async () => 0, gmailFor: () => client }) as unknown as PipelineDeps;
  const emailFlags = async (userId: string, mailboxId: string) =>
    new Map(
      (
        await withUser(pool, userId, (_db, c) =>
          c.query<{ provider_message_id: string; is_unread: boolean; is_starred: boolean; in_trash: boolean; in_spam: boolean }>(
            "SELECT provider_message_id, is_unread, is_starred, in_trash, in_spam FROM email WHERE mailbox_id = $1",
            [mailboxId],
          ),
        )
      ).rows.map((r) => [r.provider_message_id, { unread: r.is_unread, starred: r.is_starred, trash: r.in_trash, spam: r.in_spam }]),
    );
  const ledgerIds = async (userId: string, mailboxId: string) =>
    new Map(
      (
        await withUser(pool, userId, (_db, c) =>
          c.query<{ provider_message_id: string; state: string }>("SELECT provider_message_id, state FROM message_ledger WHERE mailbox_id = $1", [mailboxId]),
        )
      ).rows.map((r) => [r.provider_message_id, r.state]),
    );

  it("an import storm (> 2,000 messagesAdded) lists only mail since the last sync; deletes and label changes still apply", async () => {
    const { userId, mailboxId } = await mailbox("1000", 1);
    await stored(userId, mailboxId, "kept-1");
    await stored(userId, mailboxId, "gone-1");
    const imported = Array.from({ length: 2_001 }, (_, i) => ({
      id: String(1_001 + i),
      messagesAdded: [{ message: { id: `old-${i}`, threadId: `old-${i}`, labelIds: ["INBOX", "CATEGORY_UPDATES"] } }],
    }));
    const lists: string[] = [];
    const client = {
      async historyList() {
        return {
          historyId: "4000",
          history: [
            ...imported,
            { id: "3500", labelsAdded: [{ message: { id: "kept-1", threadId: "kept-1" }, labelIds: ["TRASH"] }] },
            { id: "3600", messagesDeleted: [{ message: { id: "gone-1", threadId: "gone-1" } }] },
          ],
        };
      },
      async messagesList(p: { q: string }) {
        lists.push(p.q);
        return p.q.startsWith("{")
          ? { messages: [{ id: "new-cat", threadId: "new-cat" }], resultSizeEstimate: 1 }
          : { messages: [{ id: "new-prim", threadId: "new-prim" }], resultSizeEstimate: 1 };
      },
    };
    const out = await pollMailbox(depsFor(client), { mailboxId, userId }, { maxPages: 20, budgetMs: 30_000, source: "sync" });
    expect(out).toMatchObject({ kind: "polled", inserted: 2, deleted: 1 });
    expect(lists).toHaveLength(2);
    const after = Math.floor((Date.now() - 2 * 86_400_000) / 1000);
    for (const q of lists) {
      const t = Number(/after:(\d+)/.exec(q)?.[1]);
      expect(Math.abs(t - after)).toBeLessThan(600); // last sync (1 day ago) minus the 1-day margin
    }
    const l = await ledgerIds(userId, mailboxId);
    expect(l.get("new-cat")).toBe("pending_full");
    expect(l.get("new-prim")).toBe("pending");
    expect([...l.keys()].some((k) => k.startsWith("old-"))).toBe(false);
    const flags = await emailFlags(userId, mailboxId);
    expect(flags.get("kept-1")?.trash).toBe(true);
    expect(flags.has("gone-1")).toBe(false);
    const cur = await withUser(pool, userId, (_db, c) => c.query<{ h: string }>("SELECT history_id::text AS h FROM mailbox WHERE id = $1", [mailboxId]));
    expect(cur.rows[0]?.h).toBe("4000");
  });

  it("a short poll that cannot finish (app-open sync: 2 pages) with > 500 messagesAdded is a storm too; dropped ids cost no per-id label statements", async () => {
    const { userId, mailboxId } = await mailbox("1000", 1);
    await stored(userId, mailboxId, "kept-2");
    // Each imported message is added and then relabelled (read) in the same pages, as Gmail's import does.
    const page = (from: number) =>
      Array.from({ length: 300 }, (_, i) => {
        const n = from + i;
        return [
          { id: String(1_000 + 2 * n + 1), messagesAdded: [{ message: { id: `old-${n}`, threadId: `old-${n}`, labelIds: ["INBOX", "UNREAD"] } }] },
          { id: String(1_000 + 2 * n + 2), labelsRemoved: [{ message: { id: `old-${n}`, threadId: `old-${n}` }, labelIds: ["UNREAD"] }] },
        ];
      }).flat();
    const lists: string[] = [];
    const client = {
      async historyList(p: { pageToken?: string }) {
        if (!p.pageToken) return { historyId: "9000", history: page(0), nextPageToken: "p2" };
        if (p.pageToken === "p2")
          return {
            historyId: "9000",
            history: [...page(300), { id: "2999", labelsAdded: [{ message: { id: "kept-2", threadId: "kept-2" }, labelIds: ["STARRED"] }] }],
            nextPageToken: "p3",
          };
        return { historyId: "9000", history: page(600) };
      },
      async messagesList(p: { q: string }) {
        lists.push(p.q);
        return p.q.startsWith("{") ? { messages: [], resultSizeEstimate: 0 } : { messages: [{ id: "new-2", threadId: "new-2" }], resultSizeEstimate: 1 };
      },
    };
    // Count the per-id label statements (SELECT … FOR UPDATE on the ledger).
    let perId = 0;
    const wrapped = new WeakSet<object>();
    const counting = Object.create(pool) as pg.Pool;
    counting.connect = (async () => {
      const cl = await pool.connect();
      if (!wrapped.has(cl)) {
        wrapped.add(cl);
        const q = cl.query.bind(cl) as (...a: unknown[]) => unknown;
        (cl as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
          if (typeof a[0] === "string" && a[0].includes("FROM message_ledger") && a[0].includes("FOR UPDATE")) perId++;
          return q(...a);
        };
      }
      return cl;
    }) as unknown as pg.Pool["connect"];
    const out = await pollMailbox(depsFor(client), { mailboxId, userId }, { maxPages: 2, budgetMs: 8_000, source: "sync" });
    expect(out).toMatchObject({ kind: "polled", inserted: 1, complete: false });
    expect(lists).toHaveLength(2);
    const l = await ledgerIds(userId, mailboxId);
    expect([...l.keys()].some((k) => k.startsWith("old-"))).toBe(false);
    expect(l.get("new-2")).toBe("pending");
    expect((await emailFlags(userId, mailboxId)).get("kept-2")?.starred).toBe(true);
    const again = await pollMailbox({ ...depsFor(client), pool: counting }, { mailboxId, userId }, { maxPages: 2, budgetMs: 8_000, source: "sync" });
    expect(again).toMatchObject({ kind: "polled", complete: false });
    expect(perId).toBeLessThanOrEqual(1); // only kept-2, never the 600 dropped imported ids
    expect([...(await ledgerIds(userId, mailboxId)).keys()].some((k) => k.startsWith("old-"))).toBe(false);
  });

  it("a label change merged into a message this poll queues is not stashed (the fetch reads current labels)", async () => {
    const { userId, mailboxId } = await mailbox("1000", 1);
    await withUser(pool, userId, (_db, c) =>
      applyPollDelta(c, { userId, mailboxId, source: "sync", nextPollAt: new Date() }, {
        added: [{ id: "n1", labelIds: ["INBOX"] }],
        deleted: [],
        labelChanges: [{ id: "n1", add: [], remove: ["UNREAD"], historyId: "1100" }],
        newCursor: "1200",
        incomplete: false,
      }),
    );
    const r = await withUser(pool, userId, (_db, c) =>
      c.query<{ state: string; d: unknown }>("SELECT state, pending_label_delta AS d FROM message_ledger WHERE mailbox_id = $1 AND provider_message_id = 'n1'", [mailboxId]),
    );
    expect(r.rows[0]).toMatchObject({ state: "pending", d: null });
  });

  it("a resync after a history 404 reconciles read/star/trash/spam of stored emails in the gap window (older state only)", async () => {
    const { userId, mailboxId } = await mailbox("1000", 10);
    await stored(userId, mailboxId, "read-in-gap"); // stored unread, read during the gap
    await stored(userId, mailboxId, "trashed-in-gap");
    await stored(userId, mailboxId, "starred-in-gap");
    await stored(userId, mailboxId, "spammed-in-gap");
    await stored(userId, mailboxId, "untouched");
    await stored(userId, mailboxId, "newer", { historyId: "99999" }); // stored after the fresh cursor: left alone
    const all = ["read-in-gap", "trashed-in-gap", "starred-in-gap", "spammed-in-gap", "untouched", "newer"];
    const sets: Record<string, string[]> = {
      "is:unread": ["trashed-in-gap", "starred-in-gap", "spammed-in-gap", "untouched"],
      "is:starred": ["starred-in-gap"],
      "in:trash": ["trashed-in-gap"],
      "in:spam": ["spammed-in-gap"],
    };
    const client = {
      async historyList() {
        throw new GmailError("history_expired", { method: "users.history.list", status: 404 });
      },
      async getProfile() {
        return { emailAddress: "x@gmail.example", historyId: "9000", messagesTotal: 1, threadsTotal: 1 };
      },
      async messagesList(p: { q: string }) {
        const term = Object.keys(sets).find((t) => p.q.endsWith(` ${t}`));
        const ids = term ? sets[term]! : all;
        return { messages: ids.map((id) => ({ id, threadId: id })), resultSizeEstimate: ids.length };
      },
    };
    const out = await pollMailbox(depsFor(client), { mailboxId, userId }, { maxPages: 20, budgetMs: 30_000, source: "sync" });
    expect(out).toMatchObject({ kind: "resync", reconciledDeletes: 0 });
    const f = await emailFlags(userId, mailboxId);
    expect(f.get("read-in-gap")).toEqual({ unread: false, starred: false, trash: false, spam: false });
    expect(f.get("trashed-in-gap")).toEqual({ unread: true, starred: false, trash: true, spam: false });
    expect(f.get("starred-in-gap")).toEqual({ unread: true, starred: true, trash: false, spam: false });
    expect(f.get("spammed-in-gap")).toEqual({ unread: true, starred: false, trash: false, spam: true });
    expect(f.get("untouched")).toEqual({ unread: true, starred: false, trash: false, spam: false });
    expect(f.get("newer")).toEqual({ unread: true, starred: false, trash: false, spam: false }); // not in the unread set, but newer
    const h = await withUser(pool, userId, (_db, c) =>
      c.query<{ h: string }>("SELECT gmail_history_id::text AS h FROM email WHERE mailbox_id = $1 AND provider_message_id = 'read-in-gap'", [mailboxId]),
    );
    expect(h.rows[0]?.h).toBe("9000");
  });
});

