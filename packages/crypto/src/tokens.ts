/**
 * HMAC-signed, URL-safe tokens: view URLs (DESIGN.md §11.5, FREE-TIER.md §9.3), invites
 * (FREE-TIER.md §8.4) and `/out` links (DESIGN.md §11.5). Parsing is strict (anchored regexes,
 * canonical base64url); expiry is checked without clock skew (the minting and verifying side
 * are both edf-app). Verification never throws.
 */
import { b64url, fromB64urlStrict, isWellFormedString, nowSeconds } from "./encoding";
import { CryptoError } from "./errors";
import { hmacSign, hmacVerify } from "./hmac";
import type { Keyring } from "./keyring";

/**
 * "img": images through edf-view's privacy proxy; "noimg": never; "card": a gallery card's preview,
 * which proxies only its first few distinct images (a card shows the top of the email), so browsing
 * the gallery stays inside the free tier (FREE-TIER.md §8.4).
 */
export type ViewMode = "img" | "noimg" | "card";

/** A view URL is valid for at most 5 minutes (DESIGN.md §11.5). */
export const VIEW_TOKEN_MAX_TTL_SEC = 300;
/** Upper bound on invite lifetimes (DECISIONS.md D-C4). */
export const INVITE_MAX_TTL_SEC = 30 * 86_400;
/** Upper bound on `/out` link lifetimes (DECISIONS.md D-C4). */
export const OUT_LINK_MAX_TTL_SEC = 30 * 86_400;

/** Email ids travel in URL paths: UUIDs in practice, any short URL-safe id accepted. */
export const EMAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const VIEW_TOKEN_RE =
  /^([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,11})\.(img|noimg|card)\.([A-Za-z0-9_-]{43})$/;
const INVITE_RE =
  /^([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/;
const OUT_RE = /^([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;
const MAX_ID_LEN = 256;
const MAX_URL_LEN = 8192;

function assertId(v: unknown): asserts v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN || !isWellFormedString(v)) {
    throw new CryptoError("bad_input");
  }
}

function assertExp(exp: unknown, maxTtl: number): asserts exp is number {
  const now = nowSeconds();
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= now || exp > now + maxTtl) {
    throw new CryptoError("bad_input");
  }
}

function validNow(nowSec: unknown): nowSec is number {
  return typeof nowSec === "number" && Number.isSafeInteger(nowSec) && nowSec > 0;
}

// ───────────────────────── view tokens ─────────────────────────

/**
 * View token `{kid}.{exp}.{mode}.{sig}` over JSON ["view/v1", userId, emailId, exp, mode];
 * exp = unix seconds, ≤ now + 300. The email id travels in the URL path, the user id doesn't.
 * Throws if `exp` is not in (now, now + 300] or an id is malformed.
 */
export function signViewToken(
  ring: Keyring,
  c: { userId: string; emailId: string; exp: number; mode: ViewMode },
): string {
  assertId(c.userId);
  if (typeof c.emailId !== "string" || !EMAIL_ID_RE.test(c.emailId))
    throw new CryptoError("bad_input");
  if (c.mode !== "img" && c.mode !== "noimg" && c.mode !== "card")
    throw new CryptoError("bad_input");
  assertExp(c.exp, VIEW_TOKEN_MAX_TTL_SEC);
  const { kid, sig } = hmacSign(ring, ["view/v1", c.userId, c.emailId, c.exp, c.mode]);
  return `${kid}.${c.exp}.${c.mode}.${sig}`;
}

/** Parse without verifying (edf-view uses this to drop expired or far-future tokens, and edf-app to find kid/exp). */
export function parseViewToken(
  token: string,
): { kid: string; exp: number; mode: ViewMode; sig: string } | null {
  if (typeof token !== "string" || token.length > 128) return null;
  const m = VIEW_TOKEN_RE.exec(token);
  if (m === null) return null;
  const exp = Number(m[2]);
  if (!Number.isSafeInteger(exp)) return null;
  return { kid: m[1] as string, exp, mode: m[3] as ViewMode, sig: m[4] as string };
}

/**
 * Verify a view token for (userId, emailId). Valid iff the MAC matches and
 * `nowSec ≤ exp ≤ nowSec + 300`. Returns the signed image mode, or null.
 */
export function verifyViewToken(
  ring: Keyring,
  token: string,
  c: { userId: string; emailId: string; nowSec: number },
): { mode: ViewMode } | null {
  try {
    const t = parseViewToken(token);
    if (t === null || !validNow(c.nowSec)) return null;
    if (typeof c.userId !== "string" || typeof c.emailId !== "string") return null;
    if (c.nowSec > t.exp || t.exp > c.nowSec + VIEW_TOKEN_MAX_TTL_SEC) return null;
    if (!hmacVerify(ring, t.kid, t.sig, ["view/v1", c.userId, c.emailId, t.exp, t.mode]))
      return null;
    return { mode: t.mode };
  } catch {
    return null;
  }
}

// ───────────────────────── invites ─────────────────────────

function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") throw new CryptoError("bad_input");
  const e = email.trim().toLowerCase();
  if (e.length < 3 || e.length > 254 || !isWellFormedString(e)) throw new CryptoError("bad_input");
  // Deliberately loose on the grammar, strict on separators and control characters.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(e))
    throw new CryptoError("bad_input");
  return e;
}

