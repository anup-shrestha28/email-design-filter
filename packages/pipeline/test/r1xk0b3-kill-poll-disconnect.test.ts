/**
 * R1-21: the per-stage kill switches (`app_setting` kill.ingest / kill.render / kill.backfill,
 * DESIGN.md §11.8) stop their stage — before, only kill.ai was read and the System page showed the
 * others as "Switched off" while the stage kept running.
 * R1-24: a polled mailbox's next poll is timed from when the tick listed it (less a small grace),
 * so the next :30 tick finds it due instead of a few seconds short (which made it hourly).
 * R1-25: a disconnect whose Google /revoke failed reports `revokeFailed`, so the UI never claims
 * the access was revoked.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { admitBackfill } from "../src/backfill";
import type { PipelineDeps } from "../src/deps";
import { drain } from "../src/drain";
import { POLL_GRACE_MS, pollDueMailboxes, pollMailbox } from "../src/poll";
import { raiseAlert } from "../src/alerts";
import { deleteAccount, disconnectNow } from "../src/purge";
import { currentRenderOptions, readRenderGovernor } from "../src/render-plan";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

const MIN = 60_000;

describe.skipIf(!HAS_DB)("kill switches, poll timing and disconnect reporting", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  const setKill = (stage: string, on: boolean) =>
    owner.query("UPDATE app_setting SET value = $2::jsonb WHERE key = $1", [`kill.${stage}`, JSON.stringify(on)]);
  const resetBackfills = async () => {
    await owner.query("UPDATE mailbox SET backfill_state = 'done' WHERE backfill_state IN ('pending', 'running')");
    await owner.query("UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL");
    await owner.query("DELETE FROM usage_ledger WHERE resource = 'backfill.started'");
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    // Other suites' mailboxes must not be due while pollDueMailboxes runs here.
    await owner.query("UPDATE mailbox SET next_poll_at = 'infinity' WHERE status = 'active'");
    await owner.query("UPDATE app_setting SET value = '{\"level\":0,\"actions\":{}}'::jsonb WHERE key = 'governor'");
    await resetBackfills();
  });
  afterEach(async () => {
    for (const s of ["ingest", "render", "backfill"]) await setKill(s, false);
  });
  afterAll(async () => {
    if (owner) {
      for (const s of ["ingest", "render", "backfill"]) await setKill(s, false);
      await resetBackfills();
      await owner.end();
    }
    await pool?.end();
  });

  async function seed(o: { role?: "owner" | "friend"; historyId?: string | null; backfill?: "pending" | "done" } = {}) {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role, last_active_at) VALUES ($1, $2, now())", [userId, o.role ?? "owner"]);
      const r = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, history_id, next_poll_at,
                              backfill_state, backfill_requested_at)
         VALUES ($1, 'gmail', $2, $3, 'active', $4::numeric, now() - interval '1 minute', $5, now() - interval '10 minutes') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`, o.historyId ?? null, o.backfill ?? "done"],
      );
      return r.rows[0]!.id;
    });
    return { userId, mailboxId };
  }

  /** Deps whose Gmail client only answers getProfile, and records every call. */
  function deps(extra: Partial<PipelineDeps> = {}): { deps: PipelineDeps; gmailCalls: string[] } {
    const gmailCalls: string[] = [];
    const client = {
      getProfile: async () => (gmailCalls.push("getProfile"), { historyId: "1000", emailAddress: "x" }),
    };
    return {
      deps: {
        pool,
        tickEvery: 30,
        governorLevel: async () => 0,
        tokens: null,
        gmailFor: () => client,
        ...extra,
      } as unknown as PipelineDeps,
      gmailCalls,
    };
  }

  const nextPollAt = async (mailboxId: string) =>
    (await owner.query<{ t: Date }>("SELECT next_poll_at AS t FROM mailbox WHERE id = $1", [mailboxId])).rows[0]!.t;

  describe("R1-21 kill switches", () => {
    it("kill.ingest: no poll (tick or single mailbox) and no drain", async () => {
      const { userId, mailboxId } = await seed();
      const d = deps();
      await setKill("ingest", true);
      expect(await pollMailbox(d.deps, { mailboxId, userId }, { maxPages: 2, budgetMs: 5_000, source: "sync" })).toEqual({
        kind: "skipped",
        why: "kill_switch",
      });
      expect(await pollDueMailboxes(d.deps, 20_000)).toMatchObject({ polled: 0, errors: 0 });
      expect((await drain(d.deps, { budgetMs: 10_000, maxRows: 10 })).stoppedReason).toBe("kill_switch");
      expect(d.gmailCalls).toEqual([]);

      // Switched back on, the same mailbox polls again.
      await setKill("ingest", false);
      expect((await pollMailbox(d.deps, { mailboxId, userId }, { maxPages: 2, budgetMs: 5_000, source: "sync" })).kind).toBe("polled");
      expect(d.gmailCalls).toEqual(["getProfile"]);
    });

    it("kill.render: no render VM, planned or on-demand, even for the owner at L0", async () => {
      const { userId } = await seed();
      const d = deps();
      const opts = { fillAllowed: true, samplesAllowed: true, aiSamplesAllowed: false, aiRealtimeAllowed: false };
      expect((await readRenderGovernor(d.deps)).actions.rendersOff).not.toBe(true);
      expect(await currentRenderOptions(d.deps, userId, opts)).not.toBeNull();
      await setKill("render", true);
      expect((await readRenderGovernor(d.deps)).actions.rendersOff).toBe(true);
      expect(await currentRenderOptions(d.deps, userId, { ...opts, onDemandOnly: true })).toBeNull();
    });

    it("kill.backfill: a first import stays queued until the switch is lifted", async () => {
      await resetBackfills();
      const { userId, mailboxId } = await seed({ backfill: "pending" });
      const d = deps();
      await setKill("backfill", true);
      expect(await admitBackfill(d.deps, { mailboxId, userId })).toEqual({ kind: "queued", why: "kill_switch" });
      const lease = await owner.query<{ m: string | null }>("SELECT backfill_lease_mailbox AS m FROM system_state");
      expect(lease.rows[0]?.m).toBeNull();
      await setKill("backfill", false);
      expect((await admitBackfill(d.deps, { mailboxId, userId })).kind).toBe("admitted");
      await resetBackfills();
    });
  });

  /** The pool, counting the transactions that read a `kill.*` switch. */
  function countingPool(): { pool: pg.Pool; killReads: () => number } {
    let n = 0;
    const wrapped = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop !== "connect") {
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...a: unknown[]) => unknown;
          const release = client.release.bind(client);
          (client as { query: unknown }).query = (...a: unknown[]) => {
            if (Array.isArray(a[1]) && typeof a[1][0] === "string" && a[1][0].startsWith("kill.")) n++;
            return query(...a);
          };
          (client as { release: unknown }).release = (err?: Error | boolean) => {
            (client as { query: unknown }).query = query;
            (client as { release: unknown }).release = release;
            return release(err);
          };
          return client;
        };
      },
    });
    return { pool: wrapped, killReads: () => n };
  }

  it("R1-21: the tick's poll reads kill.ingest once, not again for every mailbox it polls", async () => {
    await seed();
    await seed();
    await seed();
    const c = countingPool();
    const d = deps({ pool: c.pool });
    const res = await pollDueMailboxes(d.deps, 30_000);
    expect(res.polled).toBeGreaterThanOrEqual(3);
    expect(c.killReads()).toBe(1);
  });

  describe("R1-24 next poll time", () => {
    it("is timed from the tick's listing, less the grace, not from the mailbox's own poll start", async () => {
      const { userId, mailboxId } = await seed();
      const listedAt = new Date(Date.now() - 40_000); // the tick listed it 40 s before this mailbox's turn
      const d = deps();
      const r = await pollMailbox(d.deps, { mailboxId, userId }, { maxPages: 2, budgetMs: 5_000, source: "sync", anchor: listedAt });
      expect(r.kind).toBe("polled");
      const next = await nextPollAt(mailboxId);
      expect(next.getTime()).toBe(listedAt.getTime() + 30 * MIN - POLL_GRACE_MS);
      // The next :30 tick lists 30 min after this one, even if it starts up 60 s faster: due.
      expect(next.getTime()).toBeLessThanOrEqual(listedAt.getTime() + 30 * MIN - 60_000);
    });

    it("the tick's poll passes its listing time, so every mailbox it polls is due on the next tick", async () => {
      const a = await seed();
      const b = await seed();
      const before = Date.now();
      const d = deps();
      const res = await pollDueMailboxes(d.deps, 30_000);
      expect(res.polled).toBeGreaterThanOrEqual(2);
      for (const m of [a, b]) {
        const next = (await nextPollAt(m.mailboxId)).getTime();
        // Relative to the listing (taken at or after `before`), less the grace.
        expect(next).toBeGreaterThanOrEqual(before + 30 * MIN - POLL_GRACE_MS);
        expect(next).toBeLessThanOrEqual(Date.now() + 30 * MIN - POLL_GRACE_MS);
      }
    });

    it("without an anchor (sync-on-open) it is timed from the poll itself, less the grace", async () => {
      const { userId, mailboxId } = await seed();
      const now = new Date(Date.now() - 1_000);
      const d = deps({ now: () => now });
      await pollMailbox(d.deps, { mailboxId, userId }, { maxPages: 2, budgetMs: 5_000, source: "sync" });
      expect((await nextPollAt(mailboxId)).getTime()).toBe(now.getTime() + 30 * MIN - POLL_GRACE_MS);
    });
  });

  describe("R1-25 disconnect reports a failed revoke", () => {
    const withRevoke = (revokeGrant: () => Promise<unknown>) =>
      ({ pool, tokens: { revokeGrant }, log: () => {} }) as unknown as PipelineDeps;

    it.each([
      ["Google/network error", async () => Promise.reject(new Error("gmail 503")), { revoked: false, revokeFailed: true }],
      ["revoke refused (not invalid_token)", async () => ({ revoked: false, alreadyInvalid: false, reason: null }), { revoked: false, revokeFailed: true }],
      ["revoked", async () => ({ revoked: true, alreadyInvalid: false, reason: null }), { revoked: true, revokeFailed: false }],
      ["already invalid at Google", async () => ({ revoked: true, alreadyInvalid: true, reason: null }), { revoked: true, revokeFailed: false }],
      ["no stored tokens (no grant held)", async () => ({ revoked: false, alreadyInvalid: false, reason: "no_tokens" }), { revoked: false, revokeFailed: false }],
    ])("%s", async (_name, revokeGrant, expected) => {
      const { userId, mailboxId } = await seed();
      const r = await disconnectNow(withRevoke(revokeGrant), { userId, mailboxId });
      expect(r).toMatchObject(expected);
      // The disconnect itself always goes ahead (FREE-TIER.md §4.9).
      const row = await owner.query<{ status: string }>("SELECT status FROM mailbox WHERE id = $1", [mailboxId]);
      expect(row.rows[0]?.status).toBe("disconnecting");
    });
  });

  describe("R1-25 account deletion reports a failed revoke", () => {
    const withRevoke = (revokeGrant: () => Promise<unknown>) =>
      ({ pool, tokens: { revokeGrant }, log: () => {} }) as unknown as PipelineDeps;
    const gone = async (userId: string) => (await owner.query(`SELECT 1 FROM "user" WHERE id = $1`, [userId])).rowCount === 0;

    it("any mailbox whose revoke failed → revokeFailed; the account is deleted either way", async () => {
      const a = await seed();
      expect(await deleteAccount(withRevoke(async () => Promise.reject(new Error("gmail 503"))), a.userId)).toEqual({ revokeFailed: true });
      expect(await gone(a.userId)).toBe(true);
      const b = await seed();
      expect(await deleteAccount(withRevoke(async () => ({ revoked: true, alreadyInvalid: false, reason: null })), b.userId)).toEqual({
        revokeFailed: false,
      });
      expect(await gone(b.userId)).toBe(true);
    });
  });

  describe("R1-22 raiseAlert gives its send mark back when GitHub fails", () => {
    const cfg = (status: number, calls: string[]) => ({
      token: "t",
      repo: "o/r",
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ items: [] }), { status: url.includes("/search/") ? 200 : status });
      }) as unknown as typeof fetch,
    });
    const sent = async () =>
      (await owner.query<{ value: Record<string, string> }>("SELECT value FROM app_setting WHERE key = 'alerts.sent'")).rows[0]!.value;
    let saved: unknown;
    beforeAll(async () => {
      saved = await sent();
    });
    afterAll(async () => {
      await owner.query("UPDATE app_setting SET value = $1::jsonb WHERE key = 'alerts.sent'", [JSON.stringify(saved ?? {})]);
    });

    it("a failed send is retried by the next raise; a delivered one waits out the 6 h window", async () => {
      await owner.query(`UPDATE app_setting SET value = '{}'::jsonb WHERE key = 'alerts.sent'`);
      const calls: string[] = [];
      expect(await raiseAlert(pool, cfg(502, calls), "SIGNIN_BREAKER", { wakes: 11 })).toBe(false);
      expect((await sent()).SIGNIN_BREAKER).toBeUndefined();
      expect(await raiseAlert(pool, cfg(201, calls), "SIGNIN_BREAKER", { wakes: 12 })).toBe(true);
      expect((await sent()).SIGNIN_BREAKER).toBeTruthy();
      const before = calls.length;
      expect(await raiseAlert(pool, cfg(201, calls), "SIGNIN_BREAKER", { wakes: 13 })).toBe(false);
      expect(calls.length).toBe(before);
    });

    it("a failed re-notification restores the previous send time (a network error too)", async () => {
      const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
      await owner.query("UPDATE app_setting SET value = $1::jsonb WHERE key = 'alerts.sent'", [JSON.stringify({ EXECUTION_TRIPWIRE: old })]);
      const broken = { token: "t", repo: "o/r", fetchImpl: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch };
      expect(await raiseAlert(pool, broken, "EXECUTION_TRIPWIRE")).toBe(false);
      expect((await sent()).EXECUTION_TRIPWIRE).toBe(old);
    });
  });
});
