import type { Metadata, Route } from "next";
import Link from "next/link";
import { ArrowUpRight, Radar, TrendingUp } from "lucide-react";
import { BarList } from "@/components/charts/bar-list";
import { ScoreHistogram } from "@/components/charts/score-histogram";
import { TypeMixDonut } from "@/components/charts/type-mix-donut";
import { VolumeChart } from "@/components/charts/volume-chart";
import { BandShare } from "@/components/insights/band-share";
import { RangeSelect } from "@/components/insights/range-select";
import { PageContainer, PageHeader } from "@/components/page/page-header";
import { MuteButton, UnsubscribeButton } from "@/components/senders/sender-controls";
import { SenderAvatar } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScoreBadge } from "@/components/ui/score-badge";
import { formatNumber, formatPercent } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-params";
import { ISSUE_LABELS } from "@/lib/labels";
import { getInsights } from "@/server/queries/insights";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Insights" };

function bandOf(score: number) {
  return score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "needs_work" : "poor";
}

function Kpi({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-raised">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex h-8 items-center text-2xl font-semibold tracking-[-0.025em] text-foreground">
        {value}
      </div>
      {hint ? <p className="mt-1 text-xs text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}

function SenderScores({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; name: string; avgScore: number; emails: number }>;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Needs at least 3 scored emails per sender.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/senders/${r.id}` as Route}
                className="-mx-2 flex h-9 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] hover:bg-surface-muted"
              >
                <ScoreBadge score={r.avgScore} band={bandOf(r.avgScore)} size="sm" />
                <span className="min-w-0 flex-1 truncate text-foreground">{r.name}</span>
                <span className="tabular text-xs text-subtle-foreground">
                  {formatNumber(r.emails)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await requireUser();
  const { range } = await searchParams;
  const data = await getInsights(user.userId, Number(range) || 90);
  const t = data.totals;
  const webTotal = data.webVsSystem.webFontEmails + data.webVsSystem.systemOnlyEmails;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Insights"
        description={`Your automated mail over the last ${data.rangeDays === 365 ? "year" : `${data.rangeDays} days`}.`}
        actions={<RangeSelect />}
      />

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Emails" value={formatNumber(t.emails)} />
        <Kpi label="Senders" value={formatNumber(t.senders)} />
        <Kpi
          label="Subscriptions"
          value={formatNumber(t.subscriptions)}
          hint={t.emails ? `${formatPercent(t.subscriptions / t.emails)} of all mail` : undefined}
        />
        <Kpi
          label="Design scored"
          value={formatNumber(t.designed)}
          hint={t.emails ? `${formatPercent(t.designed / t.emails)} of all mail` : undefined}
        />
        <Kpi
          label="Average design score"
          value={
            t.avgScore === null ? (
              "—"
            ) : (
              <ScoreBadge score={t.avgScore} band={bandOf(t.avgScore)} size="lg" />
            )
          }
        />
      </div>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Volume by week</CardTitle>
              <CardDescription>Emails received each week, by type.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <VolumeChart data={data.volumeByWeek} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Type mix</CardTitle>
          </CardHeader>
          <CardContent>
            <TypeMixDonut data={data.typeMix} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Design score distribution</CardTitle>
              <CardDescription>Scored emails (provisional scores left out).</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ScoreHistogram data={data.designDistribution} />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Design bands</CardTitle>
            </CardHeader>
            <CardContent>
              <BandShare data={data.bandShare} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Radar className="size-4 text-subtle-foreground" aria-hidden />
                  Tracking
                </CardTitle>
                <CardDescription>Information only — we never load trackers.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                <span className="text-3xl font-semibold tracking-[-0.03em] text-foreground">
                  {formatPercent(data.tracking.share)}
                </span>{" "}
                of emails carry a tracking pixel
              </p>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
                role="img"
                aria-label={`${formatPercent(data.tracking.share)} with tracking pixels`}
              >
                <span
                  className="block h-full rounded-full bg-warning"
                  style={{ width: `${data.tracking.share * 100}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-subtle-foreground">
                {formatNumber(data.tracking.emailsWithPixels)} of{" "}
                {formatNumber(data.tracking.total)} (security mail excluded)
              </p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Senders by design</CardTitle>
              <CardDescription>Average score, 3+ scored emails.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
            <SenderScores title="Best designed" rows={data.bestSenders} />
            <SenderScores title="Needs the most work" rows={data.worstSenders} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Top design issues</CardTitle>
              <CardDescription>Show-stoppers that cap a score.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.topIssues.length ? (
              <BarList
                color="var(--band-poor)"
                items={data.topIssues.map((i) => ({
                  key: i.issue,
                  label: (
                    <Link
                      className="hover:underline"
                      href={inboxHref({ issues: [i.issue], scope: "all" }) as Route}
                    >
                      {ISSUE_LABELS[i.issue]}
                    </Link>
                  ),
                  value: i.count,
                }))}
                format={formatNumber}
              />
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground">
                No capped emails in this period.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Most-used fonts</CardTitle>
              <CardDescription>Emails per font family.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.fonts.length ? (
              <BarList
                items={data.fonts
                  .slice(0, 8)
                  .map((f) => ({ key: f.family, label: f.family, value: f.emails }))}
                format={formatNumber}
              />
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground">No font data yet.</p>
            )}
            {webTotal > 0 ? (
              <div className="mt-5 border-t border-border pt-4">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Web fonts {formatPercent(data.webVsSystem.webFontEmails / webTotal)}</span>
                  <span>
                    System fonts only {formatPercent(data.webVsSystem.systemOnlyEmails / webTotal)}
                  </span>
                </div>
                <div
                  className="mt-1.5 flex h-2 gap-0.5 overflow-hidden rounded-full"
                  role="img"
                  aria-label={`Web fonts ${formatPercent(data.webVsSystem.webFontEmails / webTotal)}, system fonts only ${formatPercent(data.webVsSystem.systemOnlyEmails / webTotal)}`}
                >
                  <span
                    className="h-full rounded-l-full bg-accent"
                    style={{ width: `${(data.webVsSystem.webFontEmails / webTotal) * 100}%` }}
                  />
                  <span className="h-full flex-1 rounded-r-full bg-subtle-foreground/50" />
                </div>
                <p className="mt-2 text-2xs text-subtle-foreground">
                  Most email apps ignore web fonts, so readers usually see the backup font.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="size-4 text-subtle-foreground" aria-hidden />
                Frequency spikes
              </CardTitle>
              <CardDescription>
                Senders mailing at least twice their usual rate this week.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.frequencySpikes.length ? (
              <ul className="divide-y divide-border">
                {data.frequencySpikes.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-[0.8125rem]"
                  >
                    <Link
                      href={`/senders/${s.id}` as Route}
                      className="min-w-0 truncate font-medium text-foreground hover:underline"
                    >
                      {s.name}
                    </Link>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{s.last7}</span> this week ·{" "}
                      {s.prior28Weekly === 0 ? "new" : `usually ${s.prior28Weekly}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground">No unusual spikes this week.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-5">
        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>Cleanup candidates</CardTitle>
              <CardDescription>5+ emails and you open fewer than 1 in 10.</CardDescription>
            </div>
            <Link
              href="/senders?filter=never_opened"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              See all <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          </CardHeader>
          {data.cleanupCandidates.length ? (
            // `relative`: the header's screen-reader-only "Actions" label (absolutely positioned)
            // stays inside this scroller instead of widening the page at phone widths.
            <div className="relative overflow-x-auto">
              <table className="w-full text-[0.8125rem]">
                <thead className="border-y border-border bg-surface-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="h-8 px-4 text-left font-medium">
                      Sender
                    </th>
                    <th scope="col" className="px-3 text-right font-medium">
                      Emails
                    </th>
                    <th scope="col" className="px-3 text-right font-medium">
                      Read
                    </th>
                    <th scope="col" className="px-4 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {data.cleanupCandidates.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/senders/${s.id}` as Route}
                          className="flex min-w-0 items-center gap-2.5 hover:underline"
                        >
                          <SenderAvatar name={s.displayName} domain={s.domain} size="sm" />
                          <span className="truncate font-medium text-foreground">
                            {s.displayName ?? s.address}
                          </span>
                        </Link>
                      </td>
                      <td className="tabular px-3 text-right text-muted-foreground">
                        {formatNumber(s.emailCount)}
                      </td>
                      <td className="tabular px-3 text-right text-muted-foreground">
                        {s.readRate60d === null ? "—" : formatPercent(s.readRate60d)}
                      </td>
                      <td className="px-4">
                        <div className="flex justify-end gap-1">
                          <MuteButton sender={s} />
                          <UnsubscribeButton sender={s} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <CardContent>
              <p className="text-[0.8125rem] text-muted-foreground">
                Nothing to clean up — you read what you receive.
              </p>
            </CardContent>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
