import type { DesignBand } from "@edf/design/types";
import { cn } from "@/lib/cn";
import type { Verdict } from "@/lib/gallery";
import { BAND_STYLES } from "./band-pill";

/** The band colour each verdict is drawn in (the verdict badge uses the same three). */
const VERDICT_BAND = { good: "excellent", ok: "needs_work", bad: "poor" } as const;

/** Large animated score ring for the Design Score panel. */
export function ScoreRing({
  score,
  raw,
  band,
  provisional = false,
  verdict,
  size = 132,
  className,
}: {
  score: number;
  /** Uncapped raw score; drawn as a faint dashed arc when capped. */
  raw?: number | null;
  band: DesignBand | null;
  provisional?: boolean;
  /**
   * The gallery's word for this design. When given, the ring takes the verdict's colour (green
   * Good, amber Okay, red Bad) so it always matches the verdict badge beside it.
   */
  verdict?: Verdict;
  size?: number;
  className?: string;
}) {
  const stroke = Math.max(6, Math.round(size / 13));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const rawPct = raw !== null && raw !== undefined ? Math.max(0, Math.min(100, raw)) / 100 : null;
  const color =
    verdict && verdict !== "unscored"
      ? BAND_STYLES[VERDICT_BAND[verdict]].stroke
      : provisional || !band
        ? "var(--band-provisional)"
        : BAND_STYLES[band].stroke;
  return (
    <div
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-sunken)"
          strokeWidth={stroke}
        />
        {rawPct !== null && rawPct > pct ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={stroke}
            strokeDasharray={`${c * rawPct} ${c}`}
            strokeLinecap="round"
            opacity={0.9}
          />
        ) : null}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={
            {
              "--ring-c": c,
              animation: "ring-fill 1s var(--ease-out-quint) both",
            } as React.CSSProperties
          }
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="tabular leading-none font-semibold tracking-[-0.04em] text-foreground"
          style={{ fontSize: size * 0.3 }}
        >
          {score}
        </span>
        <span className="mt-1 text-2xs font-medium text-subtle-foreground">of 100</span>
      </div>
    </div>
  );
}
