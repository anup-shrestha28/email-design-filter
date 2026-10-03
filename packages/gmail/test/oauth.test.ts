import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertConnectGrant,
  assertProfileEmailMatches,
  buildAuthUrl,
  ConnectError,
  createPkcePair,
  exchangeCode,
  GlobalIncidentError,
  GMAIL_READONLY_SCOPE,
  isGlobalIncident,
  OAuthError,
  pkceChallenge,
  refreshAccessToken,
  revokeToken,
  verifyConnectorIdToken,
} from "../src/index";
import { fakeFetch, json } from "./fake-http";

const CLIENT = { clientId: "connector.apps.googleusercontent.com", clientSecret: "shh-secret" };

describe("buildAuthUrl / PKCE (DESIGN §4.3)", () => {
  it("requests exactly the connector scopes with offline access, PKCE S256, nonce and login_hint", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
    const url = new URL(
      buildAuthUrl({
        clientId: CLIENT.clientId,
        redirectUri: "https://edf.example/api/mailboxes/google/callback",
        state: "s".repeat(32),
        codeChallenge: challenge,
        nonce: "n".repeat(32),
        loginHint: "me@example.com",
        prompt: "consent",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("scope")).toBe(`openid email ${GMAIL_READONLY_SCOPE}`);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(challenge);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("login_hint")).toBe("me@example.com");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("nonce")).toBe("n".repeat(32));
  });

  it("omits prompt unless asked (prompt=consent only on first connect/reconnect)", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "c",
        redirectUri: "https://x/cb",
        state: "s".repeat(16),
        codeChallenge: pkceChallenge("v"),
        nonce: "n".repeat(16),
      }),
    );
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.has("login_hint")).toBe(false);
    expect(() =>
      buildAuthUrl({
        clientId: "c",
        redirectUri: "https://x/cb",
        state: "short",
        codeChallenge: pkceChallenge("v"),
        nonce: "n".repeat(16),
      }),
    ).toThrow(TypeError);
  });
});

describe("token endpoint", () => {
  it("exchanges a code and validates the grant", async () => {
    const f = fakeFetch(() =>
      json({
        access_token: "at",
        expires_in: 3599,
        refresh_token: "rt",
        scope: `openid ${GMAIL_READONLY_SCOPE} email`,
        token_type: "Bearer",
        id_token: "idt",
      }),
    );
    const t = await exchangeCode(
      { code: "c0de", codeVerifier: "ver", redirectUri: "https://x/cb" },
      { ...CLIENT, fetch: f, now: () => 1_000_000 },
    );
    expect(t).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3599,
      idToken: "idt",
    });
    expect(t.expiresAt.getTime()).toBe(1_000_000 + 3599_000);
    const body = new URLSearchParams(f.calls[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("ver");
    expect(f.calls[0]?.redirect).toBe("error");
    expect(() => assertConnectGrant(t)).not.toThrow();
    expect(() => assertConnectGrant({ ...t, refreshToken: null })).toThrow(
      expect.objectContaining({ reason: "no_refresh_token" }),
    );
    expect(() => assertConnectGrant({ ...t, scopes: ["openid", "email"] })).toThrow(
      expect.objectContaining({ reason: "scope_missing" }),
    );
    expect(() => assertConnectGrant({ ...t, idToken: null })).toThrow(
      expect.objectContaining({ reason: "id_token_missing" }),
    );
  });

  it.each([
    [400, "invalid_grant", "invalid_grant", false],
    [401, "invalid_client", "invalid_client", false],
    [400, "unauthorized_client", "unauthorized_client", false],
    [401, "deleted_client", "deleted_client", false],
    [400, "admin_policy_enforced", "admin_policy_enforced", false],
    [500, "internal_failure", "other", true],
    [429, "rate_limit_exceeded", "other", true],
    [400, "Some Weird Thing", "other", false],
  ] as const)("maps HTTP %i %s → %s (retriable=%s)", async (status, code, kind, retriable) => {
    const f = fakeFetch(() =>
      json({ error: code, error_description: "Token for user@example.com revoked" }, status),
    );
    const err = (await refreshAccessToken("rt-secret", { ...CLIENT, fetch: f }).catch(
      (e: unknown) => e,
    )) as OAuthError;
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.kind).toBe(kind);
    expect(err.retriable).toBe(retriable);
    expect(err.message).not.toContain("user@example.com");
    expect(err.message).not.toContain("rt-secret");
    expect(isGlobalIncident(err)).toBe(
      ["invalid_client", "unauthorized_client", "deleted_client"].includes(kind),
    );
  });

  it("network failures are retriable `network` errors", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(refreshAccessToken("rt", { ...CLIENT, fetch: f })).rejects.toMatchObject({
      kind: "network",
      retriable: true,
    });
    expect(isGlobalIncident(new GlobalIncidentError("deleted_client"))).toBe(true);
    expect(isGlobalIncident(new Error("x"))).toBe(false);
  });

  it("refresh sends the refresh_token grant and reports rotation only when present", async () => {
    const f = fakeFetch(() =>
      json({ access_token: "at2", expires_in: 3600, scope: GMAIL_READONLY_SCOPE }),
    );
    const t = await refreshAccessToken("rt", { ...CLIENT, fetch: f });
    expect(t.refreshToken).toBeNull();
    expect(new URLSearchParams(f.calls[0]?.body ?? "").get("grant_type")).toBe("refresh_token");
    const bad = fakeFetch(() => json({ access_token: "", expires_in: 3600 }));
    await expect(refreshAccessToken("rt", { ...CLIENT, fetch: bad })).rejects.toMatchObject({
      kind: "other",
      code: "bad_response",
    });
  });

  it("revoke treats an already-invalid token as revoked", async () => {
    const ok = fakeFetch(() => new Response("", { status: 200 }));
    await expect(revokeToken("rt", { fetch: ok })).resolves.toEqual({
      revoked: true,
      alreadyInvalid: false,
    });
    expect(ok.calls[0]?.url.href).toBe("https://oauth2.googleapis.com/revoke");
    const gone = fakeFetch(() => json({ error: "invalid_token" }, 400));
    await expect(revokeToken("rt", { fetch: gone })).resolves.toEqual({
      revoked: true,
      alreadyInvalid: true,
    });
    const down = fakeFetch(() => json({ error: "backend" }, 503));
    await expect(revokeToken("rt", { fetch: down })).rejects.toMatchObject({ retriable: true });
  });

  it("profile email must match the id_token email case-insensitively", () => {
    expect(() => assertProfileEmailMatches("Me@Example.com", "me@example.COM")).not.toThrow();
    expect(() => assertProfileEmailMatches("me@example.com", "other@example.com")).toThrow(
      ConnectError,
    );
  });
});

