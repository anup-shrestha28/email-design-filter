import { PageContainer } from "@/components/page/page-header";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

export default function SystemLoading() {
  return (
    <PageContainer width="wide">
      <LoadingRegion label="Loading system status">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <Skeleton className="mt-6 h-28 rounded-2xl" />
        <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </LoadingRegion>
    </PageContainer>
  );
}
