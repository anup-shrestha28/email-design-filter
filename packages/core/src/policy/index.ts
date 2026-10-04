/**
 * Remote-image and tracking policy (DESIGN.md §6.3, §7.6; DESIGN-SCORE §2.1 "Content images").
 * Shared by ingest (tracking facts), render prep (image pre-fetch) and the image proxy.
 *
 * Nothing here performs network I/O. Decisions are conservative: when in doubt an image is not
 * fetched, because fetching can confirm to a sender that the address is live (§6.3, §11.6).
 */
import { createHash } from "node:crypto";
import { cssUrls, stripCssComments, stripNonImageAtRules } from "../util/css";
import { decodeEntities } from "../util/entities";
import { forEachTag } from "../util/tags";
import {
  normalizeHost,
  parseHttpUrl,
  registrableDomain,
  safeDecodeURIComponent,
} from "../util/domain";
import { cssLengthPx, isHiddenStyle, parseInlineStyle } from "../util/style";
import { shannonEntropy } from "../util/text";
import {
  CLICK_PATH_PATTERNS,
  CLICK_QUERY_KEYS,
  CLICK_TRACKER_DOMAINS,
  CLICK_TRACKER_HOSTS,
  CLICK_TRACKER_PATTERNS,
  PIXEL_LAST_SEGMENTS,
  PIXEL_PATH_PREFIXES,
  PIXEL_PATH_REGEXES,
  STATIC_ASSET_CDN_DOMAINS,
  STATIC_ASSET_UPLOAD_PATHS,
  STATIC_ASSET_UPLOAD_PATH_SHAPES,
  STATIC_SIGNATURE_PARAMS,
  STATIC_SIGNED_URL_EXPIRY,
  STATIC_SIGNED_URL_PARAMS,
  TRACKER_DOMAIN_CONTENT_HOSTS,
  TRACKER_EXCLUSIVE_DOMAINS,
  TRACKER_EXCLUSIVE_HOSTS,
  TRACKER_EXCLUSIVE_PATTERNS,
} from "./trackers";

export interface ImageAttrs {
  src: string;
  width?: string | null;
  height?: string | null;
  style?: string | null;
  alt?: string | null;
}

/** Max URL length we are willing to evaluate; longer image URLs are treated as token-bearing. */
const MAX_URL = 4096;
/** Minimum length of a per-recipient token (DESIGN.md §6.3). */
const MIN_TOKEN = 24;

function hostMatches(
  host: string,
  domains: ReadonlySet<string>,
  hosts: ReadonlySet<string>,
  patterns: readonly RegExp[],
): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  // Exact host or any parent host in the host list.
  let cur = h;
  for (let i = 0; i < 8; i++) {
    if (hosts.has(cur)) return true;
    const dot = cur.indexOf(".");
    if (dot < 0) break;
    cur = cur.slice(dot + 1);
  }
  const reg = registrableDomain(h);
  if (!reg) return false;
  if (domains.has(reg)) return true;
  return patterns.some((re) => re.test(reg));
}

const NO_DOMAINS: ReadonlySet<string> = new Set();

/** Tracker-exclusive host (host or registrable domain on our own list, seeded from Trocker, Apache-2.0). */
export function isTrackerHost(host: string): boolean {
  if (hostMatches(host, NO_DOMAINS, TRACKER_DOMAIN_CONTENT_HOSTS, [])) return false;
  return hostMatches(
    host,
    TRACKER_EXCLUSIVE_DOMAINS,
    TRACKER_EXCLUSIVE_HOSTS,
    TRACKER_EXCLUSIVE_PATTERNS,
  );
}

/** Click-tracking redirect host (e.g. ESP click domains). Redirects are never resolved. */
export function isClickTrackerHost(host: string): boolean {
  return hostMatches(host, CLICK_TRACKER_DOMAINS, CLICK_TRACKER_HOSTS, CLICK_TRACKER_PATTERNS);
}

/**
 * Click-tracking URL: a click-tracker host, or a branded tracking domain recognisable by its
 * redirect path/query shape (e.g. SendGrid `/ls/click?upn=`, SES `/CL0/`, Mailgun `/c/<token>`).
 */
export function isClickTrackingUrl(url: string): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  if (isClickTrackerHost(u.hostname)) return true;
  const path = u.pathname.toLowerCase();
  if (CLICK_PATH_PATTERNS.some((re) => re.test(path))) return true;
  for (const key of u.searchParams.keys()) {
    const k = key.toLowerCase();
    if (CLICK_QUERY_KEYS.includes(k)) return true;
    if (k === "qs" && /^[0-9a-f]{40,}$/i.test(u.searchParams.get(key) ?? "")) return true;
  }
  return false;
}

