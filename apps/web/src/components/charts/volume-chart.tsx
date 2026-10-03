"use client";
import type { TypeGroup } from "@edf/core/types";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { TYPE_GROUP_COLOR } from "@/components/ui/type-chip";
import { TYPE_GROUP_LABELS } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { TYPE_GROUP_ORDER } from "@/lib/labels";
import { AXIS_TICK, DataTable, GRID_STROKE, Legend, TooltipCard, useAnimate } from "./chart-kit";

type Week = { week: string } & Partial<Record<TypeGroup, number>>;

function weekLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Weekly volume stacked by type group (fixed colour per group, 1px surface gaps between segments). */
export function VolumeChart({ data }: { data: Week[] }) {
  const animate = useAnimate();
  const groups = TYPE_GROUP_ORDER.filter((g) => data.some((w) => (w[g] ?? 0) > 0));
  const rows = data.map((w) => ({ ...w, label: weekLabel(w.week) }));
  if (rows.length === 0)
    return <p className="text-[0.8125rem] text-muted-foreground">No mail in this period.</p>;
  return (
    <div>
      <Legend
        className="mb-3"
        items={groups.map((g) => ({ label: TYPE_GROUP_LABELS[g], color: TYPE_GROUP_COLOR[g] }))}
      />
      <BarChart
        responsive
        data={rows}
        margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
        style={{ width: "100%", height: 260 }}
        title="Emails per week by type"
        barCategoryGap="22%"
      >
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={18}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          width={44}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-muted)" }}
          content={({ active, payload }) => {
            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
            if (!active || !p) return null;
            const total = groups.reduce((a, g) => a + (p[g] ?? 0), 0);
            return (
              <TooltipCard
                title={`Week of ${p.label}`}
                rows={[...groups]
                  .reverse()
                  .filter((g) => (p[g] ?? 0) > 0)
                  .map((g) => ({
                    label: TYPE_GROUP_LABELS[g],
                    value: formatNumber(p[g] ?? 0),
                    color: TYPE_GROUP_COLOR[g],
                  }))}
                footer={`${formatNumber(total)} emails`}
              />
            );
          }}
        />
        {groups.map((g, i) => (
          <Bar
            key={g}
            dataKey={g}
            stackId="v"
            fill={TYPE_GROUP_COLOR[g]}
            stroke="var(--surface)"
            strokeWidth={1}
            radius={i === groups.length - 1 ? [3, 3, 0, 0] : 0}
            isAnimationActive={animate}
            name={TYPE_GROUP_LABELS[g]}
          />
        ))}
      </BarChart>
      <DataTable
        caption="Emails per week by type"
        columns={["Week", ...groups.map((g) => TYPE_GROUP_LABELS[g]), "Total"]}
        rows={rows.map((r) => [
          r.label,
          ...groups.map((g) => r[g] ?? 0),
          groups.reduce((a, g) => a + (r[g] ?? 0), 0),
        ])}
      />
    </div>
  );
}
