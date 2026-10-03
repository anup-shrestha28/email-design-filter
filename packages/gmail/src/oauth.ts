/**
 * Connector OAuth for Gmail (DESIGN.md §4.3, §4.4; FREE-TIER.md §4.8, §9.1).
 *
 *  - Authorization URL: `openid email gmail.readonly`, `access_type=offline`,
 *    `include_granted_scopes=true`, PKCE S256, nonce, login_hint; `prompt=consent` only on first
 *    connect or reconnect (Google keeps ≤ 100 refresh tokens per account per client).
 *  - Token, refresh and revoke calls go straight to Google's endpoints with an injectable
 *    fetch, so errors map precisely onto `OAuthError.kind`.
 *  - ID tokens are verified with google-auth-library (`OAuth2Client.verifyIdToken`), plus our
 *    own nonce and `email_verified` checks. Library error messages embed the token and its
 *    payload (incl. the address), so they are never propagated.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { ConnectError, OAuthError, type OAuthErrorKind } from "./errors";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Connector scopes (DESIGN.md §4.3). */
export const CONNECTOR_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE] as const;

const TIMEOUT_MS = 10_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  /** base64url(SHA-256(verifier)), 43 chars. */
  codeChallenge: string;
  nonce: string;
  /** The address the user said they'd connect (pre-selects the account). */
  loginHint?: string | null;
  /** "consent" only on first connect or reconnect (DESIGN.md §4.3). */
  prompt?: "consent" | "select_account" | "none" | null;
}

/** Build the Google authorization URL for the connector client. */
export function buildAuthUrl(p: AuthUrlParams): string {
  if (!p.clientId || !p.redirectUri)
    throw new TypeError("buildAuthUrl: clientId and redirectUri are required");
  if (!p.state || p.state.length < 16)
    throw new TypeError("buildAuthUrl: state must be ≥ 16 chars");
  if (!p.nonce || p.nonce.length < 16)
    throw new TypeError("buildAuthUrl: nonce must be ≥ 16 chars");
  if (!B64URL.test(p.codeChallenge) || p.codeChallenge.length !== 43) {
    throw new TypeError("buildAuthUrl: codeChallenge must be a base64url SHA-256 digest");
  }
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  const q = u.searchParams;
  q.set("client_id", p.clientId);
  q.set("redirect_uri", p.redirectUri);
  q.set("response_type", "code");
  q.set("scope", CONNECTOR_SCOPES.join(" "));
  q.set("access_type", "offline");
  q.set("include_granted_scopes", "true");
  q.set("state", p.state);
  q.set("code_challenge", p.codeChallenge);
  q.set("code_challenge_method", "S256");
  q.set("nonce", p.nonce);
  if (p.loginHint) q.set("login_hint", p.loginHint);
  if (p.prompt) q.set("prompt", p.prompt);
  return u.toString();
}

/** A PKCE pair: a 256-bit random verifier and its S256 challenge (RFC 7636). */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(86_400 * 7),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(4096).optional(),
  token_type: z.string().max(32).optional(),
  id_token: z.string().min(1).max(16_384).optional(),
});

const errorResponseSchema = z.object({ error: z.string().max(128).optional() });

export interface TokenSet {
  accessToken: string;
  /** Null when Google didn't issue one (refresh responses, or a repeat consent without prompt). */
  refreshToken: string | null;
  expiresIn: number;
  expiresAt: Date;
  scopes: string[];
  idToken: string | null;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
  "admin_policy_enforced",
]);

/** Map a Google OAuth `error` code onto our kinds. Pure; exported for tests. */
export function oauthErrorKind(code: string | null): OAuthErrorKind {
  return code !== null && KNOWN_KINDS.has(code) ? (code as OAuthErrorKind) : "other";
}

async function postForm(
  operation: string,
  url: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError("network", { operation });
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new OAuthError("network", { operation, status: res.status });
  }
  if (text.length > 64 * 1024) throw new OAuthError("other", { operation, status: res.status });
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    const raw = parsed.success ? (parsed.data.error ?? null) : null;
    const code = raw !== null && /^[a-z_]{1,64}$/.test(raw) ? raw : null;
    throw new OAuthError(oauthErrorKind(code), { operation, status: res.status, code });
  }
  return { status: res.status, json };
}

