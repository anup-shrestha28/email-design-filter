"use client";
import type { Region } from "@edf/design/types";
import { ImageOff, Monitor, RotateCw, ScanLine, Smartphone, Unplug } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNow } from "@/components/providers/clock";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { phoneZoom, previewFrameOf } from "@/lib/gallery-preview";
import type { EmailDetail } from "@/server/queries/types";

type Width = "desktop" | "mobile";
const FRAME_WIDTH: Record<Width, number> = { desktop: 800, mobile: 375 };
const FALLBACK_HEIGHT = 900;

/** The email frame's sandbox: no scripts, no same-origin access; links may open a new tab. */
export const EMAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

export interface ViewerIssue {
  index: number;
  title: string;
  regions: Region[];
}

export type Reach = "checking" | "ok" | "unreachable";

/**
 * Is the viewer origin up? A tiny image probe (img-src allows VIEW_ORIGIN; connect-src doesn't).
 * Keyed on the origin, not the signed URL: fresh URLs for the same viewer don't re-probe it.
 * Patient on purpose: a busy moment (a cold start, a slow network) must not hide previews, so the
 * probe waits PROBE_TIMEOUT_MS and needs two failures in a row before it answers "unreachable".
 */
/** How long one probe may take, how many failures in a row mean "unreachable", and the gap between them. */
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_FAILURES = 2;
const PROBE_RETRY_MS = 2_000;

