/**
 * Key material for edf-app (FREE-TIER.md §3 zone ①). Each HMAC purpose has its own keyring;
 * edf-app never holds the KEK (mailbox keys are unwrapped by edf-keys, §9.2).
 * Locally, missing keyrings fall back to per-process random keys (development only; the env
 * schema requires real ones in production).
 */
import "server-only";
import { randomBytes } from "node:crypto";
import {
  KeyServiceWrapper,
  LocalKeyWrapper,
  parseEd25519SigningRing,
  parseKeyring,
  type Ed25519SigningRing,
  type Keyring,
  type KeyWrapper,
} from "@edf/crypto";
import { env, IS_PROD } from "@/env";

const cache = new Map<string, unknown>();

function memo<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

function ring(name: "VIEW_KEYS" | "OUT_KEYS" | "STATE_KEYS" | "INVITE_KEYS" | "ACCESS_TOKEN_KEYS"): Keyring {
  return memo(name, () => {
    const raw = env()[name];
    if (raw) return parseKeyring(raw);
    if (IS_PROD) throw new Error(`${name} is required in production`);
    return parseKeyring(JSON.stringify({ dev: randomBytes(32).toString("base64") }));
  });
}

export const viewKeys = () => ring("VIEW_KEYS");
export const outKeys = () => ring("OUT_KEYS");
export const stateKeys = () => ring("STATE_KEYS");
export const inviteKeys = () => ring("INVITE_KEYS");
export const accessTokenKeys = () => ring("ACCESS_TOKEN_KEYS");

export function imageSigningKeys(): Ed25519SigningRing | null {
  return memo("IMG_SIGNING_KEYS", () => {
    const raw = env().IMG_SIGNING_KEYS;
    return raw ? parseEd25519SigningRing(raw) : null;
  });
}

/**
 * The KeyWrapper seam (§12 C): edf-keys in production (called with this function's Vercel OIDC
 * token), a local keyring only in development.
 */
export function keyWrapper(): KeyWrapper {
  return memo("keyWrapper", () => {
    const e = env();
    if (e.KEYS_ORIGIN) {
      return new KeyServiceWrapper({ origin: e.KEYS_ORIGIN, getOidcToken: functionOidcToken });
    }
    if (IS_PROD) throw new Error("KEYS_ORIGIN/KEYS_AUD are required in production");
    const local = e.DEV_LOCAL_KEK ?? JSON.stringify({ v1: randomBytes(32).toString("base64") });
    return new LocalKeyWrapper(parseKeyring(local));
  });
}

/**
 * This function's own Vercel OIDC token (`exp − iat = 7200`), sent WITHOUT a custom-audience
 * exchange: exchanged tokens have an undocumented lifetime, which would defeat the receivers'
 * build-token check (FREE-TIER.md §9.2). Receivers pin iss + our project's `sub` + lifetime.
 */
export async function functionOidcToken(): Promise<string> {
  if (!IS_PROD && process.env.DEV_OIDC_PRIVATE_JWK && !process.env.VERCEL) {
    // Local development against the edf-keys dev server: a token from the development issuer.
    const { importDevOidcIssuer, mintDevOidcToken, DEV_OIDC_AUDIENCE, DEV_OIDC_ISSUER } = await import("@edf/crypto");
    const dev = importDevOidcIssuer(process.env.DEV_OIDC_PRIVATE_JWK, process.env.DEV_OIDC_ISSUER ?? DEV_OIDC_ISSUER);
    return mintDevOidcToken(dev, { sub: process.env.DEV_APP_SUB ?? "dev:edf-app", aud: process.env.DEV_OIDC_AUD ?? DEV_OIDC_AUDIENCE });
  }
  const { getVercelOidcToken } = await import("@vercel/oidc");
  return getVercelOidcToken();
}
