"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RotateCw } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import type { VerdictEvidence as Evidence } from "@/lib/gallery-evidence";
import { galleryEvidence } from "@/server/actions/gallery-evidence";
import type { GalleryItem } from "@/server/queries/types";
import { ChecklistNotes, ChecklistRows } from "./checklist-rows";

/**
 * One opened design's evidence (Server Action → lib/gallery-evidence.ts), asked once per design and
 * checklist: a design re-checked while the gallery is open (live updates) asks again.
 */
export function useVerdictEvidence(item: GalleryItem) {
  return useQuery({
    queryKey: ["gallery-evidence", item.id, item.verdict, item.reason?.text ?? null] as const,
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
 * Whether the rules are unfolded for this design: open until the reader folds them (each design
 * starts open: the rules are the reason for its verdict).
 */
export function useChecksOpen(item: GalleryItem): [boolean, (open: boolean) => void] {
  const [chosen, setChosen] = useState<{ id: string; open: boolean } | null>(null);
  const open = chosen?.id === item.id ? chosen.open : true;
  return [open, (o) => setChosen({ id: item.id, open: o })];
}

/** The evidence when it's for the verdict the card shows (a re-score in between can differ). */
export function shownEvidence(item: GalleryItem, query: EvidenceQuery): Evidence | null {
  const ev = query.data ?? null;
  return ev && ev.verdict === item.verdict ? ev : null;
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
 * "How we judged this": the verdict in one sentence (how many of the 16 design rules it missed),
 * then — open unless the reader folds it — every rule with its mark and what was measured, and what
 * the rules can't measure. Everything comes from the saved checklist; nothing is re-measured here.
 */
export function VerdictEvidence({
  item,
  query,
  open,
  onOpenChange,
}: {
  item: GalleryItem;
  query: EvidenceQuery;
  /** The rules are unfolded (useChecksOpen). */
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
          <span>We couldn&apos;t load the rules just now.</span>
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </div>
      ) : !ev ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {query.data
            ? "This design was just checked again. Reload the page to see the latest."
            : "There are no rules to show for this design yet."}
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
              {open ? "Hide the 16 rules" : "Show the 16 rules"}
            </Collapsible.Trigger>
            <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out-quint data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
              <div className="space-y-4 pt-3">
                <ChecklistRows rows={ev.rows} />
                <ChecklistNotes notes={ev.notes} />
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        </>
      )}
    </section>
  );
}
