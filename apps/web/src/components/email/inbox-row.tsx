"use client";
import Link from "next/link";
import type { Route } from "next";
import { ArrowUpRight, Check, Pin, PinOff, ShieldAlert, Undo2 } from "lucide-react";
import type { MouseEvent, Ref } from "react";
import { SenderAvatar } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { DealCountdown } from "@/components/ui/deal-countdown";
import { ImportanceDot } from "@/components/ui/importance-dot";
import { SnapshotScore } from "@/components/ui/score-badge";
import { Time } from "@/components/ui/time";
import { Tooltip } from "@/components/ui/tooltip";
import { TypeChip } from "@/components/ui/type-chip";
import { senderLabel } from "@/lib/avatar";
import { cn } from "@/lib/cn";
import type { InboxItem } from "@/server/queries/types";

interface InboxRowProps {
  item: InboxItem;
  /** Keyboard cursor / preview selection. */
  active?: boolean;
  checked?: boolean;
  /** Hide hover actions and the checkbox (Today lists, sender profile). */
  compact?: boolean;
  tabIndex?: number;
  linkRef?: Ref<HTMLAnchorElement>;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onToggleDone?: () => void;
  onTogglePin?: () => void;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
}

function HoverAction({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground [&_svg]:size-4"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** One email in a list: sender, subject + snippet, type, importance, score, deal, fonts, time. */
export function InboxRow({
  item,
  active = false,
  checked = false,
  compact = false,
  tabIndex,
  linkRef,
  onOpen,
  onToggleDone,
  onTogglePin,
  onCheckedChange,
  className,
}: InboxRowProps) {
  const unread = item.isUnread && !item.openedInApp;
  const sender = senderLabel(item.fromName, item.fromAddress);
  const fonts = item.fontFamilies;
  return (
    <div
      className={cn(
        "group/row relative flex gap-3 border-b border-border/70 px-3 py-2.5 transition-colors sm:px-4",
        active
          ? "bg-accent-soft/60 dark:bg-accent-soft/40"
          : checked
            ? "bg-surface-muted"
            : "hover:bg-surface-muted/70",
        item.done && "opacity-60",
        className,
      )}
    >
      {active ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
      <div className="relative mt-0.5 shrink-0">
        <SenderAvatar
          name={item.fromName}
          domain={item.senderDomain}
          size="md"
          className={cn(
            !compact && onCheckedChange && "transition-opacity group-hover/row:opacity-0",
            checked && "opacity-0",
          )}
        />
        {!compact && onCheckedChange ? (
          <span
            className={cn(
              "absolute inset-0 z-10 flex items-center justify-center opacity-0 transition-opacity group-hover/row:opacity-100",
              checked && "opacity-100",
            )}
          >
            <Checkbox
              checked={checked}
              onCheckedChange={onCheckedChange}
              aria-label={`Select “${item.subject ?? "email"}”`}
              // Like the hover actions: the list is one Tab stop (roving tabindex); x selects.
              tabIndex={-1}
              className="size-[1.125rem]"
            />
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-[0.8125rem]",
              unread ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
            )}
          >
            {sender}
          </span>
          <ImportanceDot level={item.importance} />
          {item.pinned ? (
            <Pin className="size-3 shrink-0 rotate-45 text-accent" aria-label="Pinned" />
          ) : null}
          {item.suspicious ? (
            <ShieldAlert className="size-3.5 shrink-0 text-danger" aria-label="Suspicious" />
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <Time
              iso={item.receivedAt}
              variant="list"
              className={cn(
                "tabular text-xs whitespace-nowrap",
                unread ? "font-medium text-foreground" : "text-subtle-foreground",
                !compact && "group-focus-within/row:invisible group-hover/row:invisible",
              )}
            />
          </span>
        </div>

        <Link
          href={`/email/${item.id}?back=%2Finbox` as Route}
          ref={linkRef}
          tabIndex={tabIndex}
          aria-current={active ? "true" : undefined}
          onClick={onOpen}
          prefetch={false}
          className="mt-0.5 flex min-w-0 items-center gap-2 rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
            <span className={cn(unread ? "font-semibold text-foreground" : "text-foreground")}>
              {item.subject?.trim() || "(no subject)"}
            </span>
            {/* The label follows securitySensitive: a null snippet alone (an image-only email) isn't one. */}
            {item.securitySensitive ? (
              <span className="text-subtle-foreground">
                {" — "}
                <em className="not-italic">Security email — content hidden</em>
              </span>
            ) : item.snippet ? (
              <span className="text-subtle-foreground">
                {" — "}
                {item.snippet}
              </span>
            ) : null}
          </span>
          {unread ? <span className="sr-only">(unread)</span> : null}
        </Link>

        <div className="relative mt-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden">
          <TypeChip type={item.primaryType} size="sm" />
          <SnapshotScore design={item.design} size="sm" />
          {item.deal ? (
            <DealCountdown endsAt={item.deal.endsAt} hasCode={item.deal.hasCode} size="sm" hideEnded />
          ) : null}
          {fonts.length > 0 ? (
            <span
              className="hidden min-w-0 truncate text-2xs text-subtle-foreground sm:inline"
              title={fonts.join(", ")}
            >
              {fonts[0]}
              {fonts.length > 1 ? ` +${fonts.length - 1}` : ""}
            </span>
          ) : null}
        </div>
      </div>

      {!compact && (onToggleDone || onTogglePin) ? (
        <div className="absolute top-1.5 right-2 z-10 hidden items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-raised group-focus-within/row:flex group-hover/row:flex sm:right-3">
          {onToggleDone ? (
            <HoverAction
              label={item.done ? "Mark not done" : "Done"}
              shortcut="e"
              onClick={onToggleDone}
            >
              {item.done ? <Undo2 aria-hidden /> : <Check aria-hidden />}
            </HoverAction>
          ) : null}
          {onTogglePin ? (
            <HoverAction label={item.pinned ? "Unpin" : "Pin"} shortcut="p" onClick={onTogglePin}>
              {item.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            </HoverAction>
          ) : null}
          <Tooltip content="Open full page" shortcut="↵">
            <Link
              href={`/email/${item.id}?back=%2Finbox` as Route}
              tabIndex={-1}
              aria-label="Open full page"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground"
            >
              <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
