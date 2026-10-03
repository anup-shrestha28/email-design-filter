/**
 * Local-development stand-in for Vercel OIDC (no Vercel in dev). Every function refuses to run
 * when NODE_ENV=production or a Vercel runtime marker (VERCEL_ENV, VERCEL=1) is set.
 *
 * Tokens mirror Vercel function tokens: RS256, `typ: JWT`, a `kid`, and `exp − iat = 7200`, so
 * `createOidcVerifier(expect, { jwks: issuer.jwks })` verifies them unchanged. Share the issuer
 * between processes with the env vars printed by `scripts/gen-keys.ts --dev`:
 * `DEV_OIDC_PRIVATE_JWK` (minting side) and `DEV_OIDC_JWKS` (verifying side).
 */
import { randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { assertDevOnly, isPlainObject } from "./encoding";
import { CryptoConfigError } from "./errors";
import { OIDC_FUNCTION_TOKEN_TTL_SEC } from "./oidc";

export interface DevOidcIssuer {
  readonly issuer: string;
  readonly kid: string;
  /** Public JWKS, for the `jwks` option of createOidcVerifier and `DEV_OIDC_JWKS`. */
  readonly jwks: { keys: JWK[] };
  /** Private RSA JWK (dev only), for `DEV_OIDC_PRIVATE_JWK`. */
  readonly privateJwk: JWK;
}

/** Default dev issuer string (never a real Vercel issuer); env `DEV_OIDC_ISSUER` overrides. */
export const DEV_OIDC_ISSUER = "https://oidc.dev.invalid/edf-dev";
/** Default dev audience (stands in for `https://vercel.com/<team>`); env `DEV_OIDC_AUD` overrides. */
export const DEV_OIDC_AUDIENCE = "https://vercel.com/edf-dev";
/** Default dev subjects (env `DEV_APP_SUB`, `DEV_VIEW_SUB`, `DEV_KEYS_SUB`). */
export const DEV_OIDC_SUBJECTS = Object.freeze({
  app: "dev:edf-app",
  view: "dev:edf-view",
  keys: "dev:edf-keys",
});

function publicFromPrivate(priv: JWK, kid: string): JWK {
  if (priv.kty !== "RSA" || typeof priv.n !== "string" || typeof priv.e !== "string") {
    throw new CryptoConfigError("dev OIDC: expected an RSA private JWK");
  }
  return { kty: "RSA", n: priv.n, e: priv.e, kid, alg: "RS256", use: "sig" };
}

/** Generate a fresh RS256 dev issuer (2048-bit RSA). */
export async function createDevOidcIssuer(opts?: { issuer?: string }): Promise<DevOidcIssuer> {
  assertDevOnly("createDevOidcIssuer");
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const kid = `dev-${randomBytes(6).toString("hex")}`;
  const privateJwk: JWK = { ...(await exportJWK(privateKey)), kid, alg: "RS256", use: "sig" };
  return Object.freeze({
    issuer: opts?.issuer ?? DEV_OIDC_ISSUER,
    kid,
    jwks: { keys: [publicFromPrivate(privateJwk, kid)] },
    privateJwk,
  });
}

/** Rebuild a dev issuer from `DEV_OIDC_PRIVATE_JWK` (JSON). */
export function importDevOidcIssuer(
  privateJwkJson: string,
  issuer: string = DEV_OIDC_ISSUER,
): DevOidcIssuer {
  assertDevOnly("importDevOidcIssuer");
  let jwk: unknown;
  try {
    jwk = JSON.parse(privateJwkJson);
  } catch {
    throw new CryptoConfigError("dev OIDC: DEV_OIDC_PRIVATE_JWK is not JSON");
  }
  if (!isPlainObject(jwk) || typeof jwk.kid !== "string" || typeof jwk.d !== "string") {
    throw new CryptoConfigError("dev OIDC: DEV_OIDC_PRIVATE_JWK must be a private JWK with a kid");
  }
  const priv = jwk as JWK;
  const kid = jwk.kid;
  return Object.freeze({
    issuer,
    kid,
    jwks: { keys: [publicFromPrivate(priv, kid)] },
    privateJwk: priv,
  });
}

/**
 * Mint a dev token shaped like a Vercel function token. `ttlSec` (default 7200) and `iat`
 * exist so tests can produce build-like (3600 s) or expired tokens.
 */
export async function mintDevOidcToken(
  dev: DevOidcIssuer,
  c: { sub: string; aud: string; issuer?: string; ttlSec?: number; iat?: number },
): Promise<string> {
  assertDevOnly("mintDevOidcToken");
  const iat = c.iat ?? Math.floor(Date.now() / 1000);
  const ttl = c.ttlSec ?? OIDC_FUNCTION_TOKEN_TTL_SEC;
  const key = await importJWK(dev.privateJwk, "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: dev.kid, typ: "JWT" })
    .setIssuer(c.issuer ?? dev.issuer)
    .setSubject(c.sub)
    .setAudience(c.aud)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + ttl)
    .sign(key);
}
