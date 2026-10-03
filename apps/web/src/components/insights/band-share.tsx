import type { DesignBand } from "@edf/design/types";
import { formatNumber, formatPercent } from "@/lib/format";
import { BAND_LABELS } from "@/lib/labels";

type Key = DesignBand | "provisional" | "not_analysed";
const ORDER: Key[] = ["excellent", "good", "needs_work", "poor", "provisional", "not_analysed"];
const COLOR: Record<Key, string> = {
  excellent: "var(--band-excellent)",
  good: "var(--band-good)",
  needs_work: "var(--band-needs-work)",
  poor: "var(--band-poor)",
  provisional: "var(--band-provisional)",
  not_analysed: "var(--border-strong)",
};
const LABEL: Record<Key, string> = {
  ...BAND_LABELS,
  provisional: "Provisional",
  not_analysed: "Not analysed",
};

/** Share of designed mail per band, as one segmented bar plus a labelled list. */
export function BandShare({ data }: { data: Array<{ band: Key; count: number }> }) {
  const rows = ORDER.map((k) => ({
    key: k,
    count: data.find((d) => d.band === k)?.count ?? 0,
  })).filter((r) => r.count > 0);
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (total === 0)
    return (
      <p className="text-[0.8125rem] text-muted-foreground">No designed mail in this period.</p>
    );
  const good =
    (rows.find((r) => r.key === "excellent")?.count ?? 0) +
    (rows.find((r) => r.key === "good")?.count ?? 0);
  return (
    <div>
      <p className="text-sm text-muted-foreground">
        <span className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
          {formatPercent(good / total)}
        </span>{" "}
        of designed mail is good design
      </p>
      <div
        className="mt-3 flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={rows.map((r) => `${LABEL[r.key]} ${formatPercent(r.count / total)}`).join(", ")}
      >
        {rows.map((r) => (
          <span
            key={r.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(r.count / total) * 100}%`, background: COLOR[r.key] }}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 rounded-[3px]"
              style={{ background: COLOR[r.key] }}
            />
            <span className="flex-1 text-muted-foreground">{LABEL[r.key]}</span>
            <span className="tabular font-medium text-foreground">{formatNumber(r.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
