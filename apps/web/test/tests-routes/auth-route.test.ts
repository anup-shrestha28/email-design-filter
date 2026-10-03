/**
 * /api/auth/[...all] in development mode (FREE-TIER.md §8.4): the Google callback is refused before
 * any database work unless Better Auth's own OAuth state cookie comes with it — and the cookie name
 * the guard looks for is the one Better Auth really sets (a mismatch would lock everyone out).
 * Google's token endpoint is faked; everything else is real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { endAppPool, fakeFetch, json } from "./helpers";

process.env.GOOGLE_LOGIN_CLIENT_ID = "login-test.apps.googleusercontent.com";
process.env.GOOGLE_LOGIN_CLIENT_SECRET = "login-test-secret";

const fake = fakeFetch([
  (r) => (r.url === "https://oauth2.googleapis.com/token" ? json({ error: "invalid_grant" }, 400) : undefined),
]);

describe.skipIf(!HAS_DB)("/api/auth guards (development)", () => {
  let owner: pg.Pool;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    owner = ownerPool();
    globalThis.fetch = fake.fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await owner.end();
    await endAppPool();
  });

  const wakes = async () => (await owner.query<{ n: number }>("SELECT signin_wake_count AS n FROM system_state")).rows[0]!.n;

  async function route() {
    return import("@/app/api/auth/[...all]/route");
  }

  it("a callback without the state cookie is a cheap 400 that never touches the breaker row", async () => {
    const { GET } = await route();
    const before = await wakes();
    for (const cookie of [null, "edf.session_token=x", "xedf.oauth_state=1", "edf.oauth_statex"]) {
      const res = await GET(
        new Request("https://app.test/api/auth/callback/google?code=c&state=s", { headers: cookie ? { cookie } : {} }),
      );
      expect(res.status, String(cookie)).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("Invalid sign-in request");
    }
    expect(await wakes()).toBe(before);
  });

  it("the state cookie Better Auth sets on sign-in/social is the one the callback guard accepts", async () => {
    const { POST, GET } = await route();
    const res = await POST(
      new Request("https://app.test/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-real-ip": "203.0.113.20" },
        body: JSON.stringify({ provider: "google", callbackURL: "/today" }),
      }),
    );
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const google = new URL(url);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("client_id")).toBe("login-test.apps.googleusercontent.com");
    // Basic scopes only on the login client — never Gmail.
    expect(google.searchParams.get("scope")).not.toContain("gmail");
    const stateCookie = res.headers.getSetCookie().find((c) => /^(__Secure-)?edf\.oauth_state=/.test(c));
    expect(stateCookie, res.headers.getSetCookie().map((c) => c.split("=")[0]).join(",")).toBeDefined();

    const cb = await GET(
      new Request(`https://app.test/api/auth/callback/google?code=4%2Fbad&state=${google.searchParams.get("state")}`, {
        headers: { cookie: stateCookie!.split(";")[0]!, "x-real-ip": "203.0.113.20" },
      }),
    );
    // Past the guard: Better Auth handled it (the faked token exchange failed → its error redirect).
    expect(await cb.clone().text()).not.toBe("Invalid sign-in request");
    expect(cb.status).toBe(302);
    expect(fake.calls.some((c) => c.url === "https://oauth2.googleapis.com/token")).toBe(true);
  });

  it("in development the breaker never trips (IS_PROD only)", async () => {
    const { POST } = await route();
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 500");
    try {
      const res = await POST(
        new Request("https://app.test/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-123" }),
        }),
      );
      expect(res.status).not.toBe(503);
      expect(await wakes()).toBe(500);
    } finally {
      await owner.query("UPDATE system_state SET signin_wake_day = NULL, signin_wake_count = 0");
    }
  });
});
