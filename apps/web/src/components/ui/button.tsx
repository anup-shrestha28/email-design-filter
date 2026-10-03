import Link from "next/link";
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.12)] hover:bg-accent-hover",
        secondary:
          "border border-border bg-surface text-foreground shadow-xs hover:border-border-strong hover:bg-surface-muted",
        ghost: "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        soft: "bg-accent-soft text-accent-soft-foreground hover:bg-[color-mix(in_oklch,var(--accent-soft)_80%,var(--accent)_20%)]",
        danger:
          "bg-danger text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-danger-hover dark:text-[oklch(0.16_0.02_25)]",
        "danger-ghost": "text-danger hover:bg-danger-soft",
        link: "h-auto px-0 text-accent underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 rounded-sm px-2 text-xs [&_svg]:size-3.5",
        sm: "h-7 rounded-md px-2.5 text-[0.8125rem] [&_svg]:size-3.5",
        md: "h-8 rounded-md px-3 text-sm [&_svg]:size-4",
        lg: "h-10 rounded-lg px-4 text-[0.9375rem] [&_svg]:size-4",
        xl: "h-12 rounded-lg px-5 text-base [&_svg]:size-5",
        "icon-xs": "size-6 rounded-sm [&_svg]:size-3.5",
        "icon-sm": "size-7 rounded-md [&_svg]:size-4",
        icon: "size-8 rounded-md [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export interface ButtonProps extends ComponentProps<"button">, ButtonVariantProps {
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

type LinkButtonProps = ComponentProps<typeof Link> & ButtonVariantProps;

/** A Next.js link styled as a button (internal navigation only). */
export function LinkButton({ className, variant, size, ...props }: LinkButtonProps) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
