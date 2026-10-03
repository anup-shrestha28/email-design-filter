import { PageContainer } from "@/components/page/page-header";
import { EmailDetailSkeleton } from "@/components/email/detail-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function EmailLoading() {
  return (
    <PageContainer width="wide" className="max-w-[88rem]">
      <Skeleton className="mb-4 h-7 w-20" />
      <EmailDetailSkeleton />
    </PageContainer>
  );
}
