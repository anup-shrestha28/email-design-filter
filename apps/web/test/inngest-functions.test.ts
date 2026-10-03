/**
 * The coarse Inngest functions' control flow (FREE-TIER.md §4.2, §4.7, §5.1, §8.3), with the job
 * bodies replaced by in-memory stand-ins:
 *  - render-batch: a render/requested event sent while a run is active is dropped (singleton skip),
 *    so the run re-plans until no on-demand work remains, within MAX_RENDER_ROUNDS, and stops when
 *    a round picks nothing up (counted from real RenderSummary results with the real isSkipped); the nightly cron, dropped the same way while an on-demand run is
 *    active at 04:30 UTC, becomes that run's next round or one extra round after it;
 *  - pipeline-tick: finished Sandbox VMs are metered before the governor runs, so this tick's
 *    Sandbox switches count them; on-demand requests still queued get their event re-sent (not while
 *    renders are nightly-only); a fresh batch due after the drain gets its own render/requested
 *    (checked after the heartbeat, and a failed check never fails the tick).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Job from "@/server/inngest/job";

type Handler = (ctx: { event: { name: string; data?: unknown }; step: unknown; runId: string }) => Promise<unknown>;

const s = vi.hoisted(() => ({
  calls: [] as string[],
  /** Users with queued on-demand requests. */
  queue: [] as string[],
  /** Clicks that arrive while render round N runs: round → users. */
  clicksDuring: new Map<number, string[]>(),
  round: -1,
  pickNothing: false,
  /** Emails one render step picks at most (render.ts MAX_EMAILS_PER_BATCH); the rest wait for the next round. */
  batchMax: Number.POSITIVE_INFINITY,
  /** The render step's skip reason (RenderSummary.skipped): "renderer_unavailable", "governor", … */
  renderSkipped: null as string | null,
  renderDue: false,
  /** freshRenderDue's answer; an Error is thrown (the check failed). */
  freshDue: false as boolean | Error,
  nightlyOnly: false,
  /** Runs inside each render step, after the pick (e.g. the clock moving on while the VM renders). */
  duringRender: null as null | (() => void),
  /** Runs inside each heartbeat. */
  duringHeartbeat: null as null | (() => void),
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
  runGovernor: async () => {
    s.calls.push("governor");
    return { alerts: [], result: { level: 0, actions: { rendersNightlyOnly: s.nightlyOnly } } };
  },
}));
vi.mock("@edf/db", () => ({
  withSystem: async (_pool: unknown, fn: (db: unknown, c: unknown) => Promise<unknown>) =>
    fn(null, { query: async () => ({ rows: [{ open: "0", pending: "0" }] }) }),
}));
vi.mock("@edf/pipeline", () => ({
  raiseAlert: async () => {},
  recordAppError: async () => {},
  sweepAndMeterSandboxes: async () => {
    s.calls.push("sweep");
  },
  pollDueMailboxes: async () => ({ polled: 0, inserted: 0 }),
  sweepImportance: async () => 0,
  releaseFinishedBackfill: async () => null,
  drainEligibleCount: async () => 0,
  listNewSenderChecks: async () => [],
  onDemandRenderDue: async () => {
    s.calls.push("render-due");
    return s.renderDue;
  },
  takeContinuationKick: async () => false,
  freshRenderDue: async () => {
    s.calls.push("fresh-due");
    if (s.freshDue instanceof Error) throw s.freshDue;
    return s.freshDue;
  },
  heartbeat: async () => {
    s.calls.push("heartbeat");
    s.duringHeartbeat?.();
  },
  planRenders: async (_deps: unknown, trigger: string) => {
    s.round++;
    s.calls.push(`plan:${trigger}`);
    return [...new Set(s.queue)].map((userId) => ({ userId, options: {} }));
  },
  renderForUser: async (_deps: unknown, userId: string) => {
    // A real RenderSummary (render.ts): `skipped` is null when the step rendered, a reason when it didn't.
    const summary = (picked: number) => ({ picked, rendered: picked, failed: 0, gone: 0, upgraded: 0, aiQueued: 0, skipped: s.renderSkipped });
    if (s.renderSkipped !== null) return summary(0);
    let take = s.pickNothing ? 0 : Math.min(s.batchMax, s.queue.filter((u) => u === userId).length);
    const picked = take;
    s.queue.splice(0, s.queue.length, ...s.queue.filter((u) => u !== userId || take-- <= 0));
    // Clicks that arrive after the pick, while the VM renders: their events are dropped (the run is active).
    for (const u of s.clicksDuring.get(s.round) ?? []) s.queue.push(u);
    s.clicksDuring.delete(s.round);
    s.duringRender?.();
    // Step results reach the function through JSON (Inngest memoizes them), null included.
    return JSON.parse(JSON.stringify(summary(picked))) as ReturnType<typeof summary>;
  },
}));

