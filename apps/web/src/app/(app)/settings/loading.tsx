import { PageContainer } from "@/components/page/page-header";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <PageContainer width="narrow" className="max-w-4xl">
      <LoadingRegion label="Loading settings">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-2 h-4 w-72" />
        <div className="mt-6 flex gap-4 border-b border-border pb-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-24" />
          ))}
        </div>
        <Skeleton className="mt-6 h-64 rounded-xl" />
      </LoadingRegion>
    </PageContainer>
  );
}
