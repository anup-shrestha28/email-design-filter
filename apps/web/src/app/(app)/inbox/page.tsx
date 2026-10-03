import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";
import { filtersFromSearchParams } from "@/lib/inbox-params";
import { getSyncStatus } from "@/server/queries/account";
import { facetCounts, fontOptions, listInbox } from "@/server/queries/inbox";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const filters = filtersFromSearchParams(await searchParams);
  const [page, counts, fonts, sync] = await Promise.all([
    listInbox(user.userId, filters),
    facetCounts(user.userId, filters),
    fontOptions(user.userId),
    getSyncStatus(user.userId),
  ]);
  return (
    <InboxView
      filters={filters}
      page={page}
      counts={counts}
      fonts={fonts}
      hasMailbox={sync.mailboxes.length > 0}
    />
  );
}
