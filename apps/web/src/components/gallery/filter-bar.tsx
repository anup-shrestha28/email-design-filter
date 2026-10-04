"use client";
import { Bookmark, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import {
  GALLERY_CATEGORIES,
  GALLERY_CHIP_IDS,
  GALLERY_SORTS,
  advancedFilterCount,
  type GalleryCategory,
  type GalleryDesign,
  type GalleryParams,
  type GalleryPatch,
  type GallerySort,
} from "@/lib/gallery";
import type { GalleryFacets } from "@/server/queries/types";
import { FiltersButton, FiltersPanel } from "./gallery-filters";
import { GallerySearch } from "./gallery-search";

/**
 * Each category's colour dot (the type-group tokens in globals.css). Social and Notifications are
 * the inbox's one "Notifications" group, and Welcome (lifecycle mail) sits in its "Updates" group
 * with product updates, so a colour means the same kind of mail here as in the inbox.
 */
const CATEGORY_DOT: Record<Exclude<GalleryCategory, "all">, string> = {
  promotions: "var(--tg-promotions)",
  newsletters: "var(--tg-newsletters)",
  social: "var(--tg-notifications)",
  notifications: "var(--tg-notifications)",
  welcome: "var(--tg-updates)",
  product_updates: "var(--tg-updates)",
  events: "var(--tg-events)",
  abandoned_cart: "var(--tg-security)",
  receipts: "var(--tg-orders)",
  other: "var(--tg-other)",
};

/** "All" alone is ambiguous next to the Design control: the category chip says what it covers. */
const CHIP_LABEL: Partial<Record<GalleryCategory, string>> = { all: "All types" };

/** Sort names that read as a complete phrase in the closed select. */
const SORT_LABEL: Record<GallerySort, string> = {
  newest: "Newest first",
  best: "Best design first",
  worst: "Worst design first",
};

const ANY_FONT = "__any";

type Patch = GalleryPatch;

/**
 * Phones: the chips scroll sideways in one line, with arrow buttons at the edges whenever more
 * chips are hidden that way. From tablets up they wrap, so every category is always visible.
 */
function ChipRow({ children, busy }: { children: React.ReactNode; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);
  const scrollBy = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.7, behavior: "smooth" });
  return (
    <div className="relative -mx-4 min-w-0 sm:mx-0 lg:flex-[1_1_36rem]">
      <div
        ref={ref}
        role="group"
        aria-label="Email type"
        aria-busy={busy}
        className={cn(
          "scrollbar-none flex gap-2 overflow-x-auto px-4 sm:flex-wrap sm:overflow-visible sm:px-0",
          edges.right &&
            "[mask-image:linear-gradient(to_right,black_calc(100%-3.5rem),transparent)] sm:[mask-image:none]",
        )}
      >
        {children}
      </div>
      {edges.left ? <EdgeButton side="left" onClick={() => scrollBy(-1)} /> : null}
      {edges.right ? <EdgeButton side="right" onClick={() => scrollBy(1)} /> : null}
    </div>
  );
}

function EdgeButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      className={cn(
        "absolute top-0 flex size-8 items-center justify-center rounded-full border border-border bg-surface text-foreground shadow-raised sm:hidden",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

/**
 * The only controls on the gallery: the email-type chips, Design (Any / Good / Bad), font, sort,
 * the Filters button (score, date, senders, problems, mailbox, web fonts) and — on phones — the
 * search. Every change lands in the URL and can be undone with the browser's Back button.
 * While `stale` (a change is loading) the choices already show the new state but the counts are
 * still the old filters', so the counts are dimmed until the new ones arrive.
 */
export function FilterBar({
  params,
  facets,
  onChange,
  onReset,
  activeCount,
  stale = false,
}: {
  params: GalleryParams;
  facets: GalleryFacets;
  onChange: (patch: Patch) => void;
  onReset: () => void;
  activeCount: number;
  stale?: boolean;
}) {
  // The shown categories only (lib/gallery.ts GALLERY_SHOWN_CATEGORIES), in chip order.
  const chips = GALLERY_CATEGORIES.filter(
    (c): c is (typeof GALLERY_CATEGORIES)[number] & { id: (typeof GALLERY_CHIP_IDS)[number] } =>
      (GALLERY_CHIP_IDS as readonly string[]).includes(c.id) &&
      (c.id === "all" || c.id === params.category || facets.categories[c.id] > 0),
  );
  const saved = params.saved === "1";
  // While stale the font counts would be the old filters', so the menu shows names only.
  const withCount = (name: string, n: number) => (stale ? name : `${name} (${formatNumber(n)})`);
  const fontOptions = [
    { value: ANY_FONT, label: "Any font" },
    ...facets.fonts.map((f) => ({ value: f.name, label: withCount(f.name, f.count) })),
  ];
  // A font from a shared link that isn't in this view's list still shows as selected.
  if (
    params.font &&
    !facets.fonts.some((f) => f.name.toLowerCase() === params.font!.toLowerCase())
  ) {
    fontOptions.push({ value: params.font, label: withCount(params.font, 0) });
  }
  // Phones: font and sort sit in the Filters panel too, so the first design starts higher up.
  const [panelOpen, setPanelOpen] = useState(false);
  const advanced = advancedFilterCount(params);
  const phoneCount = advanced + (params.font !== null ? 1 : 0) + (params.sort !== "newest" ? 1 : 0);
  const fontValue = params.font
    ? (facets.fonts.find((f) => f.name.toLowerCase() === params.font!.toLowerCase())?.name ??
      params.font)
    : ANY_FONT;

  return (
    // Sticky on wide screens only; below that it scrolls away so the designs get the whole screen.
    <div className="z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 xl:sticky xl:top-0">
      <div className="mx-auto max-w-[1760px] space-y-3 px-4 py-3 sm:px-6 lg:flex lg:flex-wrap lg:items-start lg:gap-x-6 lg:gap-y-3 lg:space-y-0 lg:px-8">
        <GallerySearch className="md:hidden" />
        <ChipRow busy={stale}>
          {chips.map((c) => {
            // "Saved" shows every saved design, whatever its type: no type chip is on then.
            const on = params.category === c.id && !saved;
            const count = facets.categories[c.id] ?? 0;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ category: c.id === "all" ? null : c.id, saved: null })}
                className={cn(
                  "relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  on
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-surface text-foreground hover:bg-surface-muted",
                )}
              >
                {c.id !== "all" ? (
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ background: CATEGORY_DOT[c.id] }}
                  />
                ) : null}
                {CHIP_LABEL[c.id] ?? c.label}
                <Count n={count} stale={stale} />
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={saved}
            onClick={() => onChange(saved ? { saved: null } : { saved: "1", category: null })}
            className={cn(
              "relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              saved
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-surface text-foreground hover:bg-surface-muted",
            )}
          >
            <Bookmark aria-hidden className="size-3.5" />
            Saved
            <Count n={facets.saved} stale={stale} />
          </button>
        </ChipRow>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
          <div
            role="group"
            aria-labelledby="gallery-design-label"
            aria-busy={stale}
            className="flex w-full items-center gap-2 sm:w-auto"
          >
            <span
              id="gallery-design-label"
              className="shrink-0 text-sm font-medium text-muted-foreground"
            >
              Design:
            </span>
            <SegmentedControl<GalleryDesign>
              aria-label="Design"
              value={params.design}
              onValueChange={(v) => onChange({ design: v === "all" ? null : v })}
              className="min-w-0 flex-1 sm:flex-none [&>button]:h-7 [&>button]:flex-1"
              options={[
                {
                  value: "all",
                  label: (
                    <>
                      Any <Count n={facets.design.all} stale={stale} />
                    </>
                  ),
                },
                {
                  value: "good",
                  label: (
                    <>
                      <Check aria-hidden strokeWidth={3} className="text-band-excellent" /> Good{" "}
                      <Count n={facets.design.good} stale={stale} />
                    </>
                  ),
                },
                {
                  value: "bad",
                  label: (
                    <>
                      <X aria-hidden strokeWidth={3} className="text-band-poor" /> Bad{" "}
                      <Count n={facets.design.bad} stale={stale} />
                    </>
                  ),
                },
              ]}
            />
            <FiltersButton
              compact
              count={phoneCount}
              onClick={() => setPanelOpen(true)}
              className="sm:hidden"
            />
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <Select<string>
              aria-label="Font"
              value={fontValue}
              onValueChange={(v) => onChange({ font: v === ANY_FONT ? null : v })}
              options={fontOptions}
              className="h-8 min-w-0 flex-1 text-sm sm:max-w-[12rem] sm:min-w-[9rem] sm:flex-none"
            />
            <Select<GallerySort>
              aria-label="Sort"
              value={params.sort}
              onValueChange={(v) => onChange({ sort: v === "newest" ? null : v })}
              options={GALLERY_SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
              className="h-8 min-w-0 flex-1 text-sm sm:min-w-[10.5rem] sm:flex-none"
            />
            <FiltersButton count={advanced} onClick={() => setPanelOpen(true)} />
          </div>
          {activeCount > 0 ? (
            <button
              type="button"
              onClick={onReset}
              className="h-8 shrink-0 rounded-md px-2 text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>
      <FiltersPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        params={params}
        facets={facets}
        onApply={onChange}
        stale={stale}
      />
    </div>
  );
}

/**
 * A count badge, in its label's own colour but lighter weight, so it reads at full contrast (a
 * faded count fell to 2.6:1 on the Design control); faint only while it still belongs to the
 * previous filters (`stale`, a moment while the new counts load).
 */
function Count({ n, stale }: { n: number; stale: boolean }) {
  return (
    <span className={cn("text-xs font-normal tabular transition-opacity", stale && "opacity-25")}>
      {formatNumber(n)}
    </span>
  );
}
