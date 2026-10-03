"use client";
import { ArrowUp, Plug, SearchX, Sparkles, ThumbsUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { preconnect } from "react-dom";
import { toast } from "sonner";
import { Button, LinkButton } from "@/components/ui/button";
import { useSync } from "@/components/providers/sync";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import {
  CLEAR_ADVANCED,
  pageBounds,
  type GalleryPageSize,
  type GalleryParams,
  type GalleryPatch,
} from "@/lib/gallery";
import type { GalleryFacets, GalleryPage } from "@/server/queries/types";
import { ActiveFilters } from "./active-filters";
import { FilterBar } from "./filter-bar";
import { groupSimilar } from "@/lib/gallery-display";
import { GalleryCard, scrollRoot, shapeOf } from "./gallery-card";
import { GalleryDetail } from "./gallery-detail";
import { GalleryPagination } from "./gallery-pagination";
import { LiveSlot } from "./live-updates";
import { Masonry } from "./masonry";
import { PreviewUrlProvider, type SeedUrls } from "./preview-urls";
import {
  activeFilterCount,
  galleryParsers,
  useGalleryParams,
  useOpenCard,
} from "./use-gallery-params";

/**
 * Few, large cards, so each design can be read at a glance: 1 column on phones, 2 on tablets, 3 on
 * small laptops, 4 on desktops (5 on very wide screens), in a Pinterest-style masonry (masonry.tsx):
 * each card is its email's own shape — the whole design, or the top of a very long one — so short
 * and long designs sit together without gaps. The full design is one click away in the detail
 * view (gallery-detail.tsx).
 */
/** The gallery's page width (shared by the filter bar, so both line up). */
export const GALLERY_WIDTH = "mx-auto max-w-[1760px] px-4 sm:px-6 lg:px-8";

/** Every URL field back to its default (the "Clear filters" buttons; page size is kept). */
const RESET_ALL = Object.fromEntries(
  Object.keys(galleryParsers)
    .filter((k) => k !== "size")
    .map((k) => [k, null]),
) as GalleryPatch;

/**
 * The gallery: the design grid is on screen the moment the app opens. The controls are the filters,
 * the page numbers and the cards; a card opens its detail (a modal, `?open=<id>` in the URL).
 */
export function GalleryView({
  params: serverParams,
  page,
  facets,
  previewSeed,
}: {
  params: GalleryParams;
  page: GalleryPage;
  facets: GalleryFacets;
  /** Preview URLs minted with the page for the first screen of cards. */
  previewSeed?: SeedUrls | null;
}) {
  const { params, setParams, pending } = useGalleryParams();
  const hasMailbox = useSync().status.mailboxes.length > 0;
  const active = activeFilterCount(serverParams);
  // The choices on screen are ahead of the designs and counts until the server answers (whichever
  // control changed the URL, the search box included): everything they'd contradict is dimmed.
  const stale = pending || JSON.stringify(params) !== JSON.stringify(serverParams);
  /** Set when the viewer turned the page, so focus follows to the new results once they arrive. */
  const focusResults = useRef(false);

  // Any filter change starts again from page 1.
  const onChange = useCallback(
    (patch: GalleryPatch) => {
      void setParams({ ...patch, page: null });
      scrollRoot()?.scrollTo({ top: 0 });
    },
    [setParams],
  );
  const onReset = useCallback(() => {
    void setParams(RESET_ALL);
    scrollRoot()?.scrollTo({ top: 0 });
  }, [setParams]);
  const onClearAdvanced = useCallback(() => onChange(CLEAR_ADVANCED), [onChange]);
  const onPage = useCallback(
    (n: number) => {
      focusResults.current = true;
      void setParams({ page: n <= 1 ? null : n });
      scrollRoot()?.scrollTo({ top: 0 });
    },
    [setParams],
  );
  const onSize = useCallback(
    (size: GalleryPageSize) => {
      void setParams({ size, page: null });
      scrollRoot()?.scrollTo({ top: 0 });
    },
    [setParams],
  );

  // The viewer origin serves every preview: connect to it while the page is still arriving.
  const firstUrl = previewSeed ? Object.values(previewSeed.urls)[0] : undefined;
  if (firstUrl) preconnect(new URL(firstUrl).origin);

  // The results belong to the params the server rendered; new params start a new list.
  const key = JSON.stringify(serverParams);

  return (
    <PreviewUrlProvider seed={previewSeed}>
      <FilterBar
        params={params}
        facets={facets}
        onChange={onChange}
        onReset={onReset}
        activeCount={activeFilterCount(params)}
        stale={stale}
      />
      <div className={cn(GALLERY_WIDTH, "pt-4 pb-16")}>
        <LiveSlot />
        <ActiveFilters
          params={serverParams}
          facets={facets}
          onChange={onChange}
          onClearAll={onClearAdvanced}
        />
        <Results
          key={key}
          params={serverParams}
          page={page}
          facets={facets}
          hasMailbox={hasMailbox}
          active={active}
          onReset={onReset}
          onPage={onPage}
          onSize={onSize}
          focusResults={focusResults}
          stale={stale}
          seed={previewSeed ?? null}
        />
      </div>
    </PreviewUrlProvider>
  );
}

function ResultLine({
  facets,
  params,
  page,
  cards,
  stale,
  focusRef,
}: {
  facets: GalleryFacets;
  params: GalleryParams;
  page: GalleryPage;
  /** Cards on this page: fewer than its designs when near-identical ones are collapsed into one. */
  cards: number;
  /** New filters are loading: these numbers are still the old ones. */
  stale: boolean;
  focusRef: React.Ref<HTMLParagraphElement>;
}) {
  const { good, bad } = facets.design;
  const { first, last } = pageBounds(page.page, page.pageSize, page.total);
  const noun = `${params.design === "all" ? "" : `${params.design} `}${page.total === 1 ? "design" : "designs"}`;
  return (
    <p
      ref={focusRef}
      tabIndex={-1}
      className={cn(
        "mb-4 text-sm text-muted-foreground outline-none transition-opacity",
        stale && "opacity-40",
      )}
      aria-live="polite"
      aria-busy={stale}
    >
      {page.pageCount > 1 ? (
        <>
          Showing{" "}
          <span className="font-medium text-foreground tabular">
            {formatNumber(first)}–{formatNumber(last)}
          </span>{" "}
          of <span className="font-medium text-foreground tabular">{formatNumber(page.total)}</span>{" "}
          {noun}
        </>
      ) : (
        <>
          <span className="font-medium text-foreground tabular">{formatNumber(page.total)}</span>{" "}
          {noun}
        </>
      )}
      {/* Only the parts that say something: "1 design · 0 good · 0 bad" reads as noise. */}
      {params.design === "all" && good > 0 ? (
        <>
          {" · "}
          <span className="tabular">{formatNumber(good)}</span> good
        </>
      ) : null}
      {params.design === "all" && bad > 0 ? (
        <>
          {" · "}
          <span className="tabular">{formatNumber(bad)}</span> bad
        </>
      ) : null}
      {/* The range counts designs; say so when this page shows them as fewer cards. */}
      {cards < page.items.length ? (
        <>
          {" · shown as "}
          <span className="tabular">{formatNumber(cards)}</span> {cards === 1 ? "card" : "cards"},
          similar ones grouped
        </>
      ) : null}
    </p>
  );
}

function Results({
  params,
  page,
  facets,
  hasMailbox,
  active,
  onReset,
  onPage,
  onSize,
  focusResults,
  stale,
  seed,
}: {
  params: GalleryParams;
  page: GalleryPage;
  facets: GalleryFacets;
  hasMailbox: boolean;
  active: number;
  onReset: () => void;
  onPage: (page: number) => void;
  onSize: (size: GalleryPageSize) => void;
  focusResults: React.RefObject<boolean>;
  stale: boolean;
  /** The first screen's preview URLs, minted with the page: those cards load eagerly. */
  seed: SeedUrls | null;
}) {
  const eager = useMemo(() => new Set(Object.keys(seed?.urls ?? {})), [seed]);
  const items = page.items;

  // After a page change, keyboard and screen-reader users land on the new results.
  const lineRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!focusResults.current) return;
    focusResults.current = false;
    lineRef.current?.focus({ preventScroll: true });
  }, [focusResults]);

  // Near-identical designs (the same template sent again) collapse into one card, "+N similar".
  const groups = useMemo(() => groupSimilar(items), [items]);
  const shown = useMemo(() => groups.map((g) => g.item), [groups]);
  const ratios = useMemo(() => shown.map((i) => shapeOf(i).ratio), [shown]);

  // ── the open card (?open=<id>) ──
  const [openId, setOpenId] = useOpenCard();
  // Prev / next step through the cards as shown on this page; a collapsed design (opened from
  // "+N similar" or a shared link) still opens, and steps from its group's card.
  const itemIndex = useMemo(
    () => (openId ? items.findIndex((i) => i.id === openId) : -1),
    [items, openId],
  );
  const openItem = itemIndex >= 0 ? items[itemIndex]! : null;
  const index = useMemo(() => {
    if (!openItem) return -1;
    const direct = shown.findIndex((i) => i.id === openItem.id);
    if (direct >= 0) return direct;
    return groups.findIndex((g) => g.similar.some((s) => s.id === openItem.id));
  }, [openItem, shown, groups]);

  // A shared or refreshed link to a card that isn't on this page (any more).
  useEffect(() => {
    if (!openId || itemIndex >= 0) return;
    toast.info("That design isn't on this page any more.");
    void setOpenId(null, { history: "replace" });
  }, [openId, itemIndex, setOpenId]);

  // Opening a card adds one history entry (Back closes it). Closing it goes back through that same
  // entry instead of adding another, so history never holds the grid twice. A card that was opened
  // from a shared link (no entry of ours to go back through) closes by replacing the URL. Which
  // card we pushed is also kept for the tab (sessionStorage), so it still holds after a reload or a
  // trip to the full analysis page and back.
  const pushedOpen = useRef<string | null>(null);
  const focusAfterClose = useRef<string | null>(null);
  const open = useCallback(
    (id: string) => {
      pushedOpen.current = id;
      writePushed(id);
      void setOpenId(id, { history: "push" });
    },
    [setOpenId],
  );
  const close = useCallback(() => {
    focusAfterClose.current = openItem ? (shown[index]?.id ?? openItem.id) : null;
    const pushed = openId !== null && (pushedOpen.current === openId || readPushed() === openId);
    pushedOpen.current = null;
    writePushed(null);
    if (pushed) window.history.back();
    else void setOpenId(null, { history: "replace" });
  }, [openId, openItem, shown, index, setOpenId]);
  // The browser's own Back also closes the card; either way the entry we pushed is gone.
  useEffect(() => {
    if (openId) return;
    pushedOpen.current = null;
    writePushed(null);
    const id = focusAfterClose.current;
    focusAfterClose.current = null;
    // Back on the grid, focus returns to the card that was open.
    if (id)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.focus(),
      );
  }, [openId]);
  // Stepping to another card replaces the URL: when the entry is the one we pushed, it still is
  // (now for the new card), so closing afterwards goes back through it instead of leaving the grid
  // in history twice.
  const replaceOpen = useCallback(
    (target: string) => {
      const ours = openId !== null && (pushedOpen.current === openId || readPushed() === openId);
      if (ours) {
        pushedOpen.current = target;
        writePushed(target);
      }
      void setOpenId(target, { history: "replace" });
    },
    [openId, setOpenId],
  );
  const goTo = useCallback(
    (i: number) => {
      const target = shown[i];
      if (target) replaceOpen(target.id);
    },
    [shown, replaceOpen],
  );
  const onPrev = useMemo(() => (index > 0 ? () => goTo(index - 1) : null), [index, goTo]);
  const onNext = useMemo(
    () => (index >= 0 && index < shown.length - 1 ? () => goTo(index + 1) : null),
    [index, shown.length, goTo],
  );
  const openSimilar = useCallback((id: string) => replaceOpen(id), [replaceOpen]);
  const similarForOpen = useMemo(() => {
    if (!openItem || index < 0) return [];
    const g = groups[index];
    return g ? [g.item, ...g.similar] : [];
  }, [openItem, index, groups]);

  const noEmailsAtAll = facets.categories.all === 0 && active === 0;

  return (
    <>
      <ResultLine
        facets={facets}
        params={params}
        page={page}
        cards={groups.length}
        stale={stale}
        focusRef={lineRef}
      />
      {items.length === 0 ? (
        <Empty
          params={params}
          active={active}
          noEmailsAtAll={noEmailsAtAll}
          hasMailbox={hasMailbox}
          onReset={onReset}
        />
      ) : (
        <>
          <Masonry
            items={groups}
            ratios={ratios}
            getKey={(g) => g.item.id}
            label="Email designs"
            busy={stale}
            className={cn("transition-opacity", stale && "opacity-60")}
            renderItem={({ item, similar }) => (
              <GalleryCard
                item={item}
                similar={similar.length}
                eager={eager.has(item.id)}
                onOpen={open}
              />
            )}
          />
          <GalleryPagination
            page={page.page}
            pageCount={page.pageCount}
            size={params.size}
            onPage={onPage}
            onSize={onSize}
            className="pt-10"
          />
        </>
      )}
      <BackToTop />
      <GalleryDetail
        item={openItem}
        open={Boolean(openItem)}
        onClose={close}
        onPrev={onPrev}
        onNext={onNext}
        similar={similarForOpen.length > 1 ? similarForOpen : []}
        onOpenSimilar={openSimilar}
      />
    </>
  );
}

