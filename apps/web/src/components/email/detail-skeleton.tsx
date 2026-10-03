import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export function EmailDetailSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <LoadingRegion label="Loading email">
      <div className="flex gap-3.5">
        <Skeleton className="size-10 rounded-[10px]" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div
        className={
          compact
            ? "mt-6 flex flex-col gap-5"
            : "mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]"
        }
      >
        <Skeleton className="h-[32rem] rounded-xl" />
        <div className="flex flex-col gap-5">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    </LoadingRegion>
  );
}
