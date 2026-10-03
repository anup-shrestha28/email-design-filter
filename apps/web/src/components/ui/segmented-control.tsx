"use client";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Accessible label when `label` is an icon. */
  ariaLabel?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}

/** Single-choice toggle group (never empty: pressing the active segment keeps it). */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  disabled,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const v = next[0] as T | undefined;
        if (v && v !== value) onValueChange(v);
      }}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5 ring-1 ring-inset ring-border",
        className,
      )}
      aria-label={props["aria-label"]}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap text-muted-foreground transition-[background-color,color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring data-pressed:bg-surface data-pressed:text-foreground data-pressed:shadow-raised dark:data-pressed:bg-surface-muted [&_svg]:size-3.5",
            size === "md" ? "h-7 px-2.5 text-[0.8125rem]" : "h-6 px-2 text-xs",
          )}
        >
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
