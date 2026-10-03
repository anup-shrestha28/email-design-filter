import type { DesignBand } from "@edf/design/types";
import { ArrowDownToLine } from "lucide-react";
import { cn } from "@/lib/cn";
import { BAND_LABELS } from "@/lib/labels";
import type { DesignSnapshot } from "@/server/queries/types";
import { BAND_STYLES } from "./band-pill";

interface ScoreBadgeProps {
  score: number | null;
  band: DesignBand | null;
  provisional?: boolean;
  capped?: boolean;
  status?: DesignSnapshot["status"];
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE = {
  sm: "h-5 min-w-7 px-1 text-xs",
  md: "h-6 min-w-8 px-1.5 text-[0.8125rem]",
  lg: "h-8 min-w-11 px-2 text-base",
};

/** Design score chip: number + band colour, dashed when provisional, marked when capped. */
export function ScoreBadge({
  score,
  band,
  provisional = false,
  capped = false,
  status,
  size = "md",
  className,
}: ScoreBadgeProps) {
  if (status === "skipped" || status === "plain_text" || score === null) {
    const text =
      status === "skipped" ? "Skipped" : status === "plain_text" ? "Plain text" : "Not analysed";
    const title =
      status === "skipped"
        ? "Security emails are never rendered or scored"
        : status === "plain_text"
          ? "Plain-text email: no design to score"
          : "Design not analysed yet";
    return (
      <span
        title={title}
        className={cn(
          "inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-2xs font-medium whitespace-nowrap text-subtle-foreground ring-1 ring-inset ring-border",
          className,
        )}
      >
        {text}
      </span>
    );
  }
  const label = `Design score ${score}${band ? `, ${BAND_LABELS[band]}` : ""}${provisional ? ", provisional" : ""}${capped ? ", capped" : ""}`;
  if (provisional || !band) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(
          "tabular inline-flex shrink-0 items-center justify-center gap-0.5 rounded-md border border-dashed border-border-strong font-semibold text-muted-foreground",
          SIZE[size],
          className,
        )}
      >
        {score}
        {capped ? <ArrowDownToLine className="size-2.5" aria-hidden /> : null}
      </span>
    );
  }
  const s = BAND_STYLES[band];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "tabular inline-flex shrink-0 items-center justify-center gap-0.5 rounded-md font-semibold",
        s.soft,
        s.ink,
        SIZE[size],
        className,
      )}
    >
      {score}
      {capped ? <ArrowDownToLine className="size-2.5 opacity-80" aria-hidden /> : null}
    </span>
  );
}

/** Convenience: badge from an inbox snapshot. */
export function SnapshotScore({
  design,
  size,
  className,
}: {
  design: DesignSnapshot;
  size?: ScoreBadgeProps["size"];
  className?: string;
}) {
  return (
    <ScoreBadge
      score={design.score}
      band={design.band}
      provisional={design.provisional}
      capped={design.capped}
      status={design.status}
      size={size}
      className={className}
    />
  );
}
