/**
 * Where to go after sign-in (shared by the sign-in page and proxy.ts, client/edge-safe): the `next`
 * path the proxy kept from a signed-out deep link, when it is a same-origin path under an app page
 * (never `//host`, a backslash, a scheme, or a query), else /gallery. It feeds Better Auth's
 * callbackURL, the dev form's `location.assign` and the proxy's signed-in redirect, so it must not
 * become an open redirect.
 */
const NEXT_PATH =
  /^\/(?:gallery|today|inbox|email|senders|insights|settings|system|connect)(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)*\/?$/;
/**
 * Also refused: an encoded "/" or "\" (Better Auth rejects it as a callbackURL, which would break
 * Google sign-in instead of falling back) and a dot segment, plain or `%2e` (the browser resolves
 * `/email/../api/...` outside the app sections).
 */
const UNSAFE_NEXT = /%2f|%5c|(?:^|\/)(?:\.|%2e){1,2}(?=\/|$)/i;

export function afterSignIn(next: string | string[] | null | undefined): string {
  return typeof next === "string" &&
    next.length <= 512 &&
    NEXT_PATH.test(next) &&
    !UNSAFE_NEXT.test(next)
    ? next
    : "/gallery";
}

/**
 * The query flag requireUser adds when a session cookie turned out to be invalid (revoked or
 * expired): the proxy then shows the sign-in page instead of sending a "signed-in" visitor back to
 * the app, so a stale cookie can never loop between /sign-in and /gallery.
 */
export const EXPIRED_PARAM = "expired";
