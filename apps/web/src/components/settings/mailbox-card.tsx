"use client";
import {
  CircleCheck,
  CircleAlert,
  LoaderCircle,
  PauseCircle,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useNow } from "@/components/providers/clock";
import { Button, LinkButton } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { disconnectMailbox } from "@/server/actions/settings";
import type { MailboxInfo } from "@/server/queries/types";
import { useReauth } from "./reauth";

/** Where a Google user removes an app's access themselves. */
const GOOGLE_PERMISSIONS_URL = "myaccount.google.com/permissions";

const STATUS: Record<
  MailboxInfo["status"],
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  active: { label: "Connected", icon: CircleCheck, className: "bg-success-soft text-success" },
  connecting: { label: "Connecting", icon: LoaderCircle, className: "bg-info-soft text-info" },
  needs_reauth: {
    label: "Needs reconnecting",
    icon: CircleAlert,
    className: "bg-danger-soft text-danger",
  },
  paused: { label: "Paused", icon: PauseCircle, className: "bg-warning-soft text-warning" },
  disconnecting: {
    label: "Disconnecting",
    icon: LoaderCircle,
    className: "bg-surface-muted text-muted-foreground",
  },
};

function Health({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-surface-muted/60 px-3 py-2">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className={cn("tabular text-base font-semibold text-foreground", tone)}>
        {formatNumber(value)}
      </p>
    </div>
  );
}

function ImportState({ m }: { m: MailboxInfo }) {
  const b = m.backfill;
  if (b.state === "done") {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">
        First import finished:{" "}
        <span className="font-medium text-foreground">{formatNumber(b.stored)}</span> emails from
        the last {b.windowDays} days.
      </p>
    );
  }
  if (b.state === "failed") {
    return (
      <p className="text-[0.8125rem] text-danger">
        The first import stopped. It retries automatically; reconnecting also restarts it.
      </p>
    );
  }
  if (b.state === "pending") {
    return (
      <p className="text-[0.8125rem] text-muted-foreground">
        Import queued{b.queuedPosition !== null ? ` — position ${b.queuedPosition}` : ""}. It starts
        automatically; you can close the app.
      </p>
    );
  }
  const ratio = b.listed > 0 ? Math.min(1, b.stored / b.listed) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[0.8125rem]">
        <span className="text-muted-foreground">Importing the last {b.windowDays} days…</span>
        <span className="tabular text-xs text-subtle-foreground">
          {formatNumber(b.stored)}
          {b.listed ? ` of ~${formatNumber(b.listed)}` : ""}
        </span>
      </div>
      <ProgressBar value={ratio === null ? null : ratio * 100} label="Import progress" />
    </div>
  );
}

/** One connected Gmail mailbox: status, sync, import progress, ledger health, reconnect/disconnect. */
export function MailboxCard({ mailbox: m }: { mailbox: MailboxInfo }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const reauth = useReauth();
  const now = useNow();
  const s = STATUS[m.status];
  const Icon = s.icon;
  // Only active mailboxes are polled; a paused or needs-reconnecting one keeps its old next_poll_at,
  // which would read as a past "next check". A check that is already due shows as due now.
  const nextCheck =
    m.status === "active" && m.nextPollAt
      ? Date.parse(m.nextPollAt) <= now
        ? "due"
        : m.nextPollAt
      : null;

  function disconnect() {
    startTransition(async () => {
      const r = await disconnectMailbox(m.id);
      if (r.ok) {
        setConfirm(false);
        if ("data" in r && r.data?.revokeFailed) {
          // The stored data is still deleted, but Google may still list the app as having access.
          toast.warning(`Disconnected ${m.emailAddress}`, {
            description: `Its stored data is being deleted, but Google didn't confirm that access was removed. To be sure, remove this app at ${GOOGLE_PERMISSIONS_URL}.`,
            duration: 20_000,
          });
          return;
        }
        toast.success(`Disconnected ${m.emailAddress}`, {
          description: "Access was revoked. Its stored data is being deleted.",
        });
        return;
      }
      if (r.code === "stale_session") {
        setConfirm(false);
        reauth.ask("disconnect this mailbox");
        return;
      }
      toast.error(r.error);
    });
  }

  return (
    <section
      className="rounded-xl border border-border bg-surface shadow-raised"
      aria-label={m.emailAddress}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[0.9375rem] font-semibold text-foreground">
              {m.emailAddress}
            </h3>
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs font-medium",
                s.className,
              )}
            >
              <Icon
                className={cn(
                  "size-3",
                  (m.status === "connecting" || m.status === "disconnecting") && "animate-spin",
                )}
                aria-hidden
              />
              {s.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {m.lastSyncedAt ? (
              <>
                Last synced <Time iso={m.lastSyncedAt} variant="relative" />
              </>
            ) : (
              "Not synced yet"
            )}
            {nextCheck === "due" ? (
              " · check due now"
            ) : nextCheck ? (
              <>
                {" · "}next check <Time iso={nextCheck} variant="list" />
              </>
            ) : null}
            {m.resyncPending ? " · catching up on missed changes" : null}
          </p>
          {m.statusReason && m.status !== "active" ? (
            <p className="mt-1 text-xs text-danger">{m.statusReason}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {m.status === "needs_reauth" || m.status === "paused" ? (
            <LinkButton href="/connect?reconnect=1" variant="primary" size="sm">
              <RefreshCw aria-hidden />
              Reconnect
            </LinkButton>
          ) : (
            <LinkButton href="/connect?reconnect=1" variant="secondary" size="sm">
              <Plug aria-hidden />
              Reconnect
            </LinkButton>
          )}
          <Button
            variant="danger-ghost"
            size="sm"
            onClick={() => setConfirm(true)}
            disabled={m.status === "disconnecting"}
          >
            <Unplug aria-hidden />
            Disconnect
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-4 border-t border-border p-4 sm:p-5">
        <ImportState m={m} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Health label="Stored" value={m.health.stored} />
          <Health label="Waiting" value={m.health.pending} />
          <Health label="Skipped (personal etc.)" value={m.health.skipped} />
          <Health
            label="Failed"
            value={m.health.failed}
            tone={m.health.failed > 0 ? "text-danger" : undefined}
          />
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${m.emailAddress}?`}
        description={
          <>
            <p>
              We&apos;ll revoke our Google access right away and delete everything stored from this
              mailbox: emails, scores, senders and deals.
            </p>
            <p>
              Your Gmail itself is not touched. You can connect it again later; the import starts
              fresh.
            </p>
          </>
        }
        confirmLabel="Disconnect and delete"
        pending={pending}
        onConfirm={disconnect}
      />
      {reauth.dialog}
    </section>
  );
}
