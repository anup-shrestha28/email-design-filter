/**
 * /api/mailboxes/google/start and /callback (DESIGN.md §4.3) end to end: real session, real
 * encrypted state cookie, real database, real token sealing (the development LocalKeyWrapper) —
 * only Google's token, certs, revoke and Gmail profile endpoints and Inngest's event API are faked.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withUser, type pg } from "@edf/db";
import { verifyConnectorIdToken } from "@edf/gmail";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { ageSession, endAppPool, fakeFetch, json, signUp, type Recorded, type TestSession } from "./helpers";

process.env.EDF_DEV_LOGIN = "1";
process.env.GOOGLE_CONNECTOR_CLIENT_ID = "connector-test.apps.googleusercontent.com";
process.env.GOOGLE_CONNECTOR_CLIENT_SECRET = "connector-test-secret";
process.env.INNGEST_BASE_URL = "http://inngest.test/";
process.env.INNGEST_EVENT_KEY = "test-event-key-0000";
delete process.env.KEYS_ORIGIN; // development LocalKeyWrapper instead of an edf-keys server
delete process.env.KEYS_AUD;

const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => h.headers }));

const CLIENT_ID = "connector-test.apps.googleusercontent.com";
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function idToken(payload: Record<string, unknown>): string {
  const hd = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${hd}.${p}`), privateKey).toString("base64url");
  return `${hd}.${p}.${s}`;
}

interface GoogleScript {
  sub: string;
  idEmail: string;
  profileEmail: string;
  refresh: boolean;
  scope: string;
  profileStatus: number;
}

const google: { script: GoogleScript; nonce: string } = {
  script: { sub: "1", idEmail: "", profileEmail: "", refresh: true, scope: "", profileStatus: 200 },
  nonce: "",
};

const fake = fakeFetch([
  (r) => (r.url.startsWith("https://www.googleapis.com/oauth2/v1/certs") ? json({ "test-k1": PEM }, 200, { "cache-control": "public, max-age=3600" }) : undefined),
  (r) => {
    if (r.url !== "https://oauth2.googleapis.com/token") return undefined;
    const s = google.script;
    const now = Math.floor(Date.now() / 1000);
    return json({
      access_token: "ya29.test-access-token",
      expires_in: 3599,
      ...(s.refresh ? { refresh_token: "1//test-refresh-token" } : {}),
      scope: s.scope,
      token_type: "Bearer",
      id_token: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: s.sub, email: s.idEmail, email_verified: true, nonce: google.nonce, iat: now - 5, exp: now + 3000 }),
    });
  },
  (r) => (r.url === "https://oauth2.googleapis.com/revoke" ? new Response("", { status: 200 }) : undefined),
  (r) =>
    r.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")
      ? google.script.profileStatus === 200
        ? json({ emailAddress: google.script.profileEmail, historyId: "987654", messagesTotal: 10 })
        : json({ error: { code: google.script.profileStatus, message: "backend error" } }, google.script.profileStatus)
      : undefined,
  (r) => (r.url.startsWith("http://inngest.test/") ? json({ ids: ["01TEST"], status: 200 }) : undefined),
]);

describe.skipIf(!HAS_DB)("Gmail connect routes", () => {
  let owner: pg.Pool;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    owner = ownerPool();
    globalThis.fetch = fake.fetch;
    // google-auth-library (gaxios) fetches Google's certs with node-fetch unless a browser `window`
    // exists; point its one-time fetch choice at the global fake, then remove the window again.
    const g = globalThis as unknown as { window?: unknown };
    g.window = { fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a) };
    try {
      await verifyConnectorIdToken("a.b.c", { clientId: CLIENT_ID, nonce: "warm-up-nonce-000000" }).catch(() => null);
    } finally {
      delete g.window;
    }
    expect(fake.calls.some((c) => c.url.startsWith("https://www.googleapis.com/oauth2/v1/certs"))).toBe(true);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await owner.end();
    await endAppPool();
  });
  beforeEach(() => {
    fake.calls.length = 0;
  });

  const consent = (userId: string) => owner.query("UPDATE user_settings SET ai_processing_consent_at = now() WHERE user_id = $1", [userId]);

  async function start(s: TestSession | null, query = ""): Promise<Response> {
    h.headers = new Headers(s ? { cookie: s.cookie } : {});
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/mailboxes/google/start/route");
    return GET(new NextRequest(`https://app.test/api/mailboxes/google/start${query}`, { headers: h.headers }));
  }

  async function callback(s: TestSession | null, params: Record<string, string>, connectCookie?: string | null): Promise<Response> {
    const cookies = [s?.cookie, connectCookie ? `edf-connect=${connectCookie}` : null].filter(Boolean).join("; ");
    h.headers = new Headers(cookies ? { cookie: cookies } : {});
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/mailboxes/google/callback/route");
    const q = new URLSearchParams(params).toString();
    return GET(new NextRequest(`https://app.test/api/mailboxes/google/callback?${q}`, { headers: h.headers }));
  }

  /** Run /start and return what the browser carries to Google and back. */
  async function begin(s: TestSession, query = ""): Promise<{ state: string; nonce: string; cookie: string; auth: URL }> {
    const res = await start(s, query);
    expect(res.status).toBe(303);
    const auth = new URL(res.headers.get("location")!);
    const setCookie = res.headers.get("set-cookie")!;
    const cookie = /^edf-connect=([^;]+)/.exec(setCookie)![1]!;
    return { state: auth.searchParams.get("state")!, nonce: auth.searchParams.get("nonce")!, cookie, auth };
  }

  function script(s: TestSession, over: Partial<GoogleScript> = {}): void {
    google.script = { sub: `g-${s.userId}`, idEmail: s.email, profileEmail: s.email, refresh: true, scope: `openid email ${GMAIL_READONLY}`, profileStatus: 200, ...over };
  }

  const revokes = (): Recorded[] => fake.calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke");
  const location = (res: Response) => {
    const u = new URL(res.headers.get("location")!);
    return u.pathname + u.search;
  };
  const clearsConnectCookie = (res: Response) => expect(res.headers.get("set-cookie") ?? "").toMatch(/edf-connect=;[^,]*Max-Age=0/);

  describe("start", () => {
    it("sends a signed-out visitor to sign-in and a stale session to re-auth", async () => {
      expect(location(await start(null))).toBe("/sign-in");
      const u = await signUp(owner);
      await ageSession(owner, u.token, 11 * 60 * 1000);
      expect(location(await start(u))).toBe("/sign-in?reauth=connect");
    });

    it("requires the AI-processing disclosure to be accepted", async () => {
      const u = await signUp(owner);
      const res = await start(u);
      expect(res.status).toBe(303);
      expect(location(res)).toBe("/connect?error=consent_required");
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("redirects to Google with PKCE, nonce, the fixed redirect URI and an encrypted single-use cookie", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const res = await start(u, `?hint=${encodeURIComponent(u.email)}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const auth = new URL(res.headers.get("location")!);
      expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      const { env } = await import("@/env");
      expect(auth.searchParams.get("redirect_uri")).toBe(`${env().APP_ORIGIN.replace(/\/$/, "")}/api/mailboxes/google/callback`);
      expect(auth.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("prompt")).toBe("consent");
      expect(auth.searchParams.get("login_hint")).toBe(u.email);
      const setCookie = res.headers.get("set-cookie")!;
      expect(setCookie).toMatch(/^edf-connect=[A-Za-z0-9_-]{40,};/);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Max-Age=600");
      // The cookie is sealed: neither the state nor the PKCE verifier is readable in it.
      expect(setCookie).not.toContain(auth.searchParams.get("state")!);

      const bad = await start(u, "?hint=not%20an%20address");
      expect(new URL(bad.headers.get("location")!).searchParams.has("login_hint")).toBe(false);
    });

    it("enforces the per-user mailbox limit (reconnect is exempt) and the L3 freeze", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      for (let i = 0; i < 2; i++) {
        await owner.query(
          `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
           VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1)`,
          [u.userId, `limit-${u.userId}-${i}`, `m${i}-${u.userId}@gmail.example`],
        );
      }
      expect(location(await start(u))).toBe("/connect?error=limit");
      expect(new URL((await start(u, "?reconnect=1")).headers.get("location")!).origin).toBe("https://accounts.google.com");

      const prev = await owner.query<{ value: unknown }>("SELECT value FROM app_setting WHERE key = 'governor'");
      await owner.query(`UPDATE app_setting SET value = '{"level":3,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`);
      try {
        expect(location(await start(u, "?reconnect=1"))).toBe("/connect?error=frozen");
      } finally {
        await owner.query("UPDATE app_setting SET value = $1 WHERE key = 'governor'", [JSON.stringify(prev.rows[0]!.value)]);
      }
    });
  });

  describe("callback", () => {
    it("a signed-out callback goes to sign-in and still consumes the cookie", async () => {
      const res = await callback(null, { code: "c", state: "s" }, "whatever");
      expect(location(res)).toBe("/sign-in");
      clearsConnectCookie(res);
      expect(fake.calls).toHaveLength(0);
    });

    it("refuses a missing cookie, a wrong state, or another session's cookie — before calling Google", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      expect(location(await callback(u, { code: "c", state: b.state }, null))).toBe("/connect?error=state");
      expect(location(await callback(u, { code: "c", state: `${b.state}x` }, b.cookie))).toBe("/connect?error=state");
      const other = await signUp(owner);
      expect(location(await callback(other, { code: "c", state: b.state }, b.cookie))).toBe("/connect?error=state");
      expect(fake.calls).toHaveLength(0);
    });

    it("a denied consent is reported without a token exchange", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      const res = await callback(u, { error: "access_denied", state: b.state }, b.cookie);
      expect(location(res)).toBe("/connect?error=denied");
      clearsConnectCookie(res);
      expect(fake.calls).toHaveLength(0);
    });

    it("connects: tokens sealed, mailbox active, audit row, import started; a second connect is a reconnect", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      google.nonce = b.nonce;
      script(u);
      const res = await callback(u, { code: "4/test-code", state: b.state }, b.cookie);
      expect(location(res)).toBe("/gallery?connected=1");
      clearsConnectCookie(res);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const tokenCall = fake.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
      const form = new URLSearchParams(tokenCall.body);
      expect(form.get("code")).toBe("4/test-code");
      expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(form.get("redirect_uri")).toBe(b.auth.searchParams.get("redirect_uri"));

      const mb = await withUser(owner, u.userId, (_db, c) =>
        c.query<{ id: string; status: string; email_address: string; refresh_token_enc: Buffer | null; dek_wrapped: Buffer | null; history_id: string; provider_account_id: string }>(
          "SELECT id, status, email_address::text, refresh_token_enc, dek_wrapped, history_id::text, provider_account_id FROM mailbox WHERE user_id = $1",
          [u.userId],
        ),
      );
      expect(mb.rows).toHaveLength(1);
      const m = mb.rows[0]!;
      expect(m).toMatchObject({ status: "active", email_address: u.email, history_id: "987654", provider_account_id: `g-${u.userId}` });
      expect(m.refresh_token_enc).not.toBeNull();
      expect(m.dek_wrapped).not.toBeNull();
      expect(Buffer.from(m.refresh_token_enc!).toString("latin1")).not.toContain("1//test-refresh-token");
      const audit = await owner.query("SELECT action FROM audit_log WHERE user_id = $1 AND action LIKE 'mailbox.%'", [u.userId]);
      expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(["mailbox.connected"]);
      const events = fake.calls.filter((c) => c.url.startsWith("http://inngest.test/")).map((c) => c.body);
      expect(events.join("\n")).toContain("mailbox/connected");
      expect(events.join("\n")).not.toContain("ya29.");
      expect(revokes()).toHaveLength(0);

      // Reconnect: same Google account → the same mailbox row, no second import.
      fake.calls.length = 0;
      const b2 = await begin(u, "?reconnect=1");
      google.nonce = b2.nonce;
      const res2 = await callback(u, { code: "4/test-code-2", state: b2.state }, b2.cookie);
      expect(location(res2)).toBe("/settings?reconnected=1");
      const again = await owner.query<{ id: string }>("SELECT id FROM mailbox WHERE user_id = $1", [u.userId]);
      expect(again.rows.map((r) => r.id)).toEqual([m.id]);
      const events2 = fake.calls.filter((c) => c.url.startsWith("http://inngest.test/")).map((c) => c.body).join("\n");
      expect(events2).not.toContain("mailbox/connected");
    });

    it("reconnecting a mailbox whose import needs_reauth interrupted resumes that import; a finished one is not re-run", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      google.nonce = b.nonce;
      script(u);
      expect(location(await callback(u, { code: "4/c1", state: b.state }, b.cookie))).toBe("/gallery?connected=1");
      const mb = (await owner.query<{ id: string }>("SELECT id FROM mailbox WHERE user_id = $1", [u.userId])).rows[0]!.id;
      const reconnect = async () => {
        fake.calls.length = 0;
        const b2 = await begin(u, "?reconnect=1");
        google.nonce = b2.nonce;
        expect(location(await callback(u, { code: "4/c2", state: b2.state }, b2.cookie))).toBe("/settings?reconnected=1");
        const events = fake.calls.filter((c) => c.url.startsWith("http://inngest.test/")).map((c) => c.body).join("\n");
        const row = await owner.query<{ status: string; backfill_state: string }>("SELECT status, backfill_state FROM mailbox WHERE id = $1", [mb]);
        return { events, ...row.rows[0]! };
      };

      // invalid_grant mid-listing: needs_reauth with the import left 'running' (its run ended). Imports
      // admitted before the admission mark existed have none: 'running' proves admission, so it is added.
      await owner.query(
        "UPDATE mailbox SET status = 'needs_reauth', needs_reauth_since = now(), backfill_state = 'running', backfill_progress = '{\"listed\": 7}' WHERE id = $1",
        [mb],
      );
      const r1 = await reconnect();
      expect(r1).toMatchObject({ status: "active", backfill_state: "pending" });
      expect(r1.events).toContain("backfill/requested");
      expect(r1.events).not.toContain("mailbox/connected");
      const progress = await owner.query<{ p: Record<string, unknown> }>("SELECT backfill_progress AS p FROM mailbox WHERE id = $1", [mb]);
      expect(progress.rows[0]!.p).toMatchObject({ listed: 7, admittedAt: expect.any(String) });

      // A finished import stays finished.
      await owner.query("UPDATE mailbox SET status = 'needs_reauth', needs_reauth_since = now(), backfill_state = 'done' WHERE id = $1", [mb]);
      const r2 = await reconnect();
      expect(r2).toMatchObject({ status: "active", backfill_state: "done" });
      expect(r2.events).not.toContain("backfill/requested");
    });

    it.each([
      ["no refresh token", { refresh: false }, "no_refresh_token"],
      ["gmail.readonly unticked", { scope: "openid email" }, "scope_missing"],
      ["profile address differs from the id_token", { profileEmail: "someone-else@gmail.example" }, "email_mismatch"],
    ] as const)("%s → error, grant revoked, nothing stored", async (_name, over, code) => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      google.nonce = b.nonce;
      script(u, over);
      const res = await callback(u, { code: "4/c", state: b.state }, b.cookie);
      expect(location(res)).toBe(`/connect?error=${code}`);
      expect(revokes()).toHaveLength(1);
      const stored = await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [u.userId]);
      expect(stored.rowCount).toBe(0);
    });

    it("an id_token minted for a different nonce is refused and the grant revoked", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      google.nonce = "some-other-nonce-0000000000";
      script(u);
      expect(location(await callback(u, { code: "4/c", state: b.state }, b.cookie))).toBe("/connect?error=id_token");
      expect(revokes()).toHaveLength(1);
    });

    it("connecting an address other than the login address needs a session ≤ 5 minutes old", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      await ageSession(owner, u.token, 6 * 60 * 1000); // still fresh enough for /start's 10 minutes
      google.nonce = b.nonce;
      script(u, { idEmail: "second@gmail.example", profileEmail: "second@gmail.example" });
      expect(location(await callback(u, { code: "4/c", state: b.state }, b.cookie))).toBe("/connect?error=stale_session");
      expect(revokes()).toHaveLength(1);
    });

    it("a Google account already bound to another user moves to the new user (fresh proof of control), both audited", async () => {
      const first = await signUp(owner);
      await consent(first.userId);
      const b1 = await begin(first);
      google.nonce = b1.nonce;
      const shared = { sub: `shared-${first.userId}`, idEmail: first.email, profileEmail: first.email };
      script(first, shared);
      expect(location(await callback(first, { code: "4/a", state: b1.state }, b1.cookie))).toBe("/gallery?connected=1");
      // A sender the first user muted, known only from the claimed mailbox's mail: it goes with the
      // mailbox, as in the disconnect purge (nightly maintenance would keep it, since it's muted).
      await owner.query(
        `INSERT INTO sender (user_id, address, domain, first_seen_at, last_seen_at, muted) VALUES ($1, 'news@shop.example', 'shop.example', now(), now(), true)`,
        [first.userId],
      );

      const second = await signUp(owner);
      await consent(second.userId);
      const b2 = await begin(second);
      await ageSession(owner, second.token, 60_000); // different login address: ≤ 5 min is fine
      google.nonce = b2.nonce;
      script(second, shared);
      fake.calls.length = 0;
      expect(location(await callback(second, { code: "4/b", state: b2.state }, b2.cookie))).toBe("/gallery?connected=1");
      expect(revokes()).toHaveLength(0); // never /revoke: it would kill the new grant
      expect((await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [first.userId])).rowCount).toBe(0);
      expect((await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [second.userId])).rowCount).toBe(1);
      expect((await owner.query("SELECT 1 FROM sender WHERE user_id = $1", [first.userId])).rowCount).toBe(0);
      const a1 = await owner.query("SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'mailbox.claimed_elsewhere'", [first.userId]);
      const a2 = await owner.query("SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'mailbox.claimed_from_other_account'", [second.userId]);
      expect(a1.rowCount).toBe(1);
      expect(a2.rowCount).toBe(1);
    });

    it("?reconnect=1 at the mailbox limit reconnects one of your mailboxes but never adds a new one", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      // Two mailboxes, the first bound to the Google account the "real" reconnect below uses.
      for (let i = 0; i < 2; i++) {
        await owner.query(
          `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
           VALUES ($1, 'gmail', $2, $3, $4, 'done', 1)`,
          [u.userId, i === 0 ? `g-${u.userId}` : `limit-${u.userId}-${i}`, i === 0 ? u.email : `m${i}-${u.userId}@gmail.example`, i === 0 ? "needs_reauth" : "active"],
        );
      }
      const mailboxes = async () => (await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [u.userId])).rowCount;
      const seen = async () => Number((await owner.query<{ n: string }>("SELECT count(*) AS n FROM oauth_subject_seen")).rows[0]!.n);

      // A third Google account through the reconnect door: refused, the grant revoked, nothing counted.
      const b = await begin(u, "?reconnect=1");
      google.nonce = b.nonce;
      const third = `third-${u.userId}@gmail.example`.toLowerCase();
      script(u, { sub: `third-${u.userId}`, idEmail: third, profileEmail: third }); // a fresh session: another address is fine
      const before = await seen();
      expect(location(await callback(u, { code: "4/c", state: b.state }, b.cookie))).toBe("/connect?error=limit");
      expect(revokes()).toHaveLength(1);
      expect(await mailboxes()).toBe(2);
      expect(await seen()).toBe(before);

      // A genuine reconnect of one of the two still works at the limit.
      fake.calls.length = 0;
      const b2 = await begin(u, "?reconnect=1");
      google.nonce = b2.nonce;
      script(u);
      expect(location(await callback(u, { code: "4/c2", state: b2.state }, b2.cookie))).toBe("/settings?reconnected=1");
      expect(revokes()).toHaveLength(0);
      expect(await mailboxes()).toBe(2);
    });

    it("a callback that loses the race for the last slot has changed nothing: no binding moved, no account counted", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      await owner.query(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1)`,
        [u.userId, `g-${u.userId}`, u.email],
      );
      // Another user's mailbox bound to the Google account u is about to connect (the conflict rule would move it).
      const other = await signUp(owner);
      const sub = `contested-${u.userId}`;
      const address = `contested-${u.userId}@gmail.example`.toLowerCase();
      const otherMailbox = (await owner.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
         VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1) RETURNING id`,
        [other.userId, sub, address],
      )).rows[0]!.id;
      const seen = async () => Number((await owner.query<{ n: string }>("SELECT count(*) AS n FROM oauth_subject_seen")).rows[0]!.n);
      const before = await seen();

      const b = await begin(u);
      google.nonce = b.nonce;
      script(u, { sub, idEmail: address, profileEmail: address });
      // A concurrent connect of the same user holds the per-user lock and takes the last slot.
      const racer = await owner.connect();
      try {
        await racer.query("BEGIN");
        await racer.query("SELECT 1 FROM user_settings WHERE user_id = $1 FOR UPDATE", [u.userId]);
        const pending = callback(u, { code: "4/race", state: b.state }, b.cookie);
        const racerPid = (await racer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        for (let i = 0; ; i++) {
          const blocked = await owner.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [racerPid]);
          if (Number(blocked.rows[0]!.n) > 0) break;
          if (i > 200) throw new Error("the callback never waited for the per-user lock");
          await new Promise((r) => setTimeout(r, 25));
        }
        await racer.query(
          `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
           VALUES ($1, 'gmail', $2, $3, 'active', 'done', 1)`,
          [u.userId, `racer-${u.userId}`, `racer-${u.userId}@gmail.example`],
        );
        await racer.query("COMMIT");
        expect(location(await pending)).toBe("/connect?error=limit");
      } finally {
        await racer.query("ROLLBACK").catch(() => {});
        racer.release();
      }
      expect(revokes()).toHaveLength(1);
      expect((await owner.query("SELECT 1 FROM mailbox WHERE id = $1 AND user_id = $2", [otherMailbox, other.userId])).rowCount).toBe(1);
      expect((await owner.query("SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'mailbox.claimed_elsewhere'", [other.userId])).rowCount).toBe(0);
      expect(await seen()).toBe(before);
      expect((await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [u.userId])).rowCount).toBe(2); // no placeholder left
    });
  });

  describe("a friend whose invite was removed", () => {
    const removeInvite = (email: string) => owner.query("DELETE FROM beta_allowlist WHERE email = $1 AND role = 'friend'", [email]);

    it("is signed out, can't start or finish a connect, and can't sign back in", async () => {
      const u = await signUp(owner);
      await consent(u.userId);
      const b = await begin(u);
      await removeInvite(u.email);

      // The connect flow's own checks (whatever session got this far): no redirect, no token exchange.
      const { startConnect, finishConnect } = await import("@/server/connect");
      const asUser = { userId: u.userId, email: u.email, name: "Route Tester", image: null, sessionId: "s", sessionCreatedAt: new Date(), role: "friend" as const };
      expect(await startConnect(asUser, {})).toEqual({ kind: "error", code: "not_invited" });
      const sessionId = (await owner.query<{ id: string }>("SELECT id FROM session WHERE token = $1", [u.token])).rows[0]!.id;
      google.nonce = b.nonce;
      script(u);
      expect(await finishConnect({ ...asUser, sessionId }, { code: "4/c", state: b.state, error: null }, b.cookie)).toEqual({ kind: "error", code: "not_invited" });
      expect(fake.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(0);

      // Through the routes: the session is refused (and ended) before any of that.
      expect(location(await callback(u, { code: "4/c", state: b.state }, b.cookie))).toBe("/sign-in");
      expect(location(await start(u))).toBe("/sign-in");
      expect((await owner.query("SELECT 1 FROM session WHERE token = $1", [u.token])).rowCount).toBe(0);
      expect((await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [u.userId])).rowCount).toBe(0);

      const { auth } = await import("@/server/auth");
      await expect(auth().api.signInEmail({ body: { email: u.email, password: "correct-horse-battery-staple" } })).rejects.toThrow(/invite-only/);
    });

    it("the owner, whose invite can't be removed, keeps connecting", async () => {
      const u = await signUp(owner, { role: "owner" });
      await consent(u.userId);
      await removeInvite(u.email); // a no-op for the owner's row, as remove_invite()
      expect(new URL((await start(u)).headers.get("location")!).origin).toBe("https://accounts.google.com");
    });
  });
});
