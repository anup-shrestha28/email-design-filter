/**
 * edf-keys configuration from env (FREE-TIER.md §11 step 8):
 * TOKEN_KEKS, TOKEN_KEK_ACTIVE, KEYS_ALERT_TOKEN, GITHUB_ALERT_REPO, APP_ORIGIN, APP_OIDC_SUB,
 * KEYS_AUD, OIDC_ISSUER. Misconfiguration never throws out of the handler: it yields an error
 * value and every request is refused with 503 (fail closed). The one exception is the alert
 * channel (packages/crypto DECISIONS.md D-K5): missing or malformed, it only disables alerting, with a startup
 * warning and an `alert_unconfigured` count in every audit report.
 */
import type { JSONWebKeySet, JWK } from "jose";
import {
  createVerifier,
  devTokenSource,
  vercelTokenSource,
  type TokenSource,
  type Verifier,
} from "./oidc.js";

export const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface KeysConfig {
  keks: ReadonlyMap<string, Buffer>;
  activeKid: string;
  verify: Verifier;
  appOrigin: string;
  /** Where edf-keys POSTs its counts; authenticated with its own function token. */
  auditUrl: string;
  auditToken: TokenSource;
  /** Content-free GitHub issue channel; null when unconfigured (see alertWarning). */
  alert: { token: string; repo: string } | null;
  /** Production only: why `alert` is null, reported loudly instead of failing requests. */
  alertWarning: "missing" | "invalid" | null;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (event: Record<string, string | number>) => void;
}

export type ConfigResult = { ok: true; config: KeysConfig } | { ok: false; code: string };

/** Content-free structured log line (never key material, tokens, or mailbox ids in clear). */
export function defaultLog(event: Record<string, string | number>): void {
  console.log(JSON.stringify({ svc: "edf-keys", ...event }));
}

function decodeKey(v: unknown): Buffer | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  const buf = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === 32 ? buf : null;
}

export function parseKeks(json: string | undefined): Map<string, Buffer> | null {
  if (typeof json !== "string" || json.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const out = new Map<string, Buffer>();
  for (const [kid, value] of Object.entries(parsed)) {
    const key = decodeKey(value);
    if (!KID_RE.test(kid) || key === null) return null;
    out.set(kid, key);
  }
  return out.size > 0 && out.size <= 32 ? out : null;
}

function httpsOrigin(v: string | undefined, allowLoopbackHttp: boolean): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.origin !== v) return null;
    if (u.protocol === "https:" || (allowLoopbackHttp && u.protocol === "http:" && loopback))
      return u.origin;
  } catch {
    // fall through
  }
  return null;
}

function validClaim(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 512 && !/\s/.test(v);
}

/** https://oidc.vercel.com/<team>: https, no credentials/query/fragment, no trailing slash. */
function validIssuer(v: string | undefined): v is string {
  if (!validClaim(v) || v.endsWith("/")) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** True in any deployed or production-like environment. */
export function productionLike(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "production" ||
    (typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV !== "") ||
    env.VERCEL === "1"
  );
}

