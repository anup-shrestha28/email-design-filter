/**
 * The gallery page's live updates (a Server Component, mounted by app/(app)/gallery/page.tsx): the
 * stamp of what the page was rendered with, handed to the client part (live-updates.tsx). The page
 * reads the stamp (`liveStamp`) before it lists its designs, so a design stored while the page is
 * rendered is never inside the baseline without being on the page (it shows as new instead).
 * Renders nothing while the governor has UI polling off (FREE-TIER.md §8.2 L1) — the gallery then
 * works exactly as before: new mail on the next visit — or if the stamp can't be read (the page
 * itself is never affected).
 */
import "server-only";
import type { GalleryParams } from "@/lib/gallery";
import { regroupRisk } from "@/lib/gallery-live";
import { galleryStamp, type StampResult } from "@/server/queries/gallery-live";
import type { GalleryPage } from "@/server/queries/types";
import { LiveUpdates } from "./live-updates";

/** The live gallery's baseline for `userId`, or null when it can't be read (never throws). */
export function liveStamp(userId: string): Promise<StampResult | null> {
  return galleryStamp(userId).catch(() => null);
}

export function LiveGallery({
  stamp,
  params,
  page,
}: {
  /** `liveStamp`, read before the page's designs were listed. */
  stamp: StampResult | null;
  params: GalleryParams;
  page: GalleryPage;
}) {
  if (!stamp || stamp.pollingOff) return null;
  return (
    <LiveUpdates
      stamp={stamp.stamp}
      params={params}
      total={page.total}
      regroup={regroupRisk(page.items)}
    />
  );
}
