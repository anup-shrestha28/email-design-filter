/**
 * URL helpers for static analysis. Pure string handling — nothing here resolves or fetches.
 */

/** Second-level public suffixes common in mail (heuristic eTLD+1; tldts is not a design dep). */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "co.nz",
  "org.nz",
  "co.za",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "org.mx",
  "co.in",
  "net.in",
  "org.in",
  "co.kr",
  "or.kr",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.tw",
  "org.tw",
  "com.hk",
  "org.hk",
  "com.sg",
  "com.tr",
  "co.il",
  "org.il",
  "com.ar",
  "com.co",
  "com.pe",
  "com.ph",
  "com.my",
  "co.id",
  "co.th",
  "com.vn",
  "com.ua",
  "com.pl",
  "com.es",
  "co.at",
  "or.at",
  "com.pt",
  "com.gr",
  "com.ng",
  "co.ke",
  "com.eg",
  "com.sa",
  "ae.org",
  "github.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "cloudfront.net",
  "azureedge.net",
  "blob.core.windows.net",
  "amazonaws.com",
  "s3.amazonaws.com",
  "googleusercontent.com",
  "appspot.com",
]);

/**
 * Host of an absolute or protocol-relative http(s) URL, lower-cased, without port or
 * credentials; null for anything else (data:, cid:, relative, malformed).
 */
export function urlHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const m = /^(?:https?:)?\/\/([^/?#\s]{1,300})/i.exec(s);
  if (!m) return null;
  let host = m[1]!.toLowerCase();
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[")) return host.replace(/\]:\d+$/, "]");
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  return host || null;
}

/** Path of an absolute URL ("/a/b"), lower-cased, or null. */
export function urlPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(?:https?:)?\/\/[^/?#\s]+(\/[^?#\s]*)?/i.exec(raw.trim());
  if (!m) return null;
  return (m[1] ?? "/").toLowerCase();
}

/** Heuristic registrable domain (eTLD+1). IPs are returned as-is. */
export function registrableDomain(host: string | null): string | null {
  if (!host) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  for (let n = Math.min(4, labels.length - 1); n >= 2; n--) {
    const suffix = labels.slice(-n).join(".");
    if (MULTI_LABEL_SUFFIXES.has(suffix)) return labels.slice(-(n + 1)).join(".");
  }
  return labels.slice(-2).join(".");
}

/**
 * The destination behind a click tracker (`…?url=…` / `…&u=…`), decoded and lower-cased, or null.
 */
export function decodedTarget(href: string): string | null {
  const m = /[?&](?:url|u)=([^&#]+)/i.exec(href);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return null;
  }
}

/** Decode the HTML entities that commonly appear in raw URLs inside `<style>` text. */
export function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Query parameters of a URL (repeated keys kept in order). `+` and `%20` become spaces. */
export function queryParams(raw: string): Array<[string, string]> {
  const q = raw.indexOf("?");
  if (q < 0) return [];
  const end = raw.indexOf("#", q);
  const query = raw.slice(q + 1, end < 0 ? undefined : end);
  const out: Array<[string, string]> = [];
  for (const part of query.split("&").slice(0, 50)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? "" : part.slice(eq + 1);
    out.push([safeDecode(k), safeDecode(v)]);
  }
  return out;
}

function safeDecode(s: string): string {
  const plus = s.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus.replace(/%20/gi, " ");
  }
}
