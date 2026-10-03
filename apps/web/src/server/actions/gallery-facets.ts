"use server";
/**
 * The Filters panel's counts for choices not applied yet (components/gallery/gallery-filters.tsx):
 * while the panel is open, each change to its draft asks — once the viewer pauses — for the counts
 * that draft would give, so every number in the panel (and "Show N designs") is what pressing the
 * button shows. The same query as the page's own counts (queries/gallery.ts galleryFacets):
 * read-only, the caller's own designs only (RLS), metered like every Server Action. Only asked on a
 * change the viewer makes, never on a timer.
 */
import { parseGalleryParams } from "@/lib/gallery";
import { galleryFacets } from "../queries/gallery";
import type { GalleryFacets } from "../queries/types";
import { requireUserOrThrow } from "../session";

/** The counts for the gallery view `draft` (untrusted: parsed like the gallery's own URL). */
export async function galleryDraftFacets(draft: unknown): Promise<GalleryFacets> {
  const user = await requireUserOrThrow();
  return galleryFacets(user.userId, parseGalleryParams(draft));
}
