"use client";
import { Meter as BaseMeter } from "@base-ui/react/meter";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { cn } from "@/lib/cn";

type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

const TONE: Record<Tone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-band-needs-work",
  danger: "bg-danger",
  neutral: "bg-subtle-foreground",
};

/** Task progress (import, queue). `value` null = indeterminate. */
export function ProgressBar({
  value,
  max = 100,
  label,
  className,
  tone = "accent",
}: {
  value: number | null;
  max?: number;
  label: string;
  className?: string;
  tone?: Tone;
}) {
  return (
    <BaseProgress.Root
      value={value}
      max={max}
      aria-label={label}
      className={cn("w-full", className)}
    >
      <BaseProgress.Track className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border/60">
        <BaseProgress.Indicator
          className={cn(
            "block h-full rounded-full transition-[width] duration-500 ease-out-quint data-indeterminate:w-1/3 data-indeterminate:animate-pulse",
            TONE[tone],
          )}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}

/** A measured quantity within a known range (spend vs cap, resource vs limit). */
export function MeterBar({
  value,
  max,
  label,
  valueText,
  className,
  tone,
  marker,
}: {
  value: number;
  max: number;
  label: string;
  valueText?: string;
  className?: string;
  tone?: Tone;
  /** Optional marker position (0..max), e.g. the self-cap on a hard-limit bar. */
  marker?: { at: number; label: string };
}) {
  const ratio = max > 0 ? value / max : 0;
  const auto: Tone = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "accent";
  return (
    <BaseMeter.Root
      value={Math.min(value, max)}
      max={max}
      aria-label={label}
      aria-valuetext={valueText}
      className={cn("w-full", className)}
    >
      <BaseMeter.Track className="relative h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border/60">
        <BaseMeter.Indicator
          className={cn(
            "block h-full rounded-full transition-[width] duration-500 ease-out-quint",
            TONE[tone ?? auto],
          )}
        />
        {marker && max > 0 ? (
          <span
            aria-hidden
            title={marker.label}
            className="absolute top-0 h-full w-0.5 bg-foreground/60"
            style={{ left: `${Math.min(100, (marker.at / max) * 100)}%` }}
          />
        ) : null}
      </BaseMeter.Track>
    </BaseMeter.Root>
  );
}
