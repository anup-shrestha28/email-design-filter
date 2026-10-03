import Link from "next/link";
import type { Route } from "next";
import { SnapshotScore } from "@/components/ui/score-badge";
import { senderLabel } from "@/lib/avatar";
import type { InboxItem } from "@/server/queries/types";

export function DesignHighlight({ label, item }: { label: string; item: InboxItem }) {
  return (
    <Link
      href={`/email/${item.id}` as Route}
      className="group flex items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-muted/60"
    >
      <SnapshotScore design={item.design} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="text-2xs font-medium tracking-[0.04em] text-subtle-foreground uppercase">
          {label}
        </p>
        <p className="mt-0.5 truncate text-[0.8125rem] font-medium text-foreground group-hover:underline group-hover:underline-offset-2">
          {item.subject ?? "(no subject)"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {senderLabel(item.fromName, item.fromAddress)}
        </p>
      </div>
    </Link>
  );
}
