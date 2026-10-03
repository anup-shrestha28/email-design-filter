/**
 * List-Unsubscribe (RFC 2369) and one-click (RFC 8058) parsing. We only read these headers;
 * nothing here ever contacts an unsubscribe URL (DESIGN.md §11.6).
 */
import type { ListUnsubscribe } from "../types";
import type { DkimSignatureInfo } from "./dkim";
import { parseHttpUrl, registrableDomain } from "../util/domain";

const MAX_VALUE = 8192;
const MAX_URIS_PER_KIND = 5;
const MAX_URI_LENGTH = 2048;

/** Exact RFC 8058 List-Unsubscribe-Post value. */
export const ONE_CLICK_POST_VALUE = "List-Unsubscribe=One-Click";

/**
 * Parses a List-Unsubscribe value into https and mailto URIs (header order; http: ignored).
 * Returns null when the header is absent, and empty lists when it is present but unusable, so
 * callers can still treat the header's presence as a list signal (DESIGN.md §7.2).
 */
export function parseListUnsubscribe(value: string | null): ListUnsubscribe | null {
  if (value === null) return null;
  const v = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
  const candidates: string[] = [];
  const bracketed = /<([^<>]{1,2048})>/g;
  let m: RegExpExecArray | null;
  while ((m = bracketed.exec(v)) !== null && candidates.length < 20) {
    candidates.push(m[1] as string);
  }
  if (candidates.length === 0) {
    // Lenient: some senders omit the angle brackets.
    for (const part of v.split(",")) {
      if (candidates.length >= 20) break;
      candidates.push(part);
    }
  }
  const https: string[] = [];
  const mailto: string[] = [];
  for (const c of candidates) {
    // RFC 2369: whitespace inside the brackets is ignored.
    const uri = c.replace(/\s+/g, "");
    if (uri.length === 0 || uri.length > MAX_URI_LENGTH) continue;
    const lower = uri.slice(0, 8).toLowerCase();
    if (lower.startsWith("https:")) {
      if (https.length < MAX_URIS_PER_KIND && parseHttpUrl(uri)?.protocol === "https:")
        https.push(uri);
    } else if (lower.startsWith("mailto:")) {
      if (mailto.length < MAX_URIS_PER_KIND && uri.length > 7) mailto.push(uri);
    }
  }
  return { https, mailto };
}

/**
 * RFC 8058 one-click: an https List-Unsubscribe URI, `List-Unsubscribe-Post` exactly
 * "List-Unsubscribe=One-Click", and a DKIM signature whose h= covers both headers **and** which
 * Gmail reported as passing (its d= is among the trusted dkim=pass domains). RFC 8058 requires a
 * *valid* signature; an unverifiable one doesn't count (DESIGN-SCORE §9; DECISIONS.md).
 */
export function isOneClick(
  listUnsubscribe: ListUnsubscribe | null,
  postValue: string | null,
  signatures: readonly DkimSignatureInfo[],
  dkimPassDomains: readonly string[],
): boolean {
  if (!listUnsubscribe || listUnsubscribe.https.length === 0) return false;
  if (postValue === null || postValue.trim() !== ONE_CLICK_POST_VALUE) return false;
  return signatures.some((sig) => {
    if (!sig.domain) return false;
    const covers =
      sig.signedHeaders.includes("list-unsubscribe") &&
      sig.signedHeaders.includes("list-unsubscribe-post");
    if (!covers) return false;
    const reg = registrableDomain(sig.domain);
    return reg !== null && dkimPassDomains.includes(reg);
  });
}
