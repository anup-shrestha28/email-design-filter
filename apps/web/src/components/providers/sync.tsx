"use client";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { pollSyncStatus } from "@/app/(app)/actions";
import { useLiveSchedule } from "@/hooks/use-live-schedule";
import { LIVE_TIMING, nextSyncDelay, type CheckOutcome } from "@/lib/live-poll";
import { syncNow } from "@/server/actions/settings";
import type { SyncStatus } from "@/server/queries/types";

interface SyncContextValue {
  status: SyncStatus;
  /** True while a sync-on-open call or a running import is in progress. */
  syncing: boolean;
  refresh: () => void;
  /**
   * A page that keeps itself current (the live gallery) takes over "new mail arrived": instead of
   * a blunt page refresh, which could reshuffle what's under the pointer, it is told to check now.
   * Returns the unregister function.
   */
  registerLive: (onMail: () => void) => () => void;
  /**
   * The governor turned the page's timers off (L1+, FREE-TIER.md §8.2), as a check found out: the
   * background sync and the live gallery both stop until the layout is rendered again.
   */
  pollingStopped: () => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

const POLL_MS = 10_000;
const POLL_MAX_MS = 90_000;
let syncedThisLoad = false;

/** Module-level (stable), so the background sync's schedule isn't rebuilt on every render. */
const syncDelay = (outcome: CheckOutcome, _current: number, now: number) =>
  nextSyncDelay(outcome === "changed", now);

/**
 * Sync on open (FREE-TIER.md §4.4): call syncNow() once per app load (throttled server-side),
 * then check status every 10 s for up to 90 s while syncing; when mail arrives, refresh the page
 * (or tell the live gallery). While the app stays open, visible and in use, syncNow() runs again
 * every 10 minutes (lib/live-poll.ts; the server's throttle still decides whether Gmail is asked),
 * so new mail lands within minutes. While the governor has sync-status polling off (L1, §8.2)
 * there is no timer at all: new mail shows on the next navigation or refresh.
 */
export function SyncProvider({ initial, children }: { initial: SyncStatus; children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [requesting, setRequesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const live = useRef<(() => void) | null>(null);

  /** A page refresh for new mail is on its way: where the page's scroll area was, and on which URL. */
  const hold = useRef<{ top: number; href: string; at: number } | null>(null);
  /** The viewer's last scrolling input (wheel, touch, keys): a scroll they made is never undone. */
  const lastScrollInput = useRef(0);

  useEffect(() => setStatus(initial), [initial]);
  // The refreshed layout has committed (`initial` is new). Next may have jumped the page's scroll
  // area to the top behind an open design (a scroll left pending by its shallow URL change): put it
  // back where it was, unless the viewer scrolled meanwhile or went elsewhere.
  useEffect(() => {
    const h = hold.current;
    hold.current = null;
    const main = document.getElementById("main");
    if (!h || !main || lastScrollInput.current >= h.at || location.href !== h.href) return;
    if (Date.now() - h.at < 30_000 && Math.abs(main.scrollTop - h.top) > 1) main.scrollTop = h.top;
  }, [initial]);
  useEffect(() => {
    const onInput = () => {
      lastScrollInput.current = Date.now();
    };
    const events = ["wheel", "touchmove", "keydown"] as const;
    for (const e of events) window.addEventListener(e, onInput, { capture: true, passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, onInput, { capture: true });
    };
  }, []);

  const registerLive = useCallback((onMail: () => void) => {
    live.current = onMail;
    return () => {
      if (live.current === onMail) live.current = null;
    };
  }, []);
  const pollingStopped = useCallback(
    () => setStatus((s) => (s.pollingOff === true ? s : { ...s, pollingOff: true })),
    [],
  );
  const mailArrived = useCallback(() => {
    if (live.current) return live.current();
    const main = document.getElementById("main");
    hold.current = main ? { top: main.scrollTop, href: location.href, at: Date.now() } : null;
    router.refresh();
  }, [router]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
    setPolling(false);
  }, []);

  const pollingOff = status.pollingOff === true || initial.pollingOff === true;
  const startPolling = useCallback(() => {
    stopPolling();
    if (pollingOff) return;
    const started = Date.now();
    const lastSeen = { at: initial.lastSyncedAt };
    setPolling(true);
    pollTimer.current = setInterval(async () => {
      const r = await pollSyncStatus();
      if (!r.ok) return;
      setStatus(r.data);
      if (r.data.lastSyncedAt !== lastSeen.at) {
        lastSeen.at = r.data.lastSyncedAt;
        mailArrived();
      }
      if (!r.data.syncing || Date.now() - started > POLL_MAX_MS) stopPolling();
    }, POLL_MS);
  }, [initial.lastSyncedAt, pollingOff, mailArrived, stopPolling]);

  const refresh = useCallback(() => {
    setRequesting(true);
    syncNow()
      .then((r) => {
        if (!r.ok) return;
        if (r.data.pollingOff) pollingStopped();
        if (r.data.newMessages > 0) mailArrived();
        if (r.data.syncing && !r.data.pollingOff) startPolling();
      })
      .finally(() => setRequesting(false));
  }, [mailArrived, startPolling, pollingStopped]);

  useEffect(() => {
    if (syncedThisLoad || initial.mailboxes.length === 0) return;
    syncedThisLoad = true;
    refresh();
  }, [initial.mailboxes.length, refresh]);

  useEffect(() => {
    if (initial.syncing) startPolling();
    return stopPolling;
  }, [initial.syncing, startPolling, stopPolling]);

  // The same sync, in the background while the app is open and in use (no "Syncing…" flash; the
  // status polling above still shows an import that it starts).
  const backgroundSync = useCallback(async (): Promise<CheckOutcome> => {
    const r = await syncNow();
    if (!r.ok) return r.code === "unauthorized" || r.code === "stale_session" ? "stop" : "error";
    if (r.data.newMessages > 0) mailArrived();
    // The governor moved to L1 since the page was rendered: no more timers (§8.2).
    if (r.data.pollingOff) {
      pollingStopped();
      return "stop";
    }
    if (r.data.syncing) startPolling();
    return r.data.newMessages > 0 ? "changed" : "same";
  }, [mailArrived, startPolling, pollingStopped]);
  useLiveSchedule(!pollingOff && status.mailboxes.length > 0, backgroundSync, {
    baseMs: LIVE_TIMING.syncMs,
    maxMs: LIVE_TIMING.syncMs,
    nextDelay: syncDelay,
  });

  return (
    <SyncContext.Provider
      value={{
        status,
        // "Syncing…" while we're actively checking; a backlog alone isn't shown as a spinner forever.
        syncing:
          requesting ||
          (polling && status.syncing) ||
          status.mailboxes.some((m) => m.backfill.state === "running"),
        refresh,
        registerLive,
        pollingStopped,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used inside <SyncProvider>");
  return ctx;
}
