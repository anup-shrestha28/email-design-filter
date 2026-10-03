import { GalleryCardSkeleton } from "@/components/gallery/gallery-card";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

// The same page width and columns as components/gallery/gallery-view.tsx (GALLERY_WIDTH, and the
// masonry's first-paint grid), written out here so this server file doesn't pull in the client view.
const WIDTH = "mx-auto max-w-[1760px] px-4 sm:px-6 lg:px-8";
const GRID =
  "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4 min-[1700px]:grid-cols-5";

export default function GalleryLoading() {
  return (
    <LoadingRegion label="Loading email designs">
      <div className="border-b border-border">
        <div className={`${WIDTH} flex flex-col gap-3 py-3`}>
          <Skeleton className="h-10 w-full md:hidden" />
          <div className="flex flex-wrap gap-2 overflow-hidden">
            {[88, 120, 112, 96, 128, 132, 88, 150, 72].map((w, i) => (
              <Skeleton key={i} className="h-8 shrink-0 rounded-full" style={{ width: w }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <Skeleton className="h-8 w-64 rounded-lg" />
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-8 w-40" />
          </div>
        </div>
      </div>
      <div className={`${WIDTH} pt-4 pb-16`}>
        <Skeleton className="mb-4 h-5 w-56" />
        <ul className={GRID}>
          {Array.from({ length: 12 }, (_, i) => (
            <GalleryCardSkeleton key={i} />
          ))}
        </ul>
      </div>
    </LoadingRegion>
  );
}
