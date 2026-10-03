/** UTC calendar helpers for usage windows (usage_ledger.day is a UTC date). */

export const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" for the UTC day containing `d`. */
export function utcDay(d: Date | number): string {
  return new Date(typeof d === "number" ? d : d.getTime()).toISOString().slice(0, 10);
}

/** Midnight UTC of the day containing `d`. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** First day of the UTC calendar month containing `now`. */
export function calendarMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Start of the current billing period given the anchor recorded in
 * `app_setting.neon.period_start` (FREE-TIER §8.1): periods start on the anchor's day of month
 * (clamped to short months). No anchor → the calendar month.
 */
export function billingPeriodStart(anchor: string | null, now: Date): Date {
  if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return calendarMonthStart(now);
  const day = Number(anchor.slice(8, 10));
  if (day < 1 || day > 31) return calendarMonthStart(now);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
  if (thisMonth.getTime() <= startOfUtcDay(now).getTime()) return thisMonth;
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 11 : m - 1;
  return new Date(Date.UTC(py, pm, Math.min(day, daysInMonth(py, pm))));
}

/** The start of the period after the one starting at `start` (same anchor day). */
export function nextPeriodStart(start: Date, anchorDay: number): Date {
  const y = start.getUTCMonth() === 11 ? start.getUTCFullYear() + 1 : start.getUTCFullYear();
  const m = (start.getUTCMonth() + 1) % 12;
  return new Date(Date.UTC(y, m, Math.min(anchorDay, daysInMonth(y, m))));
}

/** Days elapsed in the period, counting the current (partial) day as elapsed: 1-based. */
export function daysElapsed(periodStart: Date, now: Date): number {
  return Math.floor((startOfUtcDay(now).getTime() - periodStart.getTime()) / DAY_MS) + 1;
}

/** Whole days left in the period after today. */
export function daysRemaining(periodStart: Date, periodEnd: Date, now: Date): number {
  return Math.max(0, Math.round((periodEnd.getTime() - startOfUtcDay(now).getTime()) / DAY_MS) - 1);
}
