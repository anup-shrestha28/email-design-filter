"use client";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { SMART_VIEW_LABELS, TYPE_GROUP_LABELS } from "@/lib/filters";
import type { InboxParams } from "@/lib/inbox-params";
import {
  DATE_LABELS,
  DEAL_FILTER_LABELS,
  DESIGN_FILTER_LABELS,
  FREQUENCY_LABELS,
  IMPORTANCE_LABELS,
  ISSUE_LABELS,
  subtypeLabel,
} from "@/lib/labels";
import type { FontOption } from "@/server/queries/types";
import { useInboxFilters } from "./use-inbox-filters";

interface Chip {
  key: string;
  label: string;
  remove: Partial<InboxParams>;
}

/** Everything that narrows the list except scope & sort: facet params + the smart view. */
export const CLEARED_FILTERS: Partial<InboxParams> = {
  view: null,
  types: [],
  subtypes: [],
  importance: [],
  design: [],
  issues: [],
  fonts: [],
  webFonts: false,
  senderId: null,
  newSenders: false,
  frequency: [],
  stillSending: false,
  unread: false,
  notOpened: false,
  done: null,
  pinned: false,
  deals: [],
  suspicious: false,
  date: null,
  mailboxId: null,
  language: null,
};

function chipsFor(p: InboxParams, fonts: FontOption[], senderName: string | null): Chip[] {
  const without = <T,>(list: readonly T[], v: T) => list.filter((x) => x !== v);
  const fontLabel = new Map(fonts.map((f) => [f.key, f.label]));
  const chips: Chip[] = [];
  if (p.view) chips.push({ key: "view", label: SMART_VIEW_LABELS[p.view], remove: { view: null } });
  for (const t of p.types)
    chips.push({
      key: `t:${t}`,
      label: TYPE_GROUP_LABELS[t],
      remove: { types: without(p.types, t) },
    });
  for (const s of p.subtypes)
    chips.push({
      key: `s:${s}`,
      label: subtypeLabel(s) ?? s,
      remove: { subtypes: without(p.subtypes, s) },
    });
  for (const i of p.importance)
    chips.push({
      key: `i:${i}`,
      label: `${IMPORTANCE_LABELS[i]} importance`,
      remove: { importance: without(p.importance, i) },
    });
  for (const d of p.design)
    chips.push({
      key: `d:${d}`,
      label: DESIGN_FILTER_LABELS[d],
      remove: { design: without(p.design, d) },
    });
  for (const i of p.issues)
    chips.push({ key: `x:${i}`, label: ISSUE_LABELS[i], remove: { issues: without(p.issues, i) } });
  for (const f of p.fonts)
    chips.push({
      key: `f:${f}`,
      label: `Font: ${fontLabel.get(f) ?? f}`,
      remove: { fonts: without(p.fonts, f) },
    });
  if (p.webFonts) chips.push({ key: "web", label: "Uses web fonts", remove: { webFonts: false } });
  if (p.senderId)
    chips.push({
      key: "sender",
      label: senderName ? `From ${senderName}` : "One sender",
      remove: { senderId: null },
    });
  if (p.newSenders) chips.push({ key: "new", label: "New senders", remove: { newSenders: false } });
  for (const f of p.frequency)
    chips.push({
      key: `q:${f}`,
      label: FREQUENCY_LABELS[f],
      remove: { frequency: without(p.frequency, f) },
    });
  if (p.stillSending)
    chips.push({
      key: "still",
      label: "Still sending after unsubscribe",
      remove: { stillSending: false },
    });
  if (p.unread) chips.push({ key: "unread", label: "Unread", remove: { unread: false } });
  if (p.notOpened)
    chips.push({ key: "unopened", label: "Not opened in app", remove: { notOpened: false } });
  if (p.done)
    chips.push({
      key: "done",
      label: p.done === "done" ? "Done" : "Not done",
      remove: { done: null },
    });
  if (p.pinned) chips.push({ key: "pinned", label: "Pinned", remove: { pinned: false } });
  for (const d of p.deals)
    chips.push({
      key: `deal:${d}`,
      label: `Deal: ${DEAL_FILTER_LABELS[d]}`,
      remove: { deals: without(p.deals, d) },
    });
  if (p.suspicious) chips.push({ key: "sus", label: "Suspicious", remove: { suspicious: false } });
  if (p.date) chips.push({ key: "date", label: DATE_LABELS[p.date], remove: { date: null } });
  if (p.mailboxId) chips.push({ key: "mb", label: "One mailbox", remove: { mailboxId: null } });
  if (p.language)
    chips.push({
      key: "lang",
      label: `Language: ${p.language.toUpperCase()}`,
      remove: { language: null },
    });
  return chips;
}

export function FilterChips({
  fonts,
  senderName = null,
  className,
}: {
  fonts: FontOption[];
  senderName?: string | null;
  className?: string;
}) {
  const { params, setParams } = useInboxFilters();
  const chips = chipsFor(params, fonts, senderName);
  if (chips.length === 0) return null;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      aria-label="Active filters"
      role="group"
    >
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => void setParams(c.remove)}
          aria-label={`Remove filter: ${c.label}`}
          className="group inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft pr-1.5 pl-2.5 text-xs font-medium text-accent-soft-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--accent-soft)_80%,var(--accent)_20%)]"
        >
          {c.label}
          <X className="size-3 opacity-70 group-hover:opacity-100" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        onClick={() => void setParams(CLEARED_FILTERS)}
        className="h-6 rounded-full px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Clear all
      </button>
    </div>
  );
}
