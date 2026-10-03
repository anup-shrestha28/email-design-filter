import type { Importance } from "@edf/core/types";
import { cn } from "@/lib/cn";

/** High importance = accent dot. Normal shows nothing; low shows a faint hollow dot. */
export function ImportanceDot({ level, className }: { level: Importance; className?: string }) {
  if (level === "normal") return null;
  return (
    <span
      role="img"
      aria-label={level === "high" ? "High importance" : "Low importance"}
      title={level === "high" ? "High importance" : "Low importance"}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        level === "high"
          ? "bg-accent shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_18%,transparent)]"
          : "border border-subtle-foreground/60",
        className,
      )}
    />
  );
}
