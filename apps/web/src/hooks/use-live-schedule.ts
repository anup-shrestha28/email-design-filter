"use client";
import { useCallback, useEffect, useRef } from "react";
import { LiveScheduler, type CheckOutcome, type SchedulerOptions } from "@/lib/live-poll";

/** Input that counts as "the viewer is using the page" (scroll is captured: <main> scrolls, not the window). */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/**
 * A LiveScheduler (lib/live-poll.ts) for as long as `enabled`: it follows the tab's visibility,
 * the network and the viewer's input, and runs `run` (the latest one passed). Returns `trigger`,
 * which asks for a check now. Nothing runs on the server or while disabled.
 */
export function useLiveSchedule(
  enabled: boolean,
  run: () => Promise<CheckOutcome>,
  opts: Omit<SchedulerOptions, "run" | "clock">,
): () => void {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const scheduler = useRef<LiveScheduler | null>(null);
  const { baseMs, maxMs, idleMs, minGapMs, nextDelay } = opts;

  useEffect(() => {
    if (!enabled) return;
    const s = new LiveScheduler({
      run: () => runRef.current(),
      baseMs,
      maxMs,
      idleMs,
      minGapMs,
      nextDelay,
    });
    scheduler.current = s;
    s.setVisible(document.visibilityState === "visible");
    s.setOnline(navigator.onLine !== false);
    const onVisibility = () => s.setVisible(document.visibilityState === "visible");
    const onOnline = () => s.setOnline(true);
    const onOffline = () => s.setOnline(false);
    const onInput = () => s.input();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    for (const e of ACTIVITY_EVENTS) {
      window.addEventListener(e, onInput, { capture: true, passive: true });
    }
    s.start();
    return () => {
      s.dispose();
      if (scheduler.current === s) scheduler.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onInput, { capture: true });
    };
  }, [enabled, baseMs, maxMs, idleMs, minGapMs, nextDelay]);

  return useCallback(() => scheduler.current?.trigger(), []);
}