/** Production configuration (discovery-based OIDC, header-sourced outgoing token). */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  overrides: Partial<Pick<KeysConfig, "fetchImpl" | "now" | "log">> = {},
): ConfigResult {
  // FREE-TIER.md §1.3 rule 7: no Vercel API token in any runtime environment.
  if (env.VERCEL_TOKEN || env.VERCEL_API_TOKEN || env.VERCEL_ACCESS_TOKEN)
    return { ok: false, code: "vercel_token_present" };
  const keks = parseKeks(env.TOKEN_KEKS);
  if (keks === null) return { ok: false, code: "token_keks" };
  const activeKid = env.TOKEN_KEK_ACTIVE ?? "";
  if (!keks.has(activeKid)) return { ok: false, code: "token_kek_active" };
  const issuer = env.OIDC_ISSUER;
  if (!validIssuer(issuer)) return { ok: false, code: "oidc_issuer" };
  if (!validClaim(env.APP_OIDC_SUB)) return { ok: false, code: "app_oidc_sub" };
  if (!validClaim(env.KEYS_AUD)) return { ok: false, code: "keys_aud" };
  const appOrigin = httpsOrigin(env.APP_ORIGIN, false);
  if (appOrigin === null) return { ok: false, code: "app_origin" };
  const alert = alertConfig(env);
  const fetchImpl = overrides.fetchImpl ?? fetch;
  return {
    ok: true,
    config: {
      keks,
      activeKid,
      verify: createVerifier(
        { issuer, audience: env.KEYS_AUD, subject: env.APP_OIDC_SUB },
        { fetchImpl },
      ),
      appOrigin,
      auditUrl: `${appOrigin}/api/keys-audit`,
      auditToken: vercelTokenSource,
      alert: typeof alert === "string" ? null : alert,
      alertWarning: typeof alert === "string" ? alert : null,
      fetchImpl,
      now: overrides.now ?? Date.now,
      log: overrides.log ?? defaultLog,
    },
  };
}

function alertConfig(
  env: NodeJS.ProcessEnv,
): { token: string; repo: string } | "missing" | "invalid" {
  const token = env.KEYS_ALERT_TOKEN?.trim();
  const repo = env.GITHUB_ALERT_REPO?.trim();
  if (!token && !repo) return "missing";
  if (!token || !repo || !REPO_RE.test(repo) || !/^[A-Za-z0-9_]{20,255}$/.test(token))
    return "invalid";
  return { token, repo };
}

/**
 * Local development (src/dev-server.ts): OIDC verified against `DEV_OIDC_JWKS`, outgoing tokens
 * minted from `DEV_OIDC_PRIVATE_JWK`. Refuses to run in any production-like environment.
 */
export function loadDevConfig(env: NodeJS.ProcessEnv): ConfigResult {
  if (productionLike(env)) return { ok: false, code: "dev_in_production" };
  const keks = parseKeks(env.TOKEN_KEKS);
  if (keks === null) return { ok: false, code: "token_keks" };
  const activeKid = env.TOKEN_KEK_ACTIVE ?? "";
  if (!keks.has(activeKid)) return { ok: false, code: "token_kek_active" };
  let jwks: JSONWebKeySet;
  let privateJwk: JWK | null = null;
  try {
    jwks = JSON.parse(env.DEV_OIDC_JWKS ?? "") as JSONWebKeySet;
    if (!Array.isArray(jwks.keys)) throw new Error("jwks");
    if (env.DEV_OIDC_PRIVATE_JWK) privateJwk = JSON.parse(env.DEV_OIDC_PRIVATE_JWK) as JWK;
  } catch {
    return { ok: false, code: "dev_oidc" };
  }
  // Shared dev issuer (gen-keys --dev); defaults mirror @edf/crypto DEV_OIDC_* constants.
  const issuer = env.DEV_OIDC_ISSUER ?? "https://oidc.dev.invalid/edf-dev";
  const appOrigin = httpsOrigin(env.APP_ORIGIN ?? "http://localhost:3000", true);
  if (appOrigin === null) return { ok: false, code: "app_origin" };
  const audience = env.DEV_OIDC_AUD ?? "https://vercel.com/edf-dev";
  const subject = env.DEV_APP_SUB ?? "dev:edf-app";
  const alert = alertConfig(env);
  return {
    ok: true,
    config: {
      keks,
      activeKid,
      verify: createVerifier({ issuer, audience, subject }, { jwks }),
      appOrigin,
      auditUrl: `${appOrigin}/api/keys-audit`,
      auditToken:
        privateJwk === null
          ? async () => null
          : devTokenSource(privateJwk, {
              issuer,
              subject: env.DEV_KEYS_SUB ?? "dev:edf-keys",
              audience,
            }),
      alert: typeof alert === "string" ? null : alert,
      alertWarning: null,
      fetchImpl: fetch,
      now: Date.now,
      log: defaultLog,
    },
  };
}
