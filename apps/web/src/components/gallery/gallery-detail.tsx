"use client";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  ImageOff,
  Monitor,
  RotateCw,
  Smartphone,
  Unplug,
  X,
} from "lucide-react";
import type { Route } from "next";
import { useEffect, useRef, useState } from "react";
import { SenderAvatar } from "@/components/ui/avatar";
import { Button, LinkButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { GALLERY_CATEGORY_LABELS, galleryHref } from "@/lib/gallery";
import { withoutRestatedLines } from "@/lib/gallery-evidence";
import {
  fullFrame,
  PHONE_WIDTH,
  phoneFit,
  phoneZoom,
  previewFrameOf,
  RENDER_WIDTH,
} from "@/lib/gallery-preview";
import type { GalleryItem } from "@/server/queries/types";
import { EmailFrame, useElementSize } from "./email-frame";
import { galleryPreviewUrls } from "@/server/actions/gallery";
import { gaveUp, isFresh, usePreviewUrl, useRequestWhile, viewModeOf } from "./preview-urls";
import { useGalleryParams } from "./use-gallery-params";
import { VerdictBadge } from "./verdict-badge";
import {
  shownEvidence,
  useChecksOpen,
  useVerdictEvidence,
  VerdictEvidence,
} from "./verdict-evidence";
import { useWaitingCopy, WaitingBadge } from "./waiting-badge";

type Width = "desktop" | "mobile";

function BigPreview({ item, width }: { item: GalleryItem; width: Width }) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const { entry, request, retry, reach, retryReach } = usePreviewUrl(item.id, "detail");
  // The frame keeps the URL it opened with: re-signed URLs must not reload the email.
  const [frame, setFrame] = useState<{ id: string; src: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fresh = isFresh(entry);
  if (frame && frame.id !== item.id) {
    setFrame(null);
    setLoaded(false);
  }
  if ((!frame || frame.id !== item.id) && fresh) setFrame({ id: item.id, src: entry.url });
  // Asks (and, after a failure, asks again with backoff) until the frame has its URL.
  useRequestWhile(item.previewable && (!frame || frame.id !== item.id), entry, request);

  // Focus inside the email (tabbed or clicked into): its keys go to the email's own page, so the
  // dialog's Esc and arrow keys can't hear them until focus steps back out (the hint below says
  // so). A cross-origin frame sends the page no focus event of its own, only the window's blur.
  const [focusInside, setFocusInside] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      // Once the focus change has settled (activeElement is the frame only after it).
      timer = setTimeout(() => {
        const a = document.activeElement;
        setFocusInside(a instanceof HTMLIFrameElement && !!boxRef.current?.contains(a));
      }, 0);
    };
    window.addEventListener("blur", check);
    window.addEventListener("focus", check);
    document.addEventListener("focusin", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("focusin", check);
    };
  }, [boxRef]);
  const unavailable = !item.previewable || entry?.state === "none" || reach === "unreachable";
  const failed = gaveUp(entry);
  // Phone: what a phone shows. The frame is the analysis' 375 px phone, so the email's own phone
  // styles switch on (its device-width ones too: the viewer reads them as the frame's width); a
  // layout still wider than the phone there is zoomed out to fit by the viewer document itself, as
  // phone mail apps do (lib/gallery-preview.ts `phoneZoom`) — however wide, so it never runs off
  // the screen. The caption says how much it was shrunk (the reason line's "shrinks to 60%").
  const layout = previewFrameOf(item.frame ?? null);
  const fit = phoneFit(layout);
  // Desktop: the analysis' 800 px (RENDER_WIDTH), or the email's own width when it's wider (a fixed
  // 886 px layout), so it isn't cut off on the right.
  const emailWidth =
    width === "mobile" ? PHONE_WIDTH : Math.max(RENDER_WIDTH, layout?.canvasWidth ?? 0);
  // Desktop scales down to fit; the phone screen is shown at its real size, centred.
  const frameBoxWidth = Math.min(box.width, emailWidth);
  const phoneNote = width === "mobile" && fit.scale < 1 ? phoneCaption(fit) : null;
  // The whole email at once when its length is known (desktop: where its content ends at 800 px;
  // phone: where it ends on the 375 px phone, at the phone preview's zoom): the frame is that tall
  // and the pane scrolls, one natural scroll. Unknown length: the frame fills the pane and scrolls
  // inside it.
  const scale = frameBoxWidth > 0 ? Math.min(1, frameBoxWidth / emailWidth) : 1;
  const full = fullFrame(
    width === "mobile"
      ? layout?.phoneBottom !== undefined
        ? layout.phoneBottom * phoneZoom(layout)
        : null
      : layout?.contentBottom,
    scale,
  );
  // The governor paused images (FREE-TIER.md §8.2–8.3): the design is shown without them until the
  // reader asks, like the email page's click-to-load.
  const [withImages, setWithImages] = useState<{ id: string; src: string } | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const shownSrc = withImages?.id === item.id ? withImages.src : frame?.src;
  const imagesPaused =
    !!frame &&
    frame.id === item.id &&
    withImages?.id !== item.id &&
    viewModeOf(frame.src) === "noimg";
  const loadImages = async () => {
    setLoadingImages(true);
    try {
      const urls = await galleryPreviewUrls([item.id], "img", { loadImages: true });
      const url = urls[item.id];
      if (url) {
        setLoaded(false);
        setWithImages({ id: item.id, src: url });
      }
    } catch {
      // stays images-off; the button can be pressed again
    } finally {
      setLoadingImages(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2 lg:h-full", !full && "h-[70dvh]")}>
      {phoneNote ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Smartphone className="size-3.5 shrink-0" aria-hidden />
          {phoneNote}
        </p>
      ) : null}
      {imagesPaused ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-muted-foreground">
          <ImageOff className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Images are paused for now to stay within the free allowance.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadImages()}
            disabled={loadingImages}
          >
            Load images
          </Button>
        </div>
      ) : null}
      <div
        ref={boxRef}
        data-preview-pane={full ? "full" : "scroll"}
        className={cn(
          "relative rounded-xl border border-border bg-[repeating-conic-gradient(var(--surface-muted)_0%_25%,var(--surface)_0%_50%)] bg-[length:16px_16px]",
          // Full length: as tall as the email on phones and tablets (the sheet itself scrolls); on
          // desktops the pane fills the column and scrolls (always room for the scrollbar, so the
          // measured width never changes under it).
          full
            ? "overflow-x-hidden lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:[scrollbar-gutter:stable]"
            : "min-h-0 flex-1 overflow-hidden",
        )}
      >
        <div
          className="pointer-events-none sticky top-2 z-10 flex h-0 justify-center"
          aria-live="polite"
        >
          {focusInside ? (
            <p className="mx-2 rounded-md bg-foreground px-2.5 py-1.5 text-center text-xs font-medium text-background shadow-overlay">
              Keys now go to the email. Press Shift+Tab (or click outside it) to use Esc and the
              arrow keys again.
            </p>
          ) : null}
        </div>
        {unavailable || failed ? (
          <div
            className={cn(
              "flex h-full flex-col items-center justify-center gap-3 bg-surface px-6 text-center",
              full && "min-h-[60dvh]",
            )}
          >
            <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-surface-muted text-muted-foreground shadow-raised">
              <Unplug className="size-5" aria-hidden />
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">
              {!item.previewable || entry?.state === "none"
                ? "This email can't be shown right now (its Gmail account may be disconnected)."
                : "The email viewer isn't answering just now."}
            </p>
            {item.previewable && entry?.state !== "none" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  retryReach();
                  retry();
                }}
              >
                <RotateCw aria-hidden />
                Try again
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            {full ? (
              // Holds the email's whole height in the pane (also while it loads, so nothing jumps).
              <div
                className={cn(
                  "relative mx-auto overflow-hidden",
                  loaded && "bg-white",
                  width === "mobile" && "shadow-overlay",
                )}
                style={{ width: frameBoxWidth || undefined, height: full.shownHeight }}
              >
                {frame && shownSrc && box.width > 0 ? (
                  <EmailFrame
                    key={shownSrc}
                    src={shownSrc}
                    title={`Email from ${item.sender.name} (sandboxed preview)`}
                    emailWidth={emailWidth}
                    boxWidth={frameBoxWidth}
                    boxHeight={full.shownHeight}
                    frameHeight={full.frameHeight}
                    interactive
                    onLoad={() => setLoaded(true)}
                  />
                ) : null}
              </div>
            ) : frame && shownSrc && box.width > 0 ? (
              <div
                className={cn(
                  "absolute inset-y-0 left-1/2 -translate-x-1/2 overflow-hidden bg-white",
                  width === "mobile" && "shadow-overlay",
                )}
                style={{ width: frameBoxWidth }}
              >
                <EmailFrame
                  key={shownSrc}
                  src={shownSrc}
                  title={`Email from ${item.sender.name} (sandboxed preview)`}
                  emailWidth={emailWidth}
                  boxWidth={frameBoxWidth}
                  boxHeight={box.height}
                  interactive
                  onLoad={() => setLoaded(true)}
                />
              </div>
            ) : null}
            {!loaded ? (
              <div
                role="status"
                aria-label="Loading preview"
                className="skeleton absolute inset-0 rounded-none"
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The Phone preview's caption, graded by how much the layout is shrunk: a layout a few percent
 * wider than the phone (one wide code block, k ≥ 0.9) is "a little wider", not "not built for
 * phones" — which stays for real fixed-width layouts. One more than twice the phone's width (the
 * engine's "genuinely broken", k < 0.5) is shown shrunk too, as phone mail apps do, and says so.
 */
export function phoneCaption(fit: { scale: number }): string {
  const pct = Math.round(fit.scale * 100);
  if (fit.scale >= 0.9) return `Shown at ${pct}%: a little wider than a phone screen`;
  if (fit.scale >= 0.5)
    return `Not built for phones: shown shrunk to ${pct}%, as phone mail apps do`;
  return `Far too wide for phones: shown shrunk to ${pct}%, as phone mail apps do, so it's hard to read`;
}

function Findings({
  title,
  items,
  kind,
}: {
  title: string;
  items: string[];
  kind: "problem" | "strength";
}) {
  if (items.length === 0) return null;
  const Icon = kind === "strength" ? Check : X;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <ul className="space-y-1.5">
        {items.map((t) => (
          <li key={t} className="flex items-start gap-2 text-sm leading-6 text-foreground">
            <Icon
              aria-hidden
              strokeWidth={2.75}
              className={cn(
                "mt-1.5 size-3.5 shrink-0",
                kind === "strength" ? "text-band-excellent" : "text-band-poor",
              )}
            />
            <span>
              <span className="sr-only">{kind === "strength" ? "Strength: " : "Problem: "}</span>
              {t}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The verdict and its one-line reason: above the email on phones, so the design comes first. */
function VerdictSummary({ item }: { item: GalleryItem }) {
  if (item.verdict === "unscored") return <WaitingSummary item={item} />;
  const text = item.reason?.text;
  return (
    <div className="flex items-start gap-2.5">
      <VerdictBadge verdict={item.verdict} score={item.score} />
      {text ? <p className="min-w-0 pt-0.5 text-sm leading-5 text-foreground">{text}</p> : null}
    </div>
  );
}

/** Not scored yet: when the score comes (lib/gallery-copy.ts `waitingCopy`). */
function WaitingSummary({ item }: { item: GalleryItem }) {
  const { line, pending } = useWaitingCopy(item.waiting);
  return (
    <div className="flex items-start gap-2.5">
      <WaitingBadge waiting={item.waiting} />
      {line ? (
        <p
          className={cn("min-w-0 pt-0.5 text-sm leading-5 text-foreground", pending && "invisible")}
        >
          {line}
        </p>
      ) : null}
    </div>
  );
}

function WaitingDetail({ item }: { item: GalleryItem }) {
  const { detail, pending } = useWaitingCopy(item.waiting);
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-sm leading-6 text-muted-foreground",
        pending && "invisible",
      )}
    >
      <Clock className="mt-1 size-4 shrink-0" aria-hidden />
      <span>{detail}</span>
    </p>
  );
}

function SimilarList({
  items,
  current,
  onOpen,
}: {
  items: GalleryItem[];
  current: string;
  onOpen: (id: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-foreground">
        {items.length} versions of this design
      </h3>
      <ul className="space-y-1">
        {items.map((it) => {
          const on = it.id === current;
          return (
            <li key={it.id}>
              <button
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => onOpen(it.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  on
                    ? "bg-surface-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
                )}
              >
                {/* Same sender and subject by construction: versions differ by when they came. */}
                <Time
                  iso={it.receivedAt}
                  variant="full"
                  className="min-w-0 flex-1 truncate tabular"
                />
                <VerdictBadge verdict={it.verdict} score={it.score} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The verdict, how it was judged, and the problem and strength lists (exported for tests). */
export function VerdictPanel({
  item,
  withBadge = true,
  similar,
  onOpenSimilar,
}: {
  item: GalleryItem;
  withBadge?: boolean;
  similar: GalleryItem[];
  onOpenSimilar: (id: string) => void;
}) {
  // "How we judged this" states the deciding rule and each failed check with its value and limit,
  // so the problem list (made plain and specific on the server, deduplicated by root cause, ≤ 3
  // each) doesn't say them again — only what is in view: while the checks are folded, just the
  // sentence's own statement is left out.
  const evidence = useVerdictEvidence(item);
  const [checksOpen, setChecksOpen] = useChecksOpen(item);
  const problems = withoutRestatedLines(item.problems, shownEvidence(item, evidence), checksOpen);
  const strengths = item.strengths;
  const good = item.verdict === "good";
  const { params } = useGalleryParams();
  // The full analysis page's "← All designs" returns to this gallery view, filters and all.
  const analysisHref = `/email/${item.id}?back=${encodeURIComponent(galleryHref(params))}`;
  return (
    <div className="space-y-5" data-verdict-panel>
      {withBadge ? (
        <div className="flex flex-wrap items-center gap-2">
          {item.verdict === "unscored" ? (
            <WaitingBadge waiting={item.waiting} size="lg" />
          ) : (
            <VerdictBadge verdict={item.verdict} score={item.score} size="lg" />
          )}
        </div>
      ) : null}
      {item.verdict === "unscored" ? null : (
        <VerdictEvidence
          key={item.id}
          item={item}
          query={evidence}
          open={checksOpen}
          onOpenChange={setChecksOpen}
        />
      )}
      {item.verdict === "unscored" ? (
        <WaitingDetail item={item} />
      ) : good ? (
        <>
          <Findings title="Why it's good" items={strengths} kind="strength" />
          <Findings title="Could be better" items={problems} kind="problem" />
        </>
      ) : (
        <>
          <Findings
            title={item.verdict === "bad" ? "What's wrong" : "What could be better"}
            items={problems}
            kind="problem"
          />
          <Findings title="What works" items={strengths} kind="strength" />
        </>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-4 text-sm">
        <dt className="text-muted-foreground">Category</dt>
        <dd className="text-foreground">{GALLERY_CATEGORY_LABELS[item.category]}</dd>
        <dt className="text-muted-foreground">Fonts</dt>
        <dd className="text-foreground">
          {item.fonts.length ? item.fonts.join(", ") : "Not measured"}
        </dd>
      </dl>
      <SimilarList items={similar} current={item.id} onOpen={onOpenSimilar} />
      <LinkButton href={analysisHref as Route} variant="secondary" className="w-full">
        Open full analysis
        <ArrowRight aria-hidden />
      </LinkButton>
    </div>
  );
}

/**
 * A card, opened: a big live preview with a Desktop / Phone width toggle, the verdict and why,
 * and previous / next (← / → keys). A modal on desktop, a full-screen sheet on phones; Esc closes.
 */
export function GalleryDetail({
  item,
  open,
  onClose,
  onPrev,
  onNext,
  similar = [],
  onOpenSimilar,
}: {
  item: GalleryItem | null;
  open: boolean;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** The open design's group of near-identical designs (including itself), or empty. */
  similar?: GalleryItem[];
  onOpenSimilar: (id: string) => void;
}) {
  const [width, setWidth] = useState<Width>("desktop");
  const closeRef = useRef<HTMLButtonElement>(null);
  const afterPreviewRef = useRef<HTMLParagraphElement>(null);
  // Keep showing the last card while the dialog animates closed.
  const [shown, setShown] = useState(item);
  if (item && item !== shown) setShown(item);

  // Phones always show the phone width (the toggle is hidden there: a desktop layout squeezed onto
  // a phone looks the same as the phone width anyway).
  useEffect(() => {
    if (open && window.matchMedia("(max-width: 639px)").matches) setWidth("mobile");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      // Arrow keys inside a composite widget (the width toggle) move within it.
      if (
        t?.closest(
          '[role="group"], [role="radiogroup"], [role="toolbar"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (e.key === "ArrowLeft" && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    // Capture phase: the dialog's own key handling stops some keys from bubbling to the window.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onPrev, onNext]);

  const subject = shown?.subject?.trim() || "(no subject)";

  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[80] bg-[oklch(0.18_0.01_270/0.55)] backdrop-blur-[2px] transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/70" />
        <BaseDialog.Popup
          initialFocus={closeRef}
          finalFocus={false}
          className={cn(
            "fixed inset-0 z-[81] flex flex-col bg-surface-overlay text-foreground shadow-overlay outline-none transition-[transform,opacity] duration-200 ease-out-quint data-ending-style:opacity-0 data-starting-style:opacity-0",
            "sm:inset-4 sm:rounded-2xl sm:border sm:border-border lg:inset-x-[max(2rem,calc((100vw-80rem)/2))] lg:inset-y-6",
            "data-ending-style:translate-y-2 data-starting-style:translate-y-2",
          )}
        >
          {shown ? (
            <>
              <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 sm:px-5 sm:py-3">
                <SenderAvatar
                  name={shown.sender.name}
                  domain={shown.sender.domain}
                  size="sm"
                  className="hidden rounded-full sm:inline-flex"
                />
                <div className="min-w-0 flex-1">
                  <BaseDialog.Title className="truncate text-base font-semibold tracking-tight sm:text-xl">
                    {subject}
                  </BaseDialog.Title>
                  <BaseDialog.Description className="truncate text-xs text-muted-foreground sm:text-sm">
                    {shown.sender.name}
                    {shown.sender.domain ? (
                      <span className="text-subtle-foreground"> · {shown.sender.domain}</span>
                    ) : null}
                    {" · "}
                    <Time iso={shown.receivedAt} variant="short" />
                  </BaseDialog.Description>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    label="Previous design"
                    tooltip={false}
                    aria-keyshortcuts="ArrowLeft"
                    icon={<ChevronLeft aria-hidden />}
                    className="max-sm:size-11"
                    disabled={!onPrev}
                    onClick={() => onPrev?.()}
                  />
                  <IconButton
                    label="Next design"
                    tooltip={false}
                    aria-keyshortcuts="ArrowRight"
                    icon={<ChevronRight aria-hidden />}
                    className="max-sm:size-11"
                    disabled={!onNext}
                    onClick={() => onNext?.()}
                  />
                  <BaseDialog.Close
                    ref={closeRef}
                    aria-label="Close"
                    className="ml-1 flex size-11 items-center justify-center rounded-md sm:size-8 text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
                  >
                    <X className="size-4" aria-hidden />
                  </BaseDialog.Close>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden">
                <div className="flex flex-col gap-3 p-3 sm:p-5 lg:min-h-0">
                  {/* Phones and tablets: the verdict in one line, then the email itself. */}
                  <div className="lg:hidden">
                    <VerdictSummary item={shown} />
                  </div>
                  <SegmentedControl<Width>
                    aria-label="Preview width"
                    value={width}
                    onValueChange={setWidth}
                    className="hidden self-start sm:inline-flex"
                    options={[
                      {
                        value: "desktop",
                        label: (
                          <>
                            <Monitor aria-hidden /> Desktop
                          </>
                        ),
                      },
                      {
                        value: "mobile",
                        label: (
                          <>
                            <Smartphone aria-hidden /> Phone
                          </>
                        ),
                      },
                    ]}
                  />
                  {/* Keyboard: the email's links come next (Tab steps through each of them, and
                      inside the email the dialog's keys can't be heard), so one press skips it. */}
                  <button
                    type="button"
                    onClick={() => afterPreviewRef.current?.focus()}
                    className="sr-only self-start rounded-md focus-visible:not-sr-only focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {/* The look sits on the span: `not-sr-only` resets the button's padding. */}
                    <span className="block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground">
                      Skip email preview
                    </span>
                  </button>
                  <div className="lg:min-h-0 lg:flex-1">
                    <BigPreview item={shown} width={width} />
                  </div>
                  <p ref={afterPreviewRef} tabIndex={-1} className="sr-only">
                    End of email preview
                  </p>
                  {/* …and below it, why. */}
                  <div className="pt-2 pb-4 lg:hidden">
                    <VerdictPanel
                      item={shown}
                      withBadge={false}
                      similar={similar}
                      onOpenSimilar={onOpenSimilar}
                    />
                  </div>
                </div>
                <aside className="hidden border-l border-border p-5 lg:block lg:overflow-y-auto">
                  <VerdictPanel item={shown} similar={similar} onOpenSimilar={onOpenSimilar} />
                </aside>
              </div>
            </>
          ) : (
            <BaseDialog.Title className="sr-only">Email design</BaseDialog.Title>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
