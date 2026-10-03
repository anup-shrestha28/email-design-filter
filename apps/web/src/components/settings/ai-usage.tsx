import { Sparkles } from "lucide-react";
import { MeterBar } from "@/components/ui/progress";
import { formatUsd } from "@/lib/format";
import type { SettingsData } from "@/server/queries/types";

export function AiUsage({ ai }: { ai: SettingsData["ai"] }) {
  const ratio = ai.monthCapUsd > 0 ? ai.spentThisMonthUsd / ai.monthCapUsd : 0;
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border border-border bg-surface p-4 shadow-raised sm:p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">This month</h3>
          <span className="tabular text-xs text-muted-foreground">
            <span className="text-base font-semibold text-foreground">
              {formatUsd(ai.spentThisMonthUsd)}
            </span>{" "}
            of {formatUsd(ai.monthCapUsd)}
          </span>
        </div>
        <MeterBar
          className="mt-3"
          value={ai.spentThisMonthUsd}
          max={ai.monthCapUsd}
          label="AI spend this month"
          valueText={`${formatUsd(ai.spentThisMonthUsd)} of ${formatUsd(ai.monthCapUsd)}`}
        />
        <p className="mt-2 text-xs text-subtle-foreground">
          {ratio >= 1
            ? "The monthly cap is reached: AI reviews pause until next month. Scores still work."
            : `Daily limit ${formatUsd(ai.dayCapUsd)}. When a cap is reached, AI reviews pause — they never overspend.`}
        </p>
      </section>
      <section className="flex gap-3 rounded-xl border border-border bg-surface-muted/50 p-4 sm:p-5">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">What the AI does</p>
          <p className="mt-1">
            Claude (by Anthropic) reviews how clear an email&apos;s layout, imagery and copy are,
            and classifies mail our rules can&apos;t. It contributes at most 14 of the 100 design
            points, and every AI item is labelled “AI review”. Security emails are never sent to AI.
          </p>
        </div>
      </section>
    </div>
  );
}
