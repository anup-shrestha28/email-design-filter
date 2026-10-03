import type { ConfidenceBand, ScoreResult, ScoreSummary } from "@edf/design/types";
import {
  TriangleAlert,
  FileText,
  Hourglass,
  Info,
  LoaderCircle,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import type { ReactNode } from "react";
import { VerdictBadge } from "@/components/gallery/verdict-badge";
import { BandPill } from "@/components/ui/band-pill";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CoverageLabel } from "@/components/ui/coverage-label";
import { ScoreRing } from "@/components/ui/score-ring";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { compatibleStrengthItems } from "@/lib/gallery";
import { formatPoints } from "@/lib/format";
import type { Verdict } from "@/lib/gallery";
import { STATIC_CHIP_FALLBACK } from "@/lib/labels";
import type { EmailDetail } from "@/server/queries/types";
import { AnalyzeButton, RerunBar } from "./analyze-button";
import {
  analyzeAllowanceUsed,
  notAnalysedBody,
  savedSummaryNote,
  staticOnlyBody,
  waitingState,
} from "./analyze-copy";
import { ChecksTable } from "./checks-table";
import { AiTag, GoodList, NeedsImprovementList } from "./explanation-list";
import { PillarBars } from "./pillar-bars";

type Design = EmailDetail["design"];

const CONFIDENCE_LABEL: Record<ConfidenceBand, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function bandOfConfidence(c: number): ConfidenceBand {
  return c >= 0.85 ? "high" : c >= 0.7 ? "medium" : "low";
}

function AiStateTag({
  aiState,
  aiPending,
  coverage,
}: {
  aiState: Design["snapshot"]["aiState"];
  aiPending: boolean;
  coverage: string | null;
}) {
  if (coverage === "static" || coverage === null) return null;
  if (aiPending || aiState === "pending" || aiState === "queued") {
    return (
      <Badge
        tone="outline"
        size="sm"
        title="The score is final for the measured checks; the AI part (≤ 14 points) comes later."
      >
        <Hourglass aria-hidden />
        AI review pending
      </Badge>
    );
  }
  if (aiState === "done") return <AiTag />;
  if (aiState === "from_template") {
    return (
      <Badge
        tone="accent"
        size="sm"
        title="The AI review of a matching email from the same template was reused."
      >
        AI review · from template
      </Badge>
    );
  }
  if (aiState === "flagged") {
    return (
      <Badge
        tone="warning"
        size="sm"
        title="The email looked like it tried to instruct the reviewer; AI levels were capped at the typical value."
      >
        <ShieldQuestion aria-hidden />
        AI review flagged
      </Badge>
    );
  }
  if (aiState === "failed")
    return (
      <Badge tone="outline" size="sm">
        AI review unavailable
      </Badge>
    );
  return null;
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-border px-4 py-4 sm:px-5", className)}>
      <h3 className="mb-3 text-xs font-semibold tracking-[0.02em] text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Header({ design, sampleDate }: { design: Design; sampleDate: string | null }) {
  const coverage = design.result?.coverage ?? design.summary?.coverage ?? null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-4 pb-3 sm:px-5">
      <h2 className="text-sm font-semibold tracking-[-0.005em] text-foreground">Design Score</h2>
      <div className="flex flex-wrap items-center gap-2">
        {coverage ? <CoverageLabel coverage={coverage} sampleDate={sampleDate} /> : null}
        <AiStateTag
          aiState={design.snapshot.aiState}
          aiPending={design.result?.aiPending ?? false}
          coverage={coverage}
        />
      </div>
    </div>
  );
}

function ProvisionalNote({
  result,
}: {
  result: Pick<ScoreResult, "confidenceBand" | "aiPending">;
}) {
  const why =
    result.confidenceBand === "low"
      ? "Parts of the design couldn't be measured, so confidence is low."
      : "The AI review is still pending and the score sits within 3 points of a band edge.";
  return (
    <div className="flex gap-2 rounded-lg border border-dashed border-border-strong bg-surface-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-px size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
      <p>
        <span className="font-medium text-foreground">Provisional.</span> {why} It can&apos;t be a
        Good design until it firms up (a severe problem still makes it a Bad design).
      </p>
    </div>
  );
}

