import type { Metadata, Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Layers } from "lucide-react";
import Link from "next/link";
import { BarList } from "@/components/charts/bar-list";
import { DesignTrendChart } from "@/components/charts/design-trend-chart";
import { TypeMixDonut } from "@/components/charts/type-mix-donut";
import { InboxRow } from "@/components/email/inbox-row";
import { PageContainer } from "@/components/page/page-header";
import { BiasStepper, MuteButton, UnsubscribeButton } from "@/components/senders/sender-controls";
import { SenderAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ScoreBadge } from "@/components/ui/score-badge";
import { Time } from "@/components/ui/time";
import { TypeChip } from "@/components/ui/type-chip";
import { formatNumber, formatPercent } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-params";
import { FREQUENCY_LABELS } from "@/lib/labels";
import { getSenderProfile } from "@/server/queries/senders";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Sender" };

function Stat({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-raised">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex items-center gap-2 text-xl font-semibold tracking-[-0.02em] text-foreground">
        {children}
      </div>
      {hint ? <p className="mt-1 text-xs text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}

function bandOf(score: number) {
  return score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "needs_work" : "poor";
}

export default async function SenderProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const profile = await getSenderProfile(user.userId, id);
  if (!profile) notFound();
  const s = profile.sender;
  const name = s.displayName ?? s.address;
  const trend = profile.designTrend.filter((t) => t.avgScore !== null);

  return (
    <PageContainer width="wide">
      <LinkButton href="/senders" variant="ghost" size="sm" className="-ml-2 mb-4">
        <ArrowLeft aria-hidden />
        Senders
      </LinkButton>

      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-4">
          <SenderAvatar name={s.displayName} domain={s.domain} size="xl" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-[-0.025em] text-foreground">
              {name}
            </h1>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {s.address} · {s.domain}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {s.primaryType ? <TypeChip type={s.primaryType} /> : null}
              {s.isNew ? <Badge tone="accent">New sender</Badge> : null}
              {s.muted ? <Badge>Muted</Badge> : null}
              {s.stillSending ? (
                <Badge tone="warning">Still sending after unsubscribe</Badge>
              ) : null}
              {s.oneClickUnsubscribe ? <Badge tone="success">One-click unsubscribe</Badge> : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-muted-foreground">
            Importance
            <BiasStepper senderId={s.id} value={s.importanceBias} />
          </div>
          <MuteButton sender={s} withLabel />
          <UnsubscribeButton sender={s} withLabel />
          <LinkButton
            href={inboxHref({ senderId: s.id, scope: "all" }) as Route}
            variant="primary"
            size="sm"
          >
            All their emails
            <ArrowRight aria-hidden />
          </LinkButton>
        </div>
      </header>

      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Emails"
          hint={
            <>
              since <Time iso={s.firstSeenAt} variant="short" />
            </>
          }
        >
          {formatNumber(s.emailCount)}
        </Stat>
        <Stat
          label="Per week"
          hint={s.frequencyBand ? FREQUENCY_LABELS[s.frequencyBand] : undefined}
        >
          {s.emailsPerWeek === null
            ? "—"
            : s.emailsPerWeek < 1
              ? s.emailsPerWeek.toFixed(1)
              : Math.round(s.emailsPerWeek)}
        </Stat>
        <Stat label="You read" hint="last 60 days">
          {s.readRate60d === null ? "—" : formatPercent(s.readRate60d)}
        </Stat>
        <Stat label="Average design">
          {s.avgDesignScore === null ? (
            "—"
          ) : (
            <ScoreBadge score={s.avgDesignScore} band={bandOf(s.avgDesignScore)} size="lg" />
          )}
        </Stat>
        <Stat label="Last email" hint={<Time iso={s.lastSeenAt} variant="short" />}>
          <Time iso={s.lastSeenAt} variant="relative" className="text-base" />
        </Stat>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Design over time</CardTitle>
              <CardDescription>Average score per month, last 12 months.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {trend.length > 0 ? (
              <DesignTrendChart data={profile.designTrend} />
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground">
                No scored emails from this sender yet.
              </p>
            )}
          </CardContent>
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Fonts they use</CardTitle>
                <CardDescription>Emails per font family, last 90 days.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {profile.fonts.length ? (
                <BarList
                  items={profile.fonts.map((f) => ({
                    key: f.family,
                    label: f.family,
                    value: f.emails,
                  }))}
                  format={(n) => formatNumber(n)}
                />
              ) : (
                <p className="text-[0.8125rem] text-muted-foreground">No font data yet.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>What they send</CardTitle>
            </CardHeader>
            <CardContent>
              <TypeMixDonut data={profile.typeMix} size={128} />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border">
            <div>
              <CardTitle>Recent emails</CardTitle>
              <CardDescription>The latest 20.</CardDescription>
            </div>
            <Link
              href={inboxHref({ senderId: s.id, scope: "all" }) as Route}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Open in Inbox
            </Link>
          </CardHeader>
          {profile.recentEmails.length ? (
            <div className="[&>div:last-child]:border-b-0">
              {profile.recentEmails.map((item) => (
                <InboxRow key={item.id} item={item} compact />
              ))}
            </div>
          ) : (
            <EmptyState size="sm" title="No stored emails" />
          )}
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="size-4 text-subtle-foreground" aria-hidden />
                Templates
              </CardTitle>
              <CardDescription>
                Emails that share a layout are scored from one rendered sample.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {profile.templates.length ? (
              <ul className="divide-y divide-border">
                {profile.templates.map((t, i) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-[0.8125rem]"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">Template {i + 1}</p>
                      <p className="text-xs text-subtle-foreground">
                        {formatNumber(t.emailCount)} emails ·{" "}
                        <Time iso={t.firstSeenAt} variant="short" /> –{" "}
                        <Time iso={t.lastSeenAt} variant="short" />
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {t.exemplarRenderedAt ? (
                        t.exemplarEmailId ? (
                          <Link href={`/email/${t.exemplarEmailId}` as Route}>
                            <Badge tone="success" size="sm">
                              Sample rendered
                            </Badge>
                          </Link>
                        ) : (
                          <Badge tone="success" size="sm">
                            Sample rendered
                          </Badge>
                        )
                      ) : (
                        <Badge tone="outline" size="sm">
                          No sample yet
                        </Badge>
                      )}
                      {t.aiReviewed ? (
                        <Badge tone="accent" size="sm">
                          AI reviewed
                        </Badge>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground">No templates detected yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
