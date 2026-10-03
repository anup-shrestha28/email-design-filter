"use client";
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useId, useMemo } from "react";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";

export interface ComboboxOption {
  value: string;
  label: string;
  count?: number;
}

interface MultiComboboxProps {
  label: string;
  hideLabel?: boolean;
  options: ReadonlyArray<ComboboxOption>;
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  className?: string;
}

/** Searchable multi-select with counts ("Montserrat (41)"), chips for the selection. */
export function MultiCombobox({
  label,
  hideLabel,
  options,
  value,
  onValueChange,
  placeholder = "Search…",
  emptyText = "No matches.",
  className,
}: MultiComboboxProps) {
  const id = useId();
  const items = useMemo(() => [...options], [options]);
  const selected = useMemo(() => {
    const byValue = new Map(items.map((o) => [o.value, o]));
    return value.map((v) => byValue.get(v) ?? { value: v, label: v });
  }, [items, value]);

  return (
    <BaseCombobox.Root
      items={items}
      multiple
      value={selected}
      onValueChange={(next) => onValueChange((next as ComboboxOption[]).map((o) => o.value))}
      isItemEqualToValue={(a: ComboboxOption, b: ComboboxOption) => a.value === b.value}
      itemToStringLabel={(o: ComboboxOption) => o.label}
    >
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label
          htmlFor={id}
          className={cn("text-xs font-medium text-muted-foreground", hideLabel && "sr-only")}
        >
          {label}
        </label>
        <BaseCombobox.InputGroup className="flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_25%,transparent)] hover:border-border-strong">
          <BaseCombobox.Chips
            className="flex w-full flex-wrap items-center gap-1"
            aria-label={selected.length ? `Selected ${label.toLowerCase()}` : undefined}
          >
            {selected.map((o) => (
              <BaseCombobox.Chip
                key={o.value}
                aria-label={o.label}
                className="flex h-5 cursor-default items-center gap-0.5 rounded-sm bg-accent-soft pr-0.5 pl-1.5 text-xs font-medium text-accent-soft-foreground outline-none data-highlighted:ring-2 data-highlighted:ring-ring"
              >
                {o.label}
                <BaseCombobox.ChipRemove
                  aria-label={`Remove ${o.label}`}
                  className="flex size-4 items-center justify-center rounded-xs hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <X className="size-3" aria-hidden />
                </BaseCombobox.ChipRemove>
              </BaseCombobox.Chip>
            ))}
            <BaseCombobox.Input
              id={id}
              placeholder={selected.length ? "" : placeholder}
              className="h-5 min-w-16 flex-1 border-0 bg-transparent px-1 text-[0.8125rem] text-foreground outline-none placeholder:text-subtle-foreground"
            />
            <BaseCombobox.Trigger
              aria-label={`Show ${label.toLowerCase()}`}
              className="ml-auto flex size-5 items-center justify-center rounded-sm text-subtle-foreground hover:text-foreground"
            >
              <ChevronsUpDown className="size-3.5" aria-hidden />
            </BaseCombobox.Trigger>
          </BaseCombobox.Chips>
        </BaseCombobox.InputGroup>
      </div>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner className="z-[60] outline-none" sideOffset={4}>
          <BaseCombobox.Popup className="max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] min-w-56 origin-[var(--transform-origin)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface-overlay p-1 text-foreground shadow-overlay transition-[transform,opacity] duration-150 ease-out-quint data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <BaseCombobox.Empty>
              <div className="px-2 py-2 text-[0.8125rem] text-muted-foreground">{emptyText}</div>
            </BaseCombobox.Empty>
            <BaseCombobox.List>
              {(o: ComboboxOption) => (
                <BaseCombobox.Item
                  key={o.value}
                  value={o}
                  className="grid h-8 cursor-default grid-cols-[1rem_1fr_auto] items-center gap-2 rounded-md px-2 text-[0.8125rem] outline-none select-none data-highlighted:bg-surface-muted"
                >
                  <BaseCombobox.ItemIndicator className="flex text-accent">
                    <Check className="size-3.5" aria-hidden />
                  </BaseCombobox.ItemIndicator>
                  <span className="col-start-2 truncate">{o.label}</span>
                  {o.count !== undefined ? (
                    <span className="tabular text-xs text-subtle-foreground">
                      {formatNumber(o.count)}
                    </span>
                  ) : null}
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
