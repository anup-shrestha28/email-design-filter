import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

export const badgeVariants = cva(
  "inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-sm font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-surface-muted text-muted-foreground ring-1 ring-inset ring-border",
        outline: "text-muted-foreground ring-1 ring-inset ring-border",
        accent: "bg-accent-soft text-accent-soft-foreground",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        info: "bg-info-soft text-info",
        solid: "bg-inverse text-inverse-foreground",
      },
      size: {
        sm: "h-[1.125rem] px-1.5 text-2xs",
        md: "h-5 px-1.5 text-xs",
        lg: "h-6 px-2 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
