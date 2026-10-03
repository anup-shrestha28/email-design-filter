import type { EmailType, TypeGroup } from "@edf/core/types";
import { TYPE_GROUP_LABELS } from "@/lib/filters";
import { cn } from "@/lib/cn";
import { TYPE_LABELS, typeGroupOf } from "@/lib/types-display";

/**
 * Type-group colours follow a CVD-validated categorical order (dataviz skill): the same colour
 * always means the same group, in chips and charts. Text stays in ink colours; the dot carries identity.
 */
export const TYPE_GROUP_COLOR: Record<TypeGroup, string> = {
  newsletters: "var(--tg-newsletters)",
  promotions: "var(--tg-promotions)",
  orders: "var(--tg-orders)",
  notifications: "var(--tg-notifications)",
  events: "var(--tg-events)",
  updates: "var(--tg-updates)",
  security: "var(--tg-security)",
  other: "var(--tg-other)",
};

export function TypeDot({ group, className }: { group: TypeGroup; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: TYPE_GROUP_COLOR[group] }}
    />
  );
}

export function TypeChip({
  type,
  group,
  size = "md",
  className,
}: {
  type?: EmailType;
  group?: TypeGroup;
  size?: "sm" | "md";
  className?: string;
}) {
  const g = group ?? (type ? typeGroupOf(type) : "other");
  const label = type ? TYPE_LABELS[type] : TYPE_GROUP_LABELS[g];
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-sm font-medium whitespace-nowrap text-muted-foreground",
        size === "md" ? "h-5 px-1.5 text-xs" : "h-[1.125rem] px-1 text-2xs",
        className,
      )}
      style={{ background: `color-mix(in oklch, ${TYPE_GROUP_COLOR[g]} 11%, transparent)` }}
    >
      <TypeDot group={g} className={size === "sm" ? "size-1.5" : undefined} />
      <span className="truncate">{label}</span>
    </span>
  );
}