describe("verifyConnectorIdToken", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const certs = fakeFetch((req) =>
    req.url.href.startsWith("https://www.googleapis.com/oauth2/v1/certs")
      ? json({ k1: pem }, 200, { "cache-control": "max-age=3600" })
      : new Response("", { status: 404 }),
  );
  const now = Math.floor(Date.now() / 1000);
  function jwt(payload: Record<string, unknown>, kid = "k1"): string {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
    return `${h}.${p}.${s}`;
  }
  const good = {
    iss: "https://accounts.google.com",
    aud: CLIENT.clientId,
    sub: "1234567890",
    email: "Me@Example.com",
    email_verified: true,
    nonce: "nonce-abcdefghijklmnop",
    iat: now - 10,
    exp: now + 3000,
  };
  const verify = (token: string, nonce = good.nonce) =>
    verifyConnectorIdToken(token, { clientId: CLIENT.clientId, nonce, fetch: certs });

  it("accepts a valid token and returns sub/email/email_verified", async () => {
    await expect(verify(jwt(good))).resolves.toEqual({
      sub: "1234567890",
      email: "Me@Example.com",
      emailVerified: true,
    });
  });

  it.each([
    ["wrong audience", { ...good, aud: "other-client" }, "id_token_invalid"],
    ["wrong issuer", { ...good, iss: "https://evil.example" }, "id_token_invalid"],
    ["expired", { ...good, iat: now - 7200, exp: now - 3600 }, "id_token_invalid"],
    ["unverified email", { ...good, email_verified: false }, "email_unverified"],
    ["no email", { ...good, email: undefined }, "email_unverified"],
    ["missing nonce", { ...good, nonce: undefined }, "nonce_mismatch"],
  ])("rejects %s", async (_name, payload, reason) => {
    const err = (await verify(jwt(payload)).catch((e: unknown) => e)) as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain("Me@Example.com");
  });

  it("rejects a nonce mismatch, a bad signature and an unknown key", async () => {
    await expect(verify(jwt(good), "another-nonce-value")).rejects.toMatchObject({
      reason: "nonce_mismatch",
    });
    const t = jwt(good);
    const tampered = `${t.split(".").slice(0, 2).join(".")}.${Buffer.from("x".repeat(256)).toString("base64url")}`;
    await expect(verify(tampered)).rejects.toMatchObject({ reason: "id_token_invalid" });
    await expect(verify(jwt(good, "unknown-kid"))).rejects.toMatchObject({
      reason: "id_token_invalid",
    });
  });
});
