"use client";
import { Check, ChevronsDown, ImageOff, Layers, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { EMAIL_FRAME_SANDBOX } from "@/components/email/email-viewer";
import { SenderAvatar } from "@/components/ui/avatar";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { cardCrop, cardLayout, cardShape, previewFrameOf, type CardShape } from "@/lib/gallery-preview";
import type { GalleryItem } from "@/server/queries/types";
import { useElementSize } from "./email-frame";
import { gaveUp, isFresh, useLoadTurn, usePreviewUrl, useRequestWhile } from "./preview-urls";
import { SaveToBoard } from "./save-to-board";
import { VerdictBadge } from "./verdict-badge";
import { useWaitingCopy, WaitingBadge } from "./waiting-badge";

/** The gallery's scroll container (the app shell's <main>); cards observe against it. */
export function scrollRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("main");
}

/**
 * The loading skeleton's preview box (a card whose length isn't known yet is square too). A real
 * card's box is the email's own shape (Pinterest-style masonry, gallery-view.tsx): the whole email
 * at the card's width, up to CARD_MAX_RATIO tall — a longer one shows its top and fades out
 * (lib/gallery-preview.ts cardShape). The full design is one click away, in the detail view.
 */
export const PREVIEW_BOX = "aspect-square";

/**
 * The card width a first-screen preview is laid out for before its box has been measured (a
 * 4-column grid at 1440 px). The preview stays hidden behind its skeleton until it is measured and
 * loaded, so a wrong guess never shows; it only lets the iframe start loading a frame earlier.
 */
const ESTIMATED_CARD_WIDTH = 326;

/**
 * How far past the visible part of the gallery a card counts as "near" (IntersectionObserver
 * `rootMargin` against <main>): about half a screen above and one screen below. Near cards get
 * their URL and a place in the load queue, and a card whose URL came with the page starts at once
 * only when it is near — on a phone that is the first few cards, not the whole first page.
 */
const NEAR_MARGIN = { top: 0.5, bottom: 1 };
const NEAR_ROOT_MARGIN = `${NEAR_MARGIN.top * 100}% 0px ${NEAR_MARGIN.bottom * 100}% 0px`;

/** The scroll container's visible rectangle (the window's when there is no <main>). */
function rootRect(root: HTMLElement | null): { top: number; bottom: number } {
  if (root) {
    const r = root.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * On screen (loads first) and near it (see NEAR_MARGIN: gets its URL and a place in the load
 * queue). Measured once synchronously before the first paint, so a first-screen card can start
 * loading in the same commit it hydrates in, then kept up to date by IntersectionObservers.
 */
function useVisibility(ref: React.RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  const [near, setNear] = useState(false);
  /** Near the screen when the card first mounted (null until measured). */
  const [nearAtMount, setNearAtMount] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      setNear(true);
      setNearAtMount(true);
      return;
    }
    const root = scrollRoot();
    const r = el.getBoundingClientRect();
    const view = rootRect(root);
    const h = view.bottom - view.top;
    const nearNow =
      r.bottom > view.top - NEAR_MARGIN.top * h && r.top < view.bottom + NEAR_MARGIN.bottom * h;
    setVisible(r.bottom > view.top && r.top < view.bottom);
    setNear(nearNow);
    setNearAtMount((was) => was ?? nearNow);
    const visObs = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), {
      root,
    });
    const nearObs = new IntersectionObserver(([e]) => setNear(Boolean(e?.isIntersecting)), {
      root,
      rootMargin: NEAR_ROOT_MARGIN,
    });
    visObs.observe(el);
    nearObs.observe(el);
    return () => {
      visObs.disconnect();
      nearObs.disconnect();
    };
  }, [ref]);
  return { visible, near: near || visible, nearAtMount: nearAtMount === true };
}

/** The email's layout facts for the crop, when the server sent them (see lib/gallery-preview.ts). */
export function frameOf(item: GalleryItem) {
  return previewFrameOf(item.frame ?? null);
}

/** A card's preview shape (height ÷ width, and whether it's cut short): the masonry lays cards out by it. */
export function shapeOf(item: GalleryItem): CardShape {
  return cardShape(cardCrop(frameOf(item)));
}

/**
 * A live picture of the whole email, served by the viewer origin (edf-view) in a sandboxed iframe —
 * never rendered in the app origin. The email is laid out at the analysis' 800 px (or its own
 * width, when wider) and zoomed so its visible content fills the card's width (lib/gallery-preview.ts
 * cardCrop); the box is the email's own shape (cardShape), so the card shows all of it — or, for a
 * very long email, its top with a soft fade.
 *
 * Loading: a card whose URL came with the page (`eager`) and that is near the screen when the page
 * hydrates mounts its frame at once, without waiting for a load turn or for the box to be measured
 * (on a 1440 px desktop that is the first rows; on a phone only the first few cards). Every other
 * card — including seeded ones further down — waits until it comes near the screen, asks for its
 * URL (reusing the seeded one while it is fresh), then waits for one of a few load turns (cards on
 * screen first). Once loaded, a frame stays mounted — scrolling back never loads it again.
 *
 * (The frames are not put in the server HTML: the gallery streams behind a Suspense boundary, and
 * moving the streamed content into place re-navigates every iframe in it — measured: 3 loads per
 * card. Stored screenshots, FREE-TIER.md §12 A2, are the real fix for the first paint.)
 */
