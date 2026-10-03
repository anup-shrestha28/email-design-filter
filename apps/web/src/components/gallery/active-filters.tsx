"use client";
import { X } from "lucide-react";
import { useMemo } from "react";
import {
  activeFilterChips,
  senderChipLabels,
  type GalleryParams,
  type GalleryPatch,
} from "@/lib/gallery";
import type { GalleryFacets } from "@/server/queries/types";

/**
 * The Filters-panel filters that are on, as removable chips ("Score 60–100 ×", "Last 30 days ×",
 * "LinkedIn ×"), with "Clear all". Nothing at all when none is on.
 */
export function ActiveFilters({
  params,
  facets,
  onChange,
  onClearAll,
}: {
  params: GalleryParams;
  facets: GalleryFacets;
  onChange: (patch: GalleryPatch) => void;
  onClearAll: () => void;
}) {
  const chips = useMemo(
    () =>
      activeFilterChips(params, {
        senders: senderChipLabels(facets.senders),
        mailboxes: new Map(facets.mailboxes.map((m) => [m.id, m.address])),
        boards: new Map(facets.boards.map((b) => [b.id, b.name])),
      }),
    [params, facets.senders, facets.mailboxes, facets.boards],
  );
  if (chips.length === 0) return null;
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Active filters"
    >
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.remove)}
          aria-label={`Remove filter: ${c.label}`}
          className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent-soft pr-1.5 pl-3 text-[0.8125rem] font-medium text-accent-soft-foreground transition-colors hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="truncate">{c.label}</span>
          <X className="size-3.5 shrink-0" aria-hidden />
        </button>
      ))}
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="h-7 rounded-md px-2 text-[0.8125rem] font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