function fakeStep() {
  const sent: Array<{ id: string; event: { id?: string; name: string; data: unknown } }> = [];
  const step = {
    run: async (_id: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: async (id: string, event: { id?: string; name: string; data: unknown }) => {
      sent.push({ id, event });
    },
  };
  return { step, sent };
}

beforeEach(() => {
  s.calls = [];
  s.queue = [];
  s.clicksDuring = new Map();
  s.round = -1;
  s.pickNothing = false;
  s.batchMax = Number.POSITIVE_INFINITY;
  s.renderSkipped = null;
  s.renderDue = false;
  s.freshDue = false;
  s.nightlyOnly = false;
  s.duringRender = null;
  s.duringHeartbeat = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("render-batch", () => {
  const run = async (event: { name: string; data?: unknown } = { name: "render/requested", data: { userId: "u1" } }) => {
    const { renderBatch } = await import("@/server/inngest/functions");
    const { step } = fakeStep();
    return (renderBatch as unknown as { handler: Handler }).handler({ event, step, runId: "r" });
  };
  const plans = () => s.calls.filter((c) => c.startsWith("plan:"));
  const at = (iso: string) => () => vi.setSystemTime(new Date(iso));

  it("keeps re-planning while clicks arrive during the run, until the on-demand queue is empty", async () => {
    s.queue = ["u1"];
    // One user clicking through emails: each click lands while the previous round renders.
    for (let r = 0; r < 5; r++) s.clicksDuring.set(r, ["u1"]);
    await run();
    expect(s.queue).toEqual([]);
    expect(s.calls.filter((c) => c.startsWith("plan:"))).toHaveLength(7); // 6 rounds with work, then an empty plan
  });

  it("stops at MAX_RENDER_ROUNDS when new work keeps arriving; the tick re-sends for the rest", async () => {
    const { MAX_RENDER_ROUNDS } = await import("@/server/inngest/functions");
    s.queue = ["u1"];
    for (let r = 0; r < 100; r++) s.clicksDuring.set(r, ["u1"]);
    await run();
    expect(s.calls.filter((c) => c.startsWith("plan:"))).toHaveLength(MAX_RENDER_ROUNDS);
    expect(s.queue).toEqual(["u1"]);
  });

  it("stops after an on-demand round that picked nothing up", async () => {
    s.queue = ["u1"];
    s.pickNothing = true;
    await run();
    expect(s.calls.filter((c) => c.startsWith("plan:"))).toHaveLength(1);
  });

  it("runs a second round when one VM's batch left work behind (a real RenderSummary, skipped: null)", async () => {
    // 30 queued for u1, 25 per step: round 0 takes 25, round 1 the other 5, round 2 plans nothing.
    s.queue = Array.from({ length: 30 }, () => "u1");
    s.batchMax = 25;
    await run();
    expect(plans()).toEqual(["plan:on_demand", "plan:on_demand", "plan:on_demand"]);
    expect(s.queue).toEqual([]);
  });

  it("a render step that reports a skip reason counts as no progress: the run stops", async () => {
    for (const reason of ["renderer_unavailable", "governor", "sandbox_error"]) {
      s.calls = [];
      s.round = -1;
      s.queue = ["u1", "u1"];
      s.renderSkipped = reason;
      await run();
      expect(plans(), reason).toEqual(["plan:on_demand"]);
    }
  });

  describe("the nightly cron dropped while an on-demand run is active", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });

    it("an on-demand run still rendering at 04:30 UTC makes its next round the nightly one", async () => {
      vi.setSystemTime(new Date("2042-06-10T04:28:00Z"));
      s.queue = ["u1"];
      s.clicksDuring.set(0, ["u2"]);
      s.duringRender = at("2042-06-10T04:31:00Z"); // the 04:30 cron fires (and is skipped) meanwhile
      await run();
      expect(plans()).toEqual(["plan:on_demand", "plan:nightly", "plan:on_demand"]);
      expect(s.queue).toEqual([]);
    });

    it("when the cron fires after the run's last plan, one nightly round follows the heartbeat", async () => {
      vi.setSystemTime(new Date("2042-06-10T04:28:00Z"));
      s.queue = ["u1"];
      s.duringHeartbeat = at("2042-06-10T04:30:05Z");
      await run();
      expect(plans()).toEqual(["plan:on_demand", "plan:on_demand", "plan:nightly"]);
      expect(s.calls.filter((c) => c === "heartbeat")).toHaveLength(2);
    });

    it("a run that ends before 04:30, or the nightly run itself, adds no nightly round", async () => {
      vi.setSystemTime(new Date("2042-06-10T04:20:00Z"));
      s.queue = ["u1"];
      s.duringRender = at("2042-06-10T04:29:59Z");
      await run();
      expect(plans()).toEqual(["plan:on_demand", "plan:on_demand"]);

      s.calls = [];
      s.round = -1;
      vi.setSystemTime(new Date("2042-06-10T04:30:00Z"));
      s.queue = ["u1"];
      s.clicksDuring.set(0, ["u2"]);
      s.duringRender = null;
      s.duringHeartbeat = at("2042-06-11T04:30:05Z"); // the nightly run never adds another nightly round
      await run({ name: "inngest/scheduled.timer" });
      expect(plans()).toEqual(["plan:nightly", "plan:on_demand", "plan:on_demand"]);
    });
  });
});

