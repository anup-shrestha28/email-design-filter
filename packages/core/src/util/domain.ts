/**
 * Host / URL helpers. Registrable domains come from tldts (ICANN section of the Public Suffix
 * List); results are memoised in a bounded cache because the same few hosts repeat across links.
 */
import { getDomain } from "tldts";

const MAX_URL_LENGTH = 4096;
const CACHE_LIMIT = 4096;
const registrableCache = new Map<string, string | null>();

/** Lower-cases a host and strips brackets, a trailing dot and a port. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.includes("]")) return h.slice(1, h.indexOf("]"));
  const colon = h.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Registrable domain ("eTLD+1") of a host, or null for IPs / single labels / garbage. */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = normalizeHost(host);
  if (!h || h.length > 253) return null;
  const cached = registrableCache.get(h);
  if (cached !== undefined) return cached;
  let result: string | null;
  try {
    result = getDomain(h);
  } catch {
    result = null;
  }
  if (registrableCache.size >= CACHE_LIMIT) registrableCache.clear();
  registrableCache.set(h, result);
  return result;
}

/** Parses an absolute http(s) URL; null for anything else (incl. over-long or malformed). */
export function parseHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_URL_LENGTH) return null;
  const lower = s.slice(0, 8).toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

/** Host of an absolute http(s) URL, lower-case, or null. */
export function hostOfUrl(raw: string | null | undefined): string | null {
  const u = parseHttpUrl(raw);
  return u ? normalizeHost(u.hostname) : null;
}

/** Domain part of a mailbox address (after the last "@"), lower-case, or null. */
export function domainOfAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  const host = normalizeHost(address.slice(at + 1).replace(/[>\s]/g, ""));
  return host || null;
}

/** Local part of a mailbox address, lower-case. */
export function localPartOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at < 0 ? address : address.slice(0, at)).toLowerCase();
}

/** Safe decodeURIComponent: returns the input when it isn't valid percent-encoding. */
export function safeDecodeURIComponent(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