export function useViewerReachable(origin: string | null): [Reach, () => void] {
  const [state, setState] = useState<Reach>(origin ? "checking" : "unreachable");
  const stateRef = useRef<Reach>(state);
  const lastOrigin = useRef(origin);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const set = (s: Reach) => {
      stateRef.current = s;
      setState(s);
    };
    if (!origin) {
      lastOrigin.current = origin;
      set("unreachable");
      return;
    }
    // A different viewer (or the first one after none): start over. A re-check of the same viewer
    // keeps showing the last known answer until it has a new one, so previews never flicker.
    if (lastOrigin.current !== origin) {
      lastOrigin.current = origin;
      set("checking");
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probeOnce = (failuresSoFar: number) => {
      let settled = false;
      const img = new Image();
      const settle = (ok: boolean) => {
        if (settled || cancelled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) set("ok");
        // Already known to be down: one more failure keeps it down. Otherwise it takes two in a row.
        else if (stateRef.current === "unreachable" || failuresSoFar + 1 >= PROBE_FAILURES)
          set("unreachable");
        else timer = setTimeout(() => probeOnce(failuresSoFar + 1), PROBE_RETRY_MS);
      };
      timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
      img.onload = () => settle(true);
      img.onerror = () => settle(false);
      img.referrerPolicy = "no-referrer";
      // Static file on edf-view (no function call); a query string keeps a cached answer from sticking.
      img.src = `${new URL("/health.gif", origin).href}?t=${Date.now()}`;
    };
    probeOnce(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [origin, attempt]);
  // Stable, so callers can use it in effect dependencies without restarting their timers.
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return [state, retry];
}

function useContainerWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Live, sandboxed email viewer. The email HTML is served by the separate viewer origin — never
 * rendered in the app origin. No scripts, no same-origin access, no referrer.
 */
export function EmailViewer({
  viewer,
  layout,
  issues = [],
  suspicious = false,
  clickToLoad = false,
  onExpired,
  maxHeight,
  className,
}: {
  viewer: EmailDetail["viewer"];
  layout: EmailDetail["design"]["layout"];
  issues?: ViewerIssue[];
  suspicious?: boolean;
  /** Images click-to-load (the governor's free-tier saver, FREE-TIER.md §8.2–8.3): start with images off. */
  clickToLoad?: boolean;
  /** Called when the signed viewer URLs expired (≤ 5 min) so the parent can fetch fresh ones. */
  onExpired?: () => void;
  maxHeight?: number;
  className?: string;
}) {
  const [width, setWidth] = useState<Width>("desktop");
  const autoWidthApplied = useRef(false);
  const [imagesOff, setImagesOff] = useState(suspicious || clickToLoad);
  const [showIssues, setShowIssues] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reach, retry] = useViewerReachable(originOf(viewer?.src ?? null));
  const [boxRef, boxWidth] = useContainerWidth<HTMLDivElement>();
  const now = useNow();
  const src = viewer ? (imagesOff ? viewer.srcImagesOff : viewer.src) : null;
  const expiresAt = viewer?.expiresAt ?? null;

  // The frame keeps the URL it opened with. Every fetch of the detail signs new URLs (a triage
  // action, router.refresh(), a background refetch), and switching to one would reload the email
  // from the top. It switches only for another email, the other images mode, or a refresh asked
  // for because its URL expired — never just because the parent fetched or time passed.
  const isExpired = (at: string | null) => (at ? Date.parse(at) - 10_000 < now : false);
  const latestExpired = isExpired(expiresAt);
  const frameKey = `${emailOf(src)}|${imagesOff ? "noimg" : "img"}`;
  const [frame, setFrame] = useState({ key: frameKey, src, expiresAt });
  /** A refresh was asked for: take the next fresh URLs the parent passes. */
  const [refreshWanted, setRefreshWanted] = useState(false);
  if (frame.key !== frameKey || (refreshWanted && src !== frame.src)) {
    setFrame({ key: frameKey, src, expiresAt });
    if (refreshWanted && !latestExpired) setRefreshWanted(false);
    setLoaded(false);
  }
  const frameSrc = frame.src;
  const expired = isExpired(frame.expiresAt);
  const refresh = useCallback(() => {
    setRefreshWanted(true);
    onExpired?.();
  }, [onExpired]);

  // Narrow containers (phones, preview pane) start in the mobile width; the choice is then the reader's.
  useEffect(() => {
    if (autoWidthApplied.current || boxWidth === 0) return;
    autoWidthApplied.current = true;
    if (boxWidth < 520) setWidth("mobile");
  }, [boxWidth]);

  const frameW = FRAME_WIDTH[width];
  // Mobile 375 is the phone preview: an email still wider than the phone there is zoomed out to
  // fit by the viewer document itself, as phone mail apps do (lib/gallery-preview.ts `phoneZoom`),
  // so its length and the phone pass's issue boxes shrink by the same zoom.
  const zoom = width === "mobile" ? phoneZoom(previewFrameOf(layout)) : 1;
  const measuredH = width === "desktop" ? layout?.desktopHeight : layout?.mobileHeight;
  const frameH = measuredH ? Math.ceil(measuredH * zoom) : FALLBACK_HEIGHT;
  const scale = boxWidth > 0 ? Math.min(1, boxWidth / frameW) : 1;
  const scaledH = frameH * scale;
  const visibleIssues = issues
    .map((i) => ({ ...i, regions: i.regions.filter((r) => r.pass === width) }))
    .filter((i) => i.regions.length);
  const hasIssues = issues.some((i) => i.regions.length > 0);

  const toggleImages = useCallback(
    (off: boolean) => {
      if (latestExpired) refresh();
      setImagesOff(off);
    },
    [latestExpired, refresh],
  );

  return (
    <Card className={cn("overflow-hidden", className)} aria-label="Email preview">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2 sm:px-4">
        <SegmentedControl<Width>
          aria-label="Preview width"
          size="sm"
          value={width}
          onValueChange={setWidth}
          options={[
            {
              value: "desktop",
              label: (
                <>
                  <Monitor aria-hidden /> Desktop 800
                </>
              ),
            },
            {
              value: "mobile",
              label: (
                <>
                  <Smartphone aria-hidden /> Mobile 375
                </>
              ),
            },
          ]}
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          <Switch size="sm" checked={imagesOff} onCheckedChange={toggleImages} />
          <ImageOff className="size-3.5" aria-hidden />
          Images off
        </label>
        {clickToLoad && !suspicious && imagesOff ? (
          <span className="text-2xs text-subtle-foreground">
            Images load when you turn this off, to keep the app within its free limits.
          </span>
        ) : null}
        {hasIssues ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
            <Switch size="sm" checked={showIssues} onCheckedChange={setShowIssues} />
            <ScanLine className="size-3.5" aria-hidden />
            Show issues
          </label>
        ) : null}
        {expired && reach === "ok" ? (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={refresh}>
            <RotateCw aria-hidden />
            Refresh preview
          </Button>
        ) : null}
      </div>

      <div
        ref={boxRef}
        className={cn(
          "relative bg-[repeating-conic-gradient(var(--surface-muted)_0%_25%,var(--surface)_0%_50%)] bg-[length:16px_16px] p-0",
          "max-h-[80vh] overflow-y-auto overscroll-contain",
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {reach === "unreachable" || !viewer ? (
          <ViewerUnavailable src={viewer?.src ?? null} onRetry={retry} />
        ) : reach === "checking" ? (
          <div
            className="skeleton h-[28rem] w-full rounded-none"
            aria-label="Loading preview"
            role="status"
          />
        ) : (
          <div className="mx-auto" style={{ width: frameW * scale, height: scaledH }}>
            <div
              className="relative origin-top-left"
              style={{ width: frameW, height: frameH, transform: `scale(${scale})` }}
            >
              {!loaded ? (
                <div className="skeleton absolute inset-0 rounded-none" aria-hidden />
              ) : null}
              {frameSrc ? (
                <iframe
                  key={frameSrc}
                  src={frameSrc}
                  title="Email preview (sandboxed)"
                  sandbox={EMAIL_FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  onLoad={() => setLoaded(true)}
                  className={cn(
                    "block h-full w-full border-0 bg-white",
                    width === "mobile" && "shadow-overlay",
                  )}
                  style={{ width: frameW, height: frameH }}
                />
              ) : null}
              {showIssues
                ? visibleIssues.map((issue) =>
                    issue.regions.map((r, i) => (
                      <div
                        key={`${issue.index}-${i}`}
                        className="pointer-events-none absolute rounded-[3px] border-2 border-band-poor bg-band-poor/10"
                        style={{
                          left: r.x * zoom,
                          top: r.y * zoom,
                          width: r.w * zoom,
                          height: r.h * zoom,
                        }}
                      >
                        {i === 0 ? (
                          <span
                            className="absolute -top-3 -left-3 flex size-6 items-center justify-center rounded-full bg-band-poor text-xs font-semibold text-white shadow-raised"
                            style={{ transform: `scale(${1 / Math.max(scale, 0.4)})` }}
                            title={issue.title}
                          >
                            {issue.index}
                          </span>
                        ) : null}
                      </div>
                    )),
                  )
                : null}
            </div>
          </div>
        )}
      </div>
      {showIssues && hasIssues ? (
        <p className="border-t border-border px-4 py-2 text-2xs text-subtle-foreground">
          Boxes are approximate: they come from our render, and your browser may lay the email out
          slightly differently. Numbers match “Needs improvement”.
        </p>
      ) : null}
    </Card>
  );
}

/** The email a signed viewer URL opens (`…/v/<token>/<emailId>`). */
function emailOf(src: string | null): string | null {
  return src ? src.slice(src.lastIndexOf("/") + 1) : null;
}

export function originOf(src: string | null): string | null {
  if (!src) return null;
  try {
    return new URL(src).origin;
  } catch {
    return null;
  }
}

function ViewerUnavailable({ src, onRetry }: { src: string | null; onRetry: () => void }) {
  const origin = originOf(src);
  const local = origin ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) : false;
  return (
    <div className="flex flex-col items-center justify-center gap-3 bg-surface px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-surface-muted text-muted-foreground shadow-raised">
        <Unplug className="size-5" aria-hidden />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-[0.9375rem] font-medium text-foreground">
          The email viewer isn&apos;t reachable
        </p>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          Emails open live from Gmail on a separate, locked-down site. It didn&apos;t answer just
          now — the score and details below still work.
        </p>
        {local ? (
          <p className="pt-1 text-xs text-subtle-foreground">
            Local development: start it with{" "}
            <code className="rounded bg-surface-muted px-1 py-0.5 font-mono">
              pnpm --filter @edf/view dev
            </code>{" "}
            ({origin}).
          </p>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden />
        Try again
      </Button>
    </div>
  );
}
