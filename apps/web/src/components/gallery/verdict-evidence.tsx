"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, CircleHelp, Minus, RotateCw, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatPoints } from "@/lib/format";
import type {
  AreaRow,
  EvidenceRow,
  EvidenceState,
  VerdictEvidence as Evidence,
} from "@/lib/gallery-evidence";
import { galleryEvidence } from "@/server/actions/gallery-evidence";
import type { GalleryItem } from "@/server/queries/types";

/**
 * One opened design's evidence (Server Action → lib/gallery-evidence.ts), asked once per design and
 * verdict: a design re-scored while the gallery is open (live updates) asks again.
 */
export function useVerdictEvidence(item: GalleryItem) {
  return useQuery({
    queryKey: ["gallery-evidence", item.id, item.verdict, item.score] as const,
    queryFn: async (): Promise<Evidence | null> => {
      const r = await galleryEvidence(item.id);
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    enabled: item.verdict !== "unscored",
    staleTime: 5 * 60_000,
  });
}

export type EvidenceQuery = ReturnType<typeof useVerdictEvidence>;

/**
 * Whether the checks are unfolded for this design: open for Good and Bad, folded for Okay, until
 * the reader toggles them (each design starts from its own default). The detail view's problem
 * list reads it too, so a line is left out only while the check that states it is in view.
 */
export function useChecksOpen(item: GalleryItem): [boolean, (open: boolean) => void] {
  const [chosen, setChosen] = useState<{ id: string; open: boolean } | null>(null);
  const open = chosen?.id === item.id ? chosen.open : item.verdict !== "ok";
  return [open, (o) => setChosen({ id: item.id, open: o })];
}

/** The evidence when it's for the verdict the card shows (a re-score in between can differ). */
export function shownEvidence(item: GalleryItem, query: EvidenceQuery): Evidence | null {
  const ev = query.data ?? null;
  return ev && ev.verdict === item.verdict ? ev : null;
}

const STATE: Record<EvidenceState, { icon: typeof Check; className: string; sr: string }> = {
  pass: { icon: Check, className: "text-band-excellent", sr: "Passed" },
  fail: { icon: X, className: "text-band-poor", sr: "Failed" },
  neutral: { icon: Minus, className: "text-subtle-foreground", sr: "Doesn't count here" },
  unknown: { icon: CircleHelp, className: "text-subtle-foreground", sr: "Not measured" },
};

function Rows({ rows }: { rows: readonly EvidenceRow[] }) {
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
              <p className="text-xs leading-5 text-muted-foreground">{r.value ?? "Not measured"}</p>
              {r.limit ? (
                <p className="text-xs leading-5 text-subtle-foreground">{r.limit}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ratioTone(r: number): string {
  if (r >= 0.85) return "bg-band-excellent";
  if (r >= 0.7) return "bg-band-good";
  if (r >= 0.5) return "bg-band-needs-work";
  return "bg-band-poor";
}

/** The score by area: points out of each area's share of 100, in plain names. */
function Areas({ rows, notes }: { rows: readonly AreaRow[]; notes: readonly string[] }) {
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {rows.map((a) => {
          const ratio = a.max > 0 ? Math.min(1, a.points / a.max) : 0;
          return (
            <li
              key={a.id}
              className="grid grid-cols-[minmax(0,1fr)_4.5rem_auto] items-center gap-2.5 text-xs"
            >
              <span className="truncate text-muted-foreground" title={a.label}>
                {a.label}
              </span>
              <span
                role="img"
                aria-label={`${a.label}: ${formatPoints(a.points)} of ${formatPoints(a.max)} points`}
                className="relative h-1.5 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-border/50 ring-inset"
              >
                <span
                  className={cn("absolute inset-y-0 left-0 rounded-full", ratioTone(ratio))}
                  style={{ width: `${Math.max(2, ratio * 100)}%` }}
                />
              </span>
              <span aria-hidden className="tabular text-right whitespace-nowrap">
                <span className="font-medium text-foreground">{formatPoints(a.points)}</span>
                <span className="text-subtle-foreground"> / {formatPoints(a.max)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {notes.map((n) => (
        <p key={n} className="text-xs leading-5 text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

function SubHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <h4 className="text-xs font-semibold text-foreground">
      {children}
      {hint ? <span className="font-normal text-subtle-foreground"> · {hint}</span> : null}
    </h4>
  );
}

/** "Bad: …" with the verdict word in bold. */
function Sentence({ text }: { text: string }) {
  const i = text.indexOf(":");
  return (
    <p className="text-sm leading-6 text-foreground">
      {i > 0 ? (
        <>
          <span className="font-semibold">{text.slice(0, i + 1)}</span>
          {text.slice(i + 1)}
        </>
      ) : (
        text
      )}
    </p>
  );
}

/**
 * "How we judged this": the verdict's deciding rule with its value and limit, then — open by
 * default for Good and Bad, folded for Okay — what Good needs, the serious problems, the score by
 * area and what couldn't be measured. Everything comes from the stored analysis; nothing is
 * re-measured here.
 */
export function VerdictEvidence({
  item,
  query,
  open,
  onOpenChange,
}: {
  item: GalleryItem;
  query: EvidenceQuery;
  /** The checks are unfolded (useChecksOpen). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const headingId = useId();
  const ev = shownEvidence(item, query);
  const state = query.isPending ? "loading" : query.isError ? "error" : "ready";
  return (
    <section aria-labelledby={headingId} data-evidence={state} className="space-y-2.5">
      <h3 id={headingId} className="text-sm font-semibold text-foreground">
        How we judged this
      </h3>
      {query.isPending ? (
        <LoadingRegion label="Loading how we judged this" className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </LoadingRegion>
      ) : query.isError ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>We couldn&apos;t load the checks just now.</span>
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </div>
      ) : !ev ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {query.data
            ? "This design was just scored again. Reload the page to see the latest."
            : "There are no checks to show for this design."}
        </p>
      ) : (
        <>
          <Sentence text={ev.sentence} />
          <Collapsible.Root open={open} onOpenChange={onOpenChange}>
            <Collapsible.Trigger className="group inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <ChevronRight
                aria-hidden
                className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90"
              />
              {open ? "Hide the checks" : "Show the checks"}
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out-quint data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
              <div className="space-y-4 pt-3">
                <div className="space-y-2">
                  <SubHeading>What Good needs</SubHeading>
                  <Rows rows={ev.good} />
                </div>
                <div className="space-y-2">
                  <SubHeading hint="any one makes it Bad">Serious problems</SubHeading>
                  <Rows rows={ev.serious} />
                  {ev.treatedAs ? (
                    <p className="text-xs leading-5 text-muted-foreground">{ev.treatedAs}</p>
                  ) : null}
                </div>
                {ev.areas ? (
                  <div className="space-y-2">
                    <SubHeading>Score by area</SubHeading>
                    <Areas rows={ev.areas.rows} notes={ev.areas.notes} />
                  </div>
                ) : null}
                {ev.notes.length ? (
                  <div className="space-y-1.5">
                    <SubHeading>About these measurements</SubHeading>
                    <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground marker:text-subtle-foreground">
                      {ev.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </>
      )}
    </section>
  );
}
