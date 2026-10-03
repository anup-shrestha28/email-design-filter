/**
 * The unauthenticated-wake breaker on /api/auth (FREE-TIER.md §8.4 item 2): with IS_PROD on, more
 * than 10 sign-in database wakes in a day answer 503 until the next day. Only a Google callback
 * carrying a state cookie our own sign-in start minted (decrypting, unexpired, matching `state`)
 * reaches the database: forged cookies, the development-only email paths (404 in production) and
 * other auth paths never count, and once tripped the breaker answers without waking the database.
 * Only the IS_PROD flag is forced (the env boot checks are covered separately); the database and
 * Better Auth are real, Google's token endpoint is faked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { symmetricEncrypt } from "better-auth/crypto";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { endAppPool, fakeFetch, json } from "./helpers";
import type * as EnvModule from "@/env";

process.env.GOOGLE_LOGIN_CLIENT_ID = "login-test.apps.googleusercontent.com";
process.env.GOOGLE_LOGIN_CLIENT_SECRET = "login-test-secret";

vi.mock("@/env", async (importOriginal) => ({ ...(await importOriginal<typeof EnvModule>()), IS_PROD: true }));

// Google accepts the code (the breaker counts only callbacks that get that far, C1-11); the
// unsigned id token names an uninvited address, so Better Auth refuses the sign-in after its first
// database read.
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ iss: "https://accounts.google.com", sub: "breaker-sub", email: "breaker-stranger@example.com", email_verified: true, name: "S" })}.sig`;
const fake = fakeFetch([
  (r) =>
    r.url === "https://oauth2.googleapis.com/token"
      ? json({ access_token: "at", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: "openid email profile" })
      : undefined,
]);

describe.skipIf(!HAS_DB)("sign-in wake breaker (production)", () => {
  let owner: pg.Pool;
  const realFetch = globalThis.fetch;
  let ipSeq = 0;

  beforeAll(() => {
    owner = ownerPool();
    globalThis.fetch = fake.fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await owner.query("UPDATE system_state SET signin_wake_day = NULL, signin_wake_count = 0");
    await owner.end();
    await endAppPool();
  });
  beforeEach(async () => {
    // A fresh route module: the tripped state it remembers belongs to one instance.
    vi.resetModules();
    await owner.query("UPDATE system_state SET signin_wake_day = NULL, signin_wake_count = 0");
  });

  const wakes = async () =>
    (await owner.query<{ n: number; today: boolean }>("SELECT signin_wake_count AS n, signin_wake_day = current_date AS today FROM system_state")).rows[0]!;
  const route = () => import("@/app/api/auth/[...all]/route");

  /** A real sign-in start (no database), then its callback with the state cookie it set. */
  const signIn = async () => {
    const { POST, GET } = await route();
    const ip = `203.0.113.${(ipSeq++ % 200) + 1}`;
    const res = await POST(
      new Request("https://app.test/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-real-ip": ip },
        body: JSON.stringify({ provider: "google", callbackURL: "/today" }),
      }),
    );
    expect(res.status).toBe(200);
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    const cookie = res.headers.getSetCookie().find((c) => /^__Secure-edf\.oauth_state=/.test(c))!.split(";")[0]!;
    return GET(new Request(`https://app.test/api/auth/callback/google?code=4%2Fbad&state=${state}`, { headers: { cookie, "x-real-ip": ip } }));
  };

  /** A callback whose cookie is encrypted with our secrets but carries the given claims. */
  const forged = async (claims: { oauthState: string; expiresAt: number }, state: string) => {
    const { auth } = await import("@/server/auth");
    const { secretConfig } = await auth().$context;
    const data = await symmetricEncrypt({ key: secretConfig, data: JSON.stringify({ callbackURL: "/today", codeVerifier: "v", ...claims }) });
    const { GET } = await route();
    return GET(new Request(`https://app.test/api/auth/callback/google?code=c&state=${state}`, { headers: { cookie: `__Secure-edf.oauth_state=${data}` } }));
  };

  it("a genuine callback counts one wake and reaches Better Auth", async () => {
    const cb = await signIn();
    expect(cb.status).toBe(403); // Better Auth refused the uninvited address after its first database read
    expect(await wakes()).toEqual({ n: 1, today: true });
  });

  it("the 11th sign-in wake of the day gets 503 with Retry-After; later requests don't wake the database", async () => {
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 10");
    const tripped = await signIn();
    expect(tripped.status).toBe(503);
    expect(tripped.headers.get("retry-after")).toBe("3600");
    expect(tripped.headers.get("cache-control")).toBe("no-store");
    expect(await tripped.text()).toMatch(/temporarily unavailable/i);
    expect(await wakes()).toEqual({ n: 11, today: true });
    for (let i = 0; i < 3; i++) expect((await signIn()).status).toBe(503);
    expect((await wakes()).n).toBe(11); // answered from the instance's memory
  });

  it("forged, mismatched or expired state cookies are refused before the breaker and never count", async () => {
    const { GET } = await route();
    for (const cookie of [null, "__Secure-edf.oauth_state=abc", "edf.oauth_state=abc", "__Secure-edf.oauth_state=%E0%A4%A"]) {
      const res = await GET(new Request("https://app.test/api/auth/callback/google?code=c&state=s", { headers: cookie ? { cookie } : {} }));
      expect(res.status, String(cookie)).toBe(400);
    }
    expect((await forged({ oauthState: "other", expiresAt: Date.now() + 60_000 }, "s")).status).toBe(400);
    expect((await forged({ oauthState: "s", expiresAt: Date.now() - 1_000 }, "s")).status).toBe(400);
    expect((await wakes()).n).toBe(0);
  });

  it("the email sign-in paths are a 404 in production and never count", async () => {
    const { POST } = await route();
    for (let i = 0; i < 20; i++) {
      for (const path of ["sign-in/email", "sign-up/email"]) {
        const res = await POST(
          new Request(`https://app.test/api/auth/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:3000" },
            body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-123", name: "N" }),
          }),
        );
        expect(res.status).toBe(404);
      }
    }
    expect((await wakes()).n).toBe(0);
  });

  it("authenticated auth paths (get-session, sign-out) never count", async () => {
    const { GET, POST } = await route();
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 99");
    const s = await GET(new Request("https://app.test/api/auth/get-session"));
    expect(s.status).not.toBe(503);
    const o = await POST(new Request("https://app.test/api/auth/sign-out", { method: "POST", headers: { origin: "http://localhost:3000" } }));
    expect(o.status).not.toBe(503);
    expect((await wakes()).n).toBe(99);
  });

  it("a new day resets the count", async () => {
    await owner.query("UPDATE system_state SET signin_wake_day = current_date - 1, signin_wake_count = 250");
    const res = await signIn();
    expect(res.status).not.toBe(503);
    expect(await wakes()).toEqual({ n: 1, today: true });
  });
});
