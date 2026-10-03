/**
 * Inngest executions are metered the way Inngest bills them (FREE-TIER §2, §8.1): +1 per run and
 * +1 per step of every kind (step.run, sendEvent, sleep), each counted once however often the run
 * is replayed. Drives real functions through the SDK's HTTP handler, playing the executor's part,
 * with edf-app's middleware; both the plain async protocol and checkpointing (the v4 default).
 */
import { describe, expect, it } from "vitest";
import { Inngest } from "inngest";
import { serve } from "inngest/edge";
import { ALL_PLATFORMS, createMeter, platformMetering, RESOURCES as R, type Meter, type PlatformMetering } from "@edf/budget";
import { executionMeter } from "@/server/inngest/execution-meter";

type Op = { id: string; op: string; data?: unknown };

/**
 * A meter that never writes (flush only counts calls), so the counts stay readable in `pending()`.
 * It meters Inngest as production does unless told otherwise (`platforms`).
 */
function memoryMeter(platforms: PlatformMetering = ALL_PLATFORMS): Meter & { flushes: number } {
  const m = createMeter({ pool: undefined as never, platforms });
  const out = Object.assign(Object.create(null) as object, m, { flushes: 0 }) as Meter & { flushes: number };
  out.flush = async () => {
    out.flushes++;
  };
  return out;
}

function total(meter: Meter, code: string): number {
  let n = 0;
  for (const [k, v] of meter.pending()) if (k.endsWith(` ${code}`)) n += v;
  return n;
}

/**
 * Plays Inngest's executor for one run: sends the memoized step state and the completed-step stack
 * on every request, records the ops each response (or, with checkpointing, each checkpoint call)
 * reports, and answers the event API for step.sendEvent.
 */
