"use client";
import { useDateDisplay } from "@/components/providers/clock";
import { cn } from "@/lib/cn";
import { formatFullDateTime, formatListTime, formatRelative, formatShortDate } from "@/lib/format";

type Variant = "list" | "relative" | "full" | "short";

/**
 * Locale- and time-zone-aware, hydration-safe time text. While the device's zone is still unknown
 * (its first visit), the text keeps its space but stays invisible until the browser's zone is used,
 * so a time never shows in UTC and then jumps.
 */
export function Time({
  iso,
  variant = "relative",
  className,
  withTitle = true,
}: {
  iso: string;
  variant?: Variant;
  className?: string;
  withTitle?: boolean;
}) {
  const { context: c, pending } = useDateDisplay();
  const text =
    variant === "list"
      ? formatListTime(iso, c)
      : variant === "full"
        ? formatFullDateTime(iso, c)
        : variant === "short"
          ? formatShortDate(iso, c)
          : formatRelative(iso, c);
  return (
    <time
      dateTime={iso}
      className={cn(className, pending && "invisible")}
      title={withTitle && variant !== "full" && !pending ? formatFullDateTime(iso, c) : undefined}
    >
      {text}
    </time>
  );
}
