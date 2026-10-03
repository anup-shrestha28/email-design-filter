/**
 * First import (FREE-TIER.md §4.5; DESIGN.md §5.4): admission (one backfill at a time, ≤ 5 new per
 * rolling 30 days, queued FIFO, paused under governor L1+, only while the projected Vercel CPU fits,
 * 180 days only with ≤ 5 users), newest-first time slices with the Q1/Q2
 * listings (5 units per page) writing ledger rows only — the drain does the fetching, paced by the
 * quota bucket — then, once the drain has stored the import (and so created its senders), the
 * new-sender check.
 */
import { calibrationFactor, FREE_TIER_PROFILE, RESOURCES, resourceSpec } from "@edf/budget";
import { isDatabaseUnavailable, withSystem, withUser } from "@edf/db";
import {
  FLOOR_BACKGROUND,
  UNITS,
  backfillQueryQ1,
  backfillQueryQ2,
  backfillSlices,
  quoteAddressForQuery,
  reserveQuota,
  type TimeSlice,
} from "@edf/gmail";
import { gmailClient, killSwitchOn, logOf, mailboxTag, nowOf, type PipelineDeps } from "./deps";
import { readStorageGate } from "./drain";
import { errorCode } from "./poll";

export const BACKFILLS_PER_30_DAYS = 5;
const LEASE_MINUTES = 30;

/** "180 only at L0 with ≤ 5 users" (FREE-TIER.md §4.5): above this many active users the owner gets 90. */
export const LONG_BACKFILL_MAX_USERS = 5;
/** FREE-TIER.md §7: a 90-day import is about 5,240 fetches, each an automated-email ingest at 0.10 CPU-s. */
export const BACKFILL_FETCHES_PER_DAY = 5_240 / 90;
export const BACKFILL_CPU_S_PER_FETCH = 0.1;
/** §4.5: projected Vercel CPU plus this reserve must stay under BACKFILL_CPU_CAP_SHARE of the self-cap. */
export const BACKFILL_CPU_RESERVE_S = 500;
export const BACKFILL_CPU_CAP_SHARE = 0.75;

/** The window an import actually gets: friends 30 days; the owner's choice, but 180 only with ≤ 5 active users. */
export function backfillWindowFor(role: string, requested: number, activeUsers: number): number {
  if (role !== "owner") return 30;
  return requested > 90 && activeUsers > LONG_BACKFILL_MAX_USERS ? 90 : requested;
}

/** Estimated Vercel CPU-s one import of `windowDays` costs (§7 per-unit estimates). */
export function projectedBackfillCpuS(windowDays: number): number {
  return windowDays * BACKFILL_FETCHES_PER_DAY * BACKFILL_CPU_S_PER_FETCH;
}

/**
 * §4.5: a backfill starts only if the calibrated rolling-30-day Vercel CPU, plus the import's
 * projected cost, plus a 500 CPU-s reserve stays under 75% of the self-cap.
 */
export function backfillCpuFits(usedCpuS: number, windowDays: number): boolean {
  const selfCap = resourceSpec(FREE_TIER_PROFILE, RESOURCES.vercelCpuS)?.selfCap ?? 0;
  return usedCpuS + projectedBackfillCpuS(windowDays) + BACKFILL_CPU_RESERVE_S < BACKFILL_CPU_CAP_SHARE * selfCap;
}

export type AdmitResult =
  | { kind: "admitted"; windowDays: number; slices: TimeSlice[] }
  | { kind: "queued"; why: "another_running" | "monthly_limit" | "governor" | "kill_switch" | "cpu_budget" }
  | { kind: "not_found" };

