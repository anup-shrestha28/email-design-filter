import type { Metadata } from "next";
import {
  Activity,
  Bot,
  Gauge,
  Mail,
  OctagonAlert,
  Power,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/page/page-header";
import { Heartbeat } from "@/components/system/heartbeat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MeterBar } from "@/components/ui/progress";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent, formatUsd } from "@/lib/format";
import { getSystemStatus } from "@/server/queries/system";
import type { ResourceRow, SystemStatus } from "@/server/queries/types";
import { requireOwner } from "@/server/session";

export const metadata: Metadata = { title: "System" };

const LEVELS: Record<
  SystemStatus["governor"]["level"],
  { name: string; tone: "success" | "warning" | "danger"; body: string }
> = {
  0: {
    name: "Normal",
    tone: "success",
    body: "Everything runs as designed. Every shared free-tier resource is below 80% of its self-cap.",
  },
  1: {
    name: "Saving",
    tone: "warning",
    body: "A shared resource passed 80% of its self-cap. Mail is checked half as often, extra renders are off, new imports wait in line, and friends' images load on click.",
  },
  2: {
    name: "Strict saving",
    tone: "warning",
    body: "A self-cap was reached. Background checks run every 6 hours, only your on-demand renders run, and automatic AI is off.",
  },
  3: {
    name: "Frozen",
    tone: "danger",
    body: "Usage is close to a hard free-tier limit. All background work and on-demand features are off. Stored data stays readable; export, delete and disconnect still work.",
  },
};

const WINDOW: Record<ResourceRow["window"], string> = {
  rolling_30d: "last 30 days",
  month: "this month",
  billing_period: "billing period",
  now: "right now",
};

function fmt(n: number, unit: string): string {
  const v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${formatNumber(v)}${unit ? ` ${unit}` : ""}`;
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-surface-muted/60 px-3 py-2.5">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className={cn("tabular text-lg font-semibold text-foreground", tone)}>
        {formatNumber(value)}
      </p>
    </div>
  );
}

export default async function SystemPage() {
  const user = await requireOwner();
  const s = await getSystemStatus(user.userId);
  const level = LEVELS[s.governor.level];
  const tickMs = s.heartbeats.tickEvery * 60_000;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="System"
        eyebrow={
          <Badge tone="outline" size="sm">
            Owner only
          </Badge>
        }
        description="Free-tier usage, background jobs and safety switches. Nothing here shows anyone's mail."
      />

      {s.warnings.length > 0 ? (
        <ul className="mt-6 flex flex-col gap-2" aria-label="Warnings">
          {s.warnings.map((w) => (
            <li
              key={w.code}
              role="alert"
              className="flex gap-3 rounded-xl border border-warning/30 bg-warning-soft/70 p-3.5 text-[0.8125rem] leading-relaxed text-foreground"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              {w.message}
            </li>
          ))}
        </ul>
      ) : null}

      <section
        className={cn(
          "mt-6 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:p-6",
          level.tone === "success"
            ? "border-success/25 bg-success-soft/50"
            : level.tone === "warning"
              ? "border-warning/30 bg-warning-soft/60"
              : "border-danger/30 bg-danger-soft/60",
        )}
        aria-label="Governor"
      >
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-xl",
            level.tone === "success"
              ? "bg-success text-white"
              : level.tone === "warning"
                ? "bg-band-needs-work text-[oklch(0.25_0.05_70)]"
                : "bg-danger text-white",
          )}
        >
          <Gauge className="size-6" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            Governor level {s.governor.level}
          </p>
          <h2 className="text-lg font-semibold tracking-[-0.015em] text-foreground">
            {level.name}
          </h2>
          <p className="mt-1 max-w-3xl text-[0.8125rem] leading-relaxed text-foreground/80">
            {level.body}
          </p>
          {s.governor.triggers.length || s.governor.since ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {s.governor.triggers.length ? (
                <>Triggered by {s.governor.triggers.join(", ")}</>
              ) : null}
              {s.governor.since ? (
                <>
                  {s.governor.triggers.length ? " · " : ""}since{" "}
                  <Time iso={s.governor.since} variant="full" />
                </>
              ) : null}
            </p>
          ) : null}
          {s.governor.recommendTick60 ? (
            <p className="mt-2 text-xs font-medium text-warning">
              Recommended: set TICK_EVERY=60 and redeploy to halve background runs.
            </p>
          ) : null}
        </div>
      </section>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="@container">
          <CardHeader>
            <div>
              <CardTitle>Resources</CardTitle>
              <CardDescription>
                Usage against our own cap (the line) and the vendor&apos;s hard limit (the full
                bar).
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {s.resources.length === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">No usage recorded yet.</p>
            ) : (
              <ul className="grid gap-x-8 gap-y-4 @xl:grid-cols-2">
                {s.resources.map((r) => {
                  const tone = r.ratio >= 1 ? "danger" : r.ratio >= 0.8 ? "warning" : "accent";
                  return (
                    <li key={r.key}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[0.8125rem]">
                        <span className="font-medium text-foreground">{r.label}</span>
                        <span className="tabular text-xs text-muted-foreground">
                          <span
                            className={cn(
                              "font-semibold",
                              tone === "danger"
                                ? "text-danger"
                                : tone === "warning"
                                  ? "text-warning"
                                  : "text-foreground",
                            )}
                          >
                            {fmt(r.used, r.unit)}
                          </span>{" "}
                          of {fmt(r.selfCap, r.unit)} cap · {formatPercent(r.ratio)}
                        </span>
                      </div>
                      <MeterBar
                        className="mt-1.5"
                        value={r.used}
                        max={Math.max(r.hardLimit, r.used)}
                        tone={tone}
                        label={`${r.label}: ${fmt(r.used, r.unit)} used`}
                        valueText={`${fmt(r.used, r.unit)} of a ${fmt(r.selfCap, r.unit)} self-cap; hard limit ${fmt(r.hardLimit, r.unit)}`}
                        marker={{ at: r.selfCap, label: "Self-cap" }}
                      />
                      <p className="mt-1 text-2xs text-subtle-foreground">
                        {WINDOW[r.window]} · hard limit {fmt(r.hardLimit, r.unit)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="size-4 text-subtle-foreground" aria-hidden />
                  Heartbeats
                </CardTitle>
                <CardDescription>
                  Background runs every {s.heartbeats.tickEvery} minutes.
                </CardDescription>
              </div>
              {s.heartbeats.inngestPaused ? (
                <Badge tone="danger" size="sm">
                  Jobs paused
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <Heartbeat label="Pipeline tick" at={s.heartbeats.lastTickAt} maxAgeMs={3 * tickMs} />
              <Heartbeat
                label="Maintenance"
                at={s.heartbeats.lastMaintenanceAt}
                maxAgeMs={26 * 3_600_000}
              />
              <Heartbeat label="Render batch" at={s.heartbeats.lastRenderBatchAt} maxAgeMs={null} />
              <Heartbeat label="Daily cron" at={s.heartbeats.lastCronAt} maxAgeMs={null} />
              {s.heartbeats.inngestPaused ? (
                <p className="pt-2.5 text-xs text-danger">
                  Inngest is paused — the backup path (Plan B) keeps sync working.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="size-4 text-subtle-foreground" aria-hidden />
                  AI spend
                </CardTitle>
                <CardDescription>This month, all users. The app stops at the cap.</CardDescription>
              </div>
              {s.ai.paused ? (
                <Badge tone="warning" size="sm">
                  Paused
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              <p className="tabular text-xs text-muted-foreground">
                <span className="text-lg font-semibold text-foreground">
                  {formatUsd(s.ai.reservedUsd)}
                </span>{" "}
                of {formatUsd(s.ai.capUsd)}
              </p>
              <MeterBar
                className="mt-2"
                value={s.ai.reservedUsd}
                max={s.ai.capUsd}
                label="AI spend"
              />
              {s.ai.paused && s.ai.pausedReason ? (
                <p className="mt-2 text-xs text-warning">{s.ai.pausedReason}</p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="size-4 text-subtle-foreground" aria-hidden />
              Mailboxes
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Metric label="Connected" value={s.mailboxes.total} />
            <Metric label="Active" value={s.mailboxes.active} />
            <Metric
              label="Need reconnecting"
              value={s.mailboxes.needsReauth}
              tone={s.mailboxes.needsReauth ? "text-danger" : undefined}
            />
            <Metric label="Importing" value={s.mailboxes.backfilling} />
            <Metric label="Messages waiting" value={s.mailboxes.pendingLedgerRows} />
            <Metric
              label="Messages failing"
              value={s.mailboxes.failingLedgerRows}
              tone={s.mailboxes.failingLedgerRows ? "text-danger" : undefined}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-4 text-subtle-foreground" aria-hidden />
                Google accounts
              </CardTitle>
              <CardDescription>
                {s.users === 1 ? "1 person uses" : `${formatNumber(s.users)} people use`} the app.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <p className="tabular text-xs text-muted-foreground">
              <span className="text-lg font-semibold text-foreground">{s.googleAccounts.used}</span>{" "}
              of {s.googleAccounts.limit} lifetime
            </p>
            <MeterBar
              className="mt-2"
              value={s.googleAccounts.used}
              max={s.googleAccounts.limit}
              label="Google accounts used"
              tone={
                s.googleAccounts.used >= s.googleAccounts.stopAt
                  ? "danger"
                  : s.googleAccounts.used >= s.googleAccounts.alertAt
                    ? "warning"
                    : "accent"
              }
              marker={{
                at: s.googleAccounts.stopAt,
                label: `Invites stop at ${s.googleAccounts.stopAt}`,
              }}
            />
            <p className="mt-2 text-2xs text-subtle-foreground">
              Alert at {s.googleAccounts.alertAt}; invites stop at {s.googleAccounts.stopAt}. The
              count never resets.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Power className="size-4 text-subtle-foreground" aria-hidden />
                Kill switches
              </CardTitle>
              <CardDescription>Emergency stops per pipeline stage. Read-only here.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {Object.entries(s.killSwitches).map(([name, on]) => (
                <li key={name} className="flex items-center justify-between py-2 text-[0.8125rem]">
                  <span className="text-foreground capitalize">{name.replaceAll("_", " ")}</span>
                  <Badge tone={on ? "danger" : "success"} size="sm">
                    {on ? "Switched off" : "Running"}
                  </Badge>
                </li>
              ))}
              {Object.keys(s.killSwitches).length === 0 ? (
                <li className="py-2 text-[0.8125rem] text-muted-foreground">
                  No switches configured.
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5 overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <OctagonAlert className="size-4 text-subtle-foreground" aria-hidden />
              Recent errors
            </CardTitle>
            <CardDescription>Last 7 days. Error codes only — never email content.</CardDescription>
          </div>
        </CardHeader>
        {s.errors.length === 0 ? (
          <CardContent>
            <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
              <ShieldCheck className="size-4 text-success" aria-hidden />
              No errors recorded.
            </p>
          </CardContent>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[0.8125rem]">
              <thead className="border-y border-border bg-surface-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="h-8 px-4 text-left font-medium">
                    Code
                  </th>
                  <th scope="col" className="px-3 text-left font-medium">
                    Job
                  </th>
                  <th scope="col" className="px-3 text-right font-medium">
                    Count
                  </th>
                  <th scope="col" className="px-4 text-right font-medium">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {s.errors.map((e) => (
                  <tr key={`${e.code}-${e.job}`}>
                    <td className="px-4 py-2 font-mono text-xs text-foreground">{e.code}</td>
                    <td className="px-3 text-muted-foreground">{e.job}</td>
                    <td className="tabular px-3 text-right text-foreground">
                      {formatNumber(e.count)}
                    </td>
                    <td className="px-4 text-right text-xs text-muted-foreground">
                      <Time iso={e.lastAt} variant="relative" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
