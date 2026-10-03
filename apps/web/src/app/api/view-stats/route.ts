/** POST /api/view-stats — content-free request counters from edf-view (FREE-TIER.md §9.2). */
import { runWithRouteClass } from "@edf/db";
import { authenticateCaller, jsonError } from "@/server/m2m";
import { meterRequest } from "@/server/metering";
import { recordServiceCounts } from "@/server/service-counts";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return runWithRouteClass("job", () =>
    meterRequest(async () => {
      const caller = await authenticateCaller(request, "view-stats");
      if (!caller) return jsonError(401, "unauthorized");
      const ok = await recordServiceCounts("edf-view", request);
      return ok ? new Response(null, { status: 204 }) : jsonError(400, "bad_body");
    }),
  );
}
