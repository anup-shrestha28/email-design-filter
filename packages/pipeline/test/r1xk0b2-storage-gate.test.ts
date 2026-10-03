/**
 * R1-17: the governor computed its Neon storage stages (FREE-TIER.md §8.3) — at 300 MB new emails
 * are stored without analysis rows or search text, at 350 MB ingest pauses so deletes keep working
 * (Neon rejects even deletes at 500 MB) — but nothing read them, so ingest ran on to the write lock.
 * The drain now honours both.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { ensureQuotaRow, type GmailClient, type GmailMessage } from "@edf/gmail";
import { drain } from "../src/drain";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

const FIXTURES = new URL("../../../fixtures/emails/", import.meta.url);

function fakeGmail(raw: Uint8Array, historyId = "5000") {
  const calls: string[] = [];
  const client = {
    async messagesGet(id: string, p: { format: string }): Promise<GmailMessage> {
      calls.push(`${id}:${p.format}`);
      return {
        id,
        threadId: id,
        labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        snippet: "",
        historyId,
        internalDate: String(Date.parse("2026-09-25T14:02:15Z")),
        sizeEstimate: raw.byteLength,
        raw: Buffer.from(raw).toString("base64url"),
      } as GmailMessage;
    },
    async messagesList() {
      calls.push("list");
      return { resultSizeEstimate: 0 };
    },
  };
  return { client: client as unknown as GmailClient, calls };
}

describe.skipIf(!HAS_DB)("drain under the governor's Neon storage stages", () => {
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
  });
  afterAll(async () => {
    if (owner) {
      if (saved === null) await owner.query("DELETE FROM app_setting WHERE key = 'governor'");
      else await setGovernor(saved);
      await owner.end();
    }
    await pool?.end();
  });

  async function setup(): Promise<{ userId: string; mailboxId: string }> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    const mailboxId = await withUser(pool, userId, async (db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1) RETURNING id`,
        [userId, randomUUID(), `${userId}@example.com`],
      );
      await ensureQuotaRow(db, m.rows[0]!.id);
      await c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1, $2, 'promo1', 'pending_full', 'sync')`,
        [m.rows[0]!.id, userId],
      );
      return m.rows[0]!.id;
    });
    return { userId, mailboxId };
  }

  const depsWith = (client: GmailClient): PipelineDeps =>
    ({
      pool,
      tokens: null,
      tickEvery: 30,
      governorLevel: async () => 0,
      gmailFor: () => client,
    }) as unknown as PipelineDeps;
  const raw = async () => new Uint8Array(await readFile(new URL("01-promo-retail.eml", FIXTURES)));

  it("at the ingest pause (≥ 350 MB) drains nothing and leaves the rows queued", async () => {
    const { userId } = await setup();
    await setGovernor({ level: 0, actions: { noAnalysisRows: true, ingestPaused: true } });
    const gmail = fakeGmail(await raw());
    const res = await drain(depsWith(gmail.client), {
      budgetMs: 60_000,
      maxRows: 10,
      userId,
      concurrency: 1,
    });
    expect(res).toMatchObject({ processed: 0, stored: 0, stoppedReason: "storage" });
    expect(gmail.calls).toEqual([]);
    const l = await withUser(
      pool,
      userId,
      async (_db, c) =>
        (
          await c.query<{ state: string; attempts: number }>(
            "SELECT state, attempts FROM message_ledger WHERE user_id = $1",
            [userId],
          )
        ).rows,
    );
    expect(l).toEqual([{ state: "pending_full", attempts: 0 }]);

    // Once storage drops, the same rows drain as usual.
    await setGovernor({ level: 0, actions: {} });
    const after = await drain(depsWith(gmail.client), {
      budgetMs: 60_000,
      maxRows: 10,
      userId,
      concurrency: 1,
    });
    expect(after).toMatchObject({ stored: 1, stoppedReason: "done" });
  });

  it("at 300 MB stores new mail without an analysis row or search text", async () => {
    const { userId } = await setup();
    await setGovernor({ level: 0, actions: { noAnalysisRows: true } });
    const gmail = fakeGmail(await raw());
    const res = await drain(depsWith(gmail.client), {
      budgetMs: 60_000,
      maxRows: 10,
      userId,
      concurrency: 1,
    });
    expect(res).toMatchObject({ stored: 1, stoppedReason: "done" });
    const row = await withUser(
      pool,
      userId,
      async (_db, c) =>
        (
          await c.query<{
            subject: string;
            analyses: string;
            tsv_empty: boolean;
            design_score: number | null;
            design_source: string;
          }>(
            `SELECT e.subject, (SELECT count(*) FROM email_analysis a WHERE a.email_id = e.id) AS analyses,
                (e.search_tsv IS NULL OR length(e.search_tsv) = 0) AS tsv_empty, e.design_score, e.design_source
         FROM email e WHERE e.user_id = $1`,
            [userId],
          )
        ).rows[0],
    );
    expect(row).toMatchObject({
      analyses: "0",
      tsv_empty: true,
      design_score: null,
      design_source: "none",
    });
    expect(row?.subject).toBeTruthy();
  });

  it("below 300 MB stores the analysis and search text as before", async () => {
    const { userId } = await setup();
    await setGovernor({ level: 0, actions: {} });
    const gmail = fakeGmail(await raw());
    await drain(depsWith(gmail.client), { budgetMs: 60_000, maxRows: 10, userId, concurrency: 1 });
    const row = await withUser(
      pool,
      userId,
      async (_db, c) =>
        (
          await c.query<{ analyses: string; tsv_empty: boolean }>(
            `SELECT (SELECT count(*) FROM email_analysis a WHERE a.email_id = e.id) AS analyses,
                (e.search_tsv IS NULL OR length(e.search_tsv) = 0) AS tsv_empty
         FROM email e WHERE e.user_id = $1`,
            [userId],
          )
        ).rows[0],
    );
    expect(row).toMatchObject({ analyses: "1", tsv_empty: false });
  });
  it("at 300 MB a re-ingest of an already stored email keeps its search text", async () => {
    const { userId, mailboxId } = await setup();
    await setGovernor({ level: 0, actions: {} });
    await drain(depsWith(fakeGmail(await raw()).client), {
      budgetMs: 60_000,
      maxRows: 10,
      userId,
      concurrency: 1,
    });
    // Queue the same message again (newer history id), now under the 300 MB stage.
    await withUser(pool, userId, (_db, c) =>
      c.query(
        `UPDATE message_ledger SET state = 'pending_full', attempts = 0, next_attempt_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = 'promo1'`,
        [mailboxId],
      ),
    );
    await setGovernor({ level: 0, actions: { noAnalysisRows: true } });
    const res = await drain(depsWith(fakeGmail(await raw(), "6000").client), {
      budgetMs: 60_000,
      maxRows: 10,
      userId,
      concurrency: 1,
    });
    expect(res).toMatchObject({ stored: 1 });
    const row = await withUser(
      pool,
      userId,
      async (_db, c) =>
        (
          await c.query<{ history: string; tsv_empty: boolean }>(
            `SELECT gmail_history_id::text AS history,
                (search_tsv IS NULL OR length(search_tsv) = 0) AS tsv_empty
             FROM email WHERE user_id = $1`,
            [userId],
          )
        ).rows[0],
    );
    expect(row).toEqual({ history: "6000", tsv_empty: false });
  });
});
