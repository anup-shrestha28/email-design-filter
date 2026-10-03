"use client";
import Link from "next/link";
import type { Route } from "next";
import { ChevronRight, Info, ShieldAlert, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SenderAvatar } from "@/components/ui/avatar";
import { ImportanceDot } from "@/components/ui/importance-dot";
import { Time } from "@/components/ui/time";
import { TrustBadge } from "@/components/ui/trust-badge";
import { TypeChip } from "@/components/ui/type-chip";
import { senderLabel } from "@/lib/avatar";
import { cn } from "@/lib/cn";
import { IMPORTANCE_LABELS, importanceReasonLabel, subtypeLabel } from "@/lib/labels";
import type { EmailDetail } from "@/server/queries/types";

function ImportanceChip({ importance }: { importance: EmailDetail["importance"] }) {
  const reasons = importance.reasons.map(importanceReasonLabel);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        className={cn(
          "inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-xs font-medium ring-1 ring-inset ring-border hover:bg-surface-muted",
          importance.level === "high" ? "text-accent" : "text-muted-foreground",
        )}
      >
        {importance.level === "normal" ? null : <ImportanceDot level={importance.level} />}
        {IMPORTANCE_LABELS[importance.level]} importance
        <Info className="size-3 text-subtle-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="text-xs font-semibold text-foreground">
          Why it&apos;s {IMPORTANCE_LABELS[importance.level].toLowerCase()}
        </p>
        {reasons.length ? (
          <ul className="mt-2 flex flex-col gap-1.5 text-xs text-muted-foreground">
            {reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span
                  aria-hidden
                  className="mt-1.5 size-1 shrink-0 rounded-full bg-subtle-foreground"
                />
                {r}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Based on the type of email and how often you read this sender.
          </p>
        )}
        {importance.score !== null ? (
          <p className="mt-2.5 border-t border-border pt-2 text-2xs text-subtle-foreground">
            Importance score {Math.round(importance.score)} / 100
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const LABEL_NAMES: Record<string, string> = { STARRED: "Starred", IMPORTANT: "Important in Gmail" };

/** Subject, sender, time, type, importance (with reasons) and trust. Email-derived text is plain text. */
export function EmailHeader({
  detail,
  compact = false,
}: {
  detail: EmailDetail;
  compact?: boolean;
}) {
  const sender = senderLabel(detail.fromName, detail.fromAddress);
  const c = detail.classification;
  const labels = detail.labels.filter((l) => l in LABEL_NAMES);
  return (
    <header className="flex flex-col gap-4">
      {c.suspicious ? (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-danger/30 bg-danger-soft p-3.5"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <div className="text-[0.8125rem] leading-relaxed">
            <p className="font-semibold text-danger">
              This email may not be from {detail.senderDomain ?? "who it says"}
            </p>
            <p className="mt-0.5 text-foreground/80">
              It failed sender authentication (DMARC) and the sender isn&apos;t aligned. Don&apos;t
              enter passwords or payment details from it. Links in the preview are disabled.
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex gap-3.5">
        <SenderAvatar
          name={detail.fromName}
          domain={detail.senderDomain}
          size={compact ? "md" : "lg"}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <h1
            className={cn(
              "font-semibold tracking-[-0.02em] text-balance break-words text-foreground",
              compact ? "text-lg leading-snug" : "text-xl leading-tight sm:text-2xl",
            )}
          >
            {detail.subject?.trim() || "(no subject)"}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.8125rem]">
            {detail.senderId ? (
              <Link
                href={`/senders/${detail.senderId}` as Route}
                className="group inline-flex items-center gap-0.5 font-medium text-foreground hover:text-accent"
              >
                {sender}
                <ChevronRight
                  className="size-3.5 text-subtle-foreground group-hover:text-accent"
                  aria-hidden
                />
              </Link>
            ) : (
              <span className="font-medium text-foreground">{sender}</span>
            )}
            {detail.fromAddress ? (
              <span className="truncate text-muted-foreground">{detail.fromAddress}</span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-subtle-foreground">
            <Time iso={detail.receivedAt} variant="full" /> · to {detail.mailboxAddress}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeChip type={c.primaryType} />
        {c.subtype ? (
          <span className="inline-flex h-5 items-center rounded-sm px-1.5 text-xs text-muted-foreground ring-1 ring-inset ring-border">
            {subtypeLabel(c.subtype)}
          </span>
        ) : null}
        <ImportanceChip importance={detail.importance} />
        {detail.trust ? (
          <TrustBadge state={detail.trust.state} missing={detail.trust.missing} size="sm" />
        ) : null}
        {labels.map((l) => (
          <span
            key={l}
            className="inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground ring-1 ring-inset ring-border"
          >
            {l === "STARRED" ? (
              <Star className="size-3 fill-current text-warning" aria-hidden />
            ) : null}
            {LABEL_NAMES[l]}
          </span>
        ))}
        {c.securitySensitive ? (
          <span className="inline-flex h-5 items-center rounded-sm bg-surface-muted px-1.5 text-xs text-muted-foreground">
            Content hidden for your security
          </span>
        ) : null}
      </div>
    </header>
  );
}
