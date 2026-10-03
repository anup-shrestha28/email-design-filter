/**
 * C1-11: the sign-in wake breaker counted every callback that carried a genuine state cookie. A
 * script could mint one through POST /api/auth/sign-in/social (no database) and send it back with a
 * bogus code: about 11 such requests a day tripped sign-in for everyone, and with it every action
 * that needs a fresh session (disconnect, delete account, export, connect). Now a wake counts only
 * when the callback's handler first asks for a database connection, which Better Auth does only
 * after Google accepted the code. The database and Better Auth are real; Google's token endpoint is
 * faked (code "4/good" is accepted, anything else is invalid_grant).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { endAppPool, fakeFetch, json } from "../tests-routes/helpers";
import type * as EnvModule from "@/env";

process.env.GOOGLE_LOGIN_CLIENT_ID = "login-test.apps.googleusercontent.com";
process.env.GOOGLE_LOGIN_CLIENT_SECRET = "login-test-secret";

vi.mock("@/env", async (importOriginal) => ({ ...(await importOriginal<typeof EnvModule>()), IS_PROD: true }));

const STRANGER = "fin-connect-gate-stranger@example.com";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  iss: "https://accounts.google.com",
  sub: "fin-connect-gate-sub",
  email: STRANGER,
  email_verified: true,
  name: "Stranger",
})}.sig`;

const fake = fakeFetch([
  (r) => {
    if (r.url !== "https://oauth2.googleapis.com/token") return undefined;
    return new URLSearchParams(r.body).get("code") === "4/good"
      ? json({ access_token: "at", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: "openid email profile" })
      : json({ error: "invalid_grant" }, 400);
  },
]);

describe.skipIf(!HAS_DB)("sign-in wake gate (C1-11)", () => {
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
    vi.resetModules(); // a fresh instance: the tripped state is remembered per instance
    await owner.query("UPDATE system_state SET signin_wake_day = NULL, signin_wake_count = 0");
  });

  const wakes = async () => (await owner.query<{ n: number }>("SELECT signin_wake_count AS n FROM system_state")).rows[0]!.n;

  /** A real sign-in start (no database), then its callback with the state cookie it set. */
  const signIn = async (code: string) => {
    const { POST, GET } = await import("@/app/api/auth/[...all]/route");
    const ip = `192.0.2.${(ipSeq++ % 200) + 1}`;
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
    return GET(
      new Request(`https://app.test/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${state}`, {
        headers: { cookie, "x-real-ip": ip },
      }),
    );
  };

  it("genuine state cookies with bogus codes never count a wake, so they cannot trip the breaker", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await signIn("4/bad");
      expect(res.status).toBe(302); // Better Auth's error redirect after Google refused the code
    }
    expect(await wakes()).toBe(0);
  });

  it("a callback whose code Google accepts counts one wake before Better Auth reads the database", async () => {
    const res = await signIn("4/good");
    expect(res.status).toBe(403); // reached Better Auth, which refused the uninvited address
    expect(await wakes()).toBe(1);
  });

  it("when that wake trips the breaker: 503 before Better Auth runs a query, and later requests don't wake the database", async () => {
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 10");
    const tripped = await signIn("4/good");
    expect(tripped.status).toBe(503);
    expect(tripped.headers.get("retry-after")).toBe("3600");
    expect(await wakes()).toBe(11);
    for (const code of ["4/good", "4/bad"]) expect((await signIn(code)).status).toBe(503);
    expect(await wakes()).toBe(11); // answered from the instance's memory
    expect((await owner.query('SELECT 1 FROM "user" WHERE email = $1', [STRANGER])).rowCount).toBe(0);
  });
});
