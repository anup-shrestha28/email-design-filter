/**
 * Strict encoding helpers, constant-time comparison and the development-only guard.
 */
import { timingSafeEqual } from "node:crypto";
import { CryptoConfigError } from "./errors";

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const B64_ANY_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when `s` has no lone UTF-16 surrogates (so its UTF-8 encoding is lossless). */
export function isWellFormedString(s: string): boolean {
  return !LONE_SURROGATE_RE.test(s);
}

/** Unpadded base64url. */
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/**
 * Decode canonical, unpadded base64url. Returns null for any other alphabet, padding,
 * non-canonical trailing bits or (when given) a length mismatch.
 */
export function fromB64urlStrict(s: string, expectedLength?: number): Buffer | null {
  if (typeof s !== "string" || !B64URL_RE.test(s) || s.length % 4 === 1) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s) return null;
  if (expectedLength !== undefined && buf.length !== expectedLength) return null;
  return buf;
}

/**
 * Decode a secret from configuration: standard or URL-safe base64, padded or not. Rejects any
 * other character and non-canonical encodings (so a typo can't silently change the key).
 */
export function decodeConfigBase64(s: string): Buffer | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed.length === 0 || !B64_ANY_RE.test(trimmed)) return null;
  const unpadded = trimmed.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return fromB64urlStrict(unpadded);
}

/**
 * Constant-time equality for MACs, signatures and secrets. Different lengths return false
 * (lengths of the values we compare are public).
 */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const ab =
    typeof a === "string"
      ? Buffer.from(a, "utf8")
      : Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const bb =
    typeof b === "string"
      ? Buffer.from(b, "utf8")
      : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (ab.length !== bb.length) {
    // Spend comparable time, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * True in any deployed or production-like environment: `NODE_ENV=production`, or any Vercel
 * runtime marker (`VERCEL_ENV` set, `VERCEL=1`). Development-only helpers refuse to run there.
 */
export function isProductionLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV === "production" ||
    (typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV !== "") ||
    env.VERCEL === "1"
  );
}

/** Throws unless running in local development or tests. */
export function assertDevOnly(what: string): void {
  if (isProductionLikeEnv()) {
    throw new CryptoConfigError(`${what} is for local development and tests only`);
  }
}

/** Plain JSON object (not an array, not null). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Current Unix time in whole seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
