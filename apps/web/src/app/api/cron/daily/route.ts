/**
 * GET /api/cron/daily — the one daily Vercel cron (FREE-TIER.md §4.9): privacy work, maintenance,
 * governor, and the watchdog that keeps mail flowing if Inngest is paused (Plan B). 270 s budget.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import { runWithRouteClass } from "@edf/db";
import { env } from "@/env";
import { clientIp, flushM2mFailures, recordM2mFailure } from "@/server/m2m";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export function GET(request: Request) {
  return runWithRouteClass("job", async () => {
    const secret = env().CRON_SECRET;
    const auth = request.headers.get("authorization") ?? "";
    if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
      await recordM2mFailure("cron-daily", "bad_cron_secret", clientIp(request));
      return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const [{ pipelineDeps }, pipeline, budget] = await Promise.all([
      import("@/server/pipeline-deps"),
      import("@edf/pipeline"),
      import("@edf/budget"),
    ]);
    const deps = await pipelineDeps();
    const meter = budget.createMeter({ pool: deps.pool });
    try {
      const summary = await meter.withMeter("route", () =>
        pipeline.runDailyCron(deps, {
          governor: async () => {
            const gov = await budget.runGovernor(deps.pool);
            for (const a of gov.alerts) await pipeline.raiseAlert(deps.pool, deps.alerts ?? { token: undefined, repo: undefined }, a as never);
          },
        }),
      );
      return Response.json({ ok: true, watchdog: summary.watchdog }, { headers: { "Cache-Control": "no-store" } });
    } finally {
      await flushM2mFailures(); // failures buffered while the database was asleep (m2m.ts)
      await meter.flush().catch(() => {});
      await budget.flushNeonAwake(deps.pool).catch(() => {});
    }
  });
}
