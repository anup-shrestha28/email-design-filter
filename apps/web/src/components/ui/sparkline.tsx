import { cn } from "@/lib/cn";

/** Tiny trend line (no axes). Nulls break the line. Decorative unless a label is given. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  min = 0,
  max = 100,
  label,
  className,
  color = "var(--accent)",
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
  min?: number;
  max?: number;
  label?: string;
  className?: string;
  color?: string;
}) {
  const pad = 2;
  const n = values.length;
  if (n === 0) return null;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1));
  const y = (v: number) => height - pad - ((v - min) / Math.max(1, max - min)) * (height - pad * 2);
  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const lastIndex = values.findLastIndex((v) => v !== null);
  const last = lastIndex >= 0 ? values[lastIndex] : null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {segments.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {last !== null && last !== undefined ? (
        <circle
          cx={x(lastIndex)}
          cy={y(last)}
          r={2.5}
          fill={color}
          stroke="var(--surface)"
          strokeWidth={1.5}
        />
      ) : null}
    </svg>
  );
}
