"use client";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { DateContext } from "@/lib/format";

interface ClockValue {
  /** Server render time (ms). Used during hydration so server and client text match. */
  serverNow: number;
  locale: string;
  timeZone: string;
  /**
   * False when the server didn't know the zone (a device that hasn't reported it yet, so it fell back
   * to UTC). Times are then hidden until hydration and shown in the browser's own zone — rendered
   * identically on server and client, and never visibly jumping from UTC to local time.
   */
  zoneKnown?: boolean;
}

const ClockContext = createContext<ClockValue>({ serverNow: 0, locale: "en-US", timeZone: "UTC" });

const noopSubscribe = () => () => {};
/** False while rendering on the server and hydrating; true after. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function browserTimeZone(fallback: string): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch {
    return fallback;
  }
}

export function ClockProvider({ value, children }: { value: ClockValue; children: ReactNode }) {
  return <ClockContext.Provider value={value}>{children}</ClockContext.Provider>;
}

let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, 20_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** A ticking "now" (20 s resolution) that is hydration-safe. */
export function useNow(): number {
  const { serverNow } = useContext(ClockContext);
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => serverNow || current,
  );
}

/** Locale, time zone and a ticking "now", for the pure formatters in lib/format. */
export function useDateContext(): DateContext {
  return useDateDisplay().context;
}

/**
 * The date context plus `pending`: true while the zone is still unknown (server render and
 * hydration of a device that hasn't reported its zone). Callers hide the text while pending; right
 * after hydration the context switches to the browser's own zone.
 */
export function useDateDisplay(): { context: DateContext; pending: boolean } {
  const { locale, timeZone, zoneKnown = true } = useContext(ClockContext);
  const hydrated = useHydrated();
  const now = useNow();
  const pending = !zoneKnown && !hydrated;
  const zone = !zoneKnown && hydrated ? browserTimeZone(timeZone) : timeZone;
  const context = useMemo(() => ({ locale, timeZone: zone, now }), [locale, zone, now]);
  return { context, pending };
}
