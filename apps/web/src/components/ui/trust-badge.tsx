import type { TrustBadge as TrustBadgeData } from "@edf/core/types";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { cn } from "@/lib/cn";
import { TRUST_MISSING_LABELS } from "@/lib/labels";

type TrustState = TrustBadgeData["state"];

const META: Record<TrustState, { label: string; icon: typeof ShieldCheck; className: string }> = {
  trusted: {
    label: "Trusted sender",
    icon: ShieldCheck,
    className: "bg-success-soft text-success",
  },
  partial: {
    label: "Partially compliant",
    icon: ShieldAlert,
    className: "bg-warning-soft text-warning",
  },
  failed_auth: {
    label: "Failed authentication",
    icon: ShieldX,
    className: "bg-danger-soft text-danger",
  },
};

export function trustSummary(state: TrustState, missing: string[] = []): string {
  if (state === "partial" && missing.length) {
    return `Missing ${missing.map((m) => TRUST_MISSING_LABELS[m] ?? m).join(", ")}`;
  }
  if (state === "failed_auth") return "DMARC or DKIM failed — this could be spoofed";
  if (state === "trusted") return "Authenticated, with one-click unsubscribe where it applies";
  return "";
}

export function TrustBadge({
  state,
  missing,
  size = "md",
  className,
}: {
  state: TrustState;
  missing?: string[];
  size?: "sm" | "md";
  className?: string;
}) {
  const m = META[state];
  const Icon = m.icon;
  return (
    <span
      title={trustSummary(state, missing)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm font-medium whitespace-nowrap",
        size === "md" ? "h-6 px-2 text-xs" : "h-5 px-1.5 text-2xs",
        m.className,
        className,
      )}
    >
      <Icon className={size === "md" ? "size-3.5" : "size-3"} aria-hidden />
      {m.label}
    </span>
  );
}
