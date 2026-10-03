"use client";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Kbd } from "./kbd";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuSubmenu = Menu.SubmenuRoot;

const popupClass =
  "min-w-44 max-w-[min(20rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] overflow-y-auto rounded-lg border border-border bg-surface-overlay p-1 text-sm text-foreground shadow-overlay outline-none transition-[transform,opacity] duration-150 ease-out-quint data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 max-h-[var(--available-height)]";

const itemClass =
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[0.8125rem] text-foreground outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-surface-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

interface ContentProps extends ComponentProps<typeof Menu.Popup> {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

export function DropdownMenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: ContentProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-[60] outline-none"
      >
        <Menu.Popup className={cn(popupClass, className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

interface ItemProps extends ComponentProps<typeof Menu.Item> {
  icon?: ReactNode;
  shortcut?: string;
  tone?: "default" | "danger";
}

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  tone = "default",
  children,
  ...props
}: ItemProps) {
  return (
    <Menu.Item
      className={cn(itemClass, tone === "danger" && "text-danger [&_svg]:text-danger", className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </Menu.Item>
  );
}

export function DropdownMenuLinkItem({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof Menu.LinkItem> & { icon?: ReactNode }) {
  return (
    <Menu.LinkItem className={cn(itemClass, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Menu.LinkItem>
  );
}

export function DropdownMenuRadioGroup(props: ComponentProps<typeof Menu.RadioGroup>) {
  return <Menu.RadioGroup {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  icon,
  ...props
}: ComponentProps<typeof Menu.RadioItem> & { icon?: ReactNode }) {
  return (
    <Menu.RadioItem className={cn(itemClass, "pr-8", className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Menu.RadioItemIndicator className="absolute right-2 flex">
        <Check className="!text-accent" aria-hidden />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(itemClass, "pr-8", className)} {...props}>
      <span className="min-w-0 flex-1">{children}</span>
      <Menu.CheckboxItemIndicator className="absolute right-2 flex">
        <Check className="!text-accent" aria-hidden />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuSubmenuTrigger({
  className,
  children,
  icon,
  ...props
}: ComponentProps<typeof Menu.SubmenuTrigger> & { icon?: ReactNode }) {
  return (
    <Menu.SubmenuTrigger
      className={cn(itemClass, "data-popup-open:bg-surface-muted", className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden />
    </Menu.SubmenuTrigger>
  );
}

export function DropdownMenuSubmenuContent({
  className,
  ...props
}: ComponentProps<typeof Menu.Popup>) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        side="right"
        align="start"
        sideOffset={4}
        alignOffset={-4}
        className="z-[61] outline-none"
      >
        <Menu.Popup className={cn(popupClass, className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.GroupLabel>) {
  return (
    <Menu.GroupLabel
      className={cn(
        "px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-subtle-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}
