"use client";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useTransition } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Scope } from "@/server/queries/types";

const SCOPES = ["subscriptions", "receipts", "all"] as const;

/** The inbox list's scope (Subscriptions / Receipts & account / All), kept in the URL. */
export function ScopeToggle({ className }: { className?: string }) {
  const [, startTransition] = useTransition();
  const [scope, setScope] = useQueryState(
    "scope",
    parseAsStringLiteral(SCOPES)
      .withDefault("subscriptions")
      .withOptions({ shallow: false, clearOnDefault: true, startTransition, scroll: false }),
  );
  return (
    <SegmentedControl<Scope>
      aria-label="Scope"
      value={scope}
      onValueChange={(v) => void setScope(v)}
      className={className}
      options={[
        { value: "subscriptions", label: "Subscriptions" },
        { value: "receipts", label: "Receipts & account" },
        { value: "all", label: "All" },
      ]}
    />
  );
}