/** Try to start this mailbox's backfill now; otherwise it stays queued (backfill_state = 'pending'). */
export async function admitBackfill(deps: PipelineDeps, mb: { mailboxId: string; userId: string }): Promise<AdmitResult> {
  const now = nowOf(deps);
  const level = await deps.governorLevel();
  const settings = await withUser(deps.pool, mb.userId, async (_db, c) => {
    await c.query(
      `UPDATE mailbox SET backfill_requested_at = coalesce(backfill_requested_at, now()) WHERE id = $1 AND backfill_state = 'pending'`,
      [mb.mailboxId],
    );
    const r = await c.query<{ window: number; role: string; state: string; status: string; resumed: boolean }>(
      `SELECT us.backfill_window_days AS window, us.role, m.backfill_state AS state, m.status,
              (m.backfill_progress ? 'admittedAt') AS resumed
       FROM mailbox m JOIN user_settings us ON us.user_id = m.user_id WHERE m.id = $1`,
      [mb.mailboxId],
    );
    return r.rows[0] ?? null;
  });
  if (!settings || settings.status !== "active") return { kind: "not_found" };
  if (level >= 1) return { kind: "queued", why: "governor" };
  // Neon storage ≥ 350 MB pauses ingest (FREE-TIER.md §8.3): no new import fills the ledger meanwhile.
  if ((await readStorageGate(deps)).ingestPaused) return { kind: "queued", why: "governor" };
  // The owner's emergency stop (`kill.backfill`): the import waits in the queue until it is lifted.
  if (await killSwitchOn(deps.pool, "backfill")) return { kind: "queued", why: "kill_switch" };

  return withSystem(deps.pool, async (_db, c) => {
    const lease = await c.query<{ m: string | null; until: Date | null }>(
      "SELECT backfill_lease_mailbox AS m, backfill_lease_until AS until FROM system_state FOR UPDATE",
    );
    const cur = lease.rows[0];
    const live = !!(cur?.m && cur.until && cur.until > now);
    if (live && cur?.m !== mb.mailboxId) return { kind: "queued", why: "another_running" } as const;
    // FIFO: only the head of the queue may start — unless this mailbox still holds the lease (e.g.
    // reconnected before the tick released it): it already owns the one-backfill slot, and making it
    // wait behind the queue would just stall everyone until the lease expired.
    if (!live) {
      const head = await c.query<{ mailbox_id: string }>("SELECT mailbox_id FROM list_backfill_queue(1)");
      if (head.rows[0] && head.rows[0].mailbox_id !== mb.mailboxId) return { kind: "queued", why: "another_running" } as const;
    }
    const started = await c.query<{ n: string | null }>(
      "SELECT sum(amount) AS n FROM usage_ledger WHERE resource = 'backfill.started' AND day > current_date - 30",
    );
    // A restarted or resumed import (crash, stranded, reconnect) was already counted when first
    // admitted: it is not a new backfill, so neither the limit nor the counter applies to it.
    const counted = cur?.m === mb.mailboxId || settings.resumed;
    if (!counted && Number(started.rows[0]?.n ?? 0) >= BACKFILLS_PER_30_DAYS) {
      return { kind: "queued", why: "monthly_limit" } as const;
    }
    // Friends get 30 days; the owner's 180 only at L0 (checked above) with ≤ 5 active users.
    const users = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM list_active_users() WHERE mailboxes > 0");
    const windowDays = backfillWindowFor(settings.role, settings.window, Number(users.rows[0]?.n ?? 0));
    // Projected Vercel CPU (§4.5): rolling 30 days of metered CPU × the calibration factor, as the governor counts it.
    const cpu = await c.query<{ n: string | null; cal: unknown }>(
      `SELECT (SELECT sum(amount) FROM usage_ledger WHERE resource = $1 AND day > current_date - 30) AS n,
              (SELECT value FROM app_setting WHERE key = 'calibration') AS cal`,
      [RESOURCES.vercelCpuS],
    );
    const cal = cpu.rows[0]?.cal;
    const factor = calibrationFactor(
      FREE_TIER_PROFILE,
      cal && typeof cal === "object" ? (cal as Record<string, number>) : {},
      resourceSpec(FREE_TIER_PROFILE, RESOURCES.vercelCpuS)?.calibrationKey ?? null,
    );
    if (!backfillCpuFits(Number(cpu.rows[0]?.n ?? 0) * factor, windowDays)) {
      return { kind: "queued", why: "cpu_budget" } as const;
    }
    await c.query(
      `UPDATE system_state SET backfill_lease_mailbox = $1, backfill_lease_until = now() + make_interval(mins => $2), updated_at = now()`,
      [mb.mailboxId, LEASE_MINUTES],
    );
    if (!counted) await c.query("SELECT add_usage(current_date, 'backfill.started', 1)");
    return { kind: "admitted", windowDays, slices: backfillSlices(windowDays, now) } as const;
  }).then(async (r) => {
    if (r.kind === "admitted") {
      await withUser(deps.pool, mb.userId, (_db, c) =>
        c.query(
          `UPDATE mailbox SET backfill_state = 'running',
                  backfill_progress = jsonb_build_object('windowDays', $2::int, 'listed', 0, 'slice', 0,
                    'admittedAt', coalesce(backfill_progress->'admittedAt', to_jsonb(now()))),
                  updated_at = now() WHERE id = $1`,
          [mb.mailboxId, r.windowDays],
        ),
      );
    }
    return r;
  });
}

