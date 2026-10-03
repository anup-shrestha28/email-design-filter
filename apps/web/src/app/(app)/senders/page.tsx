import type { Metadata, Route } from "next";
import Link from "next/link";
import { PageContainer, PageHeader } from "@/components/page/page-header";
import { SendersTable } from "@/components/senders/senders-table";
import { cn } from "@/lib/cn";
import { listSenders, type SenderFilter } from "@/server/queries/senders";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Senders" };

const TABS: Array<{ id: SenderFilter; label: string; hint: string }> = [
  { id: "all", label: "All", hint: "Everyone who sends you automated mail" },
  { id: "new", label: "New", hint: "First seen in the last 14 days" },
  { id: "never_opened", label: "Never opened", hint: "5+ emails, read less than 10% of the time" },
  {
    id: "still_sending",
    label: "Still sending",
    hint: "Kept sending 3+ days after you opened their unsubscribe page",
  },
  { id: "muted", label: "Muted", hint: "Hidden everywhere in the app" },
  { id: "no_unsubscribe", label: "No unsubscribe", hint: "No unsubscribe link in their headers" },
];

export default async function SendersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const user = await requireUser();
  const { filter: raw } = await searchParams;
  const filter = TABS.find((t) => t.id === raw)?.id ?? "all";
  const senders = await listSenders(user.userId, { filter });
  const tab = TABS.find((t) => t.id === filter);
  return (
    <PageContainer width="wide">
      <PageHeader
        title="Senders"
        description="Who sends you what, how often you read it, and how well it's designed."
      />
      <nav
        aria-label="Sender filters"
        className="mt-6 flex gap-1 overflow-x-auto border-b border-border scrollbar-none"
      >
        {TABS.map((t) => {
          const active = t.id === filter;
          return (
            <Link
              key={t.id}
              href={(t.id === "all" ? "/senders" : `/senders?filter=${t.id}`) as Route}
              aria-current={active ? "page" : undefined}
              title={t.hint}
              className={cn(
                "relative -mb-px flex h-9 shrink-0 items-center rounded-t-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                active &&
                  "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <p className="mt-3 mb-4 text-xs text-muted-foreground">{tab?.hint}</p>
      <SendersTable key={filter} initial={senders} filter={filter} />
    </PageContainer>
  );
}
