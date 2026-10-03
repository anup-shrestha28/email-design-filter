import { useId } from "react";
import { cn } from "@/lib/cn";

/** Logo mark: an envelope with a score tick. Pure SVG, inherits colour where useful. */
export function LogoMark({ className }: { className?: string }) {
  // Unique per instance: a gradient defined inside a hidden (display:none) copy wouldn't paint.
  const gradient = `edf-g-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7 shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c6cf7" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradient})`} />
      <rect
        x="7"
        y="9.5"
        width="18"
        height="13"
        rx="2.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
      />
      <path
        d="M8 11l8 6 8-6"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="23.5" cy="22.5" r="4.6" fill="#22c55e" stroke="#4f46e5" strokeWidth="1.4" />
      <path
        d="M21.6 22.6l1.3 1.3 2.3-2.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-[0.9375rem] font-semibold tracking-[-0.02em] text-foreground">
            Email Design
          </span>
          <span className="mt-0.5 text-2xs font-medium tracking-[0.12em] text-subtle-foreground uppercase">
            Filter
          </span>
        </span>
      )}
    </span>
  );
}
