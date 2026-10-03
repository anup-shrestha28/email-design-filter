/**
 * m2m failure audit (m2m.ts): a buffered row whose write fails after its window rolled over, and
 * after the new window's row was already written by a concurrent flush, still gets its earlier
 * failures reported (by the row after that) instead of losing them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  awake: false,
  written: [] as Array<{ target: string; metadata: { reason: string; previousWindowCount: number } }>,
  duringWrite: null as null | (() => Promise<void>),
}));

vi.mock("@/env", () => ({ env: () => ({}), IS_PROD: false }));
vi.mock("@/server/db", () => ({ getPool: async () => ({}) }));
vi.mock("@/server/metering", () => ({
  databaseAwake: () => state.awake,
  withoutMarkingDbUse: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("@edf/db", () => ({
  withSystem: async (_pool: unknown, fn: (db: unknown, c: unknown) => Promise<void>) => {
    const hook = state.duringWrite;
    state.duringWrite = null;
    if (hook) {
      await hook();
      throw new Error("insert failed");
    }
    const rows: typeof state.written = [];
    await fn(null, {
      query: async (_sql: string, params: [string, string | null, string]) => {
        rows.push({ target: params[0], metadata: JSON.parse(params[2]) as (typeof rows)[number]["metadata"] });
      },
    });
    state.written.push(...rows);
  },
}));

const MIN = 60_000;

describe("m2m failure audit: a failed write after the next window's row was written", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the failed row's earlier failures in a later row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-28T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { recordM2mFailure, flushM2mFailures } = await import("@/server/m2m");

    // Asleep: two failures in window 1, one in window 2 (window 1's row was never written).
    state.awake = false;
    await recordM2mFailure("view-stats", "missing_token", "198.51.100.7");
    await recordM2mFailure("view-stats", "missing_token", "198.51.100.7");
    vi.setSystemTime(t0 + 11 * MIN);
    await recordM2mFailure("view-stats", "missing_token", "198.51.100.7");

    // Window 2's row (previousWindowCount 2) is being written when window 3 starts; the database is
    // awake, so window 3's failure starts a second flush that writes window 3's row (reporting
    // window 2's one failure). Then window 2's write fails.
    state.duringWrite = async () => {
      vi.setSystemTime(t0 + 22 * MIN);
      state.awake = true;
      await recordM2mFailure("view-stats", "missing_token", "198.51.100.7");
      state.awake = false;
    };
    await flushM2mFailures();
    expect(state.written).toEqual([{ target: "view-stats", metadata: { reason: "missing_token", previousWindowCount: 1 } }]);

    // Window 4's row reports window 3's failure plus window 1's two, which no written row reported.
    vi.setSystemTime(t0 + 33 * MIN);
    await recordM2mFailure("view-stats", "missing_token", "198.51.100.7");
    await flushM2mFailures();
    expect(state.written).toEqual([
      { target: "view-stats", metadata: { reason: "missing_token", previousWindowCount: 1 } },
      { target: "view-stats", metadata: { reason: "missing_token", previousWindowCount: 3 } },
    ]);
    // Every failure before window 4 is reported exactly once.
    expect(state.written.reduce((n, r) => n + r.metadata.previousWindowCount, 0)).toBe(4);
  });
});
