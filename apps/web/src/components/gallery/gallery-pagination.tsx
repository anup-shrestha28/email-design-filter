"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { GALLERY_PAGE_SIZES, pageWindow, type GalleryPageSize } from "@/lib/gallery";

/** 36 px tall on phones, 32 px wide: Prev, 1 … 4 5 6 … 12, Next fit in 343 px (a 375 px phone). */
const cell =
  "inline-flex h-9 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium tabular transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-8";

/**
 * Numbered pages under the grid: Prev / Next and the page numbers (1 … 4 5 6 … 12), plus how many
 * designs a page shows. Plain buttons, so Tab / Enter / Space work as everywhere else.
 */
export function GalleryPagination({
  page,
  pageCount,
  size,
  onPage,
  onSize,
  className,
}: {
  page: number;
  pageCount: number;
  size: GalleryPageSize;
  onPage: (page: number) => void;
  onSize: (size: GalleryPageSize) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 sm:flex-row sm:justify-between sm:gap-4",
        className,
      )}
    >
      {pageCount > 1 ? (
        <nav aria-label="Pages" className="w-full sm:w-auto">
          <ul className="flex items-center justify-center gap-1">
            <li>
              <button
                type="button"
                onClick={() => onPage(page - 1)}
                disabled={page <= 1}
                aria-label="Previous page"
                className={cn(
                  cell,
                  "gap-1 border border-border bg-surface text-foreground hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-40",
                )}
              >
                <ChevronLeft className="size-4" aria-hidden />
                <span className="hidden sm:inline">Prev</span>
              </button>
            </li>
            {pageWindow(page, pageCount).map((n, i) =>
              n === "gap" ? (
                <li key={`gap${i}`} aria-hidden className="px-0.5 text-sm text-subtle-foreground">
                  …
                </li>
              ) : (
                <li key={n}>
                  <button
                    type="button"
                    onClick={() => onPage(n)}
                    aria-label={`Page ${n}`}
                    aria-current={n === page ? "page" : undefined}
                    className={cn(
                      cell,
                      n === page
                        ? "bg-foreground text-background"
                        : "text-foreground hover:bg-surface-muted",
                    )}
                  >
                    {n}
                  </button>
                </li>
              ),
            )}
            <li>
              <button
                type="button"
                onClick={() => onPage(page + 1)}
                disabled={page >= pageCount}
                aria-label="Next page"
                className={cn(
                  cell,
                  "gap-1 border border-border bg-surface text-foreground hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-40",
                )}
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </li>
          </ul>
        </nav>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span aria-hidden>Designs per page</span>
        <Select<string>
          aria-label="Designs per page"
          value={String(size)}
          onValueChange={(v) => onSize(Number(v) as GalleryPageSize)}
          options={GALLERY_PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
          className="h-8 min-w-[4.5rem] text-sm"
        />
      </div>
    </div>
  );
}
