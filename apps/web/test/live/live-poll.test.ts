/**
 * The open app's timers (src/lib/live-poll.ts), with a fake clock:
 *  - the gallery checks every minute while it's visible and in use, backing off × 2 up to every
 *    5 minutes while nothing changes, and back to every minute after a change or a sign of life;
 *  - no checks while hidden, offline or idle (no input for 2 minutes); shown again, back online or
 *    used again → a check at once (never within 15 s of the last one);
 *  - never two checks at once; a "check now" during one runs once more afterwards;
 *  - "stop" (signed out, UI polling off) ends it for good;
 *  - the background mail sync every 10 minutes; after it found mail (and so kicked the pipeline),
 *    the next one waits for the server's next 10-minute kick window.
 */
import { describe, expect, it } from "vitest";
import {
  LIVE_TIMING,
  LiveScheduler,
  backoff,
  nextSyncDelay,
  type CheckOutcome,
  type SchedulerClock,
} from "@/lib/live-poll";

const MIN = 60_000;

/** A manual clock: timers fire only when time is advanced past them. */
class FakeClock implements SchedulerClock {
  t = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers.delete(h as number);
  }
  get pending() {
    return this.timers.size;
  }
  /** Advance to `ms` later, firing due timers in order (and letting their checks settle). */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, x]) => x.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await settle();
    }
    this.t = end;
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(
  outcomes: CheckOutcome[] | (() => CheckOutcome) = () => "same",
  opts: Partial<ConstructorParameters<typeof LiveScheduler>[0]> = {},
) {
  const clock = new FakeClock();
  const runs: number[] = [];
  const s = new LiveScheduler({
    baseMs: LIVE_TIMING.pollMs,
    maxMs: LIVE_TIMING.pollMaxMs,
    clock,
    run: async () => {
      runs.push(clock.t);
      return typeof outcomes === "function" ? outcomes() : (outcomes.shift() ?? "same");
    },
    ...opts,
  });
  s.start();
  return {
    s,
    clock,
    runs,
    gaps: () => runs.map((t, i) => (i === 0 ? t - 1_000_000 : t - runs[i - 1]!)),
  };
}

