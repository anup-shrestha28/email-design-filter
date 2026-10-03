/**
 * Inngest execution metering (FREE-TIER.md §2, §8.1 "Inngest middleware: +1 per run, +1 per step"),
 * counted the way Inngest bills: one per run plus one per step of every kind, sendEvent and sleep
 * included. Every step attempt counts (whether retries are billed is a week-1 check, §13; counting
 * them errs high).
 *  - a run: `onRunStart` on its first request only: never on replays, nor on the requests that run
 *    one of several parallel steps (those name the step to run, and their state is empty too);
 *  - `step.run` / `step.sendEvent`: `onStepStart`, once per attempt of the handler;
 *  - every other kind (sleep, waitForEvent, invoke, …) completes on Inngest's side, and the request
 *    that follows its completion carries it last on the executor's completed-step stack: it is
 *    counted there, once, when `wrapStep` meets it (the SDK never wraps it unmemoized).
 * Counts go into the caller's meter; the step's own flush (runStep) writes them, and whatever is
 * left when the request ends (a sleep, a trailing sendEvent) is flushed then, unless `canFlush`
 * says the database is asleep (then the next step's or UI flush writes it).
 * No `server-only` / `@/` imports: the meter comes from the caller, so tests can drive a real run.
 */
import { Middleware } from "inngest";
import type { Meter } from "@edf/budget";

const HANDLER_STEPS: ReadonlySet<string> = new Set(["run", "sendEvent"]);
// RESOURCES.inngestExecutions; a literal keeps @edf/budget (and pg) out of the route's import graph.
const EXECUTIONS = "inngest.executions";

/** The step whose completion triggered this request (the last entry of `ctx.stack.stack`). */
function lastCompletedStep(body: unknown): string | undefined {
  const stack = (body as { ctx?: { stack?: { stack?: unknown } | null } | null } | null)?.ctx?.stack?.stack;
  const last = Array.isArray(stack) ? stack.at(-1) : undefined;
  return typeof last === "string" ? last : undefined;
}

/**
 * The step this request was sent to run (the executor's `stepId` query parameter; "step" means
 * "run the function from the top"). `requestInfo.headers` are the SDK's response headers, so a
 * request header can't be read here.
 */
function requestedStep(url: URL): string | undefined {
  const id = url.searchParams.get("stepId");
  return id && id !== "step" ? id : undefined;
}

export function executionMeter(
  meter: () => Promise<Meter>,
  canFlush: () => Promise<boolean> = async () => true,
): Middleware.Class {
  return class ExecutionMeter extends Middleware.BaseMiddleware {
    readonly id = "edf-execution-meter";
    // Middleware instances are created per request.
    private lastCompleted: string | undefined;
    private stepRequested = false;

    override async wrapRequest({ next, requestInfo }: Middleware.WrapRequestArgs): Promise<Middleware.Response> {
      this.lastCompleted = lastCompletedStep(await requestInfo.body().catch(() => null));
      this.stepRequested = requestedStep(requestInfo.url) !== undefined;
      try {
        return await next();
      } finally {
        const m = await meter().catch(() => null);
        if (m && [...m.pending().keys()].some((k) => k.endsWith(` ${EXECUTIONS}`)) && (await canFlush().catch(() => false)))
          await m.flush().catch(() => {});
      }
    }

    override async onRunStart(): Promise<void> {
      if (!this.stepRequested) (await meter()).recordInngest(1, 0);
    }

    override async onStepStart(): Promise<void> {
      (await meter()).recordInngest(0, 1);
    }

    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs): Promise<unknown> {
      if (stepInfo.memoized && !HANDLER_STEPS.has(String(stepInfo.stepType)) && stepInfo.hashedId === this.lastCompleted) {
        (await meter()).recordInngest(0, 1);
      }
      return next();
    }
  };
}