export interface ListPageResult {
  nextPageToken: string | null;
  listed: number;
  inserted: number;
}

/** One listing page for one slice and query (Q1 → full fetch; Q2 → metadata first). */
export async function backfillListPage(
  deps: PipelineDeps,
  mb: { mailboxId: string; userId: string },
  p: { slice: Pick<TimeSlice, "after" | "before">; query: "q1" | "q2"; pageToken: string | null; sliceIndex: number },
): Promise<ListPageResult | { waitMs: number }> {
  const q = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.mailboxId, units: UNITS.messagesList, floor: FLOOR_BACKGROUND }));
  if (!q.ok) return { waitMs: q.waitMs };
  const client = gmailClient(deps, mb.userId, mb.mailboxId);
  const page = await client.messagesList({
    q: p.query === "q1" ? backfillQueryQ1(p.slice) : backfillQueryQ2(p.slice),
    pageToken: p.pageToken ?? undefined,
    maxResults: 500,
  });
  const ids = (page.messages ?? []).map((m) => m.id);
  const inserted = await withUser(deps.pool, mb.userId, async (_db, c) => {
    const r = ids.length
      ? await c.query(
          `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source)
           SELECT $1, $2, x, $3, 'backfill' FROM unnest($4::text[]) x
           ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING`,
          [mb.mailboxId, mb.userId, p.query === "q1" ? "pending_full" : "pending", ids],
        )
      : { rowCount: 0 };
    await c.query(
      `UPDATE mailbox SET backfill_progress = backfill_progress
         || jsonb_build_object('listed', coalesce((backfill_progress->>'listed')::int, 0) + $2::int, 'slice', $3::int),
         updated_at = now() WHERE id = $1`,
      [mb.mailboxId, ids.length, p.sliceIndex],
    );
    await withSystemLeaseRenew(c, mb.mailboxId);
    return r.rowCount ?? 0;
  });
  return { nextPageToken: page.nextPageToken ?? null, listed: ids.length, inserted };
}

async function withSystemLeaseRenew(c: { query: (q: string, v?: unknown[]) => Promise<unknown> }, mailboxId: string): Promise<void> {
  await c.query(
    `UPDATE system_state SET backfill_lease_until = now() + make_interval(mins => ${LEASE_MINUTES}), updated_at = now()
     WHERE backfill_lease_mailbox = $1`,
    [mailboxId],
  );
}

/**
 * Listing finished: mark done (the drain keeps fetching; the lease is released once rows are drained).
 * `newSendersBefore` (the window start, epoch seconds; by default now − windowDays) marks the
 * new-sender check as due: `runNewSenderChecks` runs it once no backfill row is pending.
 */
export async function finishBackfillListing(
  deps: PipelineDeps,
  mb: { mailboxId: string; userId: string },
  windowStartEpoch?: number,
): Promise<void> {
  await withUser(deps.pool, mb.userId, (_db, c) =>
    // Dropping the admission mark means any later import of this mailbox counts as a new one.
    // 'pending' while this mailbox still holds the lease: a reconnect during this listing (e.g. its
    // quota sleep) put it back in the queue, and the resume event was skipped because this run was
    // still alive. The listing is complete, so it is done; otherwise it would sit 'pending' with its
    // rows undrained until the lease expired and then be listed all over again.
    c.query(
      `UPDATE mailbox SET backfill_state = 'done',
              backfill_progress = (backfill_progress - 'admittedAt') || jsonb_build_object('newSendersBefore',
                coalesce($2::bigint, floor(extract(epoch FROM now()))::bigint
                  - coalesce((backfill_progress->>'windowDays')::int, 90) * 86400)),
              updated_at = now()
       WHERE id = $1 AND (backfill_state = 'running'
         OR (backfill_state = 'pending' AND EXISTS (SELECT 1 FROM system_state WHERE backfill_lease_mailbox = $1)))`,
      [mb.mailboxId, windowStartEpoch === undefined ? null : Math.floor(windowStartEpoch)],
    ),
  );
  logOf(deps)("backfill.listed", { mailbox: mailboxTag(mb.mailboxId) });
}

/**
 * Called by the tick: release the backfill lease when the leased mailbox has no pending backfill rows
 * left (or its lease expired, or it stopped being active); returns the next queued mailbox to start,
 * if any (a crashed or stranded listing is restarted first).
 */
