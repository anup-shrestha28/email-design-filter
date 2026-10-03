/**
 * Database-wake metering and the "public routes never touch the database" guard
 * (FREE-TIER.md §8.1 "Neon", §8.4 item 2).
 *
 * Route handlers run inside `runWithRouteClass()`. Every pool checkout is recorded with its
 * class; `drainCheckouts()` hands the buffer to the budget package, which turns it into awake
 * minutes (first query … last query + 5 min) and ORs them into `neon_awake` while the
 * database is already awake.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RouteClass = "job" | "authed" | "signin" | "public";

interface MeterStore {
  routeClass: RouteClass;
}

const als = new AsyncLocalStorage<MeterStore>();
const MAX_BUFFER = 20_000;
const buffer: Array<{ at: number; routeClass: RouteClass }> = [];

/** Run `fn` with a route class attached to every database checkout it makes. */
export function runWithRouteClass<T>(routeClass: RouteClass, fn: () => T): T {
  return als.run({ routeClass }, fn);
}

export function currentRouteClass(): RouteClass {
  return als.getStore()?.routeClass ?? "job";
}

export class PublicRouteDbAccessError extends Error {
  constructor() {
    super("Database access from a public route is not allowed (FREE-TIER.md §8.4)");
    this.name = "PublicRouteDbAccessError";
  }
}

/** Throws when called from a route marked "public" (landing, privacy, help, 404, …). */
export function assertDbAllowed(): void {
  if (currentRouteClass() === "public") throw new PublicRouteDbAccessError();
}

export function recordCheckout(now = Date.now()): void {
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push({ at: now, routeClass: currentRouteClass() });
}

/** Take (and clear) the recorded checkouts. */
export function drainCheckouts(): Array<{ at: number; routeClass: RouteClass }> {
  return buffer.splice(0, buffer.length);
}

/**
 * Convert checkout timestamps into awake minutes per UTC day: each checkout keeps the compute
 * awake for its own minute plus Neon's fixed 5-minute scale-to-zero tail.
 */
export function awakeMinutesByDay(
  checkouts: ReadonlyArray<{ at: number }>,
  tailMinutes = 5,
): Map<string, number[]> {
  const byDay = new Map<string, Set<number>>();
  for (const { at } of checkouts) {
    const startMinute = Math.floor(at / 60_000);
    for (let m = startMinute; m <= startMinute + tailMinutes; m++) {
      const dayStartMinute = Math.floor(m / 1440) * 1440;
      const day = new Date(dayStartMinute * 60_000).toISOString().slice(0, 10);
      let set = byDay.get(day);
      if (!set) {
        set = new Set();
        byDay.set(day, set);
      }
      set.add(m - dayStartMinute);
    }
  }
  const out = new Map<string, number[]>();
  for (const [day, set] of byDay) out.set(day, [...set].sort((a, b) => a - b));
  return out;
}
