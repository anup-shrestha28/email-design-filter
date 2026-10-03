/** GET /api/mailboxes/google/callback — finish connecting (DESIGN.md §4.3). */
import { NextResponse, type NextRequest } from "next/server";
import { runWithRouteClass } from "@edf/db";
import { CONNECT_COOKIE, finishConnect } from "@/server/connect";
import { meterRequest } from "@/server/metering";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return runWithRouteClass("authed", () =>
    meterRequest(async () => {
      const clearCookie = `${CONNECT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
      const done = (path: string) => {
        const res = NextResponse.redirect(new URL(path, request.url), { status: 303 });
        res.headers.append("Set-Cookie", clearCookie); // single-use: always consumed
        res.headers.set("Cache-Control", "no-store");
        res.headers.set("Referrer-Policy", "no-referrer");
        return res;
      };
      const user = await getSessionUser();
      if (!user) return done("/sign-in");
      const q = request.nextUrl.searchParams;
      try {
        const r = await finishConnect(
          user,
          { code: q.get("code"), state: q.get("state"), error: q.get("error") },
          request.cookies.get(CONNECT_COOKIE)?.value,
        );
        if (r.kind === "error") return done(`/connect?error=${r.code}`);
        return done(r.reconnected ? "/settings?reconnected=1" : "/gallery?connected=1");
      } catch (err) {
        // Names only (no tokens or codes): without this a failed exchange is invisible.
        console.error("[edf] connect.callback_error", {
          name: err instanceof Error ? err.name : typeof err,
          kind: (err as { kind?: unknown } | null)?.kind ?? null,
        });
        return done("/connect?error=failed");
      }
    }),
  );
}
