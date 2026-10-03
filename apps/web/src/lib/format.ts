/**
 * Formatting helpers (pure). Dates take an explicit locale + time zone + "now" so the server
 * render and the client hydration produce identical text (see components/providers/clock.tsx).
 */
export interface DateContext {
  locale: string;
  timeZone: string;
  now: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(
  locale: string,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone });
    fmtCache.set(key, f);
  }
  return f;
}

function dayKey(ms: number, c: DateContext): string {
  return dtf(c.locale, c.timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(
    ms,
  );
}

/** "14:32" today, "Yesterday", "Mon" this week, "Sep 12" this year, else "Sep 12, 2025". */
export function formatListTime(iso: string, c: DateContext): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  if (dayKey(t, c) === dayKey(c.now, c)) {
    return dtf(c.locale, c.timeZone, { hour: "numeric", minute: "2-digit" }).format(t);
  }
  if (dayKey(t, c) === dayKey(c.now - DAY, c)) return "Yesterday";
  if (c.now - t < 6 * DAY && t < c.now) {
    return dtf(c.locale, c.timeZone, { weekday: "short" }).format(t);
  }
  const sameYear =
    dtf(c.locale, c.timeZone, { year: "numeric" }).format(t) ===
    dtf(c.locale, c.timeZone, { year: "numeric" }).format(c.now);
  return dtf(
    c.locale,
    c.timeZone,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  ).format(t);
}

/** "Sep 12" / "Sep 12, 2025". */
export function formatShortDate(iso: string, c: DateContext): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sameYear =
    dtf(c.locale, c.timeZone, { year: "numeric" }).format(t) ===
    dtf(c.locale, c.timeZone, { year: "numeric" }).format(c.now);
  return dtf(
    c.locale,
    c.timeZone,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  ).format(t);
}

/** "Tue, Sep 12, 2026, 2:32 PM". */
export function formatFullDateTime(iso: string, c: DateContext): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return dtf(c.locale, c.timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
}

/** "10:15 AM": the time of day in the context's zone and locale. */
export function formatTimeOfDay(iso: string, c: DateContext): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return dtf(c.locale, c.timeZone, { hour: "numeric", minute: "2-digit" }).format(t);
}

/** Calendar days from today to `iso` in the context's zone: 0 today, 1 tomorrow, -1 yesterday. */
export function calendarDaysFrom(iso: string, c: DateContext): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.NaN;
  const day = (ms: number) => {
    const parts = dtf("en-US", c.timeZone, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(ms);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"));
  };
  return Math.round((day(t) - day(c.now)) / DAY);
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", then a short date. */
export function formatRelative(iso: string, c: DateContext): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = c.now - t;
  if (d < 0) return formatShortDate(iso, c);
  if (d < 45_000) return "just now";
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return formatShortDate(iso, c);
}

/** Countdown text for deals: "ends in 5h", "ends in 42 min", "ends in 2 days", "ended". */
export function formatCountdown(
  iso: string,
  now: number,
): { text: string; urgent: boolean; ended: boolean } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { text: "", urgent: false, ended: false };
  const d = t - now;
  if (d <= 0) return { text: "ended", urgent: false, ended: true };
  if (d < HOUR)
    return { text: `ends in ${Math.max(1, Math.round(d / MIN))} min`, urgent: true, ended: false };
  if (d < DAY)
    return { text: `ends in ${Math.round(d / HOUR)}h`, urgent: d < 12 * HOUR, ended: false };
  const days = Math.round(d / DAY);
  return { text: `ends in ${days} day${days === 1 ? "" : "s"}`, urgent: false, ended: false };
}

export function formatNumber(n: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale).format(n);
}

export function formatCompact(n: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatPercent(ratio: number, digits = 0, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(ratio);
}

export function formatUsd(n: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(n);
}

/** Points with one decimal, trimmed: 16.9, 4, 0.4. */
export function formatPoints(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
