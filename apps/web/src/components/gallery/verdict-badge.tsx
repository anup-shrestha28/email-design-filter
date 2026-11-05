import { Check, Clock, Minus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { VERDICT_LABELS, type Verdict } from "@/lib/gallery";
import { VERDICT_SHORT } from "@/lib/gallery-copy";

/**
 * One colour per verdict, with its word and icon (green Good, amber Okay, red Bad). The solid
 * pills use the feedback tokens made for text (as the danger button does), at least 4.5:1 in both
 * themes: white on success 5.2:1 and on danger 5.9:1, dark text on their dark-theme shades 8.9:1
 * and 6.6:1 (the band colours, for marks and rings, gave white text only 4.0:1 and 4.4:1).
 */
const STYLE: Record<Verdict, { className: string; icon: typeof Check }> = {
  good: { className: "bg-success text-white dark:text-[oklch(0.18_0.03_150)]", icon: Check },
  bad: { className: "bg-danger text-white dark:text-[oklch(0.18_0.03_25)]", icon: X },
  ok: {
    className:
      "bg-band-needs-work-soft text-band-needs-work-ink ring-1 ring-inset ring-band-needs-work/45",
    icon: Minus,
  },
  unscored: { className: "bg-surface-muted text-muted-foreground", icon: Clock },
};

/**
 * The verdict: always a word (colour is never the only signal) and an icon. No number: the verdict
 * comes from the design checklist, not the 0–100 score (lib/gallery.ts VERDICT POLICY), so a score
 * beside it could argue with it; the card's line says how many rules it missed.
 * `size="lg"` is the detail view's larger badge, which spells the verdict out in full.
 */
export function VerdictBadge({
  verdict,
  size = "sm",
  className,
}: {
  verdict: Verdict;
  size?: "sm" | "lg";
  className?: string;
}) {
  const s = STYLE[verdict];
  const Icon = s.icon;
  return (
    <span
      data-verdict={verdict}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-semibold whitespace-nowrap",
        size === "sm"
          ? "h-6 gap-1 px-2 text-xs [&_svg]:size-3"
          : "h-8 gap-1.5 px-3 text-sm [&_svg]:size-4",
        s.className,
        className,
      )}
    >
      <Icon aria-hidden strokeWidth={2.75} />
      <span>{size === "lg" ? VERDICT_LABELS[verdict] : VERDICT_SHORT[verdict]}</span>
    </span>
  );
}