describe("LiveScheduler", () => {
  it("checks every minute while in use, backing off to every 5 minutes while nothing changes", async () => {
    const { s, clock, gaps } = setup();
    for (let i = 0; i < 12; i++) {
      await clock.advance(10 * 1000);
      s.input(); // someone is using the page
    }
    // 2 minutes in: one check at 1 min; the next is 2 min after it.
    expect(gaps()).toEqual([MIN]);
    for (let i = 0; i < 90; i++) {
      await clock.advance(10 * 1000);
      s.input();
    }
    expect(gaps()).toEqual([MIN, 2 * MIN, 4 * MIN, 5 * MIN, 5 * MIN]);
  });

  it("a change brings it back to every minute", async () => {
    const { s, clock, gaps } = setup(["same", "same", "changed", "same"]);
    for (let i = 0; i < 60; i++) {
      await clock.advance(10 * 1000);
      s.input();
    }
    expect(gaps().slice(0, 5)).toEqual([MIN, 2 * MIN, 4 * MIN, MIN, 2 * MIN]);
  });

  it("errors back off like 'nothing changed'; 'stop' ends it for good", async () => {
    expect(backoff("error", MIN, MIN, 5 * MIN)).toBe(2 * MIN);
    expect(backoff("same", 4 * MIN, MIN, 5 * MIN)).toBe(5 * MIN);
    expect(backoff("changed", 5 * MIN, MIN, 5 * MIN)).toBe(MIN);
    const { s, clock, runs } = setup(["stop"]);
    for (let i = 0; i < 30; i++) {
      await clock.advance(10 * 1000);
      s.input();
    }
    expect(runs).toHaveLength(1);
    expect(s.isStopped).toBe(true);
    s.trigger();
    s.setVisible(false);
    s.setVisible(true);
    await clock.advance(10 * MIN);
    expect(runs).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });

  it("no checks while hidden; shown again → a check at once, but never within 15 s of the last", async () => {
    const { s, clock, runs } = setup();
    await clock.advance(MIN); // first check
    expect(runs).toHaveLength(1);
    s.setVisible(false);
    expect(clock.pending).toBe(0);
    await clock.advance(30 * MIN);
    expect(runs).toHaveLength(1);
    s.input();
    s.setVisible(true);
    await settle();
    expect(runs).toHaveLength(2); // at once
    // Hidden and shown again within 15 s: no extra check, the schedule simply continues.
    s.setVisible(false);
    await clock.advance(5 * 1000);
    s.setVisible(true);
    await settle();
    expect(runs).toHaveLength(2);
    expect(clock.pending).toBe(1);
  });

  it("offline pauses; back online checks at once", async () => {
    const { s, clock, runs } = setup();
    s.setOnline(false);
    await clock.advance(3 * MIN);
    expect(runs).toHaveLength(0);
    s.input();
    s.setOnline(true);
    await settle();
    expect(runs).toHaveLength(1);
  });

  it("idle for 2 minutes (no input): stops checking; the next input checks at once", async () => {
    expect(LIVE_TIMING.idleMs).toBe(2 * MIN);
    const { s, clock, runs } = setup();
    await clock.advance(MIN); // check 1 (+1 min)
    await clock.advance(2 * MIN); // the +3 min check would be past the 2 idle minutes: none
    await clock.advance(10 * MIN);
    expect(runs.map((t) => (t - 1_000_000) / MIN)).toEqual([1]);
    expect(clock.pending).toBe(0);
    s.input();
    await settle();
    expect(runs).toHaveLength(2);
    expect(runs[1]! - 1_000_000).toBe(13 * MIN);
    // In use again: the schedule carries on, still backing off (the next 4 minutes after that check).
    for (let i = 0; i < 9; i++) {
      await clock.advance(30 * 1000);
      s.input();
    }
    expect(runs.map((t) => (t - 1_000_000) / MIN)).toEqual([1, 13, 17]);
  });

  it("never two checks at once: 'check now' during a check runs once more after it", async () => {
    const clock = new FakeClock();
    let release: (() => void) | null = null;
    let running = 0;
    let most = 0;
    let runs = 0;
    const s = new LiveScheduler({
      baseMs: MIN,
      maxMs: 5 * MIN,
      clock,
      run: () =>
        new Promise<CheckOutcome>((resolve) => {
          runs++;
          running++;
          most = Math.max(most, running);
          release = () => {
            running--;
            resolve("same");
          };
        }),
    });
    s.start();
    s.trigger();
    s.trigger();
    s.trigger();
    expect(runs).toBe(1);
    release!();
    await settle();
    expect(runs).toBe(2); // one more for the triggers that came during it
    release!();
    await settle();
    expect(runs).toBe(2);
    expect(most).toBe(1);
    s.dispose();
    expect(clock.pending).toBe(0);
  });

  it("'check now' also brings the pace back to every minute (something is happening)", async () => {
    const { s, clock, runs } = setup();
    for (let i = 0; i < 48; i++) {
      await clock.advance(10 * 1000);
      s.input();
    }
    expect(runs).toHaveLength(3); // at 1, 3 and 7 minutes
    expect(s.interval).toBe(5 * MIN);
    s.trigger();
    await settle();
    expect(runs).toHaveLength(4);
    expect(s.interval).toBe(MIN);
    // …then it backs off again while nothing changes.
    for (let i = 0; i < 24; i++) {
      await clock.advance(10 * 1000);
      s.input();
    }
    expect(runs.slice(3).map((t) => (t - runs[3]!) / MIN)).toEqual([0, 1, 3]);
  });

  it("a thrown check counts as an error, and disposing stops everything", async () => {
    const { s, clock, runs } = setup(() => {
      throw new Error("network");
    });
    await clock.advance(MIN);
    s.input();
    expect(runs).toHaveLength(1);
    expect(s.interval).toBe(2 * MIN);
    s.dispose();
    await clock.advance(30 * MIN);
    expect(runs).toHaveLength(1);
  });
});

describe("the background mail sync", () => {
  it("runs every 10 minutes (one per kick window); after finding mail it never runs within the same window", () => {
    expect(LIVE_TIMING.syncMs).toBe(10 * MIN);
    expect(LIVE_TIMING.syncMs).toBe(LIVE_TIMING.kickWindowMs);
    expect(nextSyncDelay(false, Date.parse("2026-09-30T12:03:00Z"))).toBe(10 * MIN);
    // Found mail at 12:03 (kick window 12:00–12:10): 12:13, past the next window's start (12:11).
    expect(nextSyncDelay(true, Date.parse("2026-09-30T12:03:00Z"))).toBe(10 * MIN);
    // Found mail at 12:00:30: 10 minutes would be 12:10:30, inside the clock-skew minute; so 12:11.
    expect(nextSyncDelay(true, Date.parse("2026-09-30T12:00:30Z"))).toBe(10.5 * MIN);
  });

  it("its scheduler uses that delay", async () => {
    const clock = new FakeClock();
    clock.t = Date.parse("2026-09-30T12:00:00Z");
    const runs: string[] = [];
    const outcomes: CheckOutcome[] = ["changed", "same", "same"];
    const s = new LiveScheduler({
      baseMs: LIVE_TIMING.syncMs,
      maxMs: LIVE_TIMING.syncMs,
      clock,
      nextDelay: (o, _c, now) => nextSyncDelay(o === "changed", now),
      run: async () => {
        runs.push(new Date(clock.t).toISOString().slice(11, 16));
        return outcomes.shift() ?? "same";
      },
    });
    s.start();
    for (let i = 0; i < 32; i++) {
      await clock.advance(MIN);
      s.input();
    }
    // 12:10 found mail (kick window 12:10–12:20): the next at 12:21 (next window + 1 min), then 10 minutes.
    expect(runs).toEqual(["12:10", "12:21", "12:31"]);
  });
});
