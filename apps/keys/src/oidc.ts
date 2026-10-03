/**
 * OIDC for edf-keys (FREE-TIER.md §9.2), jose only.
 *
 * Incoming: edf-app's Vercel *function* token — pinned iss (`OIDC_ISSUER`, team issuer), sub
 * (`APP_OIDC_SUB`), aud (`KEYS_AUD`, the deployment's configured audience — in practice the
 * default team audience, since callers send the plain function token; DECISIONS.md D-O1),
 * RS256 only, `exp − iat === 7200` (rejects 1-hour build tokens). JWKS from discovery.
 * Mirrors @edf/crypto `createOidcVerifier`; test/handler.test.ts cross-checks with its dev issuer.
 *
 * Outgoing (to edf-app `/api/keys-audit`): edf-keys' own function token, read from the
 * `x-vercel-oidc-token` request header (fallback env `VERCEL_OIDC_TOKEN`), never exchanged.
 */
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";

export const FUNCTION_TOKEN_TTL_SEC = 7200;
const CLOCK_TOLERANCE_SEC = 30;
const FETCH_TIMEOUT_MS = 5000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_BACKOFF_MS = 30 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export interface OidcExpect {
  issuer: string;
  audience: string;
  subject: string;
}

export type Verifier = (token: string) => Promise<{ sub: string } | null>;

function discoveryResolver(issuer: string, fetchImpl: typeof fetch): JWTVerifyGetKey {
  const origin = new URL(issuer).origin;
  let cached: { uri: string; getKey: JWTVerifyGetKey; at: number } | null = null;
  let failedAt = 0;
  let pending: Promise<JWTVerifyGetKey> | null = null;

  const discover = async (): Promise<JWTVerifyGetKey> => {
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    if (res.status !== 200 || text.length > 64 * 1024) throw new Error("discovery");
    const doc = JSON.parse(text) as { issuer?: unknown; jwks_uri?: unknown };
    if (doc.issuer !== issuer || typeof doc.jwks_uri !== "string") throw new Error("discovery");
    const jwks = new URL(doc.jwks_uri);
    if (jwks.protocol !== "https:" || jwks.origin !== origin || jwks.username || jwks.password)
      throw new Error("jwks_uri");
    if (cached?.uri === jwks.href) return (cached = { ...cached, at: Date.now() }).getKey;
    const getKey = createRemoteJWKSet(jwks, {
      timeoutDuration: FETCH_TIMEOUT_MS,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
    cached = { uri: jwks.href, getKey, at: Date.now() };
    return getKey;
  };

  const resolve = async (): Promise<JWTVerifyGetKey> => {
    const now = Date.now();
    if (cached !== null && now - cached.at < DISCOVERY_TTL_MS) return cached.getKey;
    if (pending !== null) return pending;
    if (now - failedAt < DISCOVERY_BACKOFF_MS) {
      if (cached !== null) return cached.getKey;
      throw new Error("discovery backoff");
    }
    pending = discover()
      .catch((e: unknown) => {
        failedAt = Date.now();
        if (cached !== null) return cached.getKey;
        throw e;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return async (header, token) => (await resolve())(header, token);
}

/** Build the verifier. `jwks` (a JWKS object) replaces discovery — local development/tests only. */
export function createVerifier(
  expect: OidcExpect,
  opts: { jwks?: JSONWebKeySet; fetchImpl?: typeof fetch } = {},
): Verifier {
  const getKey =
    opts.jwks !== undefined
      ? createLocalJWKSet(opts.jwks)
      : discoveryResolver(expect.issuer, opts.fetchImpl ?? fetch);
  return async (token) => {
    try {
      if (typeof token !== "string" || token.length > 8192 || !TOKEN_RE.test(token)) return null;
      const { payload } = await jwtVerify(token, getKey, {
        issuer: expect.issuer,
        audience: expect.audience,
        subject: expect.subject,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
        maxTokenAge: FUNCTION_TOKEN_TTL_SEC,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp"],
      });
      const { iat, exp, aud, sub } = payload;
      if (sub !== expect.subject) return null;
      if (!(
        aud === expect.audience ||
        (Array.isArray(aud) && aud.length === 1 && aud[0] === expect.audience)
      ))
        return null;
      if (
        !Number.isSafeInteger(iat) ||
        !Number.isSafeInteger(exp) ||
        (exp as number) - (iat as number) !== FUNCTION_TOKEN_TTL_SEC
      ) {
        return null;
      }
      return { sub };
    } catch {
      return null;
    }
  };
}

/** Source of edf-keys' own function token for outgoing calls. */
export type TokenSource = (request: Request) => Promise<string | null>;

function requestContextHeader(name: string): string | null {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    { get?: () => { headers?: Record<string, string | undefined> } | undefined } | undefined;
  const v = ctx?.get?.()?.headers?.[name];
  return typeof v === "string" ? v : null;
}

/** Production: the plain function token Vercel injects (no audience exchange; DECISIONS.md D-O1). */
export const vercelTokenSource: TokenSource = async (request) => {
  const t =
    request.headers.get("x-vercel-oidc-token") ??
    requestContextHeader("x-vercel-oidc-token") ??
    process.env.VERCEL_OIDC_TOKEN ??
    null;
  return t !== null && TOKEN_RE.test(t) && t.length <= 8192 ? t : null;
};

/** Local development: mint a token shaped like a Vercel function token from `DEV_OIDC_PRIVATE_JWK`. */
export function devTokenSource(
  privateJwk: JWK,
  claims: { issuer: string; subject: string; audience: string },
): TokenSource {
  if (typeof privateJwk.kid !== "string") throw new Error("DEV_OIDC_PRIVATE_JWK needs a kid");
  return async () => {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: privateJwk.kid as string, typ: "JWT" })
      .setIssuer(claims.issuer)
      .setSubject(claims.subject)
      .setAudience(claims.audience)
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(iat + FUNCTION_TOKEN_TTL_SEC)
      .sign(await importJWK(privateJwk, "RS256"));
  };
}
