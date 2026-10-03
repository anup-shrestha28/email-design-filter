import type { DesignBand } from "@edf/design/types";
import { cn } from "@/lib/cn";
import { BAND_LABELS } from "@/lib/labels";

export const BAND_STYLES: Record<
  DesignBand,
  { soft: string; ink: string; solid: string; stroke: string }
> = {
  excellent: {
    soft: "bg-band-excellent-soft",
    ink: "text-band-excellent-ink",
    solid: "bg-band-excellent",
    stroke: "var(--band-excellent)",
  },
  good: {
    soft: "bg-band-good-soft",
    ink: "text-band-good-ink",
    solid: "bg-band-good",
    stroke: "var(--band-good)",
  },
  needs_work: {
    soft: "bg-band-needs-work-soft",
    ink: "text-band-needs-work-ink",
    solid: "bg-band-needs-work",
    stroke: "var(--band-needs-work)",
  },
  poor: {
    soft: "bg-band-poor-soft",
    ink: "text-band-poor-ink",
    solid: "bg-band-poor",
    stroke: "var(--band-poor)",
  },
};

/** The band as words (never colour alone). */
export function BandPill({
  band,
  provisional = false,
  size = "md",
  className,
}: {
  band: DesignBand | null;
  provisional?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  if (provisional || !band) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-dashed border-border-strong font-medium text-muted-foreground",
          size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-2xs",
          className,
        )}
      >
        <span aria-hidden className="size-1.5 rounded-full border border-current" />
        {provisional ? "Provisional" : "Not analysed"}
      </span>
    );
  }
  const s = BAND_STYLES[band];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium",
        s.soft,
        s.ink,
        size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-2xs",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", s.solid)} />
      {BAND_LABELS[band]}
    </span>
  );
}
