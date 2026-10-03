"use client";
import { ArrowUp } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useSync } from "@/components/providers/sync";
import { useLiveSchedule } from "@/hooks/use-live-schedule";
import { cn } from "@/lib/cn";
import { galleryHref, type GalleryParams } from "@/lib/gallery";
import {
  applyMode,
  classifyChange,
  pillText,
  sameStamp,
  type GalleryStamp,
  type LiveChange,
} from "@/lib/gallery-live";
import { LIVE_TIMING, type CheckOutcome } from "@/lib/live-poll";
import { checkGallery } from "@/server/actions/gallery-live";
import { scrollRoot } from "./gallery-card";
import { useOpenCard } from "./use-gallery-params";

const SLOT = "data-gallery-live-slot";

/**
 * Where the "new designs" pill sits: the top of the grid (gallery-view.tsx), taking no room. At
 * rest the pill (28 px) sits in the empty band between the filter bar and the count line (the
 * bar's bottom padding and the grid's top padding, 12 + 16 px), so it covers no text; while the
 * grid scrolls it stays in view, just under the header or hanging from the filter bar where that
 * is sticky too.
 */
export function LiveSlot() {
  return <div {...{ [SLOT]: "" }} className="pointer-events-none sticky top-10 z-30 h-0" />;
}

