/**
 * Token handling in edf-view, which holds NO secrets (FREE-TIER.md §3, §9.3).
 *
 * - View tokens `{kid}.{exp}.{mode}.{sig}` are HMAC'd with a key edf-view doesn't have: it only
 *   checks the shape and drops tokens whose `exp` is past or more than 300 s ahead (§8.4), so
 *   garbage never reaches edf-app. Mirrors @edf/crypto `parseViewToken`.
 * - Image tokens are Ed25519-signed by edf-app; edf-view verifies with public keys only
 *   (`IMG_PUBKEYS`). Mirrors @edf/crypto `verifyImageToken` byte for byte; test/view.test.ts ("cross-verification")
 *   signs with @edf/crypto and verifies here.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** Modes: img / noimg / card (a gallery card: only its first few images are proxied). */
export const VIEW_TOKEN_RE =
  /^([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,11})\.(img|noimg|card)\.([A-Za-z0-9_-]{43})$/;
export const EMAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const VIEW_TOKEN_MAX_TTL_SEC = 300;

const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const USER_ID_RE = /^[\x21-\x7e]{1,128}$/;
const SHORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
export const IMAGE_TOKEN_MAX_LENGTH = 4096;
/**
 * Mirrors @edf/crypto IMAGE_TOKEN_MAX_BYTES (15 MB since 2026-10-04; 5 MB from 2026-09-30, 2 MB
 * before). A token over it doesn't verify, so edf-view must be deployed with a raised ceiling
 * before edf-app mints to it.
 */
export const IMAGE_TOKEN_MAX_BYTES = 15 * 1024 * 1024;
/**
 * Mirrors @edf/crypto IMAGE_TOKEN_MAX_LIFETIME_SEC: 14 days since 2026-10-07 (weekly expiry), 48 h
 * before. A longer-lived token doesn't verify, so edf-view ships a raised ceiling first.
 */
export const IMAGE_TOKEN_MAX_LIFETIME_SEC = 14 * 86_400;
const IMAGE_TOKEN_CLOCK_SKEW_SEC = 300;

export type ViewMode = "img" | "noimg" | "card";
export type ViewGate =
  | { ok: true; token: string; exp: number; mode: ViewMode }
  | { ok: false; reason: "format" | "expired" | "future" };

/** Shape + expiry gate for a view token (no secret involved). */
export function gateViewToken(token: string, nowSec: number): ViewGate {
  if (typeof token !== "string" || token.length > 128) return { ok: false, reason: "format" };
  const m = VIEW_TOKEN_RE.exec(token);
  if (m === null) return { ok: false, reason: "format" };
  const exp = Number(m[2]);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "format" };
  if (nowSec > exp) return { ok: false, reason: "expired" };
  if (exp > nowSec + VIEW_TOKEN_MAX_TTL_SEC) return { ok: false, reason: "future" };
  return { ok: true, token, exp, mode: m[3] as ViewMode };
}

export interface ImageClaims {
  u: string;
  e: string;
  x: number;
  url: string;
  mb: number;
  b: string;
}

function b64urlStrict(s: string, len?: number): Buffer | null {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s || (len !== undefined && buf.length !== len)) return null;
  return buf;
}

/** Parse `IMG_PUBKEYS` (`{"v1":"<SPKI PEM or base64 DER>"}`). Private keys are refused. */
export function parseImagePublicKeys(json: string | undefined): Map<string, KeyObject> | null {
  if (typeof json !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const out = new Map<string, KeyObject>();
  for (const [kid, value] of Object.entries(parsed)) {
    if (!KID_RE.test(kid) || typeof value !== "string") return null;
    const v = value.trim();
    try {
      let key: KeyObject;
      if (v.startsWith("-----")) {
        if (!v.startsWith("-----BEGIN PUBLIC KEY-----") || v.includes("PRIVATE")) return null;
        key = createPublicKey({ key: v, format: "pem" });
      } else {
        if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
        key = createPublicKey({ key: Buffer.from(v, "base64"), format: "der", type: "spki" });
      }
      if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
      out.set(kid, key);
    } catch {
      return null;
    }
  }
  return out.size > 0 && out.size <= 32 ? out : null;
}

function canonical(c: ImageClaims): string | null {
  const { u, e, x, url, mb, b } = c;
  if (typeof u !== "string" || !USER_ID_RE.test(u)) return null;
  if (typeof e !== "string" || !SHORT_ID_RE.test(e)) return null;
  if (typeof b !== "string" || !SHORT_ID_RE.test(b)) return null;
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) return null;
  if (typeof mb !== "number" || !Number.isSafeInteger(mb) || mb < 1 || mb > IMAGE_TOKEN_MAX_BYTES)
    return null;
  if (typeof url !== "string" || url.length > 2048) return null;
  let p: URL;
  try {
    p = new URL(url);
  } catch {
    return null;
  }
  if (
    (p.protocol !== "http:" && p.protocol !== "https:") ||
    p.username ||
    p.password ||
    p.href !== url
  )
    return null;
  return JSON.stringify(["img/v1", u, e, x, url, mb, b]);
}

/** Verify an image token with public keys only; null on any failure. Never throws. */
export function verifyImageToken(
  keys: ReadonlyMap<string, KeyObject>,
  token: string,
  nowSec: number,
): ImageClaims | null {
  try {
    if (typeof token !== "string" || token.length > IMAGE_TOKEN_MAX_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [kid, payloadB64, sigB64] = parts as [string, string, string];
    const key = KID_RE.test(kid) ? keys.get(kid) : undefined;
    if (key === undefined) return null;
    const payload = b64urlStrict(payloadB64);
    const sig = b64urlStrict(sigB64, 64);
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
    } as ImageClaims;
    if (canonical(claims) !== text) return null;
    if (
      nowSec > claims.x ||
      claims.x > nowSec + IMAGE_TOKEN_MAX_LIFETIME_SEC + IMAGE_TOKEN_CLOCK_SKEW_SEC
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}