function Headline({
  score,
  raw,
  band,
  provisional,
  capped,
  confidence,
  analyzedAt,
  note,
  verdict,
}: {
  score: number;
  raw: number | null;
  band: ScoreResult["band"];
  provisional: boolean;
  capped: boolean;
  confidence: ConfidenceBand;
  analyzedAt: string | null;
  note?: ReactNode;
  /** The gallery's word for this design; shown in place of the band so both pages agree. */
  verdict?: Verdict;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pb-4 sm:flex-row sm:items-center sm:gap-5 sm:px-5">
      <ScoreRing
        score={score}
        raw={capped ? raw : null}
        band={band}
        provisional={provisional}
        {...(verdict ? { verdict } : {})}
        size={120}
        className="self-center sm:self-auto"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {verdict ? (
            <VerdictBadge verdict={verdict} score={score} size="lg" />
          ) : (
            <BandPill band={band} provisional={provisional} />
          )}
          {capped && raw !== null ? (
            <span
              className="text-xs font-medium text-band-poor-ink"
              title="A show-stopper caps the score; the pillar points still add up to the raw score."
            >
              capped · raw {formatPoints(raw)}
            </span>
          ) : !capped && raw !== null && score === 84 && Math.round(raw) > 84 ? (
            <span
              className="text-xs font-medium text-muted-foreground"
              title="85+ needs something that stands out — a real headline, a standout button or strong visuals — and a clean phone layout. Without it the score is held at 84."
            >
              held at 84 · raw {formatPoints(raw)}
            </span>
          ) : null}
        </div>
        <dl className="grid max-w-xs grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <div>
            <dt className="text-subtle-foreground">Confidence</dt>
            <dd className="font-medium text-foreground">{CONFIDENCE_LABEL[confidence]}</dd>
          </div>
          {analyzedAt ? (
            <div>
              <dt className="text-subtle-foreground">Analysed</dt>
              <dd className="font-medium text-foreground">
                <Time iso={analyzedAt} variant="short" />
              </dd>
            </div>
          ) : null}
        </dl>
        {note}
      </div>
    </div>
  );
}

/**
 * Plain-English labels and formats for the facts scoreEmail's info() reports, keyed on its field
 * names (packages/design/src/scoring/score.ts). A key missing here still shows, as "Sentence case".
 */
const INFO_FACTS: Record<string, { label: string; format?: (v: number) => string }> = {
  htmlKb: { label: "HTML size", format: (v) => `${v} KB` },
  linkCount: { label: "Links" },
  imageCount: { label: "Images" },
  words: { label: "Words" },
  imageToTextRatio: { label: "Image area vs text", format: (v) => `${v} : 1` },
  readingTimeSec: {
    label: "Reading time",
    format: (v) => (v < 60 ? `${Math.round(v)} s` : `about ${Math.round(v / 60)} min`),
  },
  colourfulness: { label: "Colourfulness" },
  renderedAtK: {
    label: "Size on phones",
    format: (v) => (v >= 1 ? "Full size" : `Shrunk to ${Math.round(v * 100)}%`),
  },
};

