/**
 * Polling Gmail history (FREE-TIER.md §4.2 step "poll", §4.3, §4.4): lease → cached token →
 * history.list pages (2 units each) → one transaction applying ledger/labels/deletes + cursor CAS
 * → next_poll_at. History 404 → resync with a gap window and deletion reconciliation (step 9).
 */
import { withSystem, withUser, isDatabaseUnavailable } from "@edf/db";
import {
  FLOOR_BACKGROUND,
  UNITS,
  backfillQueryQ1,
  backfillQueryQ2,
  gapWindow,
  isGmailError,
  nextPollDelay,
  pollHistory,
  reserveQuota,
  stormSlice,
  windowQuery,
  type GmailClient,
  type HistoryDelta,
} from "@edf/gmail";
import { gmailClient, killSwitchOn, logOf, mailboxTag, nowOf, type GovernorLevel, type PipelineDeps } from "./deps";
import { applyPollDelta, takeSyncLease, releaseSyncLease, type PollDelta } from "./store/sync";
import { applyLabelDelta, labelColumns } from "./store/record";

export interface PollOptions {
  maxPages: number;
  /** Time budget for paging (the step budget is 60 s; sync-on-open ≈ 2 pages). */
  budgetMs: number;
  source: "sync" | "resync" | "reconcile";
  /**
   * When the tick listed this mailbox as due (`pollDueMailboxes`): the next poll is timed from it,
   * not from when this mailbox's own poll started (see POLL_GRACE_MS). Absent → the poll's start.
   */
  anchor?: Date;
  /** The caller already checked `kill.ingest` for this run (`pollDueMailboxes`), so skip the re-read. */
  ingestChecked?: boolean;
}

/**
 * Slack taken off every next poll time (FREE-TIER.md §4.3). `list_mailboxes_due_for_poll` wants
 * `next_poll_at <= now()` with no tolerance, and each tick lists after a variable start-up
 * (cron dispatch, cold start, governor, Sandbox sweep). Timed from exactly 30 min after this
 * tick's listing, a mailbox is still a few seconds short of due when the next tick lists it
 * whenever that tick started up a little faster, and so waits a full hour.
 */
export const POLL_GRACE_MS = 2 * 60_000;

/** When a mailbox polled now becomes due again: `delayMs` after the anchor, less POLL_GRACE_MS. */
export function nextPollTime(anchor: Date, delayMs: number): Date {
  return new Date(anchor.getTime() + Math.max(0, delayMs - POLL_GRACE_MS));
}

export type PollOutcome =
  | { kind: "polled"; inserted: number; deleted: number; complete: boolean }
  | { kind: "resync"; listed: number; reconciledDeletes: number }
  | { kind: "leased" }
  | { kind: "skipped"; why: string };

/** Map merged history records onto the store's delta shape (FREE-TIER.md §4.2 steps 4–6). */
export function toPollDelta(records: readonly HistoryDelta[], newCursor: string, complete: boolean): PollDelta {
  const delta: PollDelta = { added: [], deleted: [], labelChanges: [], newCursor, incomplete: !complete };
  for (const r of records) {
    switch (r.action) {
      case "delete":
        delta.deleted.push(r.messageId);
        break;
      case "insert":
        delta.added.push({ id: r.messageId, labelIds: r.labelIds ?? [] });
        // A re-read `messagesAdded` (multi-page polls, gmail DECISIONS G2; or mail a listing already
        // stored) merges the later label changes into this record. For an email that is already
        // stored the ledger insert is a no-op, so the changes are applied here too, race-safely
        // (a new message just gets a stash the fetch will supersede).
        pushLabels(delta, r, r.labelsRemoved);
        break;
      case "skip":
        // Spam keeps a skipped row (so "not spam" can rescue it); drafts/sent/chat are dropped.
        if (r.skipReason === "spam") {
          delta.added.push({ id: r.messageId, labelIds: ["SPAM"] });
          pushLabels(delta, r, r.labelsRemoved); // e.g. a stored email marked as spam: hide it
        }
        break;
      case "labels": {
        const remove = r.refetch && !r.labelsRemoved.includes("SPAM") ? [...r.labelsRemoved, "SPAM"] : r.labelsRemoved;
        pushLabels(delta, r, remove);
        break;
      }
    }
  }
  return delta;
}