function CardPreview({ item, eager }: { item: GalleryItem; eager: boolean }) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const { visible, near, nearAtMount } = useVisibility(boxRef);
  const { entry, request, reach } = usePreviewUrl(item.id);
  const fresh = isFresh(entry);
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Loaded while the viewer was confirmed reachable: a real preview, kept even if a later check fails.
  // (A frame that "loaded" while the viewer was down is the browser's error page, not the email.)
  const [loadedOk, setLoadedOk] = useState(false);
  useEffect(() => {
    if (loaded && reach === "ok") setLoadedOk(true);
  }, [loaded, reach]);

  useRequestWhile(item.previewable && near && !src, entry, request);
  const { granted, release } = useLoadTurn(
    item.id,
    item.previewable && near && !src && fresh,
    visible ? 0 : 1,
  );
  if (granted && !src && fresh) setSrc(entry.url);
  // The first screen starts at once (its URL came with the page and it was near the screen when the
  // page hydrated); the rest, seeded or not, wait until they come near and take their turn.
  useEffect(() => {
    if (eager && nearAtMount && !src && fresh && item.previewable) setSrc(entry.url);
  }, [eager, nearAtMount, src, fresh, entry, item.previewable]);

  const crop = useMemo(() => cardCrop(frameOf(item)), [item]);
  const shape = useMemo(() => cardShape(crop), [crop]);
  const width = box.width || ESTIMATED_CARD_WIDTH;
  const layout = cardLayout(crop, width, box.height || Math.round(width * shape.ratio));

  // The viewer is confirmed down (the probe is patient: two failures in a row), and this card has no
  // real preview yet: show the friendly fallback instead of a broken frame.
  const viewerDown = reach === "unreachable" && !loadedOk;
  const unavailable =
    (!loaded && (!item.previewable || entry?.state === "none" || gaveUp(entry))) || viewerDown;
  // When the viewer is down, drop the frame and its URL; once it's back, the card asks for a fresh
  // URL and loads again like any other card.
  useEffect(() => {
    if (!viewerDown) return;
    setSrc(null);
    setLoaded(false);
  }, [viewerDown]);
  // A turn that can't be used goes to the next card.
  useEffect(() => {
    if (unavailable && granted) release();
  }, [unavailable, granted, release]);

  return (
    <div
      ref={boxRef}
      data-preview-box
      className="relative overflow-hidden border-b border-border bg-surface-muted"
      style={{ aspectRatio: `1 / ${shape.ratio}` }}
    >
      {unavailable ? (
        <NoPreview name={item.sender.name} domain={item.sender.domain} />
      ) : (
        <>
          {!loaded ? <div aria-hidden className="skeleton absolute inset-0 rounded-none" /> : null}
          {src ? (
            <div
              aria-hidden
              className="absolute top-0 left-0 origin-top-left overflow-hidden"
              style={{
                width: crop.renderWidth,
                height: layout.frameHeight,
                transform: `translateX(${-crop.cropX * layout.scale}px) scale(${layout.scale})`,
              }}
            >
              <iframe
                src={src}
                title={`Email from ${item.sender.name}`}
                sandbox={EMAIL_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                tabIndex={-1}
                scrolling="no"
                onLoad={() => {
                  setLoaded(true);
                  release();
                }}
                className={cn(
                  "pointer-events-none block border-0 bg-white transition-opacity duration-300 select-none",
                  // Hidden (and, when rendered on the server, not yet measured) until it has loaded.
                  loaded && box.width > 0 ? "opacity-100" : "opacity-0",
                )}
                style={{ width: crop.renderWidth, height: layout.frameHeight }}
              />
            </div>
          ) : null}
          {shape.capped && loaded ? <LongEmailFade /> : null}
        </>
      )}
    </div>
  );
}

/** The bottom of a very long email's card: it fades out, and says there's more. */
function LongEmailFade() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 flex h-20 items-end justify-center bg-gradient-to-t from-surface via-surface/80 to-transparent pb-2"
    >
      <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground shadow-xs ring-1 ring-border">
        <ChevronsDown className="size-3" />
        Long email
      </span>
    </div>
  );
}

function NoPreview({ name, domain }: { name: string; domain: string | null }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-muted px-3 text-center">
      <SenderAvatar name={name} domain={domain} size="lg" className="rounded-full" />
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <ImageOff className="size-3.5" aria-hidden />
        Preview unavailable
      </span>
    </div>
  );
}