function infoLabel(key: string): string {
  const known = INFO_FACTS[key];
  if (known) return known.label;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function infoValue(key: string, v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "Yes (not scored)" : "No";
  const format = INFO_FACTS[key]?.format;
  return typeof v === "number" && format ? format(v) : String(v);
}

function InfoFacts({ info }: { info: ScoreResult["info"] }) {
  const entries = Object.entries(info).filter(
    (e): e is [string, string | number | boolean] => e[1] !== null && e[1] !== "",
  );
  if (entries.length === 0) return null;
  return (
    <Section title="Information only — not scored">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs @md:grid-cols-3">
        {entries.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-subtle-foreground">{infoLabel(k)}</dt>
            <dd className="truncate font-medium text-foreground">{infoValue(k, v)}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function StaticOnly({
  emailId,
  chips,
  actions,
}: {
  emailId: string;
  chips: ScoreResult["staticChips"];
  actions: EmailDetail["actions"];
}) {
  return (
    <div className="px-4 pb-5 sm:px-5">
      <div className="rounded-xl border border-dashed border-border-strong bg-surface-muted/40 p-4">
        <p className="text-[0.9375rem] font-semibold text-foreground">Design not analysed yet</p>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {staticOnlyBody(actions)}
        </p>
        {chips.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Issues found in the code">
            {chips.map((c) => (
              <li key={c.code}>
                <Badge
                  tone={
                    c.severity === "high"
                      ? "danger"
                      : c.severity === "medium"
                        ? "warning"
                        : "neutral"
                  }
                  size="lg"
                >
                  {c.severity !== "low" ? <TriangleAlert aria-hidden /> : null}
                  {c.label || STATIC_CHIP_FALLBACK[c.code]}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-subtle-foreground">No problems found in the code.</p>
        )}
        <div className="mt-4">
          <AnalyzeButton emailId={emailId} actions={actions} />
        </div>
      </div>
    </div>
  );
}

function StateBlock({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex gap-3 px-4 pb-5 sm:px-5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-semibold text-foreground">{title}</p>
        <div className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted-foreground">{body}</div>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

function FullResult({
  emailId,
  result,
  design,
  actions,
}: {
  emailId: string;
  result: ScoreResult;
  design: Design;
  actions: EmailDetail["actions"];
}) {
  if (result.score === null || result.coverage === "static") {
    return <StaticOnly emailId={emailId} chips={result.staticChips} actions={actions} />;
  }
  const hasAi = result.checks.some(
    (c) => (c.source === "ai" || c.source === "ai_template") && c.s !== null,
  );
  return (
    <>
      <Headline
        score={result.score}
        raw={result.raw}
        band={result.band}
        provisional={result.provisional}
        capped={result.capped}
        confidence={result.confidenceBand}
        analyzedAt={design.analyzedAt}
        {...(design.verdict ? { verdict: design.verdict } : {})}
        note={result.provisional ? <ProvisionalNote result={result} /> : null}
      />
      <Section title="Where the points come from">
        <PillarBars pillars={result.pillars} raw={result.raw} />
      </Section>
      <Section title="Needs improvement">
        <NeedsImprovementList items={result.needsImprovement} numbered />
      </Section>
      <Section title="Good">
        {/* The gallery's conflict rules: a strength never contradicts a listed problem. */}
        <GoodList
          items={compatibleStrengthItems(result.good, result.needsImprovement, {
            caps: result.caps,
            checks: result.checks,
          })}
        />
      </Section>
      <Section title="Details">
        <ChecksTable checks={result.checks} />
      </Section>
      <InfoFacts info={result.info} />
      <RerunBar emailId={emailId} actions={actions} hasAi={hasAi} />
    </>
  );
}

function SummaryResult({
  emailId,
  summary,
  design,
  actions,
}: {
  emailId: string;
  summary: ScoreSummary;
  design: Design;
  actions: EmailDetail["actions"];
}) {
  if (summary.score === null || summary.coverage === "static") {
    return <StaticOnly emailId={emailId} chips={[]} actions={actions} />;
  }
  return (
    <>
      <Headline
        score={summary.score}
        raw={summary.raw}
        band={summary.band}
        provisional={design.snapshot.provisional}
        capped={summary.caps.length > 0}
        confidence={bandOfConfidence(summary.confidence)}
        analyzedAt={design.analyzedAt}
        {...(design.verdict ? { verdict: design.verdict } : {})}
        note={
          <p className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <FileText className="mt-px size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
            {savedSummaryNote(actions.rendersPaused, analyzeAllowanceUsed(actions))}
          </p>
        }
      />
      <Section title="Where the points come from">
        <PillarBars pillars={summary.pillars} raw={summary.raw} />
      </Section>
      <Section title="Needs improvement">
        <NeedsImprovementList items={summary.needsImprovement} numbered />
      </Section>
      <Section title="Good">
        <GoodList
          items={compatibleStrengthItems(summary.good, summary.needsImprovement, {
            caps: summary.caps,
          })}
        />
      </Section>
      <RerunBar emailId={emailId} actions={actions} hasAi={false} />
    </>
  );
}

/** The Design Score panel in every coverage state (DESIGN-SCORE.md §3, §7; FREE-TIER.md §5.4). */
export function DesignPanel({
  emailId,
  design,
  actions,
  className,
}: {
  emailId: string;
  design: Design;
  actions: EmailDetail["actions"];
  className?: string;
}) {
  const sampleDate = design.renderRef?.renderedAt ?? null;
  const status = design.snapshot.status;
  let body: ReactNode;
  if (status === "skipped") {
    body = (
      <StateBlock
        icon={<ShieldCheck />}
        title="Security emails aren't scored"
        body="Sign-in codes, password resets and security alerts are never rendered, screenshotted or sent to AI. We keep only the subject, sender and time."
      />
    );
  } else if (status === "plain_text") {
    body = (
      <StateBlock
        icon={<FileText />}
        title="Plain-text email"
        body="There's no designed layout to score. Plain text reads the same in every email app."
      />
    );
  } else if (design.result) {
    body = (
      <FullResult emailId={emailId} result={design.result} design={design} actions={actions} />
    );
  } else if (design.summary) {
    body = (
      <SummaryResult emailId={emailId} summary={design.summary} design={design} actions={actions} />
    );
  } else if (waitingState(actions) === "queued_paused") {
    body = (
      <StateBlock
        icon={<Hourglass />}
        title="Queued, waiting for renders to resume"
        body={`${actions.rendersPaused} Your request stays in the queue and runs once they resume.`}
      />
    );
  } else if (waitingState(actions) === "queued") {
    body = (
      <StateBlock
        icon={<LoaderCircle className="animate-spin" />}
        title="Analysis queued"
        body="We're rendering this email in a sandboxed browser. Results usually arrive within a couple of minutes."
      />
    );
  } else {
    body = (
      <StateBlock
        icon={status === "failed" ? <TriangleAlert /> : <Hourglass />}
        title={status === "failed" ? "We couldn't analyse this email" : "Design not analysed yet"}
        body={notAnalysedBody(
          status === "failed",
          actions.rendersPaused,
          analyzeAllowanceUsed(actions),
        )}
        action={<AnalyzeButton emailId={emailId} actions={actions} />}
      />
    );
  }
  return (
    <Card className={cn("@container overflow-hidden", className)} aria-label="Design Score">
      <Header design={design} sampleDate={sampleDate} />
      {body}
    </Card>
  );
}
