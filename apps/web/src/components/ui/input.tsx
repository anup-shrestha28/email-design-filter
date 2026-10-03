import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2.5 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-subtle-foreground hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_25%,transparent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputClass, className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label className={cn("text-[0.8125rem] font-medium text-foreground", className)} {...props} />
  );
}
