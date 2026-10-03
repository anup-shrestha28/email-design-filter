"use client";
import { CartesianGrid, Line, LineChart, ReferenceArea, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_TICK, DataTable, GRID_STROKE, TooltipCard, useAnimate } from "./chart-kit";

function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y ?? 2026, (mo ?? 1) - 1, 1)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

/** Average design score by month, with the band ranges as quiet backgrounds. */
export function DesignTrendChart({
  data,
}: {
  data: Array<{ month: string; avgScore: number | null; count: number }>;
}) {
  const animate = useAnimate();
  const rows = data.map((d) => ({ ...d, label: monthLabel(d.month) }));
  return (
    <div>
      <LineChart
        responsive
        data={rows}
        margin={{ top: 8, right: 8, bottom: 0, left: -18 }}
        style={{ width: "100%", height: 220 }}
        title="Average design score by month"
      >
        <ReferenceArea
          y1={85}
          y2={100}
          fill="var(--band-excellent)"
          fillOpacity={0.07}
          ifOverflow="extendDomain"
        />
        <ReferenceArea y1={70} y2={85} fill="var(--band-good)" fillOpacity={0.06} />
        <ReferenceArea y1={50} y2={70} fill="var(--band-needs-work)" fillOpacity={0.06} />
        <ReferenceArea y1={0} y2={50} fill="var(--band-poor)" fillOpacity={0.05} />
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 70, 85, 100]}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)" }}
          content={({ active, payload }) => {
            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
            if (!active || !p) return null;
            return (
              <TooltipCard
                title={p.label}
                rows={[
                  {
                    label: "Average score",
                    value: p.avgScore === null ? "—" : String(p.avgScore),
                    color: "var(--accent)",
                  },
                  { label: "Emails", value: String(p.count) },
                ]}
              />
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="avgScore"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={{ r: 3.5, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }}
          activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
          connectNulls
          isAnimationActive={animate}
        />
      </LineChart>
      <DataTable
        caption="Average design score by month"
        columns={["Month", "Average score", "Emails"]}
        rows={rows.map((r) => [r.label, r.avgScore ?? "—", r.count])}
      />
    </div>
  );
}
