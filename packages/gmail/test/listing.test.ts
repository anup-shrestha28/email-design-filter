import { describe, expect, it } from "vitest";
import {
  backfillQueryQ1,
  backfillQueryQ2,
  backfillSlices,
  drainBackoff,
  gapWindow,
  ledgerFailureOutcome,
  MAX_ATTEMPTS,
  nextPollDelay,
  QueryInjectionError,
  quoteAddressForQuery,
  windowQuery,
} from "../src/index";

const NOW = new Date("2026-09-27T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const D = 86_400;
const MIN = 60_000;
const H = 60 * MIN;

describe("backfill slices and queries (DESIGN §5.4)", () => {
  it("slices newest first: 2 d → 7 d → 30 d → window, contiguous, open-ended at the top", () => {
    expect(backfillSlices(90, NOW)).toEqual([
      { after: NOW_S - 2 * D, before: null, days: 2 },
      { after: NOW_S - 7 * D, before: NOW_S - 2 * D, days: 7 },
      { after: NOW_S - 30 * D, before: NOW_S - 7 * D, days: 30 },
      { after: NOW_S - 90 * D, before: NOW_S - 30 * D, days: 90 },
    ]);
    expect(backfillSlices(30, NOW).map((s) => s.days)).toEqual([2, 7, 30]);
    expect(backfillSlices(180, NOW).map((s) => s.days)).toEqual([2, 7, 30, 180]);
    expect(() => backfillSlices(181, NOW)).toThrow(RangeError);
  });

  it("Q1/Q2 use epoch seconds and overlap slice boundaries by one second", () => {
    const [top, second] = backfillSlices(90, NOW);
    expect(backfillQueryQ1(top!)).toBe(
      `{category:promotions category:updates category:social category:forums} -in:sent -in:drafts -in:chats after:${NOW_S - 2 * D - 1}`,
    );
    expect(backfillQueryQ2(second!)).toBe(
      `-category:promotions -category:updates -category:social -category:forums -in:sent -in:drafts -in:chats after:${NOW_S - 7 * D - 1} before:${NOW_S - 2 * D}`,
    );
    expect(windowQuery({ after: 100, before: 200 })).toBe("after:99 before:200");
    expect(() => windowQuery({ after: 200, before: 100 })).toThrow(RangeError);
    expect(() => windowQuery({ after: 1.5, before: null })).toThrow(RangeError);
  });
});

describe("gapWindow (FREE-TIER §4.2 step 9)", () => {
  it("is max(7 d, gap) capped at the window, with a day of margin for long gaps", () => {
    expect(gapWindow(new Date(NOW.getTime() - 2 * H), NOW, 90).days).toBe(7);
    expect(gapWindow(new Date(NOW.getTime() - 7 * D * 1000), NOW, 90).days).toBe(7);
    expect(gapWindow(new Date(NOW.getTime() - 10.2 * D * 1000), NOW, 90).days).toBe(12);
    expect(gapWindow(new Date(NOW.getTime() - 200 * D * 1000), NOW, 90).days).toBe(90);
    expect(gapWindow(null, NOW, 30)).toEqual({ after: NOW_S - 30 * D, days: 30 });
    expect(gapWindow(new Date(NOW.getTime() - 20 * D * 1000), NOW, 90).after).toBe(NOW_S - 21 * D);
  });
});

describe("quoteAddressForQuery (DESIGN §5.2 query safety)", () => {
  it("quotes valid addresses", () => {
    expect(quoteAddressForQuery("news@example.com")).toBe('"news@example.com"');
  });
  it.each([
    'a"b@x.com',
    "a b@x.com",
    "a\t@x.com",
    "{a}@x.com",
    "a@(x).com",
    "a\\@x.com",
    "a@x.com\n",
    "nobody",
    "@x.com",
    "a@",
    "a@b@c",
    "",
  ])("rejects %j", (addr) => {
    expect(() => quoteAddressForQuery(addr)).toThrow(QueryInjectionError);
  });
});

describe("nextPollDelay (FREE-TIER §4.3)", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  it.each([
    ["active, 30-min ticks", ago(1 * D * 1000), 30, 0, 30 * MIN],
    ["active, 60-min ticks", ago(6 * D * 1000), 60, 0, 60 * MIN],
    ["idle 7–30 d", ago(10 * D * 1000), 30, 0, 3 * H],
    ["idle > 30 d", ago(31 * D * 1000), 30, 0, 24 * H],
    ["never active", null, 30, 0, 24 * H],
    ["L1 doubles", ago(1 * D * 1000), 30, 1, 60 * MIN],
    ["L1 doubles idle", ago(10 * D * 1000), 30, 1, 6 * H],
    ["L1 never exceeds 24 h", ago(40 * D * 1000), 30, 1, 24 * H],
    ["L2 every 6 h", ago(1 * D * 1000), 30, 2, 6 * H],
    ["L2 keeps a longer idle interval", ago(40 * D * 1000), 60, 2, 24 * H],
    ["L3 once a day", ago(1 * D * 1000), 30, 3, 24 * H],
  ] as const)("%s", (_name, lastActiveAt, tickEvery, governorLevel, expected) => {
    expect(nextPollDelay({ lastActiveAt, now: NOW, tickEvery, governorLevel })).toBe(expected);
  });
});

describe("drain backoff (FREE-TIER §4.6)", () => {
  it("1 m → 5 m → 30 m → 2 h → 6 h", () => {
    expect([1, 2, 3, 4, 5, 6, 0].map(drainBackoff)).toEqual([
      MIN,
      5 * MIN,
      30 * MIN,
      2 * H,
      6 * H,
      6 * H,
      MIN,
    ]);
    expect(MAX_ATTEMPTS).toBe(5);
  });
  it("uses every backoff, then fails the row", () => {
    expect(ledgerFailureOutcome(1, NOW)).toEqual({
      state: "retry",
      nextAttemptAt: new Date(NOW.getTime() + MIN),
    });
    expect(ledgerFailureOutcome(5, NOW)).toEqual({
      state: "retry",
      nextAttemptAt: new Date(NOW.getTime() + 6 * H),
    });
    expect(ledgerFailureOutcome(6, NOW)).toEqual({ state: "failed" });
  });
});
