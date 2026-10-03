"use client";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useNow } from "@/components/providers/clock";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";

/** One heartbeat row: relative time, warning when older than `maxAgeMs` (or never). */
export function Heartbeat({
  label,
  at,
  maxAgeMs,
}: {
  label: string;
  at: string | null;
  maxAgeMs: number | null;
}) {
  const now = useNow();
  const stale = at === null || (maxAgeMs !== null && now - Date.parse(at) > maxAgeMs);
  const warn = maxAgeMs !== null && stale;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-[0.8125rem]">
      <span className="flex items-center gap-2 text-foreground">
        {warn ? (
          <TriangleAlert className="size-4 text-warning" aria-label="Late" />
        ) : (
          <CircleCheck
            className={cn("size-4", at ? "text-success" : "text-subtle-foreground")}
            aria-hidden
          />
        )}
        {label}
      </span>
      <span className={cn("text-xs", warn ? "font-medium text-warning" : "text-muted-foreground")}>
        {at ? <Time iso={at} variant="relative" /> : "never"}
      </span>
    </div>
  );
}