/**
 * Invite token "inv/v1|email|exp" → `{kid}.{exp}.{b64url(email)}.{sig}`, checked without the DB.
 * The MAC covers canonical JSON ["inv/v1", email, exp]; the email is trimmed and lower-cased;
 * `exp` must be within 30 days.
 */
export function signInvite(ring: Keyring, c: { email: string; exp: number }): string {
  const email = normalizeEmail(c.email);
  assertExp(c.exp, INVITE_MAX_TTL_SEC);
  const { kid, sig } = hmacSign(ring, ["inv/v1", email, c.exp]);
  return `${kid}.${c.exp}.${b64url(Buffer.from(email, "utf8"))}.${sig}`;
}

/** Verify an invite: MAC, `nowSec ≤ exp ≤ nowSec + 30 d`. Returns the invited email or null. */
export function verifyInvite(
  ring: Keyring,
  token: string,
  nowSec: number,
): { email: string } | null {
  try {
    if (typeof token !== "string" || token.length > 600 || !validNow(nowSec)) return null;
    const m = INVITE_RE.exec(token);
    if (m === null) return null;
    const exp = Number(m[2]);
    if (!Number.isSafeInteger(exp) || nowSec > exp || exp > nowSec + INVITE_MAX_TTL_SEC)
      return null;
    const raw = fromB64urlStrict(m[3] as string);
    if (raw === null) return null;
    const email = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (normalizeEmail(email) !== email) return null;
    if (!hmacVerify(ring, m[1] as string, m[4] as string, ["inv/v1", email, exp])) return null;
    return { email };
  } catch {
    return null;
  }
}

// ───────────────────────── /out links ─────────────────────────

function assertOutUrl(url: unknown): asserts url is string {
  if (
    typeof url !== "string" ||
    url.length === 0 ||
    url.length > MAX_URL_LEN ||
    !isWellFormedString(url)
  ) {
    throw new CryptoError("bad_input");
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CryptoError("bad_input");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") {
    throw new CryptoError("bad_input");
  }
}

/**
 * `/out` link token bound to the session: JSON ["out/v1", sessionId, url, exp] →
 * `{kid}.{exp}.{sig}`. The URL (http(s) or mailto only) travels next to the token.
 */
export function signOutLink(
  ring: Keyring,
  c: { sessionId: string; url: string; exp: number },
): string {
  assertId(c.sessionId);
  assertOutUrl(c.url);
  assertExp(c.exp, OUT_LINK_MAX_TTL_SEC);
  const { kid, sig } = hmacSign(ring, ["out/v1", c.sessionId, c.url, c.exp]);
  return `${kid}.${c.exp}.${sig}`;
}

/** Verify an `/out` token for exactly this session and URL; `nowSec ≤ exp ≤ nowSec + 30 d`. */
export function verifyOutLink(
  ring: Keyring,
  token: string,
  c: { sessionId: string; url: string; nowSec: number },
): boolean {
  try {
    if (typeof token !== "string" || token.length > 128 || !validNow(c.nowSec)) return false;
    if (typeof c.sessionId !== "string" || typeof c.url !== "string") return false;
    const m = OUT_RE.exec(token);
    if (m === null) return false;
    const exp = Number(m[2]);
    if (!Number.isSafeInteger(exp) || c.nowSec > exp || exp > c.nowSec + OUT_LINK_MAX_TTL_SEC)
      return false;
    return hmacVerify(ring, m[1] as string, m[3] as string, ["out/v1", c.sessionId, c.url, exp]);
  } catch {
    return false;
  }
}
