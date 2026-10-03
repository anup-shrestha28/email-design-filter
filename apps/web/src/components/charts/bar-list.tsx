import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Horizontal labelled bars (HTML): fonts, issues, senders. Values are always printed. */
export function BarList({
  items,
  max,
  color = "var(--accent)",
  format = (n: number) => String(n),
  className,
}: {
  items: Array<{ key: string; label: ReactNode; value: number; color?: string; href?: string }>;
  max?: number;
  color?: string;
  format?: (n: number) => string;
  className?: string;
}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {items.map((i) => (
        <li
          key={i.key}
          className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[0.8125rem]"
        >
          <span className="truncate text-foreground">{i.label}</span>
          <span className="relative h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
            <span
              className="absolute inset-y-0 left-0 origin-left rounded-full"
              style={{
                width: `${Math.max(2, (i.value / top) * 100)}%`,
                background: i.color ?? color,
                animation: "bar-grow 700ms var(--ease-out-quint) both",
              }}
            />
          </span>
          <span className="tabular min-w-8 text-right text-xs text-muted-foreground">
            {format(i.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}
