/**
 * Inngest function residuals, with the job bodies replaced by in-memory stand-ins:
 *  - C1-10: an on-demand run whose first plan runs a moment after 04:30 UTC (the nightly cron firing
 *    a few seconds late and dropped by the singleton) still makes a nightly round;
 *  - C1-00: the tick's "ai" step hands submitClassificationBatch the step's start time, so the
 *    120 s prep budget includes collectBatches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Job from "@/server/inngest/job";

type Handler = (ctx: { event: { name: string; data?: unknown }; step: unknown; runId: string }) => Promise<unknown>;

const s = vi.hoisted(() => ({
  calls: [] as string[],
  queue: [] as string[],
  duringRender: null as null | (() => void),
  collectMs: 0,
  submitOpts: [] as Array<{ startedAt?: number } | undefined>,
  collectStartedAt: 0,
}));

vi.mock("@/server/inngest/client", () => ({
  inngest: { createFunction: (opts: unknown, handler: Handler) => ({ opts, handler }) },
}));
// The real isSkipped (a stand-in once hid that every RenderSummary looked skipped); runStep without metering.
vi.mock("@/server/inngest/job", async () => ({
  isSkipped: (await vi.importActual<typeof Job>("@/server/inngest/job")).isSkipped,
  runStep: async (_name: string, fn: (deps: unknown) => Promise<unknown>) => fn({ pool: {}, alerts: null }),
}));
vi.mock("@edf/budget", () => ({
  runGovernor: async () => ({ alerts: [], result: { level: 0, actions: {} } }),
}));
vi.mock("@edf/db", () => ({
  withSystem: async (_pool: unknown, fn: (db: unknown, c: unknown) => Promise<unknown>) =>
    fn(null, { query: async () => ({ rows: [{ open: "1", pending: "3" }] }) }),
}));
vi.mock("@edf/pipeline", () => ({
  raiseAlert: async () => {},
  recordAppError: async () => {},
  sweepAndMeterSandboxes: async () => {},
  pollDueMailboxes: async () => ({ polled: 0, inserted: 0 }),
  sweepImportance: async () => 0,
  releaseFinishedBackfill: async () => null,
  drainEligibleCount: async () => 0,
  listNewSenderChecks: async () => [],
  onDemandRenderDue: async () => false,
  takeContinuationKick: async () => false,
  freshRenderDue: async () => false,
  heartbeat: async () => {
    s.calls.push("heartbeat");
  },
  collectBatches: async () => {
    s.collectStartedAt = Date.now();
    vi.setSystemTime(Date.now() + s.collectMs); // a slow collection
    return { adopted: 0, ended: 0, applied: 0, released: 0 };
  },
  submitClassificationBatch: async (_deps: unknown, opts?: { startedAt?: number }) => {
    s.submitOpts.push(opts);
    return { queued: 0 };
  },
  planRenders: async (_deps: unknown, trigger: string) => {
    s.calls.push(`plan:${trigger}`);
    return [...new Set(s.queue)].map((userId) => ({ userId, options: {} }));
  },
  renderForUser: async (_deps: unknown, userId: string) => {
    const picked = s.queue.filter((u) => u === userId).length;
    s.queue = s.queue.filter((u) => u !== userId);
    s.duringRender?.();
    // A real RenderSummary (render.ts): `skipped` is null when the step rendered.
    return { picked, rendered: picked, failed: 0, gone: 0, upgraded: 0, aiQueued: 0, skipped: null };
  },
}));

const step = {
  run: async (_id: string, fn: () => Promise<unknown>) => fn(),
  sendEvent: async () => {},
};

beforeEach(() => {
  s.calls = [];
  s.queue = [];
  s.duringRender = null;
  s.collectMs = 0;
  s.submitOpts = [];
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("render-batch: the nightly cron fired late and was dropped (C1-10)", () => {
  it("an on-demand run whose first plan ran seconds after 04:30 UTC makes its next round the nightly one", async () => {
    const { renderBatch } = await import("@/server/inngest/functions");
    vi.setSystemTime(new Date("2042-06-10T04:30:02Z"));
    s.queue = ["u1"];
    // The cron fires at 04:30:04 while this run renders, and is skipped by the singleton.
    s.duringRender = () => {
      vi.setSystemTime(new Date("2042-06-10T04:32:00Z"));
      s.duringRender = null;
    };
    await (renderBatch as unknown as { handler: Handler }).handler({ event: { name: "render/requested", data: {} }, step, runId: "r" });
    expect(s.calls.filter((c) => c.startsWith("plan:"))).toEqual(["plan:on_demand", "plan:nightly"]);
  });

  it("a run that starts well after 04:30 adds no nightly round", async () => {
    const { renderBatch } = await import("@/server/inngest/functions");
    vi.setSystemTime(new Date("2042-06-10T04:40:00Z"));
    s.queue = ["u1"];
    s.duringRender = () => vi.setSystemTime(new Date("2042-06-10T04:42:00Z"));
    await (renderBatch as unknown as { handler: Handler }).handler({ event: { name: "render/requested", data: {} }, step, runId: "r" });
    expect(s.calls.filter((c) => c.startsWith("plan:"))).toEqual(["plan:on_demand", "plan:on_demand"]);
  });
});

describe("pipeline-tick: the classification prep budget (C1-00)", () => {
  it("counts from the start of the ai step, collection included", async () => {
    const { pipelineTick } = await import("@/server/inngest/functions");
    vi.setSystemTime(new Date("2042-06-10T10:00:00Z"));
    s.collectMs = 150_000;
    await (pipelineTick as unknown as { handler: Handler }).handler({ event: { name: "pipeline/kick" }, step, runId: "t" });
    expect(s.submitOpts).toHaveLength(1);
    expect(s.submitOpts[0]?.startedAt).toBe(s.collectStartedAt);
    expect(Date.now() - s.submitOpts[0]!.startedAt!).toBeGreaterThanOrEqual(150_000);
  });
});
