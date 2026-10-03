import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  size = "md",
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "md" ? "gap-3 px-6 py-14" : "gap-2 px-4 py-8",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden
          className={cn(
            "flex items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground shadow-raised [&_svg]:shrink-0",
            size === "md" ? "size-11 [&_svg]:size-5" : "size-9 [&_svg]:size-4",
          )}
        >
          {icon}
        </div>
      ) : null}
      <div className="max-w-sm space-y-1">
        <p
          className={cn(
            "font-medium text-foreground",
            size === "md" ? "text-[0.9375rem]" : "text-sm",
          )}
        >
          {title}
        </p>
        {description ? (
          <div className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
