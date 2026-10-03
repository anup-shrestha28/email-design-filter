"use client";
import Link from "next/link";
import { LoaderCircle, Plug, RefreshCw, TriangleAlert } from "lucide-react";
import { useDateContext } from "@/components/providers/clock";
import { useSync } from "@/components/providers/sync";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";

/** Mailbox sync status: "Synced 4 min ago" / "Syncing…" / reconnect warning. Announced politely. */
export function SyncChip({ className }: { className?: string }) {
  const { status, syncing, refresh } = useSync();
  const c = useDateContext();
  const reauth = status.mailboxes.find((m) => m.status === "needs_reauth");
  const base =
    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs font-medium transition-colors";

  let body: React.ReactNode;
  if (status.mailboxes.length === 0) {
    body = (
      <Link href="/connect" className={cn(base, "text-accent hover:bg-surface-muted")}>
        <Plug className="size-3.5" aria-hidden />
        Connect Gmail
      </Link>
    );
  } else if (reauth) {
    body = (
      <Link href="/settings" className={cn(base, "bg-danger-soft text-danger hover:opacity-90")}>
        <TriangleAlert className="size-3.5" aria-hidden />
        <span className="truncate">Reconnect Gmail</span>
      </Link>
    );
  } else if (syncing) {
    body = (
      <span className={cn(base, "text-muted-foreground")}>
        <LoaderCircle className="size-3.5 animate-spin text-accent" aria-hidden />
        Syncing…
      </span>
    );
  } else {
    body = (
      <Tooltip content="Check for new mail now" side="right">
        <button
          type="button"
          onClick={refresh}
          className={cn(
            base,
            "group text-muted-foreground hover:bg-surface-muted hover:text-foreground",
          )}
        >
          <span aria-hidden className="relative flex size-3.5 items-center justify-center">
            <span className="size-1.5 rounded-full bg-success group-hover:hidden" />
            <RefreshCw className="hidden size-3.5 group-hover:block" />
          </span>
          <span className="truncate">
            {status.lastSyncedAt
              ? `Synced ${formatRelative(status.lastSyncedAt, c)}`
              : "Waiting for first sync"}
          </span>
        </button>
      </Tooltip>
    );
  }
  return (
    <div className={className} role="status" aria-live="polite">
      {body}
    </div>
  );
}
