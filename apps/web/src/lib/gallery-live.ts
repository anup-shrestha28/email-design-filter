/**
 * The live gallery's rules (client-safe, pure; unit-tested): what a change means for the page on
 * screen, and when it may be shown without asking. Used by components/gallery/live-updates.tsx
 * with the server's check (server/actions/gallery-live.ts).
 *
 * Never reshuffle the grid under the viewer:
 *  - new designs in this view → "N new designs · Show" (applied by itself only on page 1 of
 *    Newest, scrolled to the top, nothing open, the pointer and focus off the grid);
 *  - designs that may move (a score changed while the view sorts or filters by score, font or
 *    type; a design left or joined the view) → "Designs updated · Show" (applied by itself only at
 *    the top, nothing open, pointer and focus off the grid);
 *  - anything else (scores or "when it's scored" of designs on screen, counts in the filters)
 *    changes nothing's place → refreshed in place at once, the open design and the scroll kept;
 *    unless two cards on the page could merge or split ("+N similar" groups follow the verdict),
 *    then only once the pointer and focus are off the grid.
 */
import { similarKey } from "./gallery-display";
import type { GalleryParams } from "./gallery";

export interface GalleryStamp {
  /** Designs in the gallery (every filter off). */
  total: number;
  /** When the newest of them arrived in the app (email.created_at, Postgres text), or null. */
  newest: string | null;
  /** How many of them have a score. */
  scored: number;
  /** How many still wait for their email type (AI classification can move them between categories). */
  typing: number;
  /** The latest analysis save: a render, a template upgrade, an AI review or a new email. */
  analyzedAt: string | null;
  /** The latest render-request change (a render starting, finishing or failing). */
  renderAt: string | null;
}

/** Same stamp: nothing the gallery shows has changed. */
export function sameStamp(a: GalleryStamp, b: GalleryStamp): boolean {
  return (
    a.total === b.total &&
    a.newest === b.newest &&
    a.scored === b.scored &&
    a.typing === b.typing &&
    a.analyzedAt === b.analyzedAt &&
    a.renderAt === b.renderAt
  );
}

/** The page view's counts, sent by the check when the stamp moved. */
export interface ViewChange {
  /** Designs in the view now. */
  total: number;
  /** Designs in the view that arrived after the page's stamp. */
  added: number;
  /** Designs in the view since before the page's stamp whose analysis changed (a new score). */
  rescored: number;
}

export type LiveChange = { kind: "new"; added: number } | { kind: "moved" } | { kind: "inplace" };

/**
 * A view where a new score can't move a card: newest first, and no filter that reads the score,
 * the verdict, the problems or the measured fonts (a render replaces the declared fonts).
 */
export function scoreStableView(p: GalleryParams): boolean {
  return (
    p.sort === "newest" &&
    p.design === "all" &&
    p.smin === 0 &&
    p.smax === 100 &&
    p.problem.length === 0 &&
    !p.font &&
    p.webfonts === "any"
  );
}

/** What a changed stamp means for the page rendered with `base` (null: nothing to do). */
export function classifyChange(
  base: { stamp: GalleryStamp; total: number },
  now: { stamp: GalleryStamp; view: ViewChange },
  params: GalleryParams,
): LiveChange | null {
  if (sameStamp(base.stamp, now.stamp)) return null;
  const { view } = now;
  if (view.added > 0) return { kind: "new", added: view.added };
  // The view's size changed with nothing new: a design left it (deleted, trashed, muted) or joined
  // it (un-hidden, or a new email type moved it into this category).
  if (view.total !== base.total) return { kind: "moved" };
  if (view.rescored > 0 && !scoreStableView(params)) return { kind: "moved" };
  if (now.stamp.typing !== base.stamp.typing && params.category !== "all") return { kind: "moved" };
  return { kind: "inplace" };
}

/** Two cards on the page could merge or split when a verdict changes ("+N similar" groups). */
export function regroupRisk(items: ReadonlyArray<Parameters<typeof similarKey>[0]>): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.subject?.trim()) continue; // never grouped
    const key = similarKey(item).replace(/\|[^|]*$/, ""); // without the verdict
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export interface ViewerState {
  page: number;
  sort: GalleryParams["sort"];
  /** Scrolled (nearly) to the top of the gallery. */
  atTop: boolean;
  /** A design is open (the detail view). */
  open: boolean;
  /** The pointer is over the grid, or focus is inside it. */
  onGrid: boolean;
  /** Cards on this page could regroup (regroupRisk). */
  regroup: boolean;
}

/** Apply now, show the pill, or (in-place changes) wait until the pointer and focus leave the grid. */
export function applyMode(change: LiveChange, v: ViewerState): "apply" | "pill" | "defer" {
  if (change.kind === "inplace") return !v.regroup || !v.onGrid ? "apply" : "defer";
  const calm = v.atTop && !v.open && !v.onGrid;
  if (change.kind === "moved") return calm ? "apply" : "pill";
  return calm && v.page === 1 && v.sort === "newest" ? "apply" : "pill";
}

/** The pill's words. */
export function pillText(change: LiveChange): string {
  if (change.kind === "new")
    return change.added === 1
      ? "1 new design"
      : `${change.added.toLocaleString("en-US")} new designs`;
  return "Designs updated";
}
