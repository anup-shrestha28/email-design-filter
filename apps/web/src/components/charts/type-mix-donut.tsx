"use client";
import type { TypeGroup } from "@edf/core/types";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { TYPE_GROUP_COLOR } from "@/components/ui/type-chip";
import { TYPE_GROUP_LABELS } from "@/lib/filters";
import { formatNumber, formatPercent } from "@/lib/format";
import { TYPE_GROUP_ORDER } from "@/lib/labels";
import { TooltipCard, useAnimate } from "./chart-kit";

/** Type mix: donut with a labelled legend list (identity never by colour alone). */
export function TypeMixDonut({
  data,
  size = 168,
}: {
  data: Array<{ group: TypeGroup; count: number }>;
  size?: number;
}) {
  const animate = useAnimate();
  const ordered = TYPE_GROUP_ORDER.map((g) => ({
    group: g,
    count: data.find((d) => d.group === g)?.count ?? 0,
  })).filter((d) => d.count > 0);
  const total = ordered.reduce((a, d) => a + d.count, 0);
  if (total === 0)
    return <p className="text-[0.8125rem] text-muted-foreground">No mail in this period.</p>;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <PieChart width={size} height={size} title="Mail by type">
          <Pie
            data={ordered}
            dataKey="count"
            nameKey="group"
            innerRadius={size * 0.32}
            outerRadius={size * 0.48}
            paddingAngle={1.5}
            stroke="var(--surface)"
            strokeWidth={2}
            isAnimationActive={animate}
          >
            {ordered.map((d) => (
              <Cell key={d.group} fill={TYPE_GROUP_COLOR[d.group]} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof ordered)[number] | undefined;
              if (!active || !p) return null;
              return (
                <TooltipCard
                  rows={[
                    {
                      label: TYPE_GROUP_LABELS[p.group],
                      value: `${formatNumber(p.count)} · ${formatPercent(p.count / total)}`,
                      color: TYPE_GROUP_COLOR[p.group],
                    },
                  ]}
                />
              );
            }}
          />
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tabular text-xl font-semibold tracking-[-0.02em] text-foreground">
            {formatNumber(total)}
          </span>
          <span className="text-2xs text-subtle-foreground">emails</span>
        </div>
      </div>
      <ul className="grid w-full flex-1 gap-1.5 text-[0.8125rem]">
        {ordered.map((d) => (
          <li key={d.group} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: TYPE_GROUP_COLOR[d.group] }}
            />
            <span className="flex-1 truncate text-foreground">{TYPE_GROUP_LABELS[d.group]}</span>
            <span className="tabular text-xs text-muted-foreground">
              {formatPercent(d.count / total)}
            </span>
            <span className="tabular w-10 text-right text-xs font-medium text-foreground">
              {formatNumber(d.count)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
