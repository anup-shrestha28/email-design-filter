/**
 * R1-22: the sign-in wake breaker (FREE-TIER.md §8.4 item 2: "sign-in returns 503 … and an alert is
 * sent"; §8.5 lists it as an alert code) tripped silently. Each instance that finds the breaker
 * tripped in the database now raises SIGNIN_BREAKER once (raiseAlert's 6 h re-notify window
 * de-duplicates, and gives the mark back when GitHub fails, so the next instance retries); the
 * requests it then answers from memory don't raise it again. The database and Better Auth are
 * real; Google's token endpoint is faked and raiseAlert itself is a spy here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type * as Pipeline from "@edf/pipeline";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { endAppPool, fakeFetch, json } from "../tests-routes/helpers";
import type * as EnvModule from "@/env";

process.env.GOOGLE_LOGIN_CLIENT_ID = "login-test.apps.googleusercontent.com";
process.env.GOOGLE_LOGIN_CLIENT_SECRET = "login-test-secret";

const alerts = vi.hoisted(() => ({ raised: [] as Array<{ code: string; details: unknown }> }));
vi.mock("@/env", async (importOriginal) => ({ ...(await importOriginal<typeof EnvModule>()), IS_PROD: true }));
vi.mock("@edf/pipeline", async (orig) => ({
  ...(await orig<typeof Pipeline>()),
  raiseAlert: async (_pool: unknown, _cfg: unknown, code: string, details: unknown) => {
    alerts.raised.push({ code, details });
    return true;
  },
}));

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

describe.skipIf(!HAS_DB)("sign-in breaker alert", () => {
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
    alerts.raised = [];
    await owner.query("UPDATE system_state SET signin_wake_day = NULL, signin_wake_count = 0");
  });

  const signIn = async () => {
    const { POST, GET } = await import("@/app/api/auth/[...all]/route");
    const ip = `198.51.100.${(ipSeq++ % 200) + 1}`;
    const res = await POST(
      new Request("https://app.test/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-real-ip": ip },
        body: JSON.stringify({ provider: "google", callbackURL: "/today" }),
      }),
    );
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state")!;
    const cookie = res.headers.getSetCookie().find((c) => /^__Secure-edf\.oauth_state=/.test(c))!.split(";")[0]!;
    return GET(new Request(`https://app.test/api/auth/callback/google?code=4%2Fbad&state=${state}`, { headers: { cookie, "x-real-ip": ip } }));
  };

  it("below the limit: no alert", async () => {
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 9");
    expect((await signIn()).status).not.toBe(503);
    expect(alerts.raised).toEqual([]);
  });

  it("the wake that trips the breaker raises SIGNIN_BREAKER once (codes and counts only)", async () => {
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 10");
    expect((await signIn()).status).toBe(503);
    expect(alerts.raised).toEqual([{ code: "SIGNIN_BREAKER", details: { wakes: 11 } }]);
    for (let i = 0; i < 2; i++) expect((await signIn()).status).toBe(503);
    expect(alerts.raised).toHaveLength(1);
  });

  it("another instance, finding the breaker already tripped, asks too (so a failed send is retried)", async () => {
    await owner.query("UPDATE system_state SET signin_wake_day = current_date, signin_wake_count = 11");
    expect((await signIn()).status).toBe(503);
    expect(alerts.raised).toEqual([{ code: "SIGNIN_BREAKER", details: { wakes: 12 } }]);
    expect((await signIn()).status).toBe(503); // answered from memory
    expect(alerts.raised).toHaveLength(1);
  });
});
