import type { Metadata, Route } from "next";
import { ArrowRight, Bot, CircleCheckBig, Sparkles, Timer } from "lucide-react";
import Link from "next/link";
import { InboxRow } from "@/components/email/inbox-row";
import { PageContainer, PageHeader } from "@/components/page/page-header";
import { GroupBreakdown } from "@/components/today/breakdown";
import { FlashToast } from "@/components/page/flash-toast";
import { ConnectCard } from "@/components/today/connect-card";
import { DealTile } from "@/components/today/deal-tile";
import { Greeting } from "@/components/today/greeting";
import { DesignHighlight } from "@/components/today/highlight";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatNumber, pluralize } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-params";
import { getToday } from "@/server/queries/account";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Today" };

function SeeAll({ href, label }: { href: Route; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>;
}) {
  const user = await requireUser();
  const { connected: justConnected } = await searchParams;
  const today = await getToday(user);
  const connected = today.sync.mailboxes.length > 0;

  const summary = connected ? (
    today.newSinceLastVisit > 0 ? (
      <>
        <span className="font-medium text-foreground">
          {pluralize(today.newSinceLastVisit, "new email")}
        </span>{" "}
        since your last visit.
      </>
    ) : (
      "You're all caught up since your last visit."
    )
  ) : (
    "Let's connect your mailbox."
  );

  return (
    <PageContainer>
      {justConnected === "1" ? (
        <FlashToast
          title="Gmail connected"
          description="Your first import is running in the background. New mail appears here as it's sorted."
        />
      ) : null}
      <PageHeader title={<Greeting firstName={today.firstName} />} description={summary} />

      {!connected ? (
        <div className="mt-8">
          <ConnectCard />
        </div>
      ) : (
        // One shrinkable column below lg (grid-cols-1 is minmax(0, 1fr)): an implicit column grows
        // to its widest content, which pushed the page 13 px past a 390 px phone.
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card aria-labelledby="attention-heading">
              <CardHeader className="border-b border-border pb-3">
                <div>
                  <CardTitle id="attention-heading">Needs attention</CardTitle>
                  <CardDescription>Important mail you haven&apos;t dealt with.</CardDescription>
                </div>
                <SeeAll
                  href={inboxHref({ view: "needs_attention", scope: "all" }) as Route}
                  label="See all"
                />
              </CardHeader>
              {today.needsAttention.length > 0 ? (
                <div className="overflow-hidden rounded-b-xl [&>*:last-child>div]:border-b-0">
                  {today.needsAttention.map((item) => (
                    <div key={item.id}>
                      <InboxRow item={item} compact />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  size="sm"
                  icon={<CircleCheckBig />}
                  title="Nothing needs you right now"
                  description="Payment problems, deliveries and security alerts show up here."
                />
              )}
            </Card>

            <section aria-labelledby="deals-heading">
              <div className="mb-3 flex items-center justify-between">
                <h2
                  id="deals-heading"
                  className="flex items-center gap-2 text-sm font-semibold text-foreground"
                >
                  <Timer className="size-4 text-subtle-foreground" aria-hidden />
                  Deals ending soon
                </h2>
                <SeeAll
                  href={inboxHref({ view: "deals_ending", scope: "all" }) as Route}
                  label="All deals"
                />
              </div>
              {today.dealsEndingSoon.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {today.dealsEndingSoon.map((item) => (
                    <DealTile key={item.id} item={item} />
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[0.8125rem] text-muted-foreground">
                  No deals end in the next 48 hours.
                </p>
              )}
            </section>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Last 24 hours</CardTitle>
                  <CardDescription>
                    {pluralize(today.last24h.total, "email")} by type
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <GroupBreakdown total={today.last24h.total} byGroup={today.last24h.byGroup} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="size-4 text-subtle-foreground" aria-hidden />
                    Design this week
                  </CardTitle>
                  <CardDescription>Best and worst scores from the last 7 days.</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2.5">
                {today.designHighlights.best ? (
                  <DesignHighlight label="Best designed" item={today.designHighlights.best} />
                ) : null}
                {today.designHighlights.worst ? (
                  <DesignHighlight
                    label="Needs the most work"
                    item={today.designHighlights.worst}
                  />
                ) : null}
                {!today.designHighlights.best && !today.designHighlights.worst ? (
                  <p className="text-[0.8125rem] text-muted-foreground">
                    No scored emails this week yet.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {today.aiPendingCount > 0 ? (
              <div className="flex gap-3 rounded-xl border border-border bg-surface-muted/60 p-4">
                <Bot className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {formatNumber(today.aiPendingCount)}
                  </span>{" "}
                  {today.aiPendingCount === 1 ? "email is" : "emails are"} waiting for the AI
                  review. Their scores are already shown; the review usually adds its part within an
                  hour.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
