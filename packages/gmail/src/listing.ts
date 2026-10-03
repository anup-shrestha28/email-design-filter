/**
 * Backfill listing, resync windows, poll cadence and drain backoff
 * (DESIGN.md §5.2, §5.4; FREE-TIER.md §4.2 step 9, §4.3, §4.5, §4.6).
 * All pure functions of their inputs (no clock reads).
 */

const DAY_S = 86_400;
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** A backfill time slice in epoch seconds: `[after, before)`; `before: null` = open-ended. */
export interface TimeSlice {
  after: number;
  before: number | null;
  /** The slice's nominal lower bound in days before `now` (2, 7, 30 or the window). */
  days: number;
}

/**
 * Backfill time slices, newest first: 2 d → 7 d → 30 d → the window (DESIGN.md §5.4 step 1).
 * The newest slice is open-ended (`before: null`) so mail arriving while the backfill runs is
 * listed too (DECISIONS.md G4); the replay from the connect-time cursor also covers it.
 */
export function backfillSlices(windowDays: number, now: Date): TimeSlice[] {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 180) {
    throw new RangeError("backfillSlices: windowDays must be an integer in 1..180");
  }
  const nowS = Math.floor(now.getTime() / 1000);
  const bounds = [2, 7, 30, windowDays].filter(
    (d, i, arr) => d <= windowDays && arr.indexOf(d) === i,
  );
  if (bounds[bounds.length - 1] !== windowDays) bounds.push(windowDays);
  const slices: TimeSlice[] = [];
  let before: number | null = null;
  for (const days of bounds.sort((a, b) => a - b)) {
    const after = nowS - days * DAY_S;
    slices.push({ after, before, days });
    before = after;
  }
  return slices;
}

/**
 * Epoch-second bounds for a Gmail `q` (DESIGN.md §5.2: epoch seconds, never date literals).
 * `after:` is written one second early so a message exactly on a slice boundary can't fall
 * between two slices whatever Gmail's inclusivity (DECISIONS.md G4); duplicates are dropped by
 * the ledger's primary key.
 */
function timeTerms(slice: Pick<TimeSlice, "after" | "before">): string {
  if (!Number.isInteger(slice.after) || slice.after < 1)
    throw new RangeError("slice.after must be epoch seconds");
  const terms = [`after:${slice.after - 1}`];
  if (slice.before !== null) {
    if (!Number.isInteger(slice.before) || slice.before <= slice.after) {
      throw new RangeError("slice.before must be epoch seconds after slice.after");
    }
    terms.push(`before:${slice.before}`);
  }
  return terms.join(" ");
}

const EXCLUDE = "-in:sent -in:drafts -in:chats";

/** Q1: the four Gmail category tabs → `full` fetches (DESIGN.md §5.4). */
export function backfillQueryQ1(slice: Pick<TimeSlice, "after" | "before">): string {
  return `{category:promotions category:updates category:social category:forums} ${EXCLUDE} ${timeTerms(slice)}`;
}

/** Q2: everything else (the exact complement of Q1) → `metadata` first (DESIGN.md §5.4). */
export function backfillQueryQ2(slice: Pick<TimeSlice, "after" | "before">): string {
  return `-category:promotions -category:updates -category:social -category:forums ${EXCLUDE} ${timeTerms(slice)}`;
}

/**
 * Deletion-reconciliation / gap listing over a window (FREE-TIER.md §4.2 step 9): no category
 * or folder filters; call with `includeSpamTrash: true` so trashed mail isn't mistaken for
 * deleted mail.
 */
export function windowQuery(slice: Pick<TimeSlice, "after" | "before">): string {
  return timeTerms(slice);
}

/** An import-storm listing (FREE-TIER.md §4.2 step 7): Q1/Q2 from `after` with no upper bound. */
export function stormSlice(afterEpochSeconds: number): Pick<TimeSlice, "after" | "before"> {
  return { after: Math.floor(afterEpochSeconds), before: null };
}

export interface GapWindow {
  /** Epoch seconds; list with `after:` (open-ended). */
  after: number;
  days: number;
}

/**
 * The resync window after a history 404: `max(7 d, now − last_synced_at)` capped at the user's
 * `backfill_window_days` (FREE-TIER.md §4.2 step 9). A gap longer than 7 days gets one extra day
 * of margin, because the cursor can lag `last_synced_at` after an incomplete poll
 * (DECISIONS.md G5). `lastSyncedAt = null` → the whole window.
 */
