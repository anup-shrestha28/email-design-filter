/**
 * Ed25519 image tokens (FREE-TIER.md §8.4, §9.3). edf-app signs with `IMG_SIGNING_KEYS`;
 * edf-view verifies with `IMG_PUBKEYS` only (apps/view mirrors `verifyImageToken`, and a
 * cross-test keeps the two byte-compatible).
 *
 * Token: `{kid}.{b64url(payload)}.{b64url(sig)}` where payload is the UTF-8 canonical JSON
 * `["img/v1", u, e, x, url, mb, b]` and sig = Ed25519(payload). Verification checks the
 * signature over the exact payload bytes before parsing, then requires the payload to be the
 * canonical encoding of the claims it contains.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  b64url,
  decodeConfigBase64,
  fromB64urlStrict,
  isWellFormedString,
  nowSeconds,
} from "./encoding";
import { CryptoConfigError, CryptoError } from "./errors";
import { KID_RE, parseKidMap, pickActiveKid } from "./keyring";

export interface ImageTokenClaims {
  /** user id */
  u: string;
  /** email id */
  e: string;
  /** expiry, unix seconds (next UTC midnight + 24 h) */
  x: number;
  /** absolute source URL */
  url: string;
  /** signed byte allowance for this image (≤ IMAGE_TOKEN_MAX_BYTES, 5 MB) */
  mb: number;
  /** per-email budget id */
  b: string;
}

/** Ed25519 keyring: private keys (PKCS#8 PEM or base64 DER) keyed by kid, from `IMG_SIGNING_KEYS` JSON. */
export interface Ed25519SigningRing {
  active: string;
  keys: ReadonlyMap<string, KeyObject>;
}
export interface Ed25519VerifyRing {
  keys: ReadonlyMap<string, KeyObject>;
}

/**
 * Per-image signed byte allowance ceiling (FREE-TIER.md §8.4): 5 MB, the SSRF-safe fetcher's own
 * limit, so an ordinary one-picture mailer's 3–5 MB PNG shows in the opened design (it was 2 MB).
 * apps/view/src/tokens.ts mirrors it; deploy edf-view before edf-app when it changes.
 */
export const IMAGE_TOKEN_MAX_BYTES = 5 * 1024 * 1024;
/** Longest accepted source URL. */
export const IMAGE_TOKEN_MAX_URL_LENGTH = 2048;
/** Longest accepted token (the signed URL dominates). */
export const IMAGE_TOKEN_MAX_LENGTH = 4096;
/** Tokens live ≤ 48 h by construction; allow 5 min of clock skew between edf-app and edf-view. */
export const IMAGE_TOKEN_MAX_LIFETIME_SEC = 48 * 3600;
export const IMAGE_TOKEN_CLOCK_SKEW_SEC = 300;

const USER_ID_RE = /^[\x21-\x7e]{1,128}$/;
const SHORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SIG_LEN = 64;

function parsePrivateKey(value: string, kid: string): KeyObject {
  let key: KeyObject;
  try {
    const trimmed = value.trim();
    if (trimmed.startsWith("-----")) {
      if (!trimmed.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("pem type");
      key = createPrivateKey({ key: trimmed, format: "pem" });
    } else {
      const der = decodeConfigBase64(trimmed);
      if (der === null) throw new Error("base64");
      key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    }
  } catch {
    throw new CryptoConfigError(`image signing key "${kid}": not a PKCS#8 Ed25519 private key`);
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new CryptoConfigError(`image signing key "${kid}": not an Ed25519 private key`);
  }
  return key;
}

function parsePublicKey(value: string, kid: string): KeyObject {
  let key: KeyObject;
  try {
    const trimmed = value.trim();
    if (trimmed.startsWith("-----")) {
      // Never derive a public key from a private one: edf-view must hold no secret (§3).
      if (!trimmed.startsWith("-----BEGIN PUBLIC KEY-----") || trimmed.includes("PRIVATE")) {
        throw new Error("pem type");
      }
      key = createPublicKey({ key: trimmed, format: "pem" });
    } else {
      const der = decodeConfigBase64(trimmed);
      if (der === null) throw new Error("base64");
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    }
  } catch {
    throw new CryptoConfigError(`image public key "${kid}": not an SPKI Ed25519 public key`);
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new CryptoConfigError(`image public key "${kid}": not an Ed25519 public key`);
  }
  return key;
}

/** Parse `IMG_SIGNING_KEYS` (`{"v1":"<PKCS#8 PEM or base64 DER>"}`). */
export function parseEd25519SigningRing(json: string, active?: string): Ed25519SigningRing {
  const map = parseKidMap(json, "IMG_SIGNING_KEYS");
  const keys = new Map<string, KeyObject>();
  for (const [kid, value] of map) keys.set(kid, parsePrivateKey(value, kid));
  return Object.freeze({ active: pickActiveKid(keys.keys(), active, "IMG_SIGNING_KEYS"), keys });
}

/** Parse `IMG_PUBKEYS` (`{"v1":"<SPKI PEM or base64 DER>"}`); private keys are refused. */
export function parseEd25519VerifyRing(json: string): Ed25519VerifyRing {
  const map = parseKidMap(json, "IMG_PUBKEYS");
  const keys = new Map<string, KeyObject>();
  for (const [kid, value] of map) keys.set(kid, parsePublicKey(value, kid));
  return Object.freeze({ keys });
}

/** Validate claims; returns the canonical payload string or null. */
function canonicalImagePayload(c: ImageTokenClaims): string | null {
  if (typeof c !== "object" || c === null) return null;
  const { u, e, x, url, mb, b } = c;
  if (typeof u !== "string" || !USER_ID_RE.test(u)) return null;
  if (typeof e !== "string" || !SHORT_ID_RE.test(e)) return null;
  if (typeof b !== "string" || !SHORT_ID_RE.test(b)) return null;
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) return null;
  if (typeof mb !== "number" || !Number.isSafeInteger(mb) || mb < 1 || mb > IMAGE_TOKEN_MAX_BYTES)
    return null;
  if (
    typeof url !== "string" ||
    url.length > IMAGE_TOKEN_MAX_URL_LENGTH ||
    !isWellFormedString(url)
  )
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  // The signature must bind exactly what the proxy will fetch: only normalized URLs are signed.
  if (parsed.href !== url) return null;
  return JSON.stringify(["img/v1", u, e, x, url, mb, b]);
}

