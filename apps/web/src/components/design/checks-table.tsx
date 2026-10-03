"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import type { CheckResult, CheckStatus, PillarId } from "@edf/design/types";
import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CircleX,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { formatPoints } from "@/lib/format";
import { CHECK_LABELS, CHECK_STATUS_LABELS, PILLAR_LABELS } from "@/lib/labels";
import { AiTag } from "./explanation-list";

const STATUS_ICON: Record<CheckStatus, { icon: typeof CircleCheck; className: string }> = {
  pass: { icon: CircleCheck, className: "text-band-excellent" },
  partial: { icon: CircleDot, className: "text-band-needs-work" },
  fail: { icon: CircleX, className: "text-band-poor" },
  not_applicable: { icon: CircleMinus, className: "text-subtle-foreground" },
  not_evaluated: { icon: CircleDashed, className: "text-subtle-foreground" },
  needs_review: { icon: CircleHelp, className: "text-warning" },
};

function words(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Render an untrusted, JSON-shaped measured value as short text. */
export function formatCheckValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(formatCheckValue).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${words(k)} ${formatCheckValue(v)}`)
      .join(" · ");
  }
  return String(value);
}

export function CheckStatusIcon({ status }: { status: CheckStatus }) {
  const m = STATUS_ICON[status];
  const Icon = m.icon;
  return (
    <Icon className={cn("size-4 shrink-0", m.className)} aria-label={CHECK_STATUS_LABELS[status]} />
  );
}

/** "All checks": every check grouped by pillar, with status, measured value and points. */
export function ChecksTable({ checks }: { checks: CheckResult[] }) {
  const byPillar = new Map<PillarId, CheckResult[]>();
  for (const c of checks) byPillar.set(c.pillar, [...(byPillar.get(c.pillar) ?? []), c]);
  const scored = checks.filter((c) => c.s !== null).length;
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex w-full items-center gap-2 rounded-md py-1.5 text-left text-[0.8125rem] font-medium text-foreground hover:text-accent">
        <ChevronRight
          className="size-4 text-subtle-foreground transition-transform duration-150 group-data-panel-open:rotate-90"
          aria-hidden
        />
        All checks
        <span className="font-normal text-subtle-foreground">
          {scored} scored of {checks.length}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out-quint data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 flex flex-col gap-4">
          {[...byPillar.entries()].map(([pillar, rows]) => (
            <div key={pillar}>
              <h4 className="mb-1 text-2xs font-medium tracking-[0.06em] text-subtle-foreground uppercase">
                {PILLAR_LABELS[pillar]}
              </h4>
              <table className="w-full text-xs">
                <caption className="sr-only">{PILLAR_LABELS[pillar]} checks</caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Check</th>
                    <th scope="col">Measured</th>
                    <th scope="col">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {rows.map((c) => (
                    <tr key={c.id} className="align-top">
                      <td className="w-6 py-1.5">
                        <CheckStatusIcon status={c.status} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="font-mono text-2xs text-subtle-foreground">{c.id}</span>{" "}
                        <span className="text-foreground">{CHECK_LABELS[c.id]}</span>
                        {c.source === "ai" || c.source === "ai_template" ? (
                          <AiTag className="ml-1.5 align-middle" />
                        ) : null}
                        {c.source === "template" || c.source === "ai_template" ? (
                          <span className="ml-1.5 text-2xs text-subtle-foreground">
                            from template
                          </span>
                        ) : null}
                      </td>
                      <td className="max-w-40 py-1.5 pr-2 break-words text-muted-foreground">
                        {formatCheckValue(c.value)}
                      </td>
                      <td className="tabular py-1.5 text-right whitespace-nowrap text-muted-foreground">
                        {c.s === null ? (
                          <span className="text-subtle-foreground">
                            {CHECK_STATUS_LABELS[c.status]}
                          </span>
                        ) : (
                          <>
                            <span className="text-foreground">{formatPoints(c.points)}</span>
                            <span className="text-subtle-foreground"> / {formatPoints(c.e)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
