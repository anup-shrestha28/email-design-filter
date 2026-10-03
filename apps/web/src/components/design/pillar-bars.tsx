import type { PillarId } from "@edf/design/types";
import { cn } from "@/lib/cn";
import { formatPoints } from "@/lib/format";
import { PILLAR_LABELS, PILLAR_SHORT } from "@/lib/labels";

function ratioTone(r: number): string {
  if (r >= 0.85) return "bg-band-excellent";
  if (r >= 0.7) return "bg-band-good";
  if (r >= 0.5) return "bg-band-needs-work";
  return "bg-band-poor";
}

/** Pillar breakdown: points / effective maximum. The rows add up to the raw score. */
export function PillarBars({
  pillars,
  raw,
  className,
}: {
  pillars: Array<{ id: PillarId; points: number; max: number }>;
  raw: number | null;
  className?: string;
}) {
  const visible = pillars.filter((p) => p.max > 0.05);
  const total = visible.reduce((a, p) => a + p.points, 0);
  return (
    <div className={className}>
      <ul className="flex flex-col gap-2.5">
        {visible.map((p) => {
          const ratio = p.max > 0 ? p.points / p.max : 0;
          return (
            <li
              key={p.id}
              className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-3 text-[0.8125rem]"
            >
              <span className="truncate text-muted-foreground" title={PILLAR_LABELS[p.id]}>
                {PILLAR_SHORT[p.id]}
              </span>
              <span
                className="relative h-1.5 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border/50"
                role="img"
                aria-label={`${PILLAR_LABELS[p.id]}: ${formatPoints(p.points)} of ${formatPoints(p.max)} points`}
              >
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 origin-left rounded-full",
                    ratioTone(ratio),
                  )}
                  style={{
                    width: `${Math.max(2, ratio * 100)}%`,
                    animation: "bar-grow 800ms var(--ease-out-quint) both",
                  }}
                />
              </span>
              <span className="tabular text-right text-xs whitespace-nowrap text-muted-foreground">
                <span className="font-medium text-foreground">{formatPoints(p.points)}</span>
                <span className="text-subtle-foreground"> / {formatPoints(p.max)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 flex justify-between border-t border-border pt-2.5 text-xs text-subtle-foreground">
        <span>Effective maxima add up to 100</span>
        <span className="tabular">
          Total <span className="font-medium text-foreground">{formatPoints(raw ?? total)}</span>
        </span>
      </p>
    </div>
  );
}