/**
 * Token = `{kid}.{b64url(JSON ["img/v1", u, e, x, url, mb, b])}.{b64url(sig)}`; URL-safe, ≤ 4 KB.
 * Throws if the claims are invalid or `x` is not in (now, now + 48 h] (no skew on the signing side).
 */
export function signImageToken(ring: Ed25519SigningRing, c: ImageTokenClaims): string {
  const payload = canonicalImagePayload(c);
  if (payload === null) throw new CryptoError("bad_input");
  const now = nowSeconds();
  if (c.x <= now || c.x > now + IMAGE_TOKEN_MAX_LIFETIME_SEC) throw new CryptoError("bad_input");
  const key = ring.keys.get(ring.active);
  if (key === undefined || !KID_RE.test(ring.active))
    throw new CryptoConfigError("IMG_SIGNING_KEYS: active key missing");
  const bytes = Buffer.from(payload, "utf8");
  const token = `${ring.active}.${b64url(bytes)}.${b64url(sign(null, bytes, key))}`;
  if (token.length > IMAGE_TOKEN_MAX_LENGTH) throw new CryptoError("bad_input");
  return token;
}

/**
 * Verify with public keys only. Valid iff the kid is known, the signature verifies over the exact
 * payload bytes, the payload is the canonical encoding of valid claims, and
 * `nowSec ≤ x ≤ nowSec + 48 h + 5 min`. Returns the claims or null; never throws.
 */
export function verifyImageToken(
  ring: Ed25519VerifyRing,
  token: string,
  nowSec: number,
): ImageTokenClaims | null {
  try {
    if (typeof token !== "string" || token.length > IMAGE_TOKEN_MAX_LENGTH) return null;
    if (typeof nowSec !== "number" || !Number.isSafeInteger(nowSec)) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [kid, payloadB64, sigB64] = parts as [string, string, string];
    if (!KID_RE.test(kid)) return null;
    const key = ring.keys.get(kid);
    if (key === undefined) return null;
    const payload = fromB64urlStrict(payloadB64);
    const sig = fromB64urlStrict(sigB64, SIG_LEN);
    if (payload === null || sig === null || payload.length === 0) return null;
    if (!verify(null, payload, key, sig)) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const arr: unknown = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== 7 || arr[0] !== "img/v1") return null;
    const claims = {
      u: arr[1],
      e: arr[2],
      x: arr[3],
      url: arr[4],
      mb: arr[5],
      b: arr[6],
    } as ImageTokenClaims;
    if (canonicalImagePayload(claims) !== text) return null;
    if (
      nowSec > claims.x ||
      claims.x > nowSec + IMAGE_TOKEN_MAX_LIFETIME_SEC + IMAGE_TOKEN_CLOCK_SKEW_SEC
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/** Expiry rule for image tokens: next UTC midnight + 24 h (so tokens live ≤ 48 h and cache well). */
export function imageTokenExpiry(now: Date): number {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new CryptoError("bad_input");
  return (Math.floor(ms / 86_400_000) + 2) * 86_400;
}
