import type { TypeGroup } from "@edf/core/types";
import { TYPE_GROUP_COLOR, TypeDot } from "@/components/ui/type-chip";
import { TYPE_GROUP_LABELS } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-params";
import { TYPE_GROUP_ORDER } from "@/lib/labels";
import Link from "next/link";
import type { Route } from "next";

/** Last-24h mail by type group: a segmented bar plus a labelled list (colour is never alone). */
export function GroupBreakdown({
  total,
  byGroup,
}: {
  total: number;
  byGroup: Partial<Record<TypeGroup, number>>;
}) {
  const rows = TYPE_GROUP_ORDER.map((g) => ({ group: g, count: byGroup[g] ?? 0 })).filter(
    (r) => r.count > 0,
  );
  if (total === 0) {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">Nothing new in the last 24 hours.</p>
    );
  }
  return (
    <div>
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={rows.map((r) => `${TYPE_GROUP_LABELS[r.group]} ${r.count}`).join(", ")}
      >
        {rows.map((r) => (
          <span
            key={r.group}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(r.count / total) * 100}%`,
              background: TYPE_GROUP_COLOR[r.group],
              animation: "bar-grow 700ms var(--ease-out-quint) both",
              transformOrigin: "left",
            }}
          />
        ))}
      </div>
      <ul className="mt-4 grid gap-1">
        {rows.map((r) => (
          <li key={r.group}>
            <Link
              href={inboxHref({ types: [r.group], date: "24h", scope: "all" }) as Route}
              className="-mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors hover:bg-surface-muted"
            >
              <TypeDot group={r.group} />
              <span className="flex-1 text-foreground">{TYPE_GROUP_LABELS[r.group]}</span>
              <span className="tabular font-medium text-muted-foreground">
                {formatNumber(r.count)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
