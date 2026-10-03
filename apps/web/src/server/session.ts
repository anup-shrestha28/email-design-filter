/**
 * Session helpers for Server Components, Server Actions and route handlers (DESIGN.md §4.1).
 * `proxy.ts` only does optimistic redirects; authorization always happens here, including the
 * invite list (DESIGN.md §11.8): a friend whose invite the owner removed is signed out on their
 * next request (the owner has no invite to lose).
 */
import "server-only";
import { EXPIRED_PARAM } from "@/lib/sign-in-next";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withUser } from "@edf/db";
import { auth } from "./auth";
import { getPool } from "./db";
import { meterInvocation } from "./metering";
import { provisionUserSettings } from "./user-settings";

const ABSOLUTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // absolute 30-day session cap
const FRESH_MS = 10 * 60 * 1000; // freshAge for sensitive actions

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  sessionId: string;
  sessionCreatedAt: Date;
  role: "owner" | "friend";
}

export class UnauthorizedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class StaleSessionError extends Error {
  constructor() {
    super("Please sign in again to confirm it's you.");
    this.name = "StaleSessionError";
  }
}

/** The signed-in user, or null. Memoized per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const h = await headers();
  // Once per request: a page render or Server Action counts one invocation (FREE-TIER.md §8.1);
  // a no-op inside route handlers, which meterRequest() already counts. After headers(), where a
  // build's prerender bails out, so builds never touch the meter (or its pool and secrets).
  meterInvocation();
  const session = await auth().api.getSession({ headers: h });
  if (!session) return null;
  const createdAt = new Date(session.session.createdAt);
  if (Date.now() - createdAt.getTime() > ABSOLUTE_MAX_AGE_MS) {
    await auth().api.revokeSession({ headers: h, body: { token: session.session.token } }).catch(() => {});
    return null;
  }
  const pool = await getPool();
  const { role, invited } = await withUser(pool, session.user.id, async (_db, client) => {
    const { rows } = await client.query<{ role: "owner" | "friend"; invited: boolean }>(
      "SELECT role, is_invited($2) IS NOT NULL AS invited FROM user_settings WHERE user_id = $1",
      [session.user.id, session.user.email],
    );
    if (rows[0]) return rows[0];
    // The sign-up hook failed after the user row committed and Better Auth won't re-run it: repair.
    const provisioned = await provisionUserSettings(client, { id: session.user.id, email: session.user.email });
    const inv = await client.query<{ invited: boolean }>("SELECT is_invited($1) IS NOT NULL AS invited", [session.user.email]);
    return { role: provisioned, invited: inv.rows[0]?.invited === true };
  });
  if (role !== "owner" && !invited) {
    // The owner removed this friend's invite: end the session instead of keeping their access.
    await auth().api.revokeSession({ headers: h, body: { token: session.session.token } }).catch(() => {});
    return null;
  }
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image ?? null,
    sessionId: session.session.id,
    sessionCreatedAt: createdAt,
    role,
  };
});

/** The request header proxy.ts sets to the page's path (the pathname only, never the query). */
export const PATH_HEADER = "x-edf-path";

/**
 * Where a signed-out page goes: `/sign-in?next=<path>`, the same redirect proxy.ts makes (the path
 * only, the query dropped; no `next` for /gallery, the default, or /out). The sign-in page re-validates `next`.
 */
export function signInPath(path: string | null | undefined): string {
  const p = (path ?? "").split(/[?#]/, 1)[0] ?? "";
  if (!p.startsWith("/") || p.startsWith("//") || p === "/gallery" || p === "/out" || p.startsWith("/out/")) return "/sign-in";
  return `/sign-in?${new URLSearchParams({ next: p }).toString()}`;
}

/**
 * For pages: redirect to sign-in when there's no session (e.g. a revoked session whose cookie got
 * past the proxy), keeping the page as `next`. `path` defaults to the proxy's path header.
 */
export async function requireUser(path?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    // ?expired=1: the cookie that got past the proxy is invalid, so /sign-in must show the form
    // rather than send this "signed-in" visitor back (proxy.ts), which would loop.
    const to = signInPath(path ?? (await headers()).get(PATH_HEADER));
    redirect(`${to}${to.includes("?") ? "&" : "?"}${EXPIRED_PARAM}=1`);
  }
  return user;
}

/** For Server Actions and route handlers: throw instead of redirecting. */
export async function requireUserOrThrow(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Sensitive actions (export, delete, disconnect, adding a mailbox) need a session ≤ 10 min old. */
export async function requireFreshSession(maxAgeMs = FRESH_MS): Promise<SessionUser> {
  const user = await requireUserOrThrow();
  if (Date.now() - user.sessionCreatedAt.getTime() > maxAgeMs) throw new StaleSessionError();
  return user;
}

export async function requireOwner(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/gallery");
  return user;
}
