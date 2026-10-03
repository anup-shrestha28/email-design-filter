import type { Metadata, Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { EmailDetailView } from "@/components/email/email-detail";
import { PageContainer } from "@/components/page/page-header";
import { LinkButton } from "@/components/ui/button";
import { backLinkOf } from "@/lib/back-link";
import { getEmailDetail } from "@/server/queries/email";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Email", referrer: "no-referrer" };

export default async function EmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  // Back to where the reader came from (the gallery, filters and all), the gallery by default.
  const back = backLinkOf(sp.back);
  const user = await requireUser();
  const detail = await getEmailDetail(user.userId, id, user.role);
  if (!detail) notFound();
  return (
    <PageContainer width="wide" className="max-w-[88rem]">
      <LinkButton href={back.href as Route} variant="ghost" size="sm" className="-ml-2 mb-4">
        <ArrowLeft aria-hidden />
        {back.label}
      </LinkButton>
      <EmailDetailView detail={detail} />
    </PageContainer>
  );
}
