"use client";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import Link from "next/link";
import type { Route } from "next";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Minus, SearchX, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchSenders } from "@/app/(app)/senders/actions";
import { SenderAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ScoreBadge } from "@/components/ui/score-badge";
import { SearchField } from "@/components/ui/search-field";
import { Time } from "@/components/ui/time";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatNumber, formatPercent } from "@/lib/format";
import type { SenderRow } from "@/server/queries/types";
import { BiasStepper, MuteButton, UnsubscribeButton } from "./sender-controls";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});
const helper = createColumnHelper<typeof features, SenderRow>();

function bandOf(score: number) {
  return score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "needs_work" : "poor";
}

const TRUST: Record<NonNullable<SenderRow["trustState"]>, { label: string; className: string }> = {
  trusted: { label: "Trusted", className: "text-success" },
  partial: { label: "Partial", className: "text-warning" },
  failed_auth: { label: "Failed auth", className: "text-danger" },
};

function ReadRate({ value }: { value: number | null }) {
  if (value === null) return <span className="text-subtle-foreground">—</span>;
  return (
    <span className="flex items-center justify-end gap-2">
      <span
        className="relative hidden h-1.5 w-14 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border/50 lg:block"
        aria-hidden
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            value < 0.1 ? "bg-subtle-foreground" : "bg-accent",
          )}
          style={{ width: `${Math.max(3, value * 100)}%` }}
        />
      </span>
      <span className="tabular w-9 text-right">{formatPercent(value)}</span>
    </span>
  );
}

const columns = helper.columns([
  helper.accessor((r) => (r.displayName ?? r.address).toLowerCase(), {
    id: "sender",
    header: "Sender",
    sortFn: "alphanumeric",
    cell: ({ row }) => {
      const s = row.original;
      return (
        <Link
          href={`/senders/${s.id}` as Route}
          className="group flex min-w-0 items-center gap-3 rounded-md outline-none"
        >
          <SenderAvatar name={s.displayName} domain={s.domain} size="md" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[0.8125rem] font-medium text-foreground group-hover:underline group-hover:underline-offset-2">
                {s.displayName ?? s.address}
              </span>
              {s.isNew ? (
                <Badge tone="accent" size="sm">
                  New
                </Badge>
              ) : null}
              {s.muted ? <Badge size="sm">Muted</Badge> : null}
              {s.stillSending ? (
                <Tooltip content="You opened their unsubscribe page, and they sent more mail 3+ days later.">
                  <Badge tone="warning" size="sm" tabIndex={0}>
                    Still sending
                  </Badge>
                </Tooltip>
              ) : null}
            </span>
            <span className="block truncate text-xs text-subtle-foreground">{s.domain}</span>
          </span>
        </Link>
      );
    },
  }),
  helper.accessor("emailCount", {
    header: "Emails",
    sortDescFirst: true,
    cell: (info) => <span className="tabular">{formatNumber(info.getValue())}</span>,
  }),
  helper.accessor((r) => r.emailsPerWeek ?? -1, {
    id: "perWeek",
    header: "Per week",
    sortDescFirst: true,
    cell: ({ row }) => {
      const v = row.original.emailsPerWeek;
      return v === null ? (
        <span className="text-subtle-foreground">—</span>
      ) : (
        <span className="tabular">{v < 1 ? v.toFixed(1) : Math.round(v)}</span>
      );
    },
  }),
  helper.accessor((r) => r.readRate60d ?? -1, {
    id: "readRate",
    header: "Read rate",
    sortDescFirst: true,
    cell: ({ row }) => <ReadRate value={row.original.readRate60d} />,
  }),
  helper.accessor((r) => r.avgDesignScore ?? -1, {
    id: "design",
    header: "Avg design",
    sortDescFirst: true,
    cell: ({ row }) => {
      const v = row.original.avgDesignScore;
      return v === null ? (
        <span className="text-xs text-subtle-foreground">—</span>
      ) : (
        <ScoreBadge score={v} band={bandOf(v)} size="sm" />
      );
    },
  }),
  helper.accessor((r) => (r.oneClickUnsubscribe === null ? -1 : r.oneClickUnsubscribe ? 1 : 0), {
    id: "oneClick",
    header: "One-click",
    sortDescFirst: true,
    cell: ({ row }) => {
      const v = row.original.oneClickUnsubscribe;
      if (v === null)
        return (
          <Minus className="ml-auto size-3.5 text-subtle-foreground" aria-label="Not applicable" />
        );
      return v ? (
        <Check
          className="ml-auto size-4 text-success"
          aria-label="Supports one-click unsubscribe"
        />
      ) : (
        <X
          className="ml-auto size-4 text-subtle-foreground"
          aria-label="No one-click unsubscribe"
        />
      );
    },
  }),
  helper.accessor((r) => r.trustState ?? "", {
    id: "trust",
    header: "Trust",
    cell: ({ row }) => {
      const t = row.original.trustState;
      return t ? (
        <span className={cn("text-xs font-medium", TRUST[t].className)}>{TRUST[t].label}</span>
      ) : (
        <span className="text-subtle-foreground">—</span>
      );
    },
  }),
  helper.accessor("lastSeenAt", {
    header: "Last seen",
    sortDescFirst: true,
    cell: (info) => (
      <Time iso={info.getValue()} variant="relative" className="text-xs text-muted-foreground" />
    ),
  }),
  helper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => (
      <div className="flex items-center justify-end gap-1">
        <span className="hidden sm:inline-flex">
          <BiasStepper senderId={row.original.id} value={row.original.importanceBias} />
        </span>
        <MuteButton sender={row.original} />
        <UnsubscribeButton sender={row.original} />
      </div>
    ),
  }),
]);

