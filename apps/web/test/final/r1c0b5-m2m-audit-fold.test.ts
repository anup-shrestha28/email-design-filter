/**
 * m2m failure audit (m2m.ts): when a buffered row's write fails after its window has already rolled
 * over, the failures that row was to report move to the next window's row instead of being lost,
 * so `previousWindowCount` still adds up to every failure before the written row.
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

describe("m2m failure audit: a failed write after a window rollover", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries the unwritten row's earlier failures into the next window's row", async () => {
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

    // Window 2's row (previousWindowCount 2) is being written when window 3 starts, and the write fails.
    state.duringWrite = async () => {
      vi.setSystemTime(t0 + 22 * MIN);
      await recordM2mFailure("view-stats", "missing_token", "198.51.100.7");
    };
    await flushM2mFailures();
    expect(state.written).toEqual([]);

    // The next write reports all three failures before window 3: none were in a written row.
    await flushM2mFailures();
    expect(state.written).toEqual([{ target: "view-stats", metadata: { reason: "missing_token", previousWindowCount: 3 } }]);
  });
});