/** The grid area (filters' chips, the count line, the cards and the page numbers) around the slot. */
function gridArea(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${SLOT}]`)?.parentElement ?? null;
}

/**
 * Where the slot sticks. The slot rests at the top of the grid's content (under its 16 px top
 * padding) and the pill (28 px) hangs just above it. Scrolled, the slot sticks 40 px from the top
 * (the pill shows 12–40 px down) — or, while the filter bar above the grid is sticky (wide
 * screens), 16 px under the bar, which is also where it rests: the pill never slides onto the
 * count line, and stays hanging from the bar's bottom edge.
 */
function stickyOffset(slot: HTMLElement): number {
  const bar = slot.parentElement?.previousElementSibling;
  if (!(bar instanceof HTMLElement) || getComputedStyle(bar).position !== "sticky") return 40;
  return bar.offsetHeight + 16;
}

interface Pending {
  /** The stamp of the render this notice is about (a new render makes it stale). */
  base: GalleryStamp;
  change: LiveChange;
}

/**
 * Keeps the gallery current while it's open (FREE-TIER.md §4.4): checks the server's stamp about
 * once a minute while the tab is visible and in use (lib/live-poll.ts; backing off to every 5
 * minutes while nothing changes, never while hidden, idle or with the governor's UI polling off),
 * and when mail is found by the app's sync. What a change means, and whether it is applied at once,
 * in place, or offered as "N new designs · Show", is lib/gallery-live.ts. Rendered by the page
 * (live-gallery.tsx) with the stamp the page was rendered with.
 */
export function LiveUpdates({
  stamp,
  params,
  total,
  regroup,
}: {
  /** The stamp the page was rendered with. */
  stamp: GalleryStamp;
  params: GalleryParams;
  /** Designs in this view when rendered (GalleryPage.total). */
  total: number;
  /** Cards on this page could merge or split ("+N similar") when a verdict changes. */
  regroup: boolean;
}) {
  const router = useRouter();
  const { status, registerLive, pollingStopped } = useSync();
  const [openId] = useOpenCard();
  const [applying, startApply] = useTransition();
  const [pending, setPending] = useState<Pending | null>(null);
  const [said, setSaid] = useState("");
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  /** The page as rendered (read by the check, which outlives renders). */
  const page = useRef({ stamp, params, total, regroup, open: openId !== null });
  /** The last stamp the check saw (the back-off counts "changed since the last check"). */
  const lastSeen = useRef(stamp);
  /** An in-place refresh waiting for the pointer and focus to leave the grid. */
  const deferred = useRef(false);
  /** The last pointer was a finger (touch keeps :hover on the last tapped card). */
  const touch = useRef(false);
  /** Our own in-place refresh is on its way: the view it refreshes (galleryHref). */
  const ownRefresh = useRef<string | null>(null);
  /** Where the grid was as our refreshed page committed (before the router could move it). */
  const keepScroll = useRef<number | null>(null);

  useEffect(() => {
    page.current = { stamp, params, total, regroup, open: openId !== null };
  }, [stamp, params, total, regroup, openId]);
  // Our refresh keeps the grid where it is. Next can apply a scroll left pending by the open
  // design's shallow URL change when the refreshed page commits, jumping the grid to the top behind
  // the open design. This layout effect runs before that (Next's scroll handler is an ancestor), so
  // it reads where the grid is at that moment — including any scrolling the viewer did while the
  // refresh was on its way, which is never undone.
  useLayoutEffect(() => {
    const view = ownRefresh.current;
    ownRefresh.current = null;
    const root = scrollRoot();
    keepScroll.current = view !== null && root && view === galleryHref(params) ? root.scrollTop : null;
  }, [stamp, params]);
  // A new render (ours, a filter change or a navigation) is the new baseline.
  useEffect(() => {
    lastSeen.current = stamp;
    deferred.current = false;
    const top = keepScroll.current;
    keepScroll.current = null;
    const root = scrollRoot();
    if (top !== null && root && Math.abs(root.scrollTop - top) > 1) root.scrollTop = top;
  }, [stamp]);

  const refresh = useCallback(() => {
    deferred.current = false;
    ownRefresh.current = galleryHref(page.current.params);
    startApply(() => router.refresh());
  }, [router]);

  const onGrid = useCallback((): boolean => {
    const area = gridArea();
    if (!area) return true;
    const hovered = !touch.current && area.matches(":hover");
    return hovered || area.contains(document.activeElement);
  }, []);

  const decide = useCallback(
    (change: LiveChange) => {
      const p = page.current;
      const root = scrollRoot();
      const mode = applyMode(change, {
        page: p.params.page,
        sort: p.params.sort,
        atTop: (root?.scrollTop ?? 0) < 8,
        open: p.open,
        onGrid: onGrid(),
        regroup: p.regroup,
      });
      if (mode === "apply") {
        if (change.kind === "new") setSaid(`${pillText(change)} added.`);
        setPending(null);
        refresh();
      } else if (mode === "defer") {
        deferred.current = true;
      } else {
        setPending((prev) =>
          // "New designs" wins over "updated" for the same render; the count follows the latest check.
          prev &&
          sameStamp(prev.base, p.stamp) &&
          prev.change.kind === "new" &&
          change.kind !== "new"
            ? prev
            : { base: p.stamp, change },
        );
        setSaid(`${pillText(change)}. Choose Show to see them.`);
      }
    },
    [onGrid, refresh],
  );

  const check = useCallback(async (): Promise<CheckOutcome> => {
    if (applying) return "same";
    const p = page.current;
    const r = await checkGallery({ params: p.params, since: p.stamp });
    if (!r.ok) return r.code === "unauthorized" || r.code === "stale_session" ? "stop" : "error";
    if (r.data.pollingOff) {
      // The governor moved to L1: this check and the app's background sync both stop (§8.2).
      pollingStopped();
      return "stop";
    }
    const moved = !sameStamp(r.data.stamp, lastSeen.current);
    lastSeen.current = r.data.stamp;
    // A newer render arrived while we asked: its own stamp is the baseline now.
    if (page.current.stamp !== p.stamp || !r.data.view) return moved ? "changed" : "same";
    const change = classifyChange(
      { stamp: p.stamp, total: p.total },
      { stamp: r.data.stamp, view: r.data.view },
      p.params,
    );
    if (change) decide(change);
    return moved ? "changed" : "same";
  }, [applying, decide, pollingStopped]);

  const enabled = status.pollingOff !== true && status.mailboxes.length > 0;
  const checkNow = useLiveSchedule(enabled, check, {
    baseMs: LIVE_TIMING.pollMs,
    maxMs: LIVE_TIMING.pollMaxMs,
  });
  // New mail found by the app's sync: check now instead of a blunt page refresh.
  useEffect(
    () => (enabled ? registerLive(checkNow) : undefined),
    [enabled, registerLive, checkNow],
  );

  // An in-place refresh that waited applies as soon as the pointer and focus leave the grid.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      touch.current = e.pointerType === "touch";
    };
    let frame = 0;
    const retry = () => {
      if (!deferred.current) return;
      // pointerleave/focusout fire before :hover and activeElement settle.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (deferred.current && !onGrid()) refresh();
      });
    };
    window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
    window.addEventListener("pointermove", onPointer, { capture: true, passive: true });
    const area = gridArea();
    area?.addEventListener("pointerleave", retry);
    area?.addEventListener("focusout", retry);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("pointermove", onPointer, { capture: true });
      area?.removeEventListener("pointerleave", retry);
      area?.removeEventListener("focusout", retry);
    };
  }, [onGrid, refresh, stamp]);

  const show = pending && sameStamp(pending.base, stamp) ? pending : null;

  // The pill lives in the grid's slot, which sticks below any sticky bar above the grid.
  useEffect(() => {
    if (!show) return;
    const el = document.querySelector<HTMLElement>(`[${SLOT}]`);
    setSlot(el);
    if (!el) return;
    const measure = () => {
      el.style.top = `${stickyOffset(el)}px`;
    };
    measure();
    const bar = el.parentElement?.previousElementSibling;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (bar) ro?.observe(bar);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [show]);

  const onShow = useCallback(() => {
    if (!show) return;
    const p = page.current;
    const root = scrollRoot();
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    root?.scrollTo?.({ top: 0, behavior: smooth ? "smooth" : "auto" });
    setPending(null);
    setSaid("");
    deferred.current = false;
    ownRefresh.current = null;
    // New designs are at the top of Newest: from a later page, go to the first.
    if (show.change.kind === "new" && p.params.sort === "newest" && p.params.page > 1) {
      startApply(() =>
        router.push(galleryHref({ ...p.params, page: 1 }) as Route, { scroll: false }),
      );
    } else {
      startApply(() => router.refresh());
    }
    requestAnimationFrame(() => document.getElementById("main")?.focus({ preventScroll: true }));
  }, [show, router]);

  const pill = show ? (
    <button
      type="button"
      onClick={onShow}
      className={cn(
        "pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[0.8125rem] font-medium text-accent-foreground",
        "shadow-overlay ring-1 ring-black/5 transition-[background-color,transform] hover:bg-accent-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2",
      )}
    >
      <ArrowUp aria-hidden className="size-3.5" />
      <span>{pillText(show.change)}</span>
      <span aria-hidden className="opacity-70">
        ·
      </span>
      <span className="font-semibold">Show</span>
    </button>
  ) : null;

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      {pill && slot?.isConnected ? (
        createPortal(
          <div className="absolute inset-x-0 -top-7 flex justify-center">{pill}</div>,
          slot,
        )
      ) : pill ? (
        // No slot (the grid isn't on screen): the top of the window.
        <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center">
          {pill}
        </div>
      ) : null}
    </>
  );
}
