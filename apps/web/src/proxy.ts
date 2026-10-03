/**
 * Optimistic redirects + per-request nonce CSP for app pages (DESIGN.md §4.1, §11.2).
 * NOT an auth boundary: authorization happens in the DAL / every action and route handler.
 * Never touches the database. Public static pages are not matched (FREE-TIER.md §8.4), except the
 * site root "/", only to send a signed-in visitor straight to the gallery.
 */
import { NextResponse, type NextRequest } from "next/server";
import { afterSignIn, EXPIRED_PARAM } from "@/lib/sign-in-next";

const SESSION_COOKIES = ["edf.session_token", "__Secure-edf.session_token"];
const PUBLIC_DYNAMIC = ["/sign-in", "/invite"];

function csp(nonce: string, viewOrigin: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${viewOrigin}`,
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    `frame-src ${viewOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_DYNAMIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = SESSION_COOKIES.some((c) => request.cookies.has(c));

  // The site root: someone signed in goes straight to their designs (no click). Everyone else gets
  // the static landing page untouched — no nonce CSP (it's prerendered with the static one from
  // next.config.ts). A stale cookie is harmless: /gallery's requireUser sends it on to /sign-in,
  // which is never redirected back here, so there's no loop.
  if (pathname === "/") {
    if (!hasSession) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = "/gallery";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // /sign-in while signed in (a bookmark, a second tab): straight on to the designs, or to the
  // page it was asked to return to. Not when re-authenticating (?reauth) or when the app just found
  // the cookie invalid (?expired, added by requireUser): that is what stops a stale cookie looping.
  if (
    pathname === "/sign-in" &&
    hasSession &&
    !request.nextUrl.searchParams.has("reauth") &&
    !request.nextUrl.searchParams.has(EXPIRED_PARAM)
  ) {
    const url = request.nextUrl.clone();
    url.pathname = afterSignIn(request.nextUrl.searchParams.get("next"));
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (!isPublic && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    // The query is dropped (it can hold search terms or an /out target); only the path is kept as
    // `next`, so a saved link returns to its page after sign-in. The sign-in page re-validates it.
    url.search = "";
    if (pathname !== "/gallery" && pathname !== "/out" && !pathname.startsWith("/out/"))
      url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const policy = csp(nonce, process.env.VIEW_ORIGIN ?? "", process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-edf-path", pathname); // always set here, so a client-sent value is overwritten
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  if (pathname.startsWith("/email") || pathname.startsWith("/out")) {
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  return response;
}

export const config = {
  matcher: [
    "/",
    "/gallery/:path*",
    "/boards/:path*",
    "/today/:path*",
    "/inbox/:path*",
    "/email/:path*",
    "/senders/:path*",
    "/insights/:path*",
    "/settings/:path*",
    "/system/:path*",
    "/connect/:path*",
    "/out/:path*",
    "/sign-in/:path*",
    "/invite/:path*",
  ],
};
