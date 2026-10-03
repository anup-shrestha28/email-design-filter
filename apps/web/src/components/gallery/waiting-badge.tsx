"use client";
import { CircleAlert, CircleSlash, Clock, LoaderCircle, Pause, Unplug } from "lucide-react";
import { useDateDisplay } from "@/components/providers/clock";
import { cn } from "@/lib/cn";
import { waitingCopy, type WaitingCopy } from "@/lib/gallery-copy";
import type { Waiting } from "@/lib/gallery-waiting";

/**
 * The words for an unscored design (lib/gallery-copy.ts `waitingCopy`), in the viewer's own zone.
 * `pending`: the zone isn't known yet (first visit, before hydration) — times stay invisible.
 */
export function useWaitingCopy(
  waiting: Waiting | null | undefined,
): WaitingCopy & { pending: boolean } {
  const { context, pending } = useDateDisplay();
  const timed = waiting?.state === "scheduled" || waiting?.state === "retry";
  return { ...waitingCopy(waiting, context), pending: pending && timed };
}

function iconFor(waiting: Waiting | null | undefined) {
  switch (waiting?.state) {
    case "scoring":
      return <LoaderCircle aria-hidden strokeWidth={2.75} className="motion-safe:animate-spin" />;
    case "paused":
    case "off":
      return <Pause aria-hidden strokeWidth={2.75} />;
    case "mailbox":
      return <Unplug aria-hidden strokeWidth={2.75} />;
    case "failed":
      return <CircleAlert aria-hidden strokeWidth={2.75} />;
    case "unscorable":
      return <CircleSlash aria-hidden strokeWidth={2.75} />;
    default:
      return <Clock aria-hidden strokeWidth={2.75} />;
  }
}

/**
 * The badge in an unscored card's verdict spot, the same shape as VerdictBadge's (so a score that
 * arrives later changes nothing's size): "Scoring now" (spinning), "Scoring soon", "No score"
 * (nothing to measure), else "Not scored yet". `size="lg"` is the detail view's.
 */
export function WaitingBadge({
  waiting,
  size = "sm",
  className,
}: {
  waiting: Waiting | null | undefined;
  size?: "sm" | "lg";
  className?: string;
}) {
  const { badge } = useWaitingCopy(waiting);
  return (
    <span
      data-verdict="unscored"
      data-waiting={waiting?.state ?? "unknown"}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-surface-muted font-semibold whitespace-nowrap text-muted-foreground",
        waiting?.state === "scoring" || waiting?.state === "soon"
          ? "text-accent-soft-foreground bg-accent-soft"
          : null,
        size === "sm"
          ? "h-6 gap-1 px-2 text-xs [&_svg]:size-3"
          : "h-8 gap-1.5 px-3 text-sm [&_svg]:size-4",
        className,
      )}
    >
      {iconFor(waiting)}
      <span>{badge}</span>
    </span>
  );
}
