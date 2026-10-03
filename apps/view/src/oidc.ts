/**
 * edf-view's own identity for calls to edf-app (`/api/view-source`, `/api/view-stats`).
 *
 * Production: the plain Vercel *function* OIDC token from the `x-vercel-oidc-token` request header
 * (fallback env `VERCEL_OIDC_TOKEN`). No audience exchange (DECISIONS.md D-O1): edf-app pins
 * iss, sub = edf-view's production project, the configured aud and `exp − iat === 7200`.
 * Development: a token of the same shape minted from `DEV_OIDC_PRIVATE_JWK` with node:crypto.
 */
import { createPrivateKey, sign } from "node:crypto";

export type TokenSource = (request: Request) => Promise<string | null>;

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function requestContextHeader(name: string): string | null {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    { get?: () => { headers?: Record<string, string | undefined> } | undefined } | undefined;
  const v = ctx?.get?.()?.headers?.[name];
  return typeof v === "string" ? v : null;
}

export const vercelTokenSource: TokenSource = async (request) => {
  const t =
    request.headers.get("x-vercel-oidc-token") ??
    requestContextHeader("x-vercel-oidc-token") ??
    process.env.VERCEL_OIDC_TOKEN ??
    null;
  return t !== null && t.length <= 8192 && JWT_RE.test(t) ? t : null;
};

const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Local development only (the caller checks the environment): RS256, `exp − iat = 7200`. */
export function devTokenSource(
  privateJwkJson: string,
  claims: { issuer: string; subject: string; audience: string },
): TokenSource {
  const jwk = JSON.parse(privateJwkJson) as { kid?: unknown; kty?: unknown };
  if (typeof jwk.kid !== "string" || jwk.kty !== "RSA")
    throw new Error("DEV_OIDC_PRIVATE_JWK must be an RSA JWK with a kid");
  const key = createPrivateKey({ key: jwk as never, format: "jwk" });
  const kid = jwk.kid;
  return async () => {
    const iat = Math.floor(Date.now() / 1000);
    const input = `${b64u({ alg: "RS256", kid, typ: "JWT" })}.${b64u({
      iss: claims.issuer,
      sub: claims.subject,
      aud: claims.audience,
      iat,
      nbf: iat,
      exp: iat + 7200,
    })}`;
    return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
  };
}