function executor(checkpointing: boolean) {
  const steps: Record<string, { type: "data"; data: unknown }> = {};
  const stack: string[] = [];
  const record = (ops: Op[]): string => {
    let planned = "step";
    for (const op of ops) {
      if (op.op === "StepPlanned") planned = op.id;
      else if (op.op !== "DiscoveryRequest" && !(op.id in steps)) {
        steps[op.id] = { type: "data", data: op.op === "Sleep" ? null : (op.data ?? null) };
        stack.push(op.id);
      }
    }
    return planned;
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/checkpoint/")) {
      record((JSON.parse(String(init?.body)) as { steps: Op[] }).steps);
      return Response.json({});
    }
    return Response.json({ ids: ["e1"], status: 200 });
  }) as typeof globalThis.fetch;

  /** Run one function to completion; returns the number of HTTP requests it took. */
  async function run(handler: (req: Request) => Promise<Response>, fnId: string): Promise<number> {
    const event = { name: "test/go", data: {}, id: "evt-1", ts: Date.now() };
    let stepId = "step";
    for (let requests = 1; requests <= 50; requests++) {
      const res = await handler(
        new Request(`http://localhost/api/inngest?fnId=${fnId}&stepId=${stepId}`, {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost" },
          body: JSON.stringify({
            version: 2,
            event,
            events: [event],
            steps,
            ctx: {
              run_id: "run-1",
              attempt: 0,
              stack: { stack, current: stack.length },
              ...(checkpointing ? { fn_id: "internal-fn-id", qi_id: "queue-item" } : {}),
            },
          }),
        }),
      );
      if (res.status === 200) return requests;
      if (res.status !== 206) throw new Error(`unexpected ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as Op[] | Op;
      const ops = Array.isArray(body) ? body : [body];
      if (ops.some((op) => op.op === "RunComplete")) return requests; // checkpointing's way of finishing
      stepId = record(ops);
    }
    throw new Error("run did not finish");
  }
  return { fetch, run };
}

describe("Inngest execution metering (runs + every step)", () => {
  for (const checkpointing of [false, true]) {
    const mode = checkpointing ? "checkpointing" : "async";

    it(`counts 1 run + run/sleep/sendEvent/run steps once each, across replays (${mode})`, async () => {
      const meter = memoryMeter();
      const ex = executor(checkpointing);
      const client = new Inngest({ id: "edf-meter-test", isDev: true, middleware: [executionMeter(async () => meter)], fetch: ex.fetch });
      const fn = client.createFunction({ id: "flow", triggers: [{ event: "test/go" }], retries: 0 }, async ({ step }) => {
        await step.run("a", () => 1);
        await step.sleep("pause", "1s");
        await step.sendEvent("kick", { name: "test/next", data: {} });
        await step.run("b", () => 2);
        return "done";
      });
      const requests = await ex.run(serve({ client, functions: [fn] }), "edf-meter-test-flow");
      expect(requests).toBeGreaterThan(1); // replays happened
      expect(total(meter, R.inngestRuns)).toBe(1);
      expect(total(meter, R.inngestSteps)).toBe(4);
      expect(total(meter, R.inngestExecutions)).toBe(5);
      expect(meter.flushes).toBeGreaterThan(0); // requests without a step.run still flush
    });

    it(`a run that ends on a sleep still counts it (${mode})`, async () => {
      const meter = memoryMeter();
      const ex = executor(checkpointing);
      const client = new Inngest({ id: "edf-meter-test", isDev: true, middleware: [executionMeter(async () => meter)], fetch: ex.fetch });
      const fn = client.createFunction({ id: "grace", triggers: [{ event: "test/go" }], retries: 0 }, async ({ step }) => {
        await step.sleep("grace", "10m");
        return "done";
      });
      await ex.run(serve({ client, functions: [fn] }), "edf-meter-test-grace");
      expect(total(meter, R.inngestExecutions)).toBe(2);
    });

    it(`parallel first steps count the run once (${mode})`, async () => {
      const meter = memoryMeter();
      const ex = executor(checkpointing);
      const client = new Inngest({ id: "edf-meter-test", isDev: true, middleware: [executionMeter(async () => meter)], fetch: ex.fetch });
      const fn = client.createFunction({ id: "fan", triggers: [{ event: "test/go" }], retries: 0 }, async ({ step }) => {
        await Promise.all([step.run("a", () => 1), step.run("b", () => 2), step.run("c", () => 3)]);
        return "done";
      });
      await ex.run(serve({ client, functions: [fn] }), "edf-meter-test-fan");
      expect(total(meter, R.inngestRuns)).toBe(1);
      expect(total(meter, R.inngestSteps)).toBe(3);
    });

    it(`leaves a request's counts buffered while the database sleeps (${mode})`, async () => {
      const meter = memoryMeter();
      const ex = executor(checkpointing);
      const mw = executionMeter(async () => meter, async () => false);
      const client = new Inngest({ id: "edf-meter-test", isDev: true, middleware: [mw], fetch: ex.fetch });
      const fn = client.createFunction({ id: "grace", triggers: [{ event: "test/go" }], retries: 0 }, async ({ step }) => {
        await step.sleep("grace", "10m");
        return "done";
      });
      await ex.run(serve({ client, functions: [fn] }), "edf-meter-test-grace");
      expect(meter.flushes).toBe(0); // written by the next step's or UI flush instead
      expect(total(meter, R.inngestExecutions)).toBe(2);
    });
  }

  it("with the Inngest Dev Server (pnpm dev) a run's executions are not Inngest usage: nothing is counted or flushed", async () => {
    // INNGEST_DEV=1 off Vercel, as in apps/web/.env.local (EDF_METER_LOCAL=1 would count them).
    const meter = memoryMeter(platformMetering({ INNGEST_DEV: "1", DATABASE_URL: "postgres://app_rw:pw@localhost:5433/edf" }));
    const ex = executor(false);
    const client = new Inngest({ id: "edf-meter-test", isDev: true, middleware: [executionMeter(async () => meter)], fetch: ex.fetch });
    const fn = client.createFunction({ id: "flow", triggers: [{ event: "test/go" }], retries: 0 }, async ({ step }) => {
      await step.run("a", () => 1);
      await step.sleep("pause", "1s");
      await step.run("b", () => 2);
      return "done";
    });
    expect(await ex.run(serve({ client, functions: [fn] }), "edf-meter-test-flow")).toBeGreaterThan(1);
    expect(total(meter, R.inngestExecutions)).toBe(0);
    expect(meter.pending().size).toBe(0);
    expect(meter.flushes).toBe(0);
  });

  it("edf-app's client carries the execution meter", async () => {
    const { inngest } = await import("@/server/inngest/client");
    expect(inngest.middleware.some((m) => m.name === "ExecutionMeter")).toBe(true);
  });
});