export async function releaseFinishedBackfill(deps: PipelineDeps): Promise<{ mailboxId: string; userId: string } | null> {
  type Mb = { mailboxId: string; userId: string };
  const decision = await withSystem(deps.pool, async (_db, c) => {
    const s = await c.query<{ m: string | null; until: Date | null }>(
      "SELECT backfill_lease_mailbox AS m, backfill_lease_until AS until FROM system_state FOR UPDATE",
    );
    const cur = s.rows[0];
    let requeue: Mb | null = null;
    if (cur?.m) {
      // The leased mailbox whatever its status, with ALL its pending backfill rows (also those in
      // retry backoff or behind new mail, which list_drain_batch leaves out).
      const q = await c.query<{ user_id: string; status: string; backfill_state: string; pending_rows: string }>(
        "SELECT user_id, status, backfill_state, pending_rows FROM backfill_lease_state($1)",
        [cur.m],
      );
      const leased = q.rows[0];
      const expired = !cur.until || cur.until < new Date();
      if (leased?.status === "active" && !expired) {
        // Still listing (or admitted a moment ago and not yet marked running), or rows still draining.
        if (leased.backfill_state === "running" || leased.backfill_state === "pending") return { next: null, restart: null, requeue: null };
        if (Number(leased.pending_rows) > 0) return { next: null, restart: null, requeue: null };
      }
      // Finished, gone, inactive, or crashed (lease expired while still "running"): release the lease.
      await c.query("UPDATE system_state SET backfill_lease_mailbox = NULL, backfill_lease_until = NULL, updated_at = now()");
      if (leased?.backfill_state === "running") {
        const mb = { mailboxId: cur.m, userId: leased.user_id };
        // Crashed listing: restart it now. Interrupted by needs_reauth/paused/…: back to the queue
        // ('pending'), so once reconnected it is admitted again instead of blocking the FIFO as 'running'.
        if (leased.status === "active") return { next: null, restart: mb, requeue: null };
        requeue = mb;
      }
    }
    const next = await c.query<{ mailbox_id: string; user_id: string; backfill_state: string }>("SELECT * FROM list_backfill_queue(1)");
    const n = next.rows[0];
    if (!n) return { next: null, restart: null, requeue };
    const head = { mailboxId: n.mailbox_id, userId: n.user_id };
    // No lease is held now, so a 'running' head is stranded (its listing ended without the lease,
    // e.g. reconnected after an interrupted import): restart it rather than wait on it forever.
    if (n.backfill_state === "running") return { next: null, restart: head, requeue };
    return { next: n.backfill_state === "pending" ? head : null, restart: null, requeue };
  });
  if (decision.requeue) {
    const r = decision.requeue;
    await backToQueue(deps, r);
    logOf(deps)("backfill.requeued", { mailbox: mailboxTag(r.mailboxId) });
  }
  if (decision.restart) {
    // A crashed listing restarts from scratch; ledger inserts are idempotent, so nothing is duplicated.
    const r = decision.restart;
    await backToQueue(deps, r);
    logOf(deps)("backfill.restart", { mailbox: mailboxTag(r.mailboxId) });
    return r;
  }
  return decision.next;
}

/**
 * A 'running' mailbox whose listing ended goes back to 'pending'. It runs after the lease-release
 * transaction (mailbox rows need the user's RLS context), so it must not undo a re-admission that
 * slipped in between: it does nothing while this mailbox holds the lease again. 'running' proves the
 * import was admitted, so the admission mark is kept (or added, for imports admitted before the mark
 * existed) and the resumed import is not counted again.
 */
async function backToQueue(deps: PipelineDeps, mb: { mailboxId: string; userId: string }): Promise<void> {
  await withUser(deps.pool, mb.userId, (_db, c) =>
    c.query(
      `UPDATE mailbox SET backfill_state = 'pending',
              backfill_progress = backfill_progress
                || jsonb_build_object('admittedAt', coalesce(backfill_progress->'admittedAt', to_jsonb(now()))),
              updated_at = now()
       WHERE id = $1 AND backfill_state = 'running'
         AND NOT EXISTS (SELECT 1 FROM system_state WHERE backfill_lease_mailbox = $1)`,
      [mb.mailboxId],
    ),
  );
}

/** "New senders" covers senders first seen in the last 14 days (apps/web queries). */
export const NEW_SENDER_DAYS = 14;
const SENDER_PAGE = 100;

export interface NewSenderCheckResult {
  checked: number;
  /** Every candidate was looked at (the check is complete for this import). */
  done: boolean;
  stopped: "quota" | "deadline" | null;
}