export function gapWindow(
  lastSyncedAt: Date | null,
  now: Date,
  backfillWindowDays: number,
): GapWindow {
  if (!Number.isInteger(backfillWindowDays) || backfillWindowDays < 1 || backfillWindowDays > 180) {
    throw new RangeError("gapWindow: backfillWindowDays must be an integer in 1..180");
  }
  let days: number;
  if (lastSyncedAt === null) days = backfillWindowDays;
  else {
    const gapDays = Math.max(0, now.getTime() - lastSyncedAt.getTime()) / DAY_MS;
    days = gapDays <= 7 ? 7 : Math.ceil(gapDays) + 1;
  }
  days = Math.min(days, backfillWindowDays);
  return { after: Math.floor(now.getTime() / 1000) - days * DAY_S, days };
}

/**
 * Validate and quote an address interpolated into `q` (DESIGN.md §5.2 "Query safety"): reject
 * `"`, whitespace, `{}` and `()` (plus control characters and backslashes), require one `@`.
 */
export function quoteAddressForQuery(addr: string): string {
  if (typeof addr !== "string" || addr.length < 3 || addr.length > 320) {
    throw new QueryInjectionError();
  }
  // eslint-disable-next-line no-control-regex
  if (/["\s{}()\\\x00-\x1f\x7f]/.test(addr)) throw new QueryInjectionError();
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@") || at === addr.length - 1)
    throw new QueryInjectionError();
  return `"${addr}"`;
}

export class QueryInjectionError extends Error {
  constructor() {
    super("Address rejected for use in a Gmail query");
    this.name = "QueryInjectionError";
  }
}

export type GovernorLevel = 0 | 1 | 2 | 3;

/**
 * Delay until a mailbox's next background poll (FREE-TIER.md §4.3, §8.2):
 *  - opened in the last 7 days → the tick interval (30 or 60 min);
 *  - idle 7–30 days → 3 h; idle > 30 days (or never) → 24 h;
 *  - L1 → × 2; L2 → every 6 h (never more often than the idle interval); L3 → 24 h;
 *  - always ≤ 24 h (keeps the cursor inside Gmail's history window and the grant in use).
 */
export function nextPollDelay(p: {
  lastActiveAt: Date | null;
  now: Date;
  tickEvery: 30 | 60;
  governorLevel: GovernorLevel;
}): number {
  const idleMs = p.lastActiveAt === null ? Infinity : p.now.getTime() - p.lastActiveAt.getTime();
  let delay: number;
  if (idleMs <= 7 * DAY_MS) delay = p.tickEvery * MIN_MS;
  else if (idleMs <= 30 * DAY_MS) delay = 3 * HOUR_MS;
  else delay = DAY_MS;
  if (p.governorLevel === 1) delay *= 2;
  else if (p.governorLevel === 2) delay = Math.max(delay, 6 * HOUR_MS);
  else if (p.governorLevel === 3) delay = DAY_MS;
  return Math.min(delay, DAY_MS);
}

/** After this many failed attempts a ledger row becomes `failed` (FREE-TIER.md §4.6). */
export const MAX_ATTEMPTS = 5;

const BACKOFF_MS = [1 * MIN_MS, 5 * MIN_MS, 30 * MIN_MS, 2 * HOUR_MS, 6 * HOUR_MS] as const;

/**
 * Ledger retry backoff 1 m → 5 m → 30 m → 2 h → 6 h (FREE-TIER.md §4.6). `attempts` is the
 * count *after* incrementing for this failure (1-based); values past 5 stay at 6 h.
 */
export function drainBackoff(attempts: number): number {
  const i = Math.min(Math.max(Math.floor(attempts), 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i] ?? 6 * HOUR_MS;
}

/**
 * What to do after a failed attempt (`attempts` already incremented). Every listed backoff is
 * used, so a row gets five backed-off retries and becomes `failed` on the attempt after the
 * 6 h wait (DECISIONS.md G6; failed rows are re-driven daily for 7 days anyway).
 */
export function ledgerFailureOutcome(
  attempts: number,
  now: Date,
): { state: "failed" } | { state: "retry"; nextAttemptAt: Date } {
  if (attempts > MAX_ATTEMPTS) return { state: "failed" };
  return { state: "retry", nextAttemptAt: new Date(now.getTime() + drainBackoff(attempts)) };
}
