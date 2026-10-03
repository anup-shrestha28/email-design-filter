/** GET /api/view-source/{token}/{emailId} — edf-view only (OIDC + HMAC view token). FREE-TIER.md §9.3 (modes img / noimg / card). */
import { runWithRouteClass } from "@edf/db";
import { JSON_HEADERS, authenticateCaller, jsonError, recordM2mFailure, clientIp } from "@/server/m2m";
import { meterOriginBytes, meterRequest, meterUnsignableUrls } from "@/server/metering";
import { buildViewSource } from "@/server/view-source";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function GET(request: Request, ctx: { params: Promise<{ token: string; emailId: string }> }) {
  return runWithRouteClass("job", () =>
    meterRequest(async () => {
      const caller = await authenticateCaller(request, "view-source");
      if (!caller) return jsonError(401, "unauthorized");
      const { token, emailId } = await ctx.params;
      const r = await buildViewSource(decodeURIComponent(token), emailId);
      if (!r.ok) {
        if (r.status === 401) await recordM2mFailure("view-source", "bad_view_token", clientIp(request));
        return jsonError(r.status, r.error);
      }
      const body = JSON.stringify({ html: r.html, height: r.height });
      // Fast Origin Transfer (FREE-TIER.md §8.1): this HTML twice (to edf-view, then in edf-view's
      // /v page), metered in this request. The view's images are not metered here (their minted
      // allowances are only an upper bound, ~5× the real bytes for a gallery card): edf-view
      // reports the exact bytes it serves to /api/view-stats, which meters them (service-counts.ts).
      meterOriginBytes({ body: 2 * Buffer.byteLength(body) });
      meterUnsignableUrls(r.unsignableUrls);
      return new Response(body, { status: 200, headers: JSON_HEADERS });
    }, { maxDuration }),
  );
}
