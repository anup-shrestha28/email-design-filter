"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/cn";

export const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11 } as const;
export const GRID_STROKE = "var(--chart-grid)";

export function useAnimate(): boolean {
  return !useMediaQuery("(prefers-reduced-motion: reduce)");
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

/** Tooltip card in our tokens; text in ink colours, the swatch carries identity. */
export function TooltipCard({
  title,
  rows,
  footer,
}: {
  title?: string;
  rows: TooltipRow[];
  footer?: string;
}) {
  return (
    <div className="min-w-40 rounded-lg border border-border bg-surface-overlay px-3 py-2 text-xs shadow-overlay">
      {title ? <p className="mb-1.5 font-medium text-foreground">{title}</p> : null}
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.color ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: r.color }}
              />
            ) : null}
            <span className="flex-1 text-muted-foreground">{r.label}</span>
            <span className="tabular font-medium text-foreground">{r.value}</span>
          </li>
        ))}
      </ul>
      {footer ? (
        <p className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">{footer}</p>
      ) : null}
    </div>
  );
}

export function Legend({
  items,
  className,
}: {
  items: Array<{ label: string; color: string }>;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground", className)}>
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** "Show data": the table view behind every chart (never colour-only, screen-reader friendly). */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <Collapsible.Root className="mt-3">
      <Collapsible.Trigger className="group inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight
          className="size-3.5 transition-transform group-data-panel-open:rotate-90"
          aria-hidden
        />
        Show data
      </Collapsible.Trigger>
      <Collapsible.Panel className="[&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <caption className="sr-only">{caption}</caption>
            <thead className="sticky top-0 bg-surface-muted text-muted-foreground">
              <tr>
                {columns.map((c, i) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(
                      "px-2.5 py-1.5 font-medium",
                      i === 0 ? "text-left" : "text-right",
                    )}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        "px-2.5 py-1.5",
                        ci === 0
                          ? "text-left text-foreground"
                          : "tabular text-right text-muted-foreground",
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