function pushLabels(delta: PollDelta, r: HistoryDelta, remove: string[]): void {
  if (r.labelsAdded.length || remove.length) {
    delta.labelChanges.push({ id: r.messageId, add: r.labelsAdded, remove, historyId: r.historyId });
  }
}

interface MailboxState {
  historyId: string | null;
  lastSyncedAt: Date | null;
  lastActiveAt: Date | null;
  windowDays: number;
  status: string;
}

async function readState(deps: PipelineDeps, userId: string, mailboxId: string): Promise<MailboxState | null> {
  return withUser(deps.pool, userId, async (_db, c) => {
    const r = await c.query<{
      history_id: string | null;
      last_synced_at: Date | null;
      last_active_at: Date | null;
      backfill_window_days: number | null;
      status: string;
    }>(
      `SELECT m.history_id::text AS history_id, m.last_synced_at, us.last_active_at, us.backfill_window_days, m.status
       FROM mailbox m LEFT JOIN user_settings us ON us.user_id = m.user_id WHERE m.id = $1`,
      [mailboxId],
    );
    const row = r.rows[0];
    return row
      ? {
          historyId: row.history_id,
          lastSyncedAt: row.last_synced_at,
          lastActiveAt: row.last_active_at,
          windowDays: row.backfill_window_days ?? 90,
          status: row.status,
        }
      : null;
  });
}

export async function pollMailbox(
  deps: PipelineDeps,
  mb: { mailboxId: string; userId: string },
  opts: PollOptions,
): Promise<PollOutcome> {
  const log = logOf(deps);
  const now = nowOf(deps);
  if (!opts.ingestChecked && (await killSwitchOn(deps.pool, "ingest"))) return { kind: "skipped", why: "kill_switch" };
  const leased = await withUser(deps.pool, mb.userId, (_db, c) => takeSyncLease(c, mb.mailboxId));
  if (!leased) return { kind: "leased" };
  try {
    const state = await readState(deps, mb.userId, mb.mailboxId);
    if (!state || state.status !== "active") return { kind: "skipped", why: "inactive" };
    const client = gmailClient(deps, mb.userId, mb.mailboxId);
    const level: GovernorLevel = await deps.governorLevel();
    const delay = nextPollDelay({ lastActiveAt: state.lastActiveAt, now, tickEvery: deps.tickEvery, governorLevel: level });
    const nextPollAt = nextPollTime(opts.anchor && opts.anchor < now ? opts.anchor : now, delay);

    if (!state.historyId) {
      // No cursor (should only happen right after connect): take one from getProfile.
      const q = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.mailboxId, units: UNITS.getProfile, floor: FLOOR_BACKGROUND }));
      if (!q.ok) return { kind: "skipped", why: "quota" };
      const profile = await client.getProfile();
      await withUser(deps.pool, mb.userId, (_db, c) =>
        applyPollDelta(c, { userId: mb.userId, mailboxId: mb.mailboxId, source: opts.source, nextPollAt }, {
          added: [], deleted: [], labelChanges: [], newCursor: profile.historyId, incomplete: false,
        }),
      );
      return { kind: "polled", inserted: 0, deleted: 0, complete: true };
    }

    const units = UNITS.historyList * Math.max(1, opts.maxPages);
    const q = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.mailboxId, units, floor: FLOOR_BACKGROUND }));
    if (!q.ok) return { kind: "skipped", why: "quota" };

    let result;
    try {
      result = await pollHistory(client, {
        startHistoryId: state.historyId,
        maxPages: opts.maxPages,
        deadlineMs: Date.now() + opts.budgetMs,
      });
    } catch (err) {
      if (isGmailError(err, "history_expired")) return await resync(deps, mb, state, nextPollAt);
      throw err;
    }
    const delta = toPollDelta(result.records, result.newCursor, result.complete);
    if (isImportStorm(result)) {
      // A bulk import of old mail: list only mail received since the last sync instead of queueing
      // every added id. Deletes and label changes still apply.
      const listed = await stormListing(deps, mb, client, state.lastSyncedAt ?? now);
      if (!listed) return { kind: "skipped", why: "quota" }; // cursor unchanged: retried next tick
      delta.added = [];
      delta.listed = listed;
      log("poll.storm", { mailbox: mailboxTag(mb.mailboxId), added: result.addedCount, listed: listed.full.length + listed.metadata.length });
    }
    const applied = await withUser(deps.pool, mb.userId, (_db, c) =>
      applyPollDelta(c, { userId: mb.userId, mailboxId: mb.mailboxId, source: opts.source, nextPollAt }, delta),
    );
    log("poll.done", {
      mailbox: mailboxTag(mb.mailboxId),
      pages: result.pages,
      inserted: applied.inserted,
      deleted: applied.deleted,
      labels: applied.labelUpdates,
      complete: result.complete,
    });
    return { kind: "polled", inserted: applied.inserted, deleted: applied.deleted, complete: result.complete };
  } finally {
    await withUser(deps.pool, mb.userId, (_db, c) => releaseSyncLease(c, mb.mailboxId)).catch(() => {});
  }
}

