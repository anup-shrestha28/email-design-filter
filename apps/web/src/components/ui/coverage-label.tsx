"use client";
import type { Coverage } from "@edf/design/types";
import { FileCode2, Layers, MonitorSmartphone } from "lucide-react";
import { useDateContext } from "@/components/providers/clock";
import { cn } from "@/lib/cn";
import { formatShortDate } from "@/lib/format";

const COPY: Record<Coverage, { label: string; icon: typeof Layers; help: string }> = {
  render: {
    label: "Own render",
    icon: MonitorSmartphone,
    help: "This email was rendered in a sandboxed browser and measured directly.",
  },
  template: {
    label: "From template",
    icon: Layers,
    help: "Scored from a closely matching email from the same sender that we rendered.",
  },
  static: {
    label: "Static checks",
    icon: FileCode2,
    help: "Only the email's code was checked; the design hasn't been rendered yet.",
  },
};

/** "Own render" / "From template · sample from Sep 12" / "Static checks" (FREE-TIER.md §5.4). */
export function CoverageLabel({
  coverage,
  sampleDate,
  className,
}: {
  coverage: Coverage;
  sampleDate?: string | null;
  className?: string;
}) {
  const c = useDateContext();
  const m = COPY[coverage];
  const Icon = m.icon;
  return (
    <span
      title={m.help}
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <Icon className="size-3.5 text-subtle-foreground" aria-hidden />
      <span>
        {m.label}
        {coverage === "template" && sampleDate
          ? ` · sample from ${formatShortDate(sampleDate, c)}`
          : null}
      </span>
    </span>
  );
}