function toTokenSet(operation: string, json: unknown, now: number): TokenSet {
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new OAuthError("other", { operation, code: "bad_response" });
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresIn: t.expires_in,
    expiresAt: new Date(now + t.expires_in * 1000),
    scopes: (t.scope ?? "").split(/\s+/).filter(Boolean),
    idToken: t.id_token ?? null,
  };
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCode(
  p: { code: string; codeVerifier: string; redirectUri: string },
  cfg: OAuthClientConfig,
): Promise<TokenSet> {
  const now = cfg.now ?? Date.now;
  const { json } = await postForm(
    "token",
    GOOGLE_TOKEN_ENDPOINT,
    {
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    },
    cfg.fetch ?? fetch,
  );
  return toTokenSet("token", json, now());
}

/**
 * Abort the connect unless a refresh token was issued, `gmail.readonly` was actually granted
 * (granular consent lets users untick it) and an id_token is present (DESIGN.md §4.3).
 */
export function assertConnectGrant(tokens: TokenSet): asserts tokens is TokenSet & {
  refreshToken: string;
  idToken: string;
} {
  if (!tokens.refreshToken) throw new ConnectError("no_refresh_token");
  if (!tokens.scopes.includes(GMAIL_READONLY_SCOPE)) throw new ConnectError("scope_missing");
  if (!tokens.idToken) throw new ConnectError("id_token_missing");
}

/** `getProfile.emailAddress` must equal the id_token email, case-insensitively (DESIGN.md §4.3). */
export function assertProfileEmailMatches(profileEmail: string, idTokenEmail: string): void {
  if (profileEmail.trim().toLowerCase() !== idTokenEmail.trim().toLowerCase()) {
    throw new ConnectError("email_mismatch");
  }
}

export interface VerifiedIdToken {
  /** The stable Google account id (mailbox identity, `provider_account_id`). */
  sub: string;
  email: string;
  emailVerified: boolean;
}

const idPayloadSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320).optional(),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  nonce: z.string().max(512).optional(),
});

const verifierCache = new Map<string, OAuth2Client>();

function constantTimeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/**
 * Verify the connector id_token: signature (Google certs), `iss`, `exp`, `aud` = the connector
 * client, then our nonce and `email_verified` (DESIGN.md §4.3). Throws `ConnectError`.
 */
export async function verifyConnectorIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; fetch?: typeof fetch },
): Promise<VerifiedIdToken> {
  let client: OAuth2Client;
  if (opts.fetch)
    client = new OAuth2Client({ transporterOptions: { fetchImplementation: opts.fetch } });
  else {
    const cached = verifierCache.get("default");
    client = cached ?? new OAuth2Client();
    if (!cached) verifierCache.set("default", client);
  }
  let payload: unknown;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: opts.clientId });
    payload = ticket.getPayload();
  } catch {
    // The library's messages contain the token/payload: never propagate them.
    throw new ConnectError("id_token_invalid");
  }
  const parsed = idPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new ConnectError("id_token_invalid");
  const p = parsed.data;
  if (p.nonce === undefined || !constantTimeEqual(p.nonce, opts.nonce))
    throw new ConnectError("nonce_mismatch");
  const verified = p.email_verified === true || p.email_verified === "true";
  if (!p.email || !verified) throw new ConnectError("email_unverified");
  return { sub: p.sub, email: p.email, emailVerified: verified };
}

/** Refresh an access token (DESIGN.md §4.4). `refreshToken` in the result is set only if rotated. */
export async function refreshAccessToken(
  refreshToken: string,
  cfg: OAuthClientConfig,
): Promise<TokenSet> {
  const now = cfg.now ?? Date.now;
  const { json } = await postForm(
    "refresh",
    GOOGLE_TOKEN_ENDPOINT,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    },
    cfg.fetch ?? fetch,
  );
  return toTokenSet("refresh", json, now());
}

/**
 * Revoke a grant (DESIGN.md §5.8; FREE-TIER.md §4.9). Revoking the refresh token removes every
 * scope of the project for that account. An already-invalid token (400 `invalid_token`) counts
 * as success: the grant is gone either way.
 */
export async function revokeToken(
  token: string,
  cfg: { fetch?: typeof fetch } = {},
): Promise<{ revoked: true; alreadyInvalid: boolean }> {
  try {
    await postForm("revoke", GOOGLE_REVOKE_ENDPOINT, { token }, cfg.fetch ?? fetch);
    return { revoked: true, alreadyInvalid: false };
  } catch (err) {
    if (
      err instanceof OAuthError &&
      err.status === 400 &&
      (err.code === "invalid_token" || err.kind === "invalid_grant")
    ) {
      return { revoked: true, alreadyInvalid: true };
    }
    throw err;
  }
}
