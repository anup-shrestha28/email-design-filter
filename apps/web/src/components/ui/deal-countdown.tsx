"use client";
import { Tag, Timer } from "lucide-react";
import { useNow } from "@/components/providers/clock";
import { cn } from "@/lib/cn";
import { formatCountdown } from "@/lib/format";

/** Live "ends in 5h" for deals. Undated deals just say "Deal". */
export function DealCountdown({
  endsAt,
  hasCode = false,
  size = "md",
  hideEnded = false,
  className,
}: {
  endsAt: string | null;
  hasCode?: boolean;
  size?: "sm" | "md";
  /** In lists, an expired deal is noise: render nothing. */
  hideEnded?: boolean;
  className?: string;
}) {
  const now = useNow();
  const c = endsAt ? formatCountdown(endsAt, now) : null;
  if (hideEnded && c?.ended) return null;
  const Icon = c && !c.ended ? Timer : Tag;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm font-medium whitespace-nowrap",
        size === "md" ? "h-5 px-1.5 text-xs" : "h-[1.125rem] px-1 text-2xs",
        c?.urgent
          ? "bg-warning-soft text-warning"
          : c?.ended
            ? "text-subtle-foreground line-through"
            : "bg-surface-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className={size === "md" ? "size-3" : "size-2.5"} aria-hidden />
      <span>{c ? (c.ended ? "Deal ended" : c.text) : "Deal"}</span>
      {hasCode && !c?.ended ? <span className="opacity-70">· code</span> : null}
    </span>
  );
}
