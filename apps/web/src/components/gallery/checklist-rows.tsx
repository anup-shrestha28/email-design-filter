import { Check, CircleHelp, Minus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { EvidenceRow, EvidenceState } from "@/lib/gallery-evidence";

/**
 * The design checklist's rules as a list (lib/gallery-evidence.ts): each with its mark — words for
 * screen readers too — and what was measured. Shared by the gallery's "How we judged this" and the
 * full analysis page's "Design rules"; no state, so it renders on the server or the client.
 */
const STATE: Record<EvidenceState, { icon: typeof Check; className: string; sr: string }> = {
  pass: { icon: Check, className: "text-band-excellent", sr: "Passed" },
  fail: { icon: X, className: "text-band-poor", sr: "Missed" },
  neutral: { icon: Minus, className: "text-subtle-foreground", sr: "Doesn't apply" },
  unknown: { icon: CircleHelp, className: "text-subtle-foreground", sr: "Couldn't be checked" },
};

/** The checklist's rules, each with its mark and what was measured (also the analysis page's). */
export function ChecklistRows({ rows }: { rows: readonly EvidenceRow[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const s = STATE[r.state];
        const Icon = s.icon;
        return (
          <li key={r.id} data-check={r.id} data-state={r.state} className="flex items-start gap-2">
            <Icon
              aria-hidden
              strokeWidth={2.75}
              className={cn("mt-1 size-3.5 shrink-0", s.className)}
            />
            <div className="min-w-0">
              <p className="text-sm leading-5 text-foreground">
                <span className="sr-only">{s.sr}: </span>
                {r.label}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">{r.value}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** What the rules can't measure, as small print. */
export function ChecklistNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground marker:text-subtle-foreground">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
