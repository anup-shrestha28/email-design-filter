import { PageContainer } from "@/components/page/page-header";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function InsightsLoading() {
  return (
    <PageContainer width="wide">
      <LoadingRegion label="Loading insights">
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-8 w-72" />
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="mt-5 grid gap-5 xl:grid-cols-[1.7fr_1fr]">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </LoadingRegion>
    </PageContainer>
  );
}