/**
 * New-sender check (DESIGN.md §5.4 step 4): for every sender that "New senders" would list (first
 * seen in the last 14 days, `seen_before_window` not yet known), one 5-unit
 * `from:<addr> before:<window_start>` listing sets `seen_before_window`. Pages through all
 * candidates; stops (not done) when the quota bucket refuses or the deadline passes, and the next
 * run resumes with the senders still unknown. Addresses that can't be quoted safely stay unknown.
 */
export async function checkNewSenders(
  deps: PipelineDeps,
  mb: { mailboxId: string; userId: string },
  windowStartEpoch: number,
  opts: { deadline?: number } = {},
): Promise<NewSenderCheckResult> {
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const client = gmailClient(deps, mb.userId, mb.mailboxId);
  let checked = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const senders = await withUser(deps.pool, mb.userId, async (_db, c) =>
      (await c.query<{ id: string; address: string }>(
        `SELECT id, address::text AS address FROM sender
         WHERE user_id = $1 AND seen_before_window IS NULL
           AND first_seen_at > now() - make_interval(days => $2) AND id > $3::uuid
         ORDER BY id LIMIT $4`,
        [mb.userId, NEW_SENDER_DAYS, after, SENDER_PAGE],
      )).rows,
    );
    if (senders.length === 0) return { checked, done: true, stopped: null };
    for (const s of senders) {
      if (Date.now() > deadline) return { checked, done: false, stopped: "deadline" };
      after = s.id;
      let quoted: string;
      try {
        quoted = quoteAddressForQuery(s.address);
      } catch {
        continue;
      }
      const q = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.mailboxId, units: UNITS.messagesList, floor: FLOOR_BACKGROUND }));
      if (!q.ok) return { checked, done: false, stopped: "quota" };
      const page = await client.messagesList({ q: `from:${quoted} before:${windowStartEpoch}`, maxResults: 1 });
      await withUser(deps.pool, mb.userId, (_db, c) =>
        c.query("UPDATE sender SET seen_before_window = $2, updated_at = now() WHERE id = $1", [s.id, (page.messages?.length ?? 0) > 0]),
      );
      checked++;
    }
  }
}

/** Mailboxes whose import has drained and whose new-sender check is still due. */
export async function listNewSenderChecks(
  deps: PipelineDeps,
  limit = 10,
): Promise<Array<{ mailboxId: string; userId: string; windowStartEpoch: number }>> {
  const rows = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ mailbox_id: string; user_id: string; before_epoch: string }>("SELECT * FROM list_new_sender_checks($1)", [limit])).rows,
  );
  return rows.map((r) => ({ mailboxId: r.mailbox_id, userId: r.user_id, windowStartEpoch: Number(r.before_epoch) }));
}

/**
 * The tick's new-sender step: runs the check for every drained import within the budget and
 * clears the mark of each one that completed (an interrupted one resumes on a later tick).
 */
export async function runNewSenderChecks(
  deps: PipelineDeps,
  budgetMs = 45_000,
): Promise<{ mailboxes: number; checked: number; completed: number; failed: number }> {
  const deadline = Date.now() + budgetMs;
  const out = { mailboxes: 0, checked: 0, completed: 0, failed: 0 };
  for (const mb of await listNewSenderChecks(deps)) {
    if (Date.now() > deadline) break;
    out.mailboxes++;
    let r: Awaited<ReturnType<typeof checkNewSenders>>;
    try {
      r = await checkNewSenders(deps, mb, mb.windowStartEpoch, { deadline });
    } catch (err) {
      // One mailbox's Gmail error must not hold back the others (it stays due and is retried).
      if (isDatabaseUnavailable(err)) throw err;
      out.failed++;
      logOf(deps)("backfill.new_senders_error", { mailbox: mailboxTag(mb.mailboxId), code: errorCode(err) });
      continue;
    }
    out.checked += r.checked;
    if (!r.done) continue;
    await withUser(deps.pool, mb.userId, (_db, c) =>
      c.query(
        `UPDATE mailbox SET backfill_progress = backfill_progress - 'newSendersBefore', updated_at = now()
         WHERE id = $1 AND backfill_state = 'done' AND backfill_progress->>'newSendersBefore' = $2`,
        [mb.mailboxId, String(mb.windowStartEpoch)],
      ),
    );
    out.completed++;
    logOf(deps)("backfill.new_senders", { mailbox: mailboxTag(mb.mailboxId), checked: r.checked });
  }
  return out;
}
