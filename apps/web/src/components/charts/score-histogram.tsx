"use client";
import type { DesignBand } from "@edf/design/types";
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from "recharts";
import { BAND_LABELS } from "@/lib/labels";
import { formatNumber } from "@/lib/format";
import { AXIS_TICK, DataTable, GRID_STROKE, Legend, TooltipCard, useAnimate } from "./chart-kit";

const BAND_COLOR: Record<DesignBand, string> = {
  excellent: "var(--band-excellent)",
  good: "var(--band-good)",
  needs_work: "var(--band-needs-work)",
  poor: "var(--band-poor)",
};

/** Distribution of design scores, each bucket coloured by its band (with the band named in the legend). */
export function ScoreHistogram({
  data,
}: {
  data: Array<{ bucket: string; count: number; band: DesignBand }>;
}) {
  const animate = useAnimate();
  return (
    <div>
      <Legend
        className="mb-3"
        items={(["poor", "needs_work", "good", "excellent"] as const).map((b) => ({
          label: BAND_LABELS[b],
          color: BAND_COLOR[b],
        }))}
      />
      <BarChart
        responsive
        data={data}
        margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
        style={{ width: "100%", height: 220 }}
        title="Design score distribution"
        barCategoryGap="14%"
      >
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey="bucket" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={0} />
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
            const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
            if (!active || !p) return null;
            return (
              <TooltipCard
                title={`Score ${p.bucket}`}
                rows={[
                  {
                    label: BAND_LABELS[p.band],
                    value: `${formatNumber(p.count)} emails`,
                    color: BAND_COLOR[p.band],
                  },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={animate}>
          {data.map((d) => (
            <Cell key={d.bucket} fill={BAND_COLOR[d.band]} />
          ))}
        </Bar>
      </BarChart>
      <DataTable
        caption="Design score distribution"
        columns={["Score", "Band", "Emails"]}
        rows={data.map((d) => [d.bucket, BAND_LABELS[d.band], d.count])}
      />
    </div>
  );
}
