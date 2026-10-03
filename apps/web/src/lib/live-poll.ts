/**
 * Timers for keeping an open app current (client-safe, pure; unit-tested with a fake clock):
 *  - the live gallery's check for new designs and scores (components/gallery/live-updates.tsx);
 *  - the mailbox sync while the app stays open (components/providers/sync.tsx).
 *
 * Every check wakes the database (Neon Free bills awake time, FREE-TIER.md §7), so they run only
 * while someone is looking: the tab is visible, online and was used in the last 2 minutes. A tab
 * left open on a second screen stops checking after 2 idle minutes and checks again as soon as it
 * is used (or shown) again. While nothing changes, checks back off from every minute to every 5.
 * The idle stop and the 10-minute background sync keep the live gallery inside the free budget at
 * 20 users (FREE-TIER.md §4.4 "Cost", §7): each session keeps Neon awake ≤ 2 minutes longer, and
 * the background sync kicks the pipeline at most once per 10-minute kick window.
 */

export const LIVE_TIMING = {
  /** The gallery checks about once a minute while it's in use… */
  pollMs: 60_000,
  /** …doubling while nothing changes, up to every 5 minutes. */
  pollMaxMs: 5 * 60_000,
  /** No input (pointer, keys, scroll, touch) for this long: idle, no checks until the next input. */
  idleMs: 2 * 60_000,
  /** A check on waking (shown again, back online, used after idling) comes ≥ this long after the last. */
  minGapMs: 15_000,
  /**
   * The mailbox sync-on-open runs again this often while the app is in use: once per kick window
   * (below), the most a sync that finds mail can kick the pipeline anyway.
   */
  syncMs: 10 * 60_000,
  /**
   * The server sends at most one pipeline/kick per user per 10-minute window (FREE-TIER.md §4.4,
   * `kick-{userId}-{floor(now/10 min)}`): after a sync that found mail (and so kicked), the next
   * one waits for the next window (plus a minute for clock skew), so its kick isn't dropped.
   */
  kickWindowMs: 10 * 60_000,
  kickSlackMs: 60_000,
} as const;

/** What one check found: `stop` ends the schedule (signed out, or polling switched off). */
export type CheckOutcome = "changed" | "same" | "error" | "stop";

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  run: () => Promise<CheckOutcome>;
  /** First interval, and the interval after a change. */
  baseMs: number;
  /** Longest interval while nothing changes (× 2 per unchanged check). */
  maxMs: number;
  idleMs?: number;
  minGapMs?: number;
  /** The interval after a check (default: base after a change, else doubled up to max). */
  nextDelay?: (outcome: CheckOutcome, current: number, now: number) => number;
  clock?: SchedulerClock;
}

/** The default back-off: base after a change, doubling (up to max) while nothing changes or on errors. */
export function backoff(
  outcome: CheckOutcome,
  current: number,
  baseMs: number,
  maxMs: number,
): number {
  if (outcome === "changed") return baseMs;
  return Math.min(maxMs, Math.max(baseMs, current * 2));
}

/** The sync interval: 10 minutes, or after a sync that found mail, until the next kick window opens if that's later. */
export function nextSyncDelay(foundMail: boolean, now: number): number {
  const { syncMs, kickWindowMs, kickSlackMs } = LIVE_TIMING;
  if (!foundMail) return syncMs;
  const nextWindow = (Math.floor(now / kickWindowMs) + 1) * kickWindowMs + kickSlackMs;
  return Math.max(syncMs, nextWindow - now);
}

/**
 * One repeating check, run only while the page is visible, online and in use. The owner feeds it
 * the page's state (`setVisible`, `setOnline`, `input`); `trigger()` asks for a check now (e.g. new
 * mail was found). Never two checks at once: a trigger during a check runs once more afterwards.
 */
