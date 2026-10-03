/** GET /api/mailboxes/google/start — begin connecting a Gmail mailbox (DESIGN.md §4.3). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithRouteClass } from "@edf/db";
import { startConnect } from "@/server/connect";
import { meterRequest } from "@/server/metering";
import { StaleSessionError, UnauthorizedError, requireFreshSession } from "@/server/session";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return runWithRouteClass("authed", () =>
    meterRequest(async () => {
      const back = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303 });
      let user;
      try {
        user = await requireFreshSession();
      } catch (err) {
        if (err instanceof UnauthorizedError) return back("/sign-in");
        if (err instanceof StaleSessionError) return back("/sign-in?reauth=connect");
        throw err;
      }
      const reconnect = request.nextUrl.searchParams.get("reconnect") === "1";
      const hint = request.nextUrl.searchParams.get("hint");
      const loginHint = hint && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(hint) ? hint : null;
      const r = await startConnect(user, { loginHint, reconnect });
      if (r.kind === "error") return back(`/connect?error=${r.code}`);
      const res = NextResponse.redirect(r.url, { status: 303 });
      res.headers.append("Set-Cookie", r.cookie);
      res.headers.set("Cache-Control", "no-store");
      res.headers.set("Referrer-Policy", "no-referrer");
      return res;
    }),
  );
}
