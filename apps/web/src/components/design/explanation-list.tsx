import type { ExplanationItem } from "@edf/design/types";
import { ArrowRight, Check, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatPoints } from "@/lib/format";

type Item = Pick<ExplanationItem, "key" | "title" | "points" | "ai"> & Partial<ExplanationItem>;

export function AiTag({ className }: { className?: string }) {
  return (
    <Badge
      tone="accent"
      size="sm"
      className={className}
      title="Judged by an AI reviewer against an anchored rubric (at most 14 of 100 points)"
    >
      <Sparkles aria-hidden />
      AI review
    </Badge>
  );
}

/** "Needs improvement": caps first, measured → target, how to fix, source, points lost. */
export function NeedsImprovementList({
  items,
  numbered = false,
}: {
  items: Item[];
  numbered?: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">Nothing significant to improve.</p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, i) => (
        <li
          key={item.key}
          className={cn(
            "rounded-lg border p-3",
            item.kind === "cap"
              ? "border-danger/30 bg-danger-soft/60"
              : "border-border bg-surface-muted/40",
          )}
        >
          <div className="flex gap-2.5">
            <span
              aria-hidden
              className={cn(
                "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
                item.kind === "cap"
                  ? "bg-danger text-white dark:text-[oklch(0.18_0.02_25)]"
                  : "bg-band-poor-soft text-band-poor-ink",
              )}
            >
              {numbered ? i + 1 : <X className="size-3" strokeWidth={3} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 flex-1 text-[0.8125rem] leading-snug font-medium text-foreground">
                  {item.kind === "cap" ? (
                    <span className="mr-1.5 text-danger">Score cap:</span>
                  ) : null}
                  {item.title}
                </p>
                <span
                  className="tabular shrink-0 text-xs font-medium text-band-poor-ink"
                  title="Points lost"
                >
                  −{formatPoints(item.points)} pts
                </span>
              </div>
              {item.measured || item.target ? (
                <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  {item.measured ? (
                    <span className="rounded-sm bg-surface px-1.5 py-0.5 font-medium text-foreground ring-1 ring-border">
                      {item.measured}
                    </span>
                  ) : null}
                  {item.measured && item.target ? (
                    <ArrowRight className="size-3 text-subtle-foreground" aria-label="target" />
                  ) : null}
                  {item.target ? (
                    <span className="rounded-sm bg-success-soft px-1.5 py-0.5 font-medium text-success">
                      {item.target}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {item.fix ? (
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{item.fix}</p>
              ) : null}
              {item.source || item.ai ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-subtle-foreground">
                  {item.ai ? <AiTag /> : null}
                  {item.source ? <span>Source: {item.source}</span> : null}
                </div>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function GoodList({ items }: { items: Item[] }) {
  if (items.length === 0) {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">No standout strengths recorded.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item.key} className="flex gap-2.5 py-1">
          <span
            aria-hidden
            className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-band-excellent-soft text-band-excellent-ink"
          >
            <Check className="size-3" strokeWidth={3} />
          </span>
          <p className="min-w-0 flex-1 text-[0.8125rem] leading-snug text-foreground">
            {item.title}
            {item.ai ? <AiTag className="ml-2 align-middle" /> : null}
          </p>
          <span className="tabular shrink-0 text-xs text-band-excellent-ink" title="Points earned">
            +{formatPoints(item.points)}
          </span>
        </li>
      ))}
    </ul>
  );
}
