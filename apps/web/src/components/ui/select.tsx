"use client";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "md",
  disabled,
  ...props
}: SelectProps<T>) {
  return (
    <BaseSelect.Root
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={value}
      onValueChange={(v) => {
        if (typeof v === "string") onValueChange(v as T);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        id={props.id}
        aria-label={props["aria-label"]}
        className={cn(
          "flex min-w-32 items-center justify-between gap-2 rounded-md border border-border bg-surface pr-1.5 pl-2.5 text-foreground shadow-xs transition-colors select-none hover:border-border-strong data-disabled:opacity-50 data-popup-open:border-border-strong",
          size === "md" ? "h-8 text-sm" : "h-7 text-[0.8125rem]",
          className,
        )}
      >
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon className="flex text-subtle-foreground">
          <ChevronsUpDown className="size-3.5" aria-hidden />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="z-[60] outline-none select-none"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <BaseSelect.Popup className="min-w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded-lg border border-border bg-surface-overlay p-1 text-foreground shadow-overlay outline-none transition-[transform,opacity] duration-150 ease-out-quint data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <BaseSelect.List className="max-h-[var(--available-height)] overflow-y-auto">
              {options.map((o) => (
                <BaseSelect.Item
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  className="grid h-8 cursor-default grid-cols-[1fr_1rem] items-center gap-3 rounded-md px-2 text-[0.8125rem] outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-muted"
                >
                  <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="flex text-accent">
                    <Check className="size-4" aria-hidden />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