const PUSHED_KEY = "edf-gallery-pushed-open";
/** The card this tab opened with a history push (per-tab; storage may be unavailable). */
function readPushed(): string | null {
  try {
    return sessionStorage.getItem(PUSHED_KEY);
  } catch {
    return null;
  }
}
function writePushed(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(PUSHED_KEY, id);
    else sessionStorage.removeItem(PUSHED_KEY);
  } catch {
    // Private mode / blocked storage: the in-memory ref still covers this visit.
  }
}

function Empty({
  params,
  active,
  noEmailsAtAll,
  hasMailbox,
  onReset,
}: {
  params: GalleryParams;
  active: number;
  noEmailsAtAll: boolean;
  hasMailbox: boolean;
  onReset: () => void;
}) {
  if (noEmailsAtAll) {
    return (
      <EmptyState
        className="py-24"
        icon={<Sparkles aria-hidden />}
        title={
          hasMailbox
            ? "Your designs will appear here as emails arrive."
            : "Connect Gmail to see your email designs."
        }
        action={
          hasMailbox ? null : (
            <LinkButton href="/connect" variant="primary">
              <Plug aria-hidden />
              Connect Gmail
            </LinkButton>
          )
        }
      />
    );
  }
  const onlyDesign = active === 1 && params.design !== "all";
  const title =
    params.design === "bad"
      ? onlyDesign
        ? "No bad designs yet — nice!"
        : "No bad designs here — nice!"
      : params.design === "good"
        ? "No really good designs here yet."
        : "No designs match these filters.";
  return (
    <EmptyState
      className="py-24"
      icon={params.design === "bad" ? <ThumbsUp aria-hidden /> : <SearchX aria-hidden />}
      title={title}
      description={
        params.design === "good"
          ? "Only designs that are really well made get the Good label."
          : undefined
      }
      action={
        <Button variant="secondary" onClick={onReset}>
          Clear filters
        </Button>
      }
    />
  );
}

/** Appears after two screens of scrolling. */
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const root = scrollRoot();
    if (!root) return;
    const onScroll = () => setShow(root.scrollTop > root.clientHeight * 2);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return (
    <IconButton
      label="Back to top"
      icon={<ArrowUp aria-hidden />}
      variant="secondary"
      tooltip={false}
      onClick={() => scrollRoot()?.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed right-6 bottom-6 z-30 size-10 rounded-full shadow-overlay"
    />
  );
}