/**
 * messagesAdded that make a poll which could not finish (more history pages remain) an import
 * storm. The app-open sync reads ≤ 2 pages (≤ 1,000 records) and a budget-cut tick poll stops
 * early, so neither would ever see IMPORT_STORM_THRESHOLD (2,000) added in one call — and during a
 * storm incomplete polls never refresh `last_synced_at`, so every app open would queue another
 * ~1,000 imported ids. A false positive costs only a few listing pages: the windowed listing still
 * picks up every genuinely new message.
 */
export const STORM_PARTIAL_THRESHOLD = 500;

/** FREE-TIER.md §4.2 step 7: > 2,000 added in one poll, or > 500 in a poll that could not finish. */
export function isImportStorm(r: { importStorm: boolean; complete: boolean; addedCount: number }): boolean {
  return r.importStorm || (!r.complete && r.addedCount > STORM_PARTIAL_THRESHOLD);
}

/** Labels whose state a resync reconciles from windowed id listings (label, search term). */
const RECONCILED_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["UNREAD", "is:unread"],
  ["STARRED", "is:starred"],
  ["TRASH", "in:trash"],
  ["SPAM", "in:spam"],
];

/** Margin before the last sync for the storm listing (clock skew, late-arriving mail). */
export const STORM_MARGIN_MS = 24 * 3_600_000;
/** Page cap per query for the storm listing (500 ids per page). */
export const STORM_MAX_PAGES = 20;

/**
 * Import storm (FREE-TIER.md §4.2 step 7; DESIGN.md §5.6 step 9): the windowed Q1/Q2
 * `messages.list after:` listing from the last sync (minus a day). Imported mail keeps its
 * original (old) internal date, so it falls outside the window; genuinely new mail is inside.
 * Null when the quota bucket refuses a page (nothing is applied; the poll is retried).
 */
async function stormListing(
  deps: PipelineDeps,
  mb: { mailboxId: string; userId: string },
  client: GmailClient,
  since: Date,
): Promise<{ full: string[]; metadata: string[] } | null> {
  const slice = stormSlice(Math.max(1, Math.floor((since.getTime() - STORM_MARGIN_MS) / 1000)));
  const out = { full: [] as string[], metadata: [] as string[] };
  for (const query of ["q1", "q2"] as const) {
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const q = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.mailboxId, units: UNITS.messagesList, floor: FLOOR_BACKGROUND }));
      if (!q.ok) return null;
      const page = await client.messagesList({
        q: query === "q1" ? backfillQueryQ1(slice) : backfillQueryQ2(slice),
        pageToken,
        maxResults: 500,
      });
      for (const m of page.messages ?? []) (query === "q1" ? out.full : out.metadata).push(m.id);
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken && ++pages < STORM_MAX_PAGES);
  }
  return out;
}

