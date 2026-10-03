"use client";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  "aria-describedby"?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  className,
  size = "md",
  ...props
}: SwitchProps) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v)}
      className={cn(
        "relative flex shrink-0 items-center rounded-full bg-border-strong p-0.5 transition-colors duration-150 ease-out data-checked:bg-accent data-disabled:opacity-50",
        size === "md" ? "h-5 w-9" : "h-4 w-7",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-150 ease-out-quint",
          size === "md" ? "size-4 data-checked:translate-x-4" : "size-3 data-checked:translate-x-3",
        )}
      />
    </BaseSwitch.Root>
  );
}
