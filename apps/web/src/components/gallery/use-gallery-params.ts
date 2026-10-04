"use client";
import {
  parseAsArrayOf,
  parseAsInteger,
  parseAsNumberLiteral,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
  useQueryStates,
} from "nuqs";
import { useTransition } from "react";
import {
  GALLERY_CHIP_IDS,
  GALLERY_DATES,
  GALLERY_DESIGNS,
  GALLERY_PAGE_SIZES,
  GALLERY_PROBLEMS,
  GALLERY_SORTS,
  GALLERY_WEB_FONTS,
  advancedFilterCount,
  parseGalleryParams,
  type GalleryParams,
} from "@/lib/gallery";

/**
 * The gallery's filters in the URL (the same keys and defaults as lib/gallery.ts). An invalid value
 * falls back to its own default; the other fields are kept. Defaults stay out of the URL.
 */
export const galleryParsers = {
  category: parseAsStringLiteral(GALLERY_CHIP_IDS).withDefault("all"),
  design: parseAsStringLiteral(GALLERY_DESIGNS).withDefault("all"),
  font: parseAsString,
  q: parseAsString.withDefault(""),
  sort: parseAsStringLiteral(GALLERY_SORTS).withDefault("newest"),
  page: parseAsInteger.withDefault(1),
  size: parseAsNumberLiteral(GALLERY_PAGE_SIZES).withDefault(GALLERY_PAGE_SIZES[0]),
  smin: parseAsInteger.withDefault(0),
  smax: parseAsInteger.withDefault(100),
  date: parseAsStringLiteral(GALLERY_DATES).withDefault("any"),
  since: parseAsString,
  until: parseAsString,
  // Lists are comma-separated, exactly as galleryHref writes them.
  sender: parseAsArrayOf(parseAsString).withDefault([]),
  problem: parseAsArrayOf(parseAsStringLiteral(GALLERY_PROBLEMS)).withDefault([]),
  mailbox: parseAsString,
  webfonts: parseAsStringLiteral(GALLERY_WEB_FONTS).withDefault("any"),
  board: parseAsString,
  saved: parseAsStringLiteral(["1"] as const),
};

/**
 * Filter changes re-render the server page (new first page and counts) inside a transition. Each
 * change is its own history entry ("push"), so the browser's Back button undoes the last filter;
 * the search box passes `history: "replace"` for the keystrokes after the first (see
 * gallery-search.tsx), so a typed word is one entry, not one per letter.
 */
export function useGalleryParams() {
  const [pending, startTransition] = useTransition();
  const [params, setParams] = useQueryStates(galleryParsers, {
    shallow: false,
    clearOnDefault: true,
    scroll: false,
    history: "push",
    startTransition,
  });
  // The server's own normalisation (lib/gallery.ts), so the page and the controls always agree —
  // e.g. an over-long hand-made ?q= is ignored by both rather than applied by one.
  const normalized: GalleryParams = parseGalleryParams(params);
  return { params: normalized, setParams, pending };
}

/** The open card (`?open=<id>`): a shallow URL change, so opening a card never refetches the page. */
export function useOpenCard() {
  return useQueryState("open", parseAsString.withOptions({ shallow: true, scroll: false }));
}

export function activeFilterCount(p: GalleryParams): number {
  return (
    (p.category !== "all" ? 1 : 0) +
    (p.design !== "all" ? 1 : 0) +
    (p.font ? 1 : 0) +
    (p.q ? 1 : 0) +
    (p.sort !== "newest" ? 1 : 0) +
    (p.saved ? 1 : 0) +
    advancedFilterCount(p)
  );
}