describe("pipeline-tick", () => {
  const run = async () => {
    const { pipelineTick } = await import("@/server/inngest/functions");
    const f = fakeStep();
    await (pipelineTick as unknown as { handler: Handler }).handler({ event: { name: "pipeline/kick" }, step: f.step, runId: "run-7" });
    return f.sent;
  };

  it("meters finished Sandbox VMs before the governor runs", async () => {
    await run();
    expect(s.calls.indexOf("sweep")).toBeGreaterThanOrEqual(0);
    expect(s.calls.indexOf("sweep")).toBeLessThan(s.calls.indexOf("governor"));
  });

  it("re-sends render/requested when on-demand requests are still queued", async () => {
    s.renderDue = true;
    const sent = await run();
    expect(sent).toEqual([{ id: "render-sweep", event: { id: "render-sweep-run-7", name: "render/requested", data: { reason: "sweep" } } }]);
  });

  it("sends nothing when no on-demand work is due, or while renders are nightly-only", async () => {
    expect(await run()).toEqual([]);
    s.calls = [];
    s.renderDue = true;
    s.nightlyOnly = true;
    expect(await run()).toEqual([]);
    expect(s.calls).not.toContain("render-due");
  });

  it("asks for a fresh batch after the drain and the heartbeat, when one is due", async () => {
    s.freshDue = true;
    const sent = await run();
    expect(sent).toEqual([{ id: "render-fresh", event: { id: "render-fresh-run-7", name: "render/requested", data: { reason: "fresh" } } }]);
    expect(s.calls.indexOf("heartbeat")).toBeLessThan(s.calls.indexOf("fresh-due"));
  });

  it("a fresh batch and an on-demand sweep in one tick send one event each (the render run drops the second)", async () => {
    s.renderDue = true;
    s.freshDue = true;
    const sent = await run();
    expect(sent.map((x) => x.event.id)).toEqual(["render-sweep-run-7", "render-fresh-run-7"]);
  });

  it("a failed fresh-render check never fails the tick", async () => {
    s.freshDue = new Error("db down");
    await expect(run()).resolves.toEqual([]);
    expect(s.calls).toContain("heartbeat");
  });
});
