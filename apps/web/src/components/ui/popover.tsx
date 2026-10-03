"use client";
import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

interface PopoverContentProps extends ComponentProps<typeof BasePopover.Popup> {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

export function PopoverContent({
  className,
  side = "bottom",
  align = "center",
  sideOffset = 6,
  ...props
}: PopoverContentProps) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[60]">
        <BasePopover.Popup
          className={cn(
            "max-w-[min(22rem,calc(100vw-2rem))] origin-[var(--transform-origin)] rounded-lg border border-border bg-surface-overlay p-3 text-sm text-foreground shadow-overlay outline-none transition-[transform,opacity] duration-150 ease-out-quint data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
