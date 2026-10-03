import { PageContainer } from "@/components/page/page-header";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function TodayLoading() {
  return (
    <PageContainer>
      <LoadingRegion label="Loading Today">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="mt-2 h-4 w-80" />
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex flex-col gap-6">
            <div className="rounded-xl border border-border bg-surface p-4">
              <Skeleton className="h-4 w-36" />
              <div className="mt-4 flex flex-col gap-4">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="size-8 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-1/3" />
                      <Skeleton className="h-3.5 w-4/5" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-32 rounded-xl" />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-6">
            <Skeleton className="h-56 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        </div>
      </LoadingRegion>
    </PageContainer>
  );
}
