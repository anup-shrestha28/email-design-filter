/**
 * In-memory, content-free counters for edf-view (FREE-TIER.md §9.2): `/v` and `/img` requests,
 * signature failures and served image bytes, POSTed to edf-app `/api/view-stats` in the
 * background (`waitUntil`, so no response waits for it), and authenticated with edf-view's own
 * function OIDC token.
 *
 * edf-app meters the served image bytes as Fast Origin Transfer (they are the only record of it),
 * so they must not sit in memory until the instance is recycled. Reports ride on requests: one
 * goes out once STATS_INTERVAL_MS (60 s) has passed since the last one, or earlier once
 * STATS_FLUSH_BYTES (4 MB) of served image bytes are pending, but never within
 * STATS_MIN_INTERVAL_MS (10 s) of the last one. Sparse traffic (a gallery loaded after a cold
 * start, then silence) would leave bytes waiting for a request that may never come, so while
 * served image bytes are pending one delayed report is also scheduled, STATS_TRAILING_MS (12 s)
 * later, under the `waitUntil` of the request that served them (the one timer; the instance stays
 * alive ~12 s longer after its last image). Counts are then lost only when a report fails and no
 * later image request reaches the instance, or the instance dies mid-`waitUntil`; the default
 * `vercel_fot` calibration factor (1.25) covers that (packages/budget/DECISIONS.md, "Fast Origin
 * Transfer"). A runtime without `waitUntil` gets no delayed report (it would hold the response).
 *
 * Wire contract (edf-app answers 204):
 *   { "v": 1, "windowStart": <unix s>, "windowEnd": <unix s>, "counts": { "<code>": <int> } }
 * codes match /^[a-z0-9_]{1,40}$/, ≤ 50 keys, values 0..10,000,000 (excess carries over to the
 * next report, so totals are never lost), body ≤ 4 KB, windowEnd − windowStart ≤ 86,400 s.
 */
import type { TokenSource } from "./oidc";

