/**
 * Wrapper for every Inngest step body (FREE-TIER.md §4.2, §8.1):
 *  - route class "job" for the database-wake metering;
 *  - CPU/wall metering, flushed at the end of the step together with the Inngest run/step counts
 *    the client's middleware recorded (./execution-meter.ts);
 *  - known vendor outages (database suspended, Gmail 5xx in bulk, Sandbox paused, AI spend limit)
 *    never throw: the step returns `{ skipped: "<reason>" }` and writes one app_error row, so
 *    Inngest Free never auto-pauses the function after 20 failures.
 */
import "server-only";
import { isDatabaseUnavailable, runWithRouteClass } from "@edf/db";
import type { PipelineDeps } from "@edf/pipeline";

export type Skipped = { skipped: string };

/**
 * A step that didn't do its work: `{ skipped: "<reason>" }` from runStep, or a job summary that
 * reports a skip reason (e.g. RenderSummary `skipped: "renderer_unavailable"`). Only a string reason
 * counts: summaries carry `skipped: null` when the work ran (RenderSummary, MaintenanceSummary), and
 * DrainResult counts skipped messages as a number — neither is a skipped step.
 */
export function isSkipped(x: unknown): x is Skipped {
  return typeof x === "object" && x !== null && typeof (x as { skipped?: unknown }).skipped === "string";
}

async function loadDeps(): Promise<PipelineDeps> {
  const { pipelineDeps } = await import("../pipeline-deps");
  return pipelineDeps();
}

export async function runStep<T>(name: string, fn: (deps: PipelineDeps) => Promise<T>): Promise<T | Skipped> {
  return runWithRouteClass("job", async () => {
    let deps: PipelineDeps;
    try {
      deps = await loadDeps();
    } catch (err) {
      return { skipped: isDatabaseUnavailable(err) ? "database_unavailable" : "init_failed" };
    }
    const { flushNeonAwake } = await import("@edf/budget");
    // The instance meter, which also holds the middleware's run/step counts (../metering.ts).
    const meter = (await import("../metering")).instanceMeter();
    try {
      return await meter.withMeter("step", () => fn(deps));
    } catch (err) {
      const { recordAppError } = await import("@edf/pipeline");
      const reason = isDatabaseUnavailable(err) ? "database_unavailable" : "error";
      await recordAppError(deps, `inngest.${name}`, err);
      if (reason === "database_unavailable") return { skipped: reason };
      // Unknown errors: still never throw repeatedly — Inngest retries are handled by our own
      // backoff in the ledger; a thrown error here would count towards auto-pause.
      return { skipped: reason };
    } finally {
      await meter.flush().catch(() => {});
      await flushNeonAwake(deps.pool).catch(() => {});
    }
  });
}
