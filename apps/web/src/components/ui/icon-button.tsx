"use client";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { Button, type ButtonVariantProps } from "./button";
import { Tooltip } from "./tooltip";

interface IconButtonProps extends Omit<ComponentProps<"button">, "children">, ButtonVariantProps {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  tooltip?: boolean;
  loading?: boolean;
}

export function IconButton({
  label,
  icon,
  shortcut,
  tooltip = true,
  variant = "ghost",
  size = "icon",
  className,
  ...props
}: IconButtonProps) {
  const button = (
    <Button aria-label={label} variant={variant} size={size} className={cn(className)} {...props}>
      {props.loading ? null : icon}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
}