export const STAT_KEYS = [
  "view_requests",
  "view_forwarded",
  "view_rejected_expiry",
  "view_rejected_format",
  "view_upstream_error",
  /** Gallery-card views that failed transiently and were answered with a self-retrying page (app.ts). */
  "view_card_retry",
  "img_requests",
  "img_ok",
  "img_bad_signature",
  "img_blocked_tracker",
  "img_budget_exceeded",
  "img_too_large",
  "img_upstream_error",
  /** Image bytes served (gallery cards included): edf-app meters these as Fast Origin Transfer. */
  "img_bytes_served",
  /**
   * The part of `img_bytes_served` that went to gallery-card images (tokens whose budget id ends
   * in `_c`): a diagnostic subset, never metered on top (FREE-TIER.md §8.1).
   */
  "img_card_bytes_served",
  /** Images served shrunk to the width they are shown at (resize.ts). */
  "img_resized",
  /** CPU spent shrinking images (ms): edf-app meters it as Vercel Active CPU. */
  "img_resize_cpu_ms",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** A report goes out once this long has passed since the last one. */
export const STATS_INTERVAL_MS = 60_000;
/** …or earlier, once this many served image bytes are pending (bounds what a report failure can hold)… */
export const STATS_FLUSH_BYTES = 4 * 1024 * 1024;
/** …but never within this long of the last report (at most one database write per 10 s per instance). */
export const STATS_MIN_INTERVAL_MS = 10_000;
/**
 * While served image bytes are pending, a delayed report goes out this long after the request that
 * scheduled it, unless a report went out in between. ≥ STATS_MIN_INTERVAL_MS, and with the 3 s
 * report timeout well inside the functions' 30 s maxDuration (vercel.json), which bounds waitUntil.
 */
export const STATS_TRAILING_MS = 12_000;
export const STAT_MAX_VALUE = 10_000_000;
/** edf-app refuses reports whose window is longer than 86,400 s. */
export const STATS_MAX_WINDOW_MS = 86_400 * 1000;

export interface StatsDeps {
  statsUrl: string;
  token: TokenSource;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (e: Record<string, string | number>) => void;
  /** Timer for the delayed report (tests inject one); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Counts = Partial<Record<StatKey, number>>;

export class Stats {
  #counts: Counts = {};
  #since: number;
  #last: number;
  #flushing = false;
  /** Bumped by every report sent, so a delayed report scheduled before it stands down. */
  #epoch = 0;
  #trailing: Promise<void> | null = null;

  constructor(now: number) {
    this.#since = now;
    this.#last = now;
  }

  add(key: StatKey, n = 1): void {
    this.#counts[key] = (this.#counts[key] ?? 0) + n;
  }

  snapshot(): Readonly<Counts> {
    return { ...this.#counts };
  }

  /**
   * Whether a report is due at `now`: STATS_INTERVAL_MS since the last one, or STATS_FLUSH_BYTES of
   * served image bytes pending and at least STATS_MIN_INTERVAL_MS since the last one.
   */
  due(now: number): boolean {
    if (this.#flushing || Object.keys(this.#counts).length === 0) return false;
    const since = now - this.#last;
    if (since >= STATS_INTERVAL_MS) return true;
    return (
      since >= STATS_MIN_INTERVAL_MS && (this.#counts.img_bytes_served ?? 0) >= STATS_FLUSH_BYTES
    );
  }

  /**
   * Report if due (`due()`); returns a promise that never rejects. Callers hand it to `waitUntil`
   * so the response never waits for it. A failed report puts its counts back for the next one.
   */
  maybeFlush(deps: StatsDeps, request: Request): Promise<void> {
    const now = deps.now();
    if (!this.due(now)) return Promise.resolve();
    return this.#send(deps, request, now);
  }

  /** The delayed report scheduled by `scheduleTrailing` and not yet fired or superseded, if any. */
  get trailing(): Promise<void> | null {
    return this.#trailing;
  }

  /**
   * While served image bytes are pending and no delayed report is scheduled, schedule one
   * STATS_TRAILING_MS from now and return its promise (it never rejects) for the caller to hand to
   * `waitUntil`; otherwise null. It stands down if any report goes out before it fires (the next
   * request with pending bytes then schedules a fresh one), so it never breaks the 10 s spacing:
   * the last report went out no later than when it was scheduled.
   */
  scheduleTrailing(deps: StatsDeps, request: Request): Promise<void> | null {
    if (this.#trailing !== null || (this.#counts.img_bytes_served ?? 0) === 0) return null;
    const epoch = this.#epoch;
    const p: Promise<void> = (deps.sleep ?? defaultSleep)(STATS_TRAILING_MS)
      .then(() => {
        if (this.#trailing === p) this.#trailing = null;
        if (epoch !== this.#epoch || this.#flushing) return;
        if (Object.keys(this.#counts).length === 0) return;
        return this.#send(deps, request, deps.now());
      })
      .catch(() => undefined);
    this.#trailing = p;
    return p;
  }

  #send(deps: StatsDeps, request: Request, now: number): Promise<void> {
    const sent: Counts = {};
    const carry: Counts = {};
    for (const [k, v] of Object.entries(this.#counts) as Array<[StatKey, number]>) {
      sent[k] = Math.min(v, STAT_MAX_VALUE);
      if (v > STAT_MAX_VALUE) carry[k] = v - STAT_MAX_VALUE;
    }
    // After long failures (or a long idle instance) the window would outgrow edf-app's limit and
    // every later report would be refused; older counts are reported in the capped window instead.
    const windowStart = Math.max(this.#since, now - STATS_MAX_WINDOW_MS);
    this.#counts = carry;
    this.#since = now;
    this.#last = now;
    this.#flushing = true;
    this.#epoch += 1;
    this.#trailing = null;
    return this.#post(deps, request, sent, windowStart, now)
      .then((ok) => {
        if (!ok) {
          for (const [k, v] of Object.entries(sent) as Array<[StatKey, number]>) this.add(k, v);
          this.#since = Math.min(this.#since, windowStart);
        }
      })
      .finally(() => {
        this.#flushing = false;
      });
  }

  async #post(
    deps: StatsDeps,
    request: Request,
    counts: Counts,
    windowStart: number,
    windowEnd: number,
  ): Promise<boolean> {
    try {
      const token = await deps.token(request);
      if (token === null) {
        deps.log({ ev: "stats_skipped", code: "no_oidc_token" });
        return false;
      }
      const res = await deps.fetchImpl(deps.statsUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          v: 1,
          windowStart: Math.floor(windowStart / 1000),
          windowEnd: Math.floor(windowEnd / 1000),
          counts,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status < 200 || res.status >= 300) {
        deps.log({ ev: "stats_failed", status: res.status });
        return false;
      }
      return true;
    } catch {
      deps.log({ ev: "stats_failed", code: "network" });
      return false;
    }
  }
}
