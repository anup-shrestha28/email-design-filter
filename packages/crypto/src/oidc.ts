/**
 * Vercel function OIDC token verification (FREE-TIER.md §9.2, §9.3).
 *
 * Pinned `iss`, `aud` (single value) and `sub`; `alg` RS256 only (Vercel's documented algorithm);
 * `exp − iat === 7200` exactly (function tokens live 2 h, build tokens 1 h, development 12 h);
 * `iat` not in the future; 30 s clock tolerance for `nbf`/`exp` (DECISIONS.md D-C5).
 * The JWKS URL comes from `${issuer}/.well-known/openid-configuration` (never hard-coded) and must
 * be HTTPS on the issuer's origin. Discovery is cached for 1 h; failures back off for 30 s.
 */
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { assertDevOnly, isPlainObject } from "./encoding";
import { CryptoConfigError } from "./errors";

export interface OidcExpectations {
  /** https://oidc.vercel.com/<team> */
  issuer: string;
  audience: string;
  /** owner:<team>:project:<name>:environment:production */
  subject: string;
}

export interface OidcVerifierOptions {
  /**
   * JWKS override (a JWKS object `{keys:[…]}` or a jose key resolver). Tests and local development
   * only: refused when NODE_ENV=production or any Vercel runtime marker is set.
   */
  jwks?: unknown;
  /** fetch used for discovery and JWKS (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
}

/** Vercel function tokens live exactly two hours. */
export const OIDC_FUNCTION_TOKEN_TTL_SEC = 7200;
const CLOCK_TOLERANCE_SEC = 30;
const MAX_TOKEN_LENGTH = 8192;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_BACKOFF_MS = 30 * 1000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5000;

function assertExpectation(name: string, v: unknown): asserts v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 512 || /\s/.test(v)) {
    throw new CryptoConfigError(`OIDC ${name}: invalid`);
  }
}

async function readCappedText(res: Response, max: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function discoveryResolver(issuer: string, fetchImpl: typeof fetch): JWTVerifyGetKey {
  const issuerUrl = new URL(issuer);
  let cached: { jwksUri: string; remote: JWTVerifyGetKey; at: number } | null = null;
  let failedAt = 0;
  let pending: Promise<JWTVerifyGetKey> | null = null;

  async function discover(): Promise<JWTVerifyGetKey> {
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("discovery status");
    }
    const doc: unknown = JSON.parse(await readCappedText(res, DISCOVERY_MAX_BYTES));
    if (!isPlainObject(doc) || doc.issuer !== issuer || typeof doc.jwks_uri !== "string") {
      throw new Error("discovery document");
    }
    const jwksUrl = new URL(doc.jwks_uri);
    if (
      jwksUrl.protocol !== "https:" ||
      jwksUrl.origin !== issuerUrl.origin ||
      jwksUrl.username ||
      jwksUrl.password
    ) {
      throw new Error("discovery jwks_uri");
    }
    if (cached !== null && cached.jwksUri === jwksUrl.href) {
      cached = { ...cached, at: Date.now() };
      return cached.remote;
    }
    const remote = createRemoteJWKSet(jwksUrl, {
      timeoutDuration: FETCH_TIMEOUT_MS,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      [customFetch]: fetchImpl,
    });
    cached = { jwksUri: jwksUrl.href, remote, at: Date.now() };
    return remote;
  }

  async function resolver(): Promise<JWTVerifyGetKey> {
    const now = Date.now();
    if (cached !== null && now - cached.at < DISCOVERY_TTL_MS) return cached.remote;
    if (pending !== null) return pending;
    if (now - failedAt < DISCOVERY_BACKOFF_MS) {
      if (cached !== null) return cached.remote; // stale but pinned to the issuer origin
      throw new Error("discovery backoff");
    }
    pending = discover()
      .catch((err: unknown) => {
        failedAt = Date.now();
        if (cached !== null) return cached.remote;
        throw err;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return async (header, token) => {
    const getKey = await resolver();
    return getKey(header, token);
  };
}

function overrideResolver(jwks: unknown): JWTVerifyGetKey {
  if (typeof jwks === "function") return jwks as JWTVerifyGetKey;
  if (isPlainObject(jwks) && Array.isArray(jwks.keys))
    return createLocalJWKSet(jwks as unknown as JSONWebKeySet);
  throw new CryptoConfigError("OIDC jwks override: expected a JWKS object or key resolver");
}

/**
 * Verify a Vercel function OIDC token with jose: JWKS resolved from
 * `${issuer}/.well-known/openid-configuration` (cached), pinned iss/aud/sub, and
 * `exp − iat === 7200` (rejects 1-hour build tokens). Returns null on any failure.
 * `jwks` overrides discovery (tests and local development only).
 */
export function createOidcVerifier(
  expect: OidcExpectations,
  opts?: OidcVerifierOptions,
): (token: string) => Promise<{ sub: string } | null> {
  assertExpectation("issuer", expect?.issuer);
  assertExpectation("audience", expect?.audience);
  assertExpectation("subject", expect?.subject);
  const { issuer, audience, subject } = expect;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;

  let getKey: JWTVerifyGetKey;
  if (opts?.jwks !== undefined) {
    assertDevOnly("OIDC jwks override");
    getKey = overrideResolver(opts.jwks);
  } else {
    let u: URL;
    try {
      u = new URL(issuer);
    } catch {
      throw new CryptoConfigError("OIDC issuer: not a URL");
    }
    if (
      u.protocol !== "https:" ||
      u.search ||
      u.hash ||
      u.username ||
      u.password ||
      issuer.endsWith("/")
    ) {
      throw new CryptoConfigError("OIDC issuer: must be an https URL without trailing slash");
    }
    getKey = discoveryResolver(issuer, fetchImpl);
  }

  return async (token: string) => {
    try {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
        return null;
      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience,
        subject,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SEC,
        maxTokenAge: OIDC_FUNCTION_TOKEN_TTL_SEC,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp"],
      });
      const { iat, exp, aud, sub, iss } = payload;
      if (iss !== issuer || sub !== subject) return null;
      if (!(aud === audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === audience)))
        return null;
      if (typeof iat !== "number" || typeof exp !== "number") return null;
      if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
      if (exp - iat !== OIDC_FUNCTION_TOKEN_TTL_SEC) return null;
      return { sub };
    } catch {
      return null;
    }
  };
}