/**
 * History 404 (FREE-TIER.md §4.2 step 9): take a fresh cursor first, re-list the gap window
 * `max(7 d, now − last_synced_at)` (capped at the backfill window) into the ledger as resync work,
 * and hard-delete stored emails in that window that no longer exist in Gmail. The label changes of
 * the gap are gone with the history, so the read/star/trash/spam state of stored emails in the
 * window is reconciled from four more id listings (`is:unread`, `is:starred`, `in:trash`,
 * `in:spam`), race-safely against the fresh cursor.
 */
async function resync(
  deps: PipelineDeps,
  mb: { mailboxId: string; userId: string },
  state: MailboxState,
  nextPollAt: Date,
): Promise<PollOutcome> {
  const log = logOf(deps);
  const now = nowOf(deps);
  const client = gmailClient(deps, mb.userId, mb.mailboxId);
  await withUser(deps.pool, mb.userId, (_db, c) => c.query("UPDATE mailbox SET resync_pending = true, updated_at = now() WHERE id = $1", [mb.mailboxId]));
  const reserve = async (units: number) => {
    const r = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.mailboxId, units, floor: FLOOR_BACKGROUND }));
    if (!r.ok) throw new Error("quota");
  };
  await reserve(UNITS.getProfile);
  const profile = await client.getProfile();
  const gap = gapWindow(state.lastSyncedAt, now, state.windowDays);
  // Deletion reconciliation only considers mail received before the listing started, so an email
  // stored concurrently (after the listing began) can never be mistaken for a deleted one.
  const listedBefore = Math.floor(Date.now() / 1000) - 60;

  // Everything in the gap window (spam/trash included) — ids only, 5 units per 500.
  const present = new Set<string>();
  let pageToken: string | undefined;
  do {
    await reserve(UNITS.messagesList);
    const page = await client.messagesList({ q: windowQuery({ after: gap.after, before: null }), includeSpamTrash: true, pageToken, maxResults: 500 });
    for (const m of page.messages ?? []) present.add(m.id);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  // Current flag state of the window (ids only). Emails not in a set lose that label.
  const flagged = new Map<string, Set<string>>();
  for (const [label, term] of RECONCILED_LABELS) {
    const set = new Set<string>();
    let token: string | undefined;
    do {
      await reserve(UNITS.messagesList);
      const page = await client.messagesList({
        q: `${windowQuery({ after: gap.after, before: null })} ${term}`,
        includeSpamTrash: true,
        pageToken: token,
        maxResults: 500,
      });
      for (const m of page.messages ?? []) set.add(m.id);
      token = page.nextPageToken ?? undefined;
    } while (token);
    flagged.set(label, set);
  }

  const ids = [...present];
  const res = await withUser(deps.pool, mb.userId, async (_db, c) => {
    let listed = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source)
         SELECT $1, $2, x, 'pending', 'resync' FROM unnest($3::text[]) x
         ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING`,
        [mb.mailboxId, mb.userId, chunk],
      );
      listed += r.rowCount ?? 0;
    }
    // Deletion reconciliation: stored emails received in the gap window that Gmail no longer has.
    const del = await c.query(
      `DELETE FROM email WHERE mailbox_id = $1 AND received_at >= to_timestamp($2) AND received_at < to_timestamp($3)
         AND NOT (provider_message_id = ANY($4::text[]))`,
      [mb.mailboxId, gap.after, listedBefore, ids],
    );
    // Label reconciliation for stored emails in the window, only where the stored state predates the
    // fresh cursor (a later history record, applied by the next poll, still wins).
    const stored = await c.query<{ provider_message_id: string; label_ids: string[] }>(
      `SELECT provider_message_id, label_ids FROM email
       WHERE mailbox_id = $1 AND received_at >= to_timestamp($2) AND received_at < to_timestamp($3)
         AND gmail_history_id < $4::numeric AND provider_message_id = ANY($5::text[])`,
      [mb.mailboxId, gap.after, listedBefore, profile.historyId, ids],
    );
    const changes: Array<Record<string, unknown>> = [];
    for (const e of stored.rows) {
      const add = RECONCILED_LABELS.filter(([l]) => flagged.get(l)!.has(e.provider_message_id)).map(([l]) => l);
      const remove = RECONCILED_LABELS.filter(([l]) => !flagged.get(l)!.has(e.provider_message_id)).map(([l]) => l);
      const labels = applyLabelDelta(e.label_ids, add, remove);
      if (labels.length === e.label_ids.length && labels.every((l) => e.label_ids.includes(l))) continue;
      const f = labelColumns(labels);
      changes.push({
        pid: e.provider_message_id, labels, unread: f.isUnread, starred: f.isStarred, important: f.gmailImportant,
        category: f.gmailCategory, trash: f.inTrash, spam: f.inSpam,
      });
    }
    let relabeled = 0;
    for (let i = 0; i < changes.length; i += 500) {
      const upd = await c.query(
        `UPDATE email e SET label_ids = x.labels, is_unread = x.unread, is_starred = x.starred, gmail_important = x.important,
                gmail_category = x.category, in_trash = x.trash, in_spam = x.spam, gmail_history_id = $3::numeric, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(pid text, labels text[], unread boolean, starred boolean, important boolean,
                                                 category text, trash boolean, spam boolean)
         WHERE e.mailbox_id = $1 AND e.provider_message_id = x.pid AND e.gmail_history_id < $3::numeric`,
        [mb.mailboxId, JSON.stringify(changes.slice(i, i + 500)), profile.historyId],
      );
      relabeled += upd.rowCount ?? 0;
    }
    await c.query(
      `UPDATE mailbox SET history_id = $2::numeric, resync_pending = false, poll_incomplete = false,
              next_poll_at = $3, last_synced_at = now(), updated_at = now()
       WHERE id = $1`,
      [mb.mailboxId, profile.historyId, nextPollAt],
    );
    return { listed, deleted: del.rowCount ?? 0, relabeled };
  });
  log("poll.resync", { mailbox: mailboxTag(mb.mailboxId), gapDays: gap.days, listed: res.listed, deleted: res.deleted, relabeled: res.relabeled });
  return { kind: "resync", listed: res.listed, reconciledDeletes: res.deleted };
}

export interface PollDueResult {
  polled: number;
  inserted: number;
  errors: number;
  stopped: "database" | null;
}

/** The tick's poll step: due mailboxes, oldest first, 4 at a time, within the step budget. */
export async function pollDueMailboxes(deps: PipelineDeps, budgetMs = 60_000): Promise<PollDueResult> {
  const deadline = Date.now() + budgetMs;
  const out: PollDueResult = { polled: 0, inserted: 0, errors: 0, stopped: null };
  if (await killSwitchOn(deps.pool, "ingest")) return out;
  // Taken before the listing: every mailbox polled below is next due relative to this tick.
  const listedAt = nowOf(deps);
  const due = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ mailbox_id: string; user_id: string }>("SELECT * FROM list_mailboxes_due_for_poll(50)")).rows,
  );
  let i = 0;
  const worker = async () => {
    for (;;) {
      if (out.stopped || Date.now() > deadline - 5_000) return;
      const mb = due[i++];
      if (!mb) return;
      try {
        const r = await pollMailbox(deps, { mailboxId: mb.mailbox_id, userId: mb.user_id }, {
          maxPages: 20,
          budgetMs: Math.max(5_000, Math.min(45_000, deadline - Date.now() - 5_000)),
          source: "sync",
          anchor: listedAt,
          ingestChecked: true,
        });
        if (r.kind === "polled") {
          out.polled++;
          out.inserted += r.inserted;
        } else if (r.kind === "resync") {
          out.polled++;
          out.inserted += r.listed;
        }
      } catch (err) {
        out.errors++;
        if (isDatabaseUnavailable(err)) out.stopped = "database";
        logOf(deps)("poll.error", { mailbox: mailboxTag(mb.mailbox_id), code: errorCode(err) });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

/** A fixed, content-free code for an error (never its message, which may contain data). */
export function errorCode(err: unknown): string {
  if (isGmailError(err)) return `gmail_${err.kind}`;
  if (err instanceof Error) return err.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "error";
  return "unknown";
}
