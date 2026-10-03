import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

function RowSkeleton({ i }: { i: number }) {
  return (
    <div className="flex gap-3 border-b border-border/70 px-4 py-3">
      <Skeleton className="size-8 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 13) % 25)}%` }} />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3.5" style={{ width: `${70 + ((i * 7) % 25)}%` }} />
        <div className="flex gap-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-7" />
        </div>
      </div>
    </div>
  );
}

export default function InboxLoading() {
  return (
    <LoadingRegion label="Loading inbox" className="flex h-full">
      <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border p-4 xl:flex">
        <Skeleton className="h-4 w-16" />
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-5" style={{ width: `${55 + ((i * 11) % 35)}%` }} />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col xl:w-[440px] xl:flex-none xl:border-r xl:border-border">
        <div className="space-y-2 border-b border-border px-4 py-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-full" />
        </div>
        {Array.from({ length: 9 }, (_, i) => (
          <RowSkeleton key={i} i={i} />
        ))}
      </div>
      <div className="hidden flex-1 p-6 xl:block">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="mt-3 h-4 w-1/3" />
        <Skeleton className="mt-6 h-96 w-full rounded-xl" />
      </div>
    </LoadingRegion>
  );
}
