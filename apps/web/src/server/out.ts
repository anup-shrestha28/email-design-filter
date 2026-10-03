/**
 * `/out` link interstitial (DESIGN.md §11.5): the signature is bound to the user's session,
 * http(s) only, the real host is shown (punycode included), tracking redirects are flagged, and
 * it never auto-redirects. Links from suspicious mail are disabled before they get here.
 */
import "server-only";
import { domainToUnicode } from "node:url";
import { verifyOutLink } from "@edf/crypto";
import { outKeys } from "./keys";
import type { SessionUser } from "./session";

export interface OutTarget {
  ok: true;
  url: string;
  /** Hostname as sent (punycode, e.g. "xn--80ak6aa92e.com"). */
  host: string;
  /** Unicode rendering of the host, when different (so homoglyph domains are visible). */
  hostUnicode: string | null;
  /** The link goes through a known click-tracking redirect. */
  trackingRedirect: boolean;
  /** An embedded destination (?url=/u=) when the redirect exposes one. Never followed by us. */
  embeddedDestination: string | null;
}

const TRACKING_PATTERNS = [
  /(^|\.)click\./i,
  /(^|\.)clicks\./i,
  /(^|\.)links?\./i,
  /(^|\.)trk\./i,
  /(^|\.)track(ing)?\./i,
  /(^|\.)email\.[^.]+\.[^.]+$/i,
  /(^|\.)(ct|t)\.sendgrid\.net$/i,
  /(^|\.)list-manage\.com$/i,
  /(^|\.)mandrillapp\.com$/i,
  /(^|\.)klclick\d*\.com$/i,
  /(^|\.)klaviyomail\.com$/i,
  /(^|\.)hubspotlinks\.com$/i,
  /(^|\.)exct\.net$/i,
  /(^|\.)rs6\.net$/i,
  /(^|\.)mailchi\.mp$/i,
];

/**
 * Longest destination accepted: the /out signer's own URL cap (packages/crypto MAX_URL_LEN). Every
 * link the viewer or the unsubscribe action signs fits, so none renders as clickable and then fails
 * here; the whole /out URL is at most 8 KB too (the sanitizer's REWRITTEN_URL_MAX_CHARS).
 */
export const OUT_URL_MAX_CHARS = 8192;

export function checkOutRequest(
  user: SessionUser,
  params: { u?: string | string[]; t?: string | string[] },
): OutTarget | { ok: false; reason: string } {
  const u = typeof params.u === "string" ? params.u : null;
  const t = typeof params.t === "string" ? params.t : null;
  if (!u || !t || u.length > OUT_URL_MAX_CHARS || t.length > 1024) return { ok: false, reason: "This link is incomplete." };
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, reason: "This link isn't a valid web address." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Only web links can be opened." };
  }
  // Links are bound to the signed-in user ("u:<id>"): viewer links are minted without a session,
  // and /out itself requires the session, so a leaked link is useless to anyone else.
  const valid = verifyOutLink(outKeys(), t, { sessionId: `u:${user.userId}`, url: u, nowSec: Math.floor(Date.now() / 1000) });
  if (!valid) return { ok: false, reason: "This link has expired. Go back to the email and click it again." };

  const host = parsed.hostname;
  const unicode = domainToUnicode(host);
  let embedded: string | null = null;
  for (const key of ["url", "u", "redirect", "redirect_url", "target", "dest", "destination"]) {
    const v = parsed.searchParams.get(key);
    if (v && /^https?:\/\//i.test(v)) {
      embedded = v.slice(0, 2048);
      break;
    }
  }
  return {
    ok: true,
    url: parsed.toString(),
    host,
    hostUnicode: unicode && unicode !== host ? unicode : null,
    trackingRedirect: TRACKING_PATTERNS.some((re) => re.test(host)) || embedded !== null,
    embeddedDestination: embedded,
  };
}
