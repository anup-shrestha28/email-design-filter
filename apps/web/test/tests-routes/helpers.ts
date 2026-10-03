/**
 * Shared helpers for the route-handler tests: real Better Auth sessions (development email +
 * password sign-in, invite gate included), session ageing through the owner connection, and a
 * fetch fake for true externals (Google, Inngest, GitHub) that records every call.
 *
 * Callers must set `process.env.EDF_DEV_LOGIN = "1"` before `@/env` is first loaded, and mock
 * `next/headers` so `headers()` returns the request's headers (there is no Next request scope).
 */
import { randomUUID } from "node:crypto";
import type { pg } from "@edf/db";

export interface TestSession {
  userId: string;
  email: string;
  /** The `Cookie` header value a browser would send. */
  cookie: string;
  token: string;
}

/** Sign up through Better Auth (invite gate + user_settings hooks run for real). */
export async function signUp(owner: pg.Pool, opts: { role?: "owner" | "friend"; email?: string } = {}): Promise<TestSession> {
  const email = opts.email ?? `r${randomUUID().replaceAll("-", "").slice(0, 12)}@example.com`;
  await owner.query("INSERT INTO beta_allowlist (email, role) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING", [email, opts.role ?? "friend"]);
  const { auth } = await import("@/server/auth");
  const r = await auth().api.signUpEmail({
    body: { email, password: "correct-horse-battery-staple", name: "Route Tester" },
    returnHeaders: true,
  });
  const setCookie = r.headers.getSetCookie();
  const tokenCookie = setCookie.find((c) => /^edf\.session_token=/.test(c));
  if (!tokenCookie) throw new Error("sign-up did not set a session cookie");
  const cookie = tokenCookie.split(";")[0]!;
  const userId = r.response.user.id;
  const token = r.response.token;
  if (!token) throw new Error("sign-up returned no session token");
  return { userId, email, cookie, token };
}

/** Move the session's creation time into the past (Better Auth keeps expires_at in the future). */
export async function ageSession(owner: pg.Pool, token: string, ageMs: number): Promise<void> {
  await owner.query("UPDATE session SET created_at = now() - make_interval(secs => $2::double precision / 1000) WHERE token = $1", [token, ageMs]);
}

export interface Recorded {
  url: string;
  method: string;
  body: string;
  headers: Headers;
}

type Handler = (req: Recorded) => Response | Promise<Response> | undefined;

/** A global fetch fake: the first handler that returns a Response answers; anything else is refused. */
export function fakeFetch(handlers: Handler[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const rec: Recorded = { url: req.url, method: req.method, body: await req.clone().text().catch(() => ""), headers: req.headers };
    calls.push(rec);
    for (const h of handlers) {
      const res = await h(rec);
      if (res) return res;
    }
    throw new TypeError(`fetch refused in test: ${req.method} ${new URL(req.url).origin}`);
  };
  return { fetch: f as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Close the app's own pool (db.ts) so the test process can exit. */
export async function endAppPool(): Promise<void> {
  const g = globalThis as unknown as { __edfPool?: pg.Pool; __edfPoolChecked?: unknown };
  const p = g.__edfPool;
  delete g.__edfPool;
  delete g.__edfPoolChecked;
  await p?.end().catch(() => {});
}
