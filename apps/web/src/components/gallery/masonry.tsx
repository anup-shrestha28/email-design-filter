"use client";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { masonryColumns } from "@/lib/gallery-preview";

/**
 * Columns per breakpoint — the gallery's grid before (1 on phones, 2 on tablets, 3 on small
 * laptops, 4 on desktops, 5 on very wide screens) — and the gap between cards, in px.
 */
const BREAKPOINTS: ReadonlyArray<{ min: number; columns: number; gap: number }> = [
  { min: 1700, columns: 5, gap: 24 },
  { min: 1280, columns: 4, gap: 24 },
  { min: 1024, columns: 3, gap: 24 },
  { min: 640, columns: 2, gap: 20 },
  { min: 0, columns: 1, gap: 16 },
];
/** The same columns as plain CSS, for the first paint (before the page knows its width). */
export const MASONRY_FALLBACK_GRID =
  "grid grid-cols-1 items-start gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4 min-[1700px]:grid-cols-5";
/**
 * A card's height besides its preview (px): the footer's fixed rows (gallery-card.tsx: p-3 around
 * a 20 px sender line, a 24 px verdict line and a 32 px reason, 8 px apart) plus its borders.
 */
export const CARD_FOOTER_PX = 119;

const QUERIES = BREAKPOINTS.filter((b) => b.min > 0).map((b) => `(min-width: ${b.min}px)`);

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
  }
  const lists = QUERIES.map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener("change", onChange);
  return () => {
    for (const l of lists) l.removeEventListener("change", onChange);
  };
}
function snapshot(): number {
  const w = window.innerWidth;
  return BREAKPOINTS.findIndex((b) => w >= b.min);
}
/** The breakpoint index; null on the server and while hydrating (the CSS grid shows then). */
function useBreakpoint(): number | null {
  return useSyncExternalStore<number | null>(subscribe, snapshot, () => null);
}

/**
 * A Pinterest-style masonry of cards whose heights are known up front (`ratios`: each card's
 * preview height ÷ width): each card goes into the column that's shortest so far, so short and
 * long designs sit together without gaps, and nothing moves once it has loaded. The list stays one
 * list for assistive tech (`role="list"`, each card a `listitem`); reading order is the list's
 * order within each column.
 *
 * Before the page knows its width (server render, hydration) the cards show in a plain CSS grid
 * with the same columns, so the first paint is never empty.
 */
export function Masonry<T>({
  items,
  ratios,
  getKey,
  renderItem,
  label,
  busy,
  className,
}: {
  items: readonly T[];
  /** Preview height ÷ width per item (same order as `items`). */
  ratios: readonly number[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  label: string;
  busy?: boolean;
  className?: string;
}) {
  const bp = useBreakpoint();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const spec = bp === null ? null : BREAKPOINTS[bp]!;
  const columns = useMemo(() => {
    if (!spec) return null;
    const colWidth = width > 0 ? (width - spec.gap * (spec.columns - 1)) / spec.columns : 320;
    return masonryColumns(ratios, spec.columns, colWidth, CARD_FOOTER_PX + spec.gap);
  }, [spec, width, ratios]);

  return (
    <div
      ref={ref}
      role="list"
      aria-label={label}
      aria-busy={busy}
      className={cn(!columns && MASONRY_FALLBACK_GRID, columns && "flex items-start", className)}
      style={columns && spec ? { gap: spec.gap } : undefined}
    >
      {columns && spec
        ? columns.map((col, c) => (
            <div key={c} className="flex min-w-0 flex-1 flex-col" style={{ gap: spec.gap }}>
              {col.map((i) => {
                const item = items[i]!;
                return <MasonryCell key={getKey(item)}>{renderItem(item)}</MasonryCell>;
              })}
            </div>
          ))
        : items.map((item) => <MasonryCell key={getKey(item)}>{renderItem(item)}</MasonryCell>)}
    </div>
  );
}

function MasonryCell({ children }: { children: React.ReactNode }) {
  return (
    <div role="listitem" className="min-w-0">
      {children}
    </div>
  );
}
