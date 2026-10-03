/**
 * Backfill admission and the one-at-a-time lease (FREE-TIER.md §4.5) against a real Postgres with RLS:
 * a listing interrupted by needs_reauth goes back to the queue instead of blocking it as 'running',
 * the lease is held while ANY backfill row of the leased mailbox is pending (also rows in retry
 * backoff), and a restarted import is not counted again against the 5-per-30-days limit.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type pg, withSystem, withUser } from "@edf/db";
import { ensureQuotaRow, type GmailClient } from "@edf/gmail";
import {
  admitBackfill,
  BACKFILLS_PER_30_DAYS,
  checkNewSenders,
  finishBackfillListing,
  listNewSenderChecks,
  releaseFinishedBackfill,
  runNewSenderChecks,
} from "../src/backfill";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

type Mb = { mailboxId: string; userId: string };

describe.skipIf(!HAS_DB)("backfill lease and admission", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let deps: PipelineDeps;

  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    deps = { pool, tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
  });
  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });
  beforeEach(async () => {
    // The queue, the lease and the usage counter are global: start every test from an empty queue.
    await owner.query("UPDATE mailbox SET backfill_state = 'done' WHERE backfill_state IN ('pending', 'running')");
    await owner.query("UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL");
    await owner.query("DELETE FROM usage_ledger WHERE resource = 'backfill.started'");
    // Earlier imports' pending new-sender checks are global too.
    await owner.query("UPDATE mailbox SET backfill_progress = backfill_progress - 'newSendersBefore' WHERE backfill_progress ? 'newSendersBefore'");
  });

  /** A user (owner of an import queue slot) with one active mailbox whose import is queued. */
  async function queuedMailbox(requestedMinutesAgo = 10): Promise<Mb> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'friend')", [userId]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, backfill_requested_at)
         VALUES ($1, 'gmail', $2, $3, 'active', 'pending', now() - make_interval(mins => $4)) RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`, requestedMinutesAgo],
      );
      return r.rows[0]!.id;
    });
    return { mailboxId, userId };
  }
  const mailboxOf = async (mb: Mb) =>
    (await owner.query<{ status: string; backfill_state: string }>("SELECT status, backfill_state FROM mailbox WHERE id = $1", [mb.mailboxId])).rows[0]!;
  const lease = async () =>
    (await owner.query<{ m: string | null; until: Date | null }>("SELECT backfill_lease_mailbox AS m, backfill_lease_until AS until FROM system_state")).rows[0]!;
  const started = async () =>
    Number((await owner.query<{ n: string | null }>("SELECT sum(amount) AS n FROM usage_ledger WHERE resource = 'backfill.started'")).rows[0]?.n ?? 0);
  const setStatus = (mb: Mb, status: string) => owner.query("UPDATE mailbox SET status = $2 WHERE id = $1", [mb.mailboxId, status]);

  it("a listing interrupted by needs_reauth goes back to the queue and resumes after reconnect; it never blocks later imports", async () => {
    const a = await queuedMailbox(20);
    const b = await queuedMailbox(10);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    expect(await mailboxOf(a)).toMatchObject({ backfill_state: "running" });

    // invalid_grant during a listing page: the token layer marks the mailbox needs_reauth; the run ends.
    await setStatus(a, "needs_reauth");
    const next = await releaseFinishedBackfill(deps);
    expect((await lease()).m).toBeNull();
    expect(await mailboxOf(a)).toMatchObject({ backfill_state: "pending" });
    // Meanwhile the next friend's import may start.
    expect(next).toEqual(b);
    expect((await admitBackfill(deps, b)).kind).toBe("admitted");
    await finishBackfillListing(deps, b);

    // Reconnected: A is queued again (not a stranded 'running' head) and is admitted once B is done.
    await setStatus(a, "active");
    expect(await releaseFinishedBackfill(deps)).toEqual(a);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
  });

  it("reconnected before the tick released its lease, the mailbox resumes at once even behind an older queued import", async () => {
    const older = await queuedMailbox(60);
    await setStatus(older, "needs_reauth"); // not in the queue when A was admitted
    const a = await queuedMailbox(20);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    // A is interrupted; the older mailbox comes back first, then A reconnects (connect.ts re-queues it).
    await setStatus(a, "needs_reauth");
    await setStatus(older, "active");
    await owner.query("UPDATE mailbox SET status = 'active', backfill_state = 'pending' WHERE id = $1", [a.mailboxId]);
    // A still holds the lease: it is admitted (not left holding the lease while the FIFO refuses it).
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    expect(await mailboxOf(a)).toMatchObject({ backfill_state: "running" });
    expect((await lease()).m).toBe(a.mailboxId);
    expect(await started()).toBe(1);
    expect(await admitBackfill(deps, older)).toEqual({ kind: "queued", why: "another_running" });
  });

  it("the tick's re-queue does not undo a re-admission that happened after it released the lease", async () => {
    const a = await queuedMailbox(20);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    await setStatus(a, "needs_reauth");
    // Between the tick's lease-release transaction and its re-queue, A reconnects and is admitted again.
    let connects = 0;
    const racing = new Proxy(pool, {
      get(t, k) {
        if (k === "connect") {
          return async () => {
            if (++connects === 2) {
              await owner.query("UPDATE mailbox SET status = 'active', backfill_state = 'running' WHERE id = $1", [a.mailboxId]);
              await owner.query("UPDATE system_state SET backfill_lease_mailbox = $1, backfill_lease_until = now() + interval '30 minutes'", [
                a.mailboxId,
              ]);
            }
            return t.connect();
          };
        }
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    await releaseFinishedBackfill({ ...deps, pool: racing } as PipelineDeps);
    expect(connects).toBeGreaterThanOrEqual(2);
    expect(await mailboxOf(a)).toMatchObject({ status: "active", backfill_state: "running" });
    expect((await lease()).m).toBe(a.mailboxId);
  });

  it("a stranded import admitted before the admission mark existed is not counted again when restarted", async () => {
    const a = await queuedMailbox(20);
    await owner.query("UPDATE mailbox SET backfill_state = 'running', backfill_progress = '{\"listed\": 500}' WHERE id = $1", [a.mailboxId]);
    await withSystem(pool, (_db, c) => c.query("SELECT add_usage(current_date, 'backfill.started', $1)", [BACKFILLS_PER_30_DAYS]));
    expect(await releaseFinishedBackfill(deps)).toEqual(a);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    expect(await started()).toBe(BACKFILLS_PER_30_DAYS);
  });

  it("a 'running' queue head without the lease (stranded) is restarted instead of blocking the FIFO", async () => {
    const a = await queuedMailbox(20);
    const b = await queuedMailbox(10);
    await owner.query("UPDATE mailbox SET backfill_state = 'running' WHERE id = $1", [a.mailboxId]);
    expect(await admitBackfill(deps, b)).toEqual({ kind: "queued", why: "another_running" });
    expect(await releaseFinishedBackfill(deps)).toEqual(a);
    expect(await mailboxOf(a)).toMatchObject({ backfill_state: "pending" });
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
  });

  it("the lease is held while the leased mailbox still has backfill rows, including rows in retry backoff", async () => {
    const a = await queuedMailbox(20);
    const b = await queuedMailbox(10);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    await withUser(pool, a.userId, (_db, c) =>
      c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source, attempts, next_attempt_at)
         VALUES ($1, $2, 'bf-backoff', 'pending_full', 'backfill', 2, now() + interval '2 hours')`,
        [a.mailboxId, a.userId],
      ),
    );
    await finishBackfillListing(deps, a);

    expect(await releaseFinishedBackfill(deps)).toBeNull();
    expect((await lease()).m).toBe(a.mailboxId);
    expect(await admitBackfill(deps, b)).toEqual({ kind: "queued", why: "another_running" });

    // Drained: the lease goes and the next import starts.
    await withUser(pool, a.userId, (_db, c) => c.query("UPDATE message_ledger SET state = 'stored' WHERE mailbox_id = $1", [a.mailboxId]));
    expect(await releaseFinishedBackfill(deps)).toEqual(b);
    expect((await lease()).m).toBeNull();
  });

  it("a restarted import is not counted again, and is not refused by the monthly limit", async () => {
    const a = await queuedMailbox(20);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    expect(await started()).toBe(1);
    // Other imports used up the rest of the rolling 30-day allowance.
    await withSystem(pool, (_db, c) => c.query("SELECT add_usage(current_date, 'backfill.started', $1)", [BACKFILLS_PER_30_DAYS - 1]));

    // The listing crashed (a transient error ends the run): the lease expires and the tick restarts it.
    await owner.query("UPDATE system_state SET backfill_lease_until = now() - interval '1 minute'");
    expect(await releaseFinishedBackfill(deps)).toEqual(a);
    expect((await admitBackfill(deps, a)).kind).toBe("admitted");
    expect(await started()).toBe(BACKFILLS_PER_30_DAYS);

    // A genuinely new import (another mailbox) is still refused.
    await finishBackfillListing(deps, a);
    expect(await releaseFinishedBackfill(deps)).toBeNull();
    const b = await queuedMailbox(5);
    expect(await admitBackfill(deps, b)).toEqual({ kind: "queued", why: "monthly_limit" });
  });

  describe("new-sender check (DESIGN.md §5.4 step 4)", () => {
    /** A Gmail whose `from:X before:T` listing finds mail from `oldSenders` only; records every query. */
    function senderGmail(oldSenders: string[]) {
      const queries: string[] = [];
      const client = {
        async messagesList(p: { q: string }) {
          queries.push(p.q);
          const hit = oldSenders.some((a) => p.q.toLowerCase().includes(a.toLowerCase()));
          return hit ? { messages: [{ id: "old", threadId: "old" }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 };
        },
      };
      return { client: client as unknown as GmailClient, queries };
    }
    const withGmail = (client: GmailClient): PipelineDeps => ({ ...deps, gmailFor: () => client }) as PipelineDeps;

    async function addSenders(mb: Mb, senders: Array<{ address: string; firstSeenDaysAgo: number }>) {
      await withUser(pool, mb.userId, async (_db, c) => {
        for (const s of senders) {
          await c.query(
            `INSERT INTO sender (user_id, address, domain, first_seen_at, last_seen_at, email_count)
             VALUES ($1, $2::text, split_part($2::text, '@', 2), now() - make_interval(days => $3), now(), 1)`,
            [mb.userId, s.address, s.firstSeenDaysAgo],
          );
        }
      });
    }
    const seen = async (mb: Mb) =>
      new Map(
        (
          await owner.query<{ address: string; seen_before_window: boolean | null }>(
            "SELECT address::text AS address, seen_before_window FROM sender WHERE user_id = $1",
            [mb.userId],
          )
        ).rows.map((r) => [r.address, r.seen_before_window]),
      );
    async function importedMailbox(): Promise<Mb> {
      const mb = await queuedMailbox(20);
      await withUser(pool, mb.userId, (db) => ensureQuotaRow(db, mb.mailboxId));
      expect((await admitBackfill(deps, mb)).kind).toBe("admitted");
      return mb;
    }

    it("waits until the import has drained, then checks every sender the drain created — also those created after the listing", async () => {
      const mb = await importedMailbox();
      const gmail = senderGmail(["monthly@news.example"]);
      // Listing done; one backfill row still waits to be drained.
      await withUser(pool, mb.userId, (_db, c) =>
        c.query(
          `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1, $2, 'bf1', 'pending_full', 'backfill')`,
          [mb.mailboxId, mb.userId],
        ),
      );
      const windowStart = Math.floor(Date.now() / 1000) - 30 * 86_400;
      await finishBackfillListing(deps, mb, windowStart);
      await addSenders(mb, [{ address: "early@shop.example", firstSeenDaysAgo: 2 }]);
      expect(await listNewSenderChecks(deps)).toEqual([]);
      expect((await runNewSenderChecks(withGmail(gmail.client))).checked).toBe(0);
      expect(gmail.queries).toEqual([]);

      // The drain stores the rest of the import, creating more senders (a monthly newsletter among them).
      await addSenders(mb, [
        { address: "monthly@news.example", firstSeenDaysAgo: 5 },
        { address: "brand-new@startup.example", firstSeenDaysAgo: 1 },
        { address: "longtime@weekly.example", firstSeenDaysAgo: 28 }, // not a "new senders" candidate
      ]);
      await withUser(pool, mb.userId, (_db, c) => c.query("UPDATE message_ledger SET state = 'stored' WHERE mailbox_id = $1", [mb.mailboxId]));
      expect(await listNewSenderChecks(deps)).toEqual([{ ...mb, windowStartEpoch: windowStart }]);

      const r = await runNewSenderChecks(withGmail(gmail.client));
      expect(r).toMatchObject({ mailboxes: 1, checked: 3, completed: 1 });
      expect(gmail.queries.every((q) => q.endsWith(` before:${windowStart}`))).toBe(true);
      expect(gmail.queries.some((q) => q.includes("longtime@weekly.example"))).toBe(false);
      expect(await seen(mb)).toEqual(
        new Map<string, boolean | null>([
          ["early@shop.example", false],
          ["monthly@news.example", true],
          ["brand-new@startup.example", false],
          ["longtime@weekly.example", null],
        ]),
      );
      // Done: the mark is cleared and nothing runs again.
      expect(await listNewSenderChecks(deps)).toEqual([]);
      gmail.queries.length = 0;
      expect((await runNewSenderChecks(withGmail(gmail.client))).mailboxes).toBe(0);
      expect(gmail.queries).toEqual([]);
    });

    it("one mailbox's Gmail error does not hold back the other mailboxes' checks (it stays due)", async () => {
      const a = await importedMailbox();
      const b = await queuedMailbox(5);
      await withUser(pool, b.userId, (db) => ensureQuotaRow(db, b.mailboxId));
      const windowStart = Math.floor(Date.now() / 1000) - 30 * 86_400;
      // Both imports listed and drained; `a` (created first) is listed first.
      await owner.query(
        `UPDATE mailbox SET backfill_state = 'done', backfill_progress = jsonb_build_object('newSendersBefore', $2::bigint) WHERE id = ANY($1::uuid[])`,
        [[a.mailboxId, b.mailboxId], windowStart],
      );
      await addSenders(a, [{ address: "x@a.example", firstSeenDaysAgo: 2 }]);
      await addSenders(b, [{ address: "y@b.example", firstSeenDaysAgo: 2 }]);
      const good = senderGmail(["y@b.example"]);
      const broken = {
        async messagesList() {
          throw new Error("backend exploded");
        },
      } as unknown as GmailClient;
      const d = { ...deps, gmailFor: (_u: string, m: string) => (m === a.mailboxId ? broken : good.client) } as PipelineDeps;
      const r = await runNewSenderChecks(d);
      expect(r).toMatchObject({ mailboxes: 2, failed: 1, completed: 1, checked: 1 });
      expect((await seen(b)).get("y@b.example")).toBe(true);
      expect((await listNewSenderChecks(deps)).map((m) => m.mailboxId)).toEqual([a.mailboxId]);
    });

    it("pages through every candidate (no cap), and resumes after the quota bucket runs dry", async () => {
      const mb = await importedMailbox();
      const n = 130;
      await addSenders(mb, Array.from({ length: n }, (_, i) => ({ address: `s${i}@many.example`, firstSeenDaysAgo: 3 })));
      const gmail = senderGmail([]);
      // The quota bucket is empty.
      await withUser(pool, mb.userId, (_db, c) =>
        c.query("UPDATE gmail_quota SET tokens = 0, updated_at = now() + interval '1 hour' WHERE mailbox_id = $1", [mb.mailboxId]),
      );
      const windowStart = Math.floor(Date.now() / 1000) - 30 * 86_400;
      expect(await checkNewSenders(withGmail(gmail.client), mb, windowStart)).toEqual({ checked: 0, done: false, stopped: "quota" });
      await finishBackfillListing(deps, mb, windowStart);
      expect((await runNewSenderChecks(withGmail(gmail.client))).completed).toBe(0);
      expect(await listNewSenderChecks(deps)).toHaveLength(1); // still due

      await withUser(pool, mb.userId, (_db, c) => c.query("UPDATE gmail_quota SET tokens = 5500, updated_at = now() WHERE mailbox_id = $1", [mb.mailboxId]));
      const r = await runNewSenderChecks(withGmail(gmail.client));
      expect(r).toMatchObject({ checked: n, completed: 1 });
      expect([...(await seen(mb)).values()].every((v) => v === false)).toBe(true);
    });
  });
});