export class LiveScheduler {
  private readonly o: Required<Omit<SchedulerOptions, "nextDelay">> &
    Pick<SchedulerOptions, "nextDelay">;
  private delay: number;
  private lastRunAt: number;
  private lastInputAt: number;
  private timer: unknown = null;
  private running = false;
  private again = false;
  /** A `trigger()` came since the last check: the check after it comes at the base interval. */
  private triggered = false;
  private stopped = false;
  private disposed = false;
  private visible = true;
  private online = true;

  constructor(opts: SchedulerOptions) {
    this.o = {
      run: opts.run,
      baseMs: opts.baseMs,
      maxMs: opts.maxMs,
      idleMs: opts.idleMs ?? LIVE_TIMING.idleMs,
      minGapMs: opts.minGapMs ?? LIVE_TIMING.minGapMs,
      clock: opts.clock ?? realClock,
      nextDelay: opts.nextDelay,
    };
    this.delay = opts.baseMs;
    const now = this.o.clock.now();
    // Created with a fresh page: that render is the latest check, and the viewer just arrived.
    this.lastRunAt = now;
    this.lastInputAt = now;
  }

  /** Start the schedule (the first check comes one interval after creation). */
  start(): void {
    this.schedule();
  }

  /** The interval the next scheduled check waits (for tests and diagnostics). */
  get interval(): number {
    return this.delay;
  }

  /** True while a timer is set (not idle, hidden, offline or stopped). */
  get waiting(): boolean {
    return this.timer !== null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.wake();
    else this.clear();
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (online) this.wake();
    else this.clear();
  }

  /** The viewer did something (pointer, key, scroll, touch). After an idle spell, check again. */
  input(): void {
    const now = this.o.clock.now();
    const wasIdle = this.idle(now);
    this.lastInputAt = now;
    if (wasIdle) this.wake();
  }

  /**
   * Check now (ignores the minimum gap and the idle state, not hidden/offline/stopped), and go
   * back to the base interval: something is happening (e.g. new mail is being stored), so the
   * checks after it come at the base pace until nothing changes again.
   */
  trigger(): void {
    if (this.stopped || this.disposed || !this.visible || !this.online) return;
    this.triggered = true;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.runNow();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private idle(now: number): boolean {
    return now - this.lastInputAt >= this.o.idleMs;
  }

  private canRun(): boolean {
    return !this.stopped && !this.disposed && this.visible && this.online;
  }

  /** Shown again, back online, or used again: check now if the last check is old enough. */
  private wake(): void {
    if (!this.canRun() || this.running) return;
    const now = this.o.clock.now();
    if (now - this.lastRunAt >= this.o.minGapMs) void this.runNow();
    else this.schedule();
  }

  private clear(): void {
    if (this.timer !== null) this.o.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clear();
    if (!this.canRun() || this.running) return;
    const now = this.o.clock.now();
    if (this.idle(now)) return; // the next input wakes it
    const wait = Math.max(0, this.lastRunAt + this.delay - now);
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = null;
      if (!this.canRun()) return;
      if (this.idle(this.o.clock.now())) return;
      void this.runNow();
    }, wait);
  }

  private async runNow(): Promise<void> {
    this.clear();
    this.running = true;
    this.again = false;
    this.lastRunAt = this.o.clock.now();
    let outcome: CheckOutcome;
    try {
      outcome = await this.o.run();
    } catch {
      outcome = "error";
    }
    this.running = false;
    if (this.disposed) return;
    if (outcome === "stop") {
      this.stopped = true;
      this.clear();
      return;
    }
    const now = this.o.clock.now();
    this.delay = this.o.nextDelay
      ? this.o.nextDelay(outcome, this.delay, now)
      : backoff(outcome, this.delay, this.o.baseMs, this.o.maxMs);
    if (this.triggered) this.delay = this.o.baseMs;
    this.triggered = false;
    if (this.again) {
      this.again = false;
      void this.runNow();
      return;
    }
    this.schedule();
  }
}