const HIDE_BELOW_LG = new Set(["perWeek", "oneClick", "trust", "lastSeenAt"]);
const HIDE_BELOW_MD = new Set(["readRate"]);
function responsive(id: string): string | false {
  if (HIDE_BELOW_LG.has(id)) return "hidden lg:table-cell";
  if (HIDE_BELOW_MD.has(id)) return "hidden md:table-cell";
  return false;
}
const RIGHT = new Set([
  "emailCount",
  "perWeek",
  "readRate",
  "design",
  "oneClick",
  "trust",
  "lastSeenAt",
  "actions",
]);
const EMPTY: SenderRow[] = [];

export function SendersTable({ initial, filter }: { initial: SenderRow[]; filter: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SenderRow[] | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setPending(false);
      return;
    }
    const id = ++seq.current;
    setPending(true);
    const t = setTimeout(() => {
      searchSenders(q, filter).then((r) => {
        if (id !== seq.current) return;
        setPending(false);
        setResults(r.ok ? r.data : EMPTY);
      });
    }, 220);
    return () => clearTimeout(t);
  }, [query, filter]);

  const data = results ?? initial;
  const table = useTable({
    features,
    columns,
    data,
    // Rows (and their stateful controls) are keyed by sender, not array position, so a search or a
    // refresh that reorders the list never hands one sender's stepper/mute state to another.
    getRowId: (r) => r.id,
    initialState: { sorting: [{ id: "emailCount", desc: true }] },
  });
  const rows = table.getRowModel().rows;
  const count = useMemo(() => data.length, [data]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="Search senders by name or domain"
          className="w-full sm:max-w-xs"
          pending={pending}
          aria-label="Search senders"
        />
        <p className="text-xs text-subtle-foreground" aria-live="polite">
          {formatNumber(count)} {count === 1 ? "sender" : "senders"}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-raised">
        {rows.length === 0 ? (
          <EmptyState
            icon={query ? <SearchX /> : <Users />}
            title={query ? "No senders match" : "No senders here"}
            description={
              query
                ? "Try part of the name or the domain."
                : "Senders appear once mail from them is imported."
            }
          />
        ) : (
          // `relative`: the screen-reader-only "Actions" header (absolutely positioned) stays
          // inside this scroller instead of widening the page at phone widths.
          <div className="relative overflow-x-auto">
            <table className="w-full text-[0.8125rem] md:min-w-[40rem]">
              <thead className="border-b border-border bg-surface-muted/60 text-xs text-muted-foreground">
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const canSort = header.column.getCanSort();
                      const id = header.column.id;
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            sorted === "asc"
                              ? "ascending"
                              : sorted === "desc"
                                ? "descending"
                                : undefined
                          }
                          className={cn(
                            "h-9 px-3 font-medium whitespace-nowrap first:pl-4 last:pr-4",
                            RIGHT.has(id) ? "text-right" : "text-left",
                            responsive(id),
                          )}
                        >
                          {canSort ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-sm hover:text-foreground",
                                sorted && "text-foreground",
                              )}
                            >
                              <table.FlexRender header={header} />
                              {sorted === "asc" ? (
                                <ArrowUp className="size-3" aria-hidden />
                              ) : sorted === "desc" ? (
                                <ArrowDown className="size-3" aria-hidden />
                              ) : (
                                <ArrowUpDown className="size-3 opacity-40" aria-hidden />
                              )}
                            </button>
                          ) : (
                            <table.FlexRender header={header} />
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-surface-muted/50">
                    {row.getAllCells().map((cell) => {
                      const id = cell.column.id;
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            "px-3 py-2.5 first:pl-4 last:pr-4",
                            RIGHT.has(id) ? "text-right" : "text-left",
                            id === "sender" && "max-w-[12rem] sm:max-w-[18rem]",
                            responsive(id),
                          )}
                        >
                          <table.FlexRender cell={cell} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
