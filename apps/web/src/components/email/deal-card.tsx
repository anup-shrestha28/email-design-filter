import { Info, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DealCountdown } from "@/components/ui/deal-countdown";
import { Time } from "@/components/ui/time";
import { dealTitle } from "@/lib/labels";
import type { DealView } from "@/server/queries/types";
import { CopyButton } from "./copy-button";

/**
 * The confidence core gives a deal with no end date at all, whose end is assumed to be 14 days after
 * receipt (@edf/core content/deals.ts UNDATED_CONFIDENCE). Mirrored here rather than imported so this
 * client-rendered card doesn't pull core's parsing dependencies into the browser bundle. Every real
 * date source scores at least 0.4, so "below 0.3" identifies the fallback even after the value has
 * round-tripped through a float4 (`real`) column. test/final/r1xk5b0-deal-card-thresholds.test.ts runs
 * core's real extractor to keep this in step with core.
 */
export const UNDATED_CONFIDENCE_MAX = 0.3;

/** Deals found in the email: value, code (private to you), countdown and exact end date. */
export function DealCard({ deals }: { deals: DealView[] }) {
  if (deals.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="size-4 text-subtle-foreground" aria-hidden />
          {deals.length === 1 ? "Deal" : `${deals.length} deals`}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {deals.map((d) => {
          const lowConfidence = d.endsAtConfidence !== null && d.endsAtConfidence < 0.5;
          // Only the 14-day fallback gets the note; a phrase-based end ("last chance", 0.4) is just "about".
          const undated =
            d.endsAtConfidence !== null && d.endsAtConfidence < UNDATED_CONFIDENCE_MAX;
          return (
            <div key={d.id} className="rounded-lg border border-border bg-surface-muted/40 p-3">
              <p className="text-base font-semibold tracking-[-0.015em] text-foreground">
                {dealTitle(d)}
              </p>
              {d.code ? (
                <div className="mt-2.5 flex items-center justify-between gap-2 rounded-md border border-dashed border-border-strong bg-surface px-2.5 py-1.5">
                  <code className="truncate font-mono text-[0.8125rem] font-semibold tracking-wider text-foreground">
                    {d.code}
                  </code>
                  <CopyButton value={d.code} label="Copy code" />
                </div>
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <DealCountdown endsAt={d.endsAt} />
                {d.endsAt ? (
                  <span>
                    {lowConfidence ? "about " : ""}
                    <Time iso={d.endsAt} variant="full" />
                  </span>
                ) : null}
              </div>
              {undated ? (
                <p className="mt-2 flex gap-1.5 text-2xs leading-relaxed text-subtle-foreground">
                  <Info className="mt-px size-3 shrink-0" aria-hidden />
                  No end date was found, so we assume it ends 14 days after the email arrived.
                </p>
              ) : null}
            </div>
          );
        })}
        <p className="text-2xs text-subtle-foreground">
          Codes can be personal. They&apos;re only ever shown to you.
        </p>
      </CardContent>
    </Card>
  );
}
