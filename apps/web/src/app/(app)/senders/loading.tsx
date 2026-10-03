import { PageContainer } from "@/components/page/page-header";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function SendersLoading() {
  return (
    <PageContainer width="wide">
      <LoadingRegion label="Loading senders">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <div className="mt-6 flex gap-4 border-b border-border pb-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-20" />
          ))}
        </div>
        <Skeleton className="mt-6 h-8 w-72" />
        <div className="mt-3 rounded-xl border border-border bg-surface">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border/70 px-4 py-3">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-4 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </LoadingRegion>
    </PageContainer>
  );
}
