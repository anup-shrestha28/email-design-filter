import type { Header } from "../types";

/** First value of a header (names are lower-case in `ParsedEmail.headers`), or null. */
export function firstHeader(headers: readonly Header[], name: string): string | null {
  for (const h of headers) if (h.name === name) return h.value;
  return null;
}

/** All values of a header, in message order (topmost first). */
export function allHeaders(headers: readonly Header[], name: string): string[] {
  const out: string[] = [];
  for (const h of headers) if (h.name === name) out.push(h.value);
  return out;
}

/** True when a header with this exact name exists. */
export function hasHeader(headers: readonly Header[], name: string): boolean {
  for (const h of headers) if (h.name === name) return true;
  return false;
}

/** True when any header name starts with the prefix (e.g. "x-mailgun-"). */
export function hasHeaderPrefix(headers: readonly Header[], prefix: string): boolean {
  for (const h of headers) if (h.name.startsWith(prefix)) return true;
  return false;
}

/**
 * Timezone offset in minutes (east of UTC positive, chrono-node convention) from an RFC 5322
 * Date header, or 0 when absent/unknown.
 */
export function dateHeaderOffsetMinutes(dateHeader: string | null): number {
  if (!dateHeader) return 0;
  const s = dateHeader.slice(0, 200);
  const m = /([+-])(\d{2})(\d{2})(?!\d)/.exec(s);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const minutes = Number(m[3]);
    if (hours <= 14 && minutes < 60) return sign * (hours * 60 + minutes);
  }
  const zone = /\b(UT|UTC|GMT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/.exec(s)?.[1];
  const zones: Record<string, number> = {
    UT: 0,
    UTC: 0,
    GMT: 0,
    Z: 0,
    EST: -300,
    EDT: -240,
    CST: -360,
    CDT: -300,
    MST: -420,
    MDT: -360,
    PST: -480,
    PDT: -420,
  };
  return zone ? (zones[zone] ?? 0) : 0;
}