/** An HTML width/height attribute in px ("1", "1px"), or null for %, auto or garbage. */
function attrPx(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const m = /^\s*(\d{1,5}(?:\.\d{1,3})?)\s*(?:px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

/** True when the URL path is a known open-pixel endpoint. */
export function isPixelPath(url: string): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const path = u.pathname.toLowerCase();
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (PIXEL_LAST_SEGMENTS.has(last)) return true;
  if (PIXEL_PATH_PREFIXES.some((p) => path.startsWith(p))) return true;
  return PIXEL_PATH_REGEXES.some((re) => re.test(path));
}

/**
 * Tracking pixel: w×h ≤ 25 px², max-width/height ≤ 1px, hidden (display:none, visibility:hidden,
 * opacity:0), a tracker-exclusive host, or a known pixel path pattern (with size for shared hosts).
 *
 * Size rule (FairEmail-style, DESIGN-SCORE §2.1): a zero dimension is replaced by the other one;
 * a single declared dimension ≤ 1px also counts (spacers/pixels are never content). For shared
 * hosts a pixel path only counts when the image isn't explicitly declared larger than 25 px².
 */
export function isTrackingPixel(img: ImageAttrs): boolean {
  const style = parseInlineStyle(img.style);
  const w = attrPx(img.width) ?? cssLengthPx(style.get("width"));
  const h = attrPx(img.height) ?? cssLengthPx(style.get("height"));
  if (w !== null && h !== null) {
    const ww = w === 0 ? h : w;
    const hh = h === 0 ? w : h;
    if (ww * hh <= 25) return true;
  } else if ((w !== null && w <= 1) || (h !== null && h <= 1)) {
    return true;
  }
  const maxW = cssLengthPx(style.get("max-width"));
  const maxH = cssLengthPx(style.get("max-height"));
  if ((maxW !== null && maxW <= 1) || (maxH !== null && maxH <= 1)) return true;
  if (isHiddenStyle(style)) return true;

  const src = img.src.trim();
  const u = parseHttpUrl(src);
  if (u && isTrackerHost(u.hostname)) return true;
  if (u && isPixelPath(src)) {
    const explicitlyLarge =
      w !== null && h !== null ? w * h > 25 : (w !== null && w > 25) || (h !== null && h > 25);
    if (!explicitlyLarge) return true;
  }
  return false;
}

// ───────────────────────── per-recipient URL detection ─────────────────────────

interface RecipientNeedles {
  lower: string[];
  exact: string[];
}

const needleCache = new Map<string, RecipientNeedles>();

/**
 * base64 substrings that appear whenever `bytes` is embedded at any byte offset inside a larger
 * base64 blob: for offset k ∈ {0,1,2} drop the first quantum (it mixes in unknown prefix bytes)
 * and the trailing partial quantum (it mixes in unknown suffix bytes).
 */
function base64Needles(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const buf = Buffer.concat([Buffer.alloc(k), bytes]);
    const b64 = buf.toString("base64");
    const start = k === 0 ? 0 : 4;
    const end = 4 * Math.floor(buf.length / 3);
    const needle = b64.slice(start, end);
    if (needle.length >= 8) {
      out.push(needle);
      out.push(needle.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...new Set(out)];
}

function needlesFor(address: string): RecipientNeedles | null {
  const addr = address.trim().toLowerCase();
  if (addr.length < 3 || !addr.includes("@")) return null;
  const cached = needleCache.get(addr);
  if (cached) return cached;
  const bytes = Buffer.from(addr, "utf8");
  const lower = [
    addr,
    encodeURIComponent(addr).toLowerCase(),
    createHash("md5").update(addr).digest("hex"),
    createHash("sha1").update(addr).digest("hex"),
    createHash("sha256").update(addr).digest("hex"),
  ];
  const exact = base64Needles(bytes);
  const result = { lower: [...new Set(lower)], exact };
  if (needleCache.size > 256) needleCache.clear();
  needleCache.set(addr, result);
  return result;
}

const TOKEN_CHARS = /^[A-Za-z0-9+/=_~-]+$/;
/**
 * A calendar date between separators in a file name: 19xx/20xx, month 01–12, day 01–31, joined by
 * one repeated "-" or "_" ("2026-08-13", "2026_08_13"), as phones and screenshot tools name files.
 */
const DATE_IN_NAME = /(?<![0-9A-Za-z])(?:19|20)\d{2}([-_])(?:0[1-9]|1[0-2])\1(?:0[1-9]|[12]\d|3[01])(?![0-9A-Za-z])/g;

/**
 * A long high-entropy per-recipient token (≥ 24 chars). Tuned NOT to flag, in paths, asset
 * fingerprints (hex runs, UUIDs, "hash-1200x600"), human slugs ("autumn-sale-hero") or wordy
 * camelCase file names — those are identical for every recipient. Hex tokens in *query values*
 * are still flagged (subscriber ids are commonly hex). See DECISIONS.md.
 */
export function looksLikeRecipientToken(token: string, inPath: boolean): boolean {
  if (token.length < MIN_TOKEN) return false;
  if (token.length > 512) return true;
  if (!TOKEN_CHARS.test(token)) return false;
  const parts = token.split(/[-_~]+/).filter((p) => p.length > 0);
  // Human slug: short alphabetic words. A calendar date written into a file name
  // ("WhatsApp-Image-2026-08-13-at-11") is the same for every recipient, so its three parts are
  // left out of the count: neither words nor noise (DECISIONS.md "Dated file names").
  const words = token
    .replace(DATE_IN_NAME, "-")
    .split(/[-_~]+/)
    .filter((p) => p.length > 0);
  if (
    words.length >= 2 &&
    words.every((p) => p.length <= 12) &&
    words.filter((p) => /^[a-z]+$/i.test(p)).length >= Math.ceil(words.length / 2)
  ) {
    return false;
  }
  if (inPath) {
    const isHex = (p: string): boolean => /^[0-9a-f]+$/i.test(p);
    // Asset fingerprint / UUID: hex runs plus short parts.
    if (
      parts.every((p) => isHex(p) || p.length <= 12) &&
      parts.some((p) => p.length >= 8 && isHex(p))
    ) {
      return false;
    }
  }
  if (/^\d+$/.test(token)) return true;
  const letters = token.replace(/[^A-Za-z]/g, "");
  const digits = token.replace(/[^0-9]/g, "").length;
  // Wordy file names ("summer2026HeroImageBanner"): natural vowel ratio, few digits.
  if (letters.length > 0) {
    const vowels = letters.replace(/[^aeiouAEIOU]/g, "").length;
    if (vowels / letters.length >= 0.35 && digits / token.length <= 0.3) return false;
  }
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = digits > 0;
  const classes = Number(hasUpper) + Number(hasLower) + Number(hasDigit);
  if (classes < 2) return false;
  return shannonEntropy(token) >= 3.3;
}

/**
 * URL carries the recipient: the address (plain, URL-encoded, base64/base64url), its MD5 or
 * SHA-256 (and SHA-1) hex, or a long high-entropy per-recipient token (≥ 24 chars) in path or query.
 */
export function isPerRecipientUrl(url: string, userAddresses: readonly string[]): boolean {
  if (url.length > MAX_URL) return true;
  const lower = url.toLowerCase();
  const decodedLower = safeDecodeURIComponent(lower);
  const decodedExact = safeDecodeURIComponent(url);
  for (const address of userAddresses) {
    const n = needlesFor(address);
    if (!n) continue;
    if (n.lower.some((needle) => lower.includes(needle) || decodedLower.includes(needle)))
      return true;
    if (n.exact.some((needle) => url.includes(needle) || decodedExact.includes(needle)))
      return true;
  }

  const u = parseHttpUrl(url);
  if (!u) return false;
  const reg = registrableDomain(u.hostname);
  const staticCdn = reg !== null && STATIC_ASSET_CDN_DOMAINS.has(reg);
  const uploadPath = STATIC_ASSET_UPLOAD_PATHS.get(normalizeHost(u.hostname));
  const assetPath =
    staticCdn ||
    (uploadPath !== undefined && uploadPath.test(u.pathname)) ||
    STATIC_ASSET_UPLOAD_PATH_SHAPES.some((re) => re.test(u.pathname));

  if (!assetPath) {
    for (const segment of u.pathname.split("/")) {
      const seg = safeDecodeURIComponent(segment);
      for (const piece of seg.split(/[.,;:=@]+/)) {
        if (looksLikeRecipientToken(piece, true)) return true;
      }
    }
  }
  const signed = staticCdn && reg !== null ? STATIC_SIGNED_URL_PARAMS.get(reg) : undefined;
  for (const [key, value] of u.searchParams) {
    if (staticCdn && STATIC_SIGNATURE_PARAMS.has(key.toLowerCase())) continue;
    if (signed !== undefined && key === signed.key && signed.shape.test(value)) continue;
    if (/^https?:/i.test(value)) continue; // nested destination URL; recipient checks above cover it
    for (const piece of value.split(/[.,;:|@\s]+/)) {
      if (looksLikeRecipientToken(piece, false)) return true;
    }
  }
  return false;
}

/**
 * A signed CDN URL whose expiry (STATIC_SIGNED_URL_EXPIRY, e.g. LinkedIn's `e`) is before `nowSec`:
 * the CDN refuses it, so fetching it can only fail. Not a privacy decision (imageFetchDecision
 * doesn't use it); the viewer skips such images instead of proxying them into a grey placeholder.
 */
export function isExpiredSignedUrl(url: string, nowSec: number): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const reg = registrableDomain(u.hostname);
  const key = reg === null ? undefined : STATIC_SIGNED_URL_EXPIRY.get(reg);
  if (key === undefined) return false;
  const v = u.searchParams.get(key);
  return v !== null && /^\d{9,11}$/.test(v) && Number(v) < nowSec;
}

export type ImageDecision =
  | { allowed: true }
  | { allowed: false; reason: "not_http" | "tracker" | "per_recipient" | "pixel" | "policy_off" };

/**
 * Decide whether one image URL may be fetched (analysis pre-fetch or viewer proxy).
 * Order: not_http → policy_off → tracker → pixel → per_recipient. `data:`/`cid:` sources are
 * `not_http` here; the renderer inlines them itself.
 */
export function imageFetchDecision(
  img: ImageAttrs,
  ctx: { userAddresses: readonly string[]; imagesAllowed: boolean },
): ImageDecision {
  const src = img.src.trim();
  const u = parseHttpUrl(src);
  if (!u || u.username !== "" || u.password !== "") return { allowed: false, reason: "not_http" };
  if (!ctx.imagesAllowed) return { allowed: false, reason: "policy_off" };
  if (isTrackerHost(u.hostname)) return { allowed: false, reason: "tracker" };
  if (isTrackingPixel(img)) return { allowed: false, reason: "pixel" };
  if (isPerRecipientUrl(src, ctx.userAddresses)) return { allowed: false, reason: "per_recipient" };
  return { allowed: true };
}

/**
 * Whether an email may load remote images at all: no images for account_security,
 * transactional, security-sensitive or suspicious (failed-auth) mail, nor in privacy mode.
 */
export function imagesAllowedFor(e: {
  primaryType: string;
  securitySensitive: boolean;
  suspicious: boolean;
  loadImagesForAnalysis: boolean;
}): boolean {
  if (!e.loadImagesForAnalysis) return false;
  if (e.securitySensitive || e.suspicious) return false;
  return e.primaryType !== "account_security" && e.primaryType !== "transactional";
}

// ───────────────────────── image references (render prep) ─────────────────────────

export interface ImageRef extends ImageAttrs {
  kind: "img" | "background-attr" | "css";
}

const ATTR_RE = /([^\s"'>/=]{1,64})(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const MAX_IMAGE_TAGS = 60_000;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = ATTR_RE.exec(src)) !== null && n++ < 64) {
    const name = (m[1] as string).toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/**
 * Every remote image reference in raw email HTML, deduplicated by absolute URL, in document
 * order, capped at `max` (default 60): `<img src>` (with width/height/style/alt), `background`
 * attributes, and `url(...)` in `style=""` attributes and `<style>` blocks (fonts and @import
 * excluded). Only absolute http(s) URLs are returned (no data:/cid:/relative). Attribute
 * character references are decoded. Pure, linear-time tag scan with no DOM library, so the
 * policy module stays cheap to import (image proxy cold starts); no network.
 */
export function extractImageRefs(html: string, opts: { max?: number } = {}): ImageRef[] {
  const max = Math.max(0, Math.floor(opts.max ?? 60));
  const out: ImageRef[] = [];
  if (max === 0 || !html) return out;
  const doc = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  const seen = new Set<string>();
  const add = (rawUrl: string, ref: Omit<ImageRef, "src">): void => {
    if (out.length >= max) return;
    const src = rawUrl.trim();
    const u = parseHttpUrl(src);
    if (!u || seen.has(u.href)) return;
    seen.add(u.href);
    out.push({ src, ...ref });
  };
  forEachTag(
    doc,
    (t) => {
      if (out.length >= max) return false;
      if (t.closing) return;
      if (t.rawText !== undefined) {
        if (t.name === "style") {
          const css = stripNonImageAtRules(stripCssComments(t.rawText.slice(0, 200_000)));
          for (const url of cssUrls(css))
            add(url, { kind: "css", width: null, height: null, style: null, alt: null });
        }
        return; // script, noscript, textarea, … never render images
      }
      if (t.name !== "img" && !/background|url\(/i.test(t.attrs)) return;
      const a = parseAttrs(t.attrs);
      if (t.name === "img" && a.src) {
        add(a.src, {
          kind: "img",
          width: a.width ?? null,
          height: a.height ?? null,
          style: a.style ?? null,
          alt: a.alt ?? null,
        });
      }
      if (a.background) {
        add(a.background, {
          kind: "background-attr",
          width: a.width ?? null,
          height: a.height ?? null,
          style: null,
          alt: null,
        });
      }
      if (a.style && a.style.includes("url(")) {
        for (const url of cssUrls(a.style, 20))
          add(url, { kind: "css", width: null, height: null, style: a.style, alt: null });
      }
    },
    { maxTags: MAX_IMAGE_TAGS },
  );
  return out;
}
