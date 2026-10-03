"use client";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { KeyCombo } from "./kbd";

export const TooltipProvider = BaseTooltip.Provider;

interface TooltipProps {
  content: ReactNode;
  /** The trigger element; must accept a ref and forward props (buttons, links, spans). */
  children: ReactElement<Record<string, unknown>>;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}

/** Supplementary hover/focus label. Never put essential information only here. */
export function Tooltip({
  content,
  children,
  shortcut,
  side = "top",
  align = "center",
  className,
}: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={6} className="z-[70]">
          <BaseTooltip.Popup
            className={cn(
              "flex max-w-72 origin-[var(--transform-origin)] items-center gap-2 rounded-md bg-inverse px-2 py-1 text-xs leading-snug font-medium text-inverse-foreground shadow-overlay transition-[transform,opacity] duration-100 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0",
              className,
            )}
          >
            <span>{content}</span>
            {shortcut ? (
              <KeyCombo
                keys={shortcut}
                className="[&_kbd]:border-transparent [&_kbd]:bg-white/15 [&_kbd]:text-inverse-foreground [&_kbd]:shadow-none"
              />
            ) : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