/** Why, in one line (scored cards only): already plain and specific from the server. */
function ReasonLine({ item }: { item: GalleryItem }) {
  const reason = item.verdict === "unscored" ? null : item.reason;
  if (!reason?.text) return <p className="h-8" aria-hidden />;
  const Icon = reason.kind === "strength" ? Check : X;
  return (
    <p className="flex h-8 items-start gap-1.5 overflow-hidden text-xs leading-4 text-muted-foreground">
      <Icon
        aria-hidden
        strokeWidth={2.75}
        className={cn(
          "mt-0.5 size-3 shrink-0",
          reason.kind === "strength" ? "text-band-excellent" : "text-band-poor",
        )}
      />
      <span className="line-clamp-2">
        <span className="sr-only">{reason.kind === "strength" ? "Strength: " : "Problem: "}</span>
        {reason.text}
      </span>
    </p>
  );
}

/**
 * Not scored yet: when the score comes, in the verdict's place and the same room (badge + one
 * line), so the card keeps its size when the score arrives.
 */
function WaitingLine({ item }: { item: GalleryItem }) {
  const { line, pending } = useWaitingCopy(item.waiting);
  return (
    <>
      <div className="flex h-6">
        <WaitingBadge waiting={item.waiting} />
      </div>
      <p
        className={cn(
          "h-8 overflow-hidden text-xs leading-4 text-muted-foreground",
          pending && "invisible",
        )}
      >
        <span className="line-clamp-2">{line}</span>
      </p>
    </>
  );
}

/**
 * One email design: a live preview of the whole email, who sent it and when, and — once scored —
 * the verdict and why (before that, when the score comes). The subject isn't printed (the design speaks for itself); it's in the card's
 * accessible name and its tooltip. The whole card is one button, laid over the content (an iframe
 * can't sit inside a button). `similar` = how many near-identical designs (same template sent
 * again) this card stands for.
 */
export const GalleryCard = memo(function GalleryCard({
  item,
  similar = 0,
  eager = false,
  onOpen,
}: {
  item: GalleryItem;
  similar?: number;
  /** Its preview URL came with the page: the frame is in the server HTML (see CardPreview). */
  eager?: boolean;
  onOpen: (id: string) => void;
}) {
  const subject = item.subject?.trim() || "(no subject)";
  const metaId = `card-${item.id}-meta`;
  const scored = item.verdict !== "unscored";
  return (
    <div
      data-gallery-card
      // isolate: the Save button's and the card button's z-index stay inside the card, so a card
      // scrolled under the sticky filter bar never pokes through it.
      className="group relative isolate flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs transition-[box-shadow,transform,border-color] duration-200 ease-out hover:border-border-strong hover:shadow-overlay motion-safe:hover:-translate-y-0.5">
      <CardPreview item={item} eager={eager} />
      {similar > 0 ? (
        <span className="pointer-events-none absolute top-2 left-2 z-[5] inline-flex h-6 items-center gap-1 rounded-full bg-[oklch(0.2_0.01_270/0.78)] px-2 text-xs font-medium text-white shadow-sm ring-1 ring-black/5 backdrop-blur-sm">
          <Layers aria-hidden className="size-3" />+{similar} similar
        </span>
      ) : null}
      <div id={metaId} className="space-y-2 p-3">
        <div className="flex h-5 items-center gap-2">
          <SenderAvatar
            name={item.sender.name}
            domain={item.sender.domain}
            size="xs"
            className="rounded-full"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {item.sender.name}
          </span>
          <Time
            iso={item.receivedAt}
            variant="list"
            withTitle={false}
            className="shrink-0 text-xs text-subtle-foreground tabular"
          />
        </div>
        {scored ? (
          <>
            <div className="flex h-6">
              <VerdictBadge verdict={item.verdict} score={item.score} />
            </div>
            <ReasonLine item={item} />
          </>
        ) : (
          <WaitingLine item={item} />
        )}
        {similar > 0 ? (
          <span className="sr-only">
            {`, and ${similar} similar ${similar === 1 ? "design" : "designs"} from the same sender`}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        data-card-id={item.id}
        onClick={() => onOpen(item.id)}
        aria-label={`Open ${item.sender.name} — ${subject}`}
        aria-describedby={metaId}
        title={subject}
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />
      {/* After the card's button (Tab: open, then save) and above it (z-20), so a click saves
          instead of opening the design. */}
      <SaveToBoard emailId={item.id} saved={item.saved === true} className="absolute top-2 right-2 z-20" />
    </div>
  );
});

/** A card-shaped placeholder while a page loads (same box, so nothing jumps when it arrives). */
export function GalleryCardSkeleton() {
  return (
    <li aria-hidden className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
      <div className={cn("skeleton rounded-none", PREVIEW_BOX)} />
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <div className="skeleton size-5 rounded-full" />
          <div className="skeleton h-3.5 flex-1 rounded" />
        </div>
        <div className="skeleton h-4 w-3/4 rounded" />
        <div className="skeleton h-6 w-20 rounded-full" />
        <div className="skeleton h-8 rounded" />
      </div>
    </li>
  );
}
