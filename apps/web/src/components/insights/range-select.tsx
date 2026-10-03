"use client";
import { parseAsNumberLiteral, useQueryState } from "nuqs";
import { useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";

const RANGES = [30, 90, 180, 365] as const;

export function RangeSelect() {
  const [pending, startTransition] = useTransition();
  const [range, setRange] = useQueryState(
    "range",
    parseAsNumberLiteral(RANGES)
      .withDefault(90)
      .withOptions({ shallow: false, clearOnDefault: true, startTransition, scroll: false }),
  );
  return (
    <div className="flex items-center gap-2">
      {pending ? (
        <LoaderCircle className="size-4 animate-spin text-accent" aria-label="Updating" />
      ) : null}
      <SegmentedControl<"30" | "90" | "180" | "365">
        aria-label="Time range"
        value={String(range) as "30" | "90" | "180" | "365"}
        onValueChange={(v) => void setRange(Number(v) as (typeof RANGES)[number])}
        options={[
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
          { value: "180", label: "180 days" },
          { value: "365", label: "1 year" },
        ]}
      />
    </div>
  );
}
