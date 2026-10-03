"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import { EMAIL_SUBTYPES, TYPE_GROUPS, type TypeGroup } from "@edf/core/types";
import type { DesignIssue } from "@edf/design/types";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { MultiCombobox } from "@/components/ui/combobox";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { TypeDot } from "@/components/ui/type-chip";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { cn } from "@/lib/cn";
import { capFonts, MAX_FONT_NAME, TYPE_GROUP_LABELS } from "@/lib/filters";
import { formatCompact } from "@/lib/format";
import {
  DATE_LABELS,
  DEAL_FILTER_LABELS,
  DESIGN_FILTER_LABELS,
  FREQUENCY_LABELS,
  ISSUE_LABELS,
  subtypeLabel,
  TYPE_GROUP_ORDER,
} from "@/lib/labels";
import type {
  DealFilter,
  DesignFilter,
  FacetCounts,
  FontOption,
  FrequencyBand,
} from "@/server/queries/types";
import { useInboxFilters } from "./use-inbox-filters";

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

type GroupId =
  "type" | "importance" | "design" | "fonts" | "sender" | "engagement" | "deals" | "date";
const DEFAULT_OPEN: GroupId[] = ["type", "importance", "design", "engagement"];
const isGroupList = (v: unknown): v is GroupId[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function Group({
  id,
  title,
  active,
  open,
  onOpenChange,
  children,
}: {
  id: GroupId;
  title: string;
  active: number;
  open: boolean;
  onOpenChange: (id: GroupId, open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(o) => onOpenChange(id, o)}
      className="border-b border-border/70 py-1 last:border-b-0"
    >
      <Collapsible.Trigger className="group flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-semibold text-foreground hover:bg-surface-muted">
        <ChevronRight
          className="size-3.5 text-subtle-foreground transition-transform duration-150 group-data-panel-open:rotate-90"
          aria-hidden
        />
        <span className="flex-1">{title}</span>
        {active > 0 ? (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-foreground">
            {active}
            <span className="sr-only"> active</span>
          </span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out-quint data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="flex flex-col gap-0.5 pt-0.5 pb-2">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Option({
  checked,
  onChange,
  label,
  count,
  leading,
}: {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  count?: number;
  leading?: ReactNode;
}) {
  const empty = count === 0 && !checked;
  return (
    <label
      className={cn(
        "flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[0.8125rem] transition-colors hover:bg-surface-muted",
        empty ? "text-subtle-foreground" : "text-foreground",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="tabular text-2xs text-subtle-foreground">{formatCompact(count)}</span>
      ) : null}
    </label>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  count,
  icon,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  count?: number;
  icon?: ReactNode;
}) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-[0.8125rem] text-foreground hover:bg-surface-muted">
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="tabular text-2xs text-subtle-foreground">{formatCompact(count)}</span>
      ) : null}
      <Switch size="sm" checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

const DESIGN_KEYS: DesignFilter[] = [
  "good",
  "needs_work",
  "bad",
  "provisional",
  "plain_text",
  "not_analysed",
];
const ISSUE_KEYS: DesignIssue[] = ["image_only", "contrast", "mobile", "clipped", "broken_images"];
const DEAL_KEYS: DealFilter[] = ["active", "ending", "has_code"];
const FREQ_KEYS: FrequencyBand[] = ["daily", "several_weekly", "weekly", "monthly", "rare"];

/** Facets: AND across groups, OR within a group (DESIGN.md §9.1). All state lives in the URL. */
export function FacetRail({
  counts,
  fonts,
  className,
}: {
  counts: FacetCounts;
  fonts: FontOption[];
  className?: string;
}) {
  const { params, setParams } = useInboxFilters();
  const [openGroups, setOpenGroups] = useLocalStorage<GroupId[]>(
    "edf.inbox.facets",
    DEFAULT_OPEN,
    isGroupList,
  );
  const onOpenChange = (id: GroupId, open: boolean) =>
    setOpenGroups(open ? [...new Set([...openGroups, id])] : openGroups.filter((g) => g !== id));
  const isOpen = (id: GroupId, active: number) => openGroups.includes(id) || active > 0;

  const typeActive = params.types.length + params.subtypes.length;
  const designActive = params.design.length + params.issues.length;
  const fontActive = params.fonts.length + (params.webFonts ? 1 : 0);
  const senderActive =
    (params.newSenders ? 1 : 0) + params.frequency.length + (params.stillSending ? 1 : 0);
  const engagementActive =
    (params.unread ? 1 : 0) +
    (params.notOpened ? 1 : 0) +
    (params.done ? 1 : 0) +
    (params.pinned ? 1 : 0);

  return (
    <nav aria-label="Filters" className={cn("flex flex-col px-2 py-2", className)}>
      <Group
        id="type"
        title="Type"
        active={typeActive}
        open={isOpen("type", typeActive)}
        onOpenChange={onOpenChange}
      >
        {TYPE_GROUP_ORDER.map((g: TypeGroup) => {
          const checked = params.types.includes(g);
          const subtypes = TYPE_GROUPS[g].flatMap((t) => [...EMAIL_SUBTYPES[t]]);
          return (
            <div key={g}>
              <Option
                checked={checked}
                onChange={() => {
                  const types = toggle(params.types, g);
                  const keep = params.subtypes.filter((s) =>
                    types.some((tg) =>
                      TYPE_GROUPS[tg].some((t) =>
                        (EMAIL_SUBTYPES[t] as readonly string[]).includes(s),
                      ),
                    ),
                  );
                  void setParams({ types, subtypes: keep });
                }}
                label={TYPE_GROUP_LABELS[g]}
                count={counts.types[g] ?? 0}
                leading={<TypeDot group={g} />}
              />
              {checked && subtypes.length > 0 ? (
                <div
                  className="flex flex-wrap gap-1 pt-1 pb-1.5 pl-8"
                  role="group"
                  aria-label={`${TYPE_GROUP_LABELS[g]} kinds`}
                >
                  {subtypes.map((s) => {
                    const on = params.subtypes.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={on}
                        onClick={() => void setParams({ subtypes: toggle(params.subtypes, s) })}
                        className={cn(
                          "h-6 rounded-full px-2 text-2xs font-medium ring-1 ring-inset transition-colors",
                          on
                            ? "bg-accent-soft text-accent-soft-foreground ring-transparent"
                            : "text-muted-foreground ring-border hover:bg-surface-muted",
                        )}
                      >
                        {subtypeLabel(s)}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </Group>

      <Group
        id="importance"
        title="Importance"
        active={params.importance.length}
        open={isOpen("importance", params.importance.length)}
        onOpenChange={onOpenChange}
      >
        {(["high", "normal", "low"] as const).map((lvl) => (
          <Option
            key={lvl}
            checked={params.importance.includes(lvl)}
            onChange={() => void setParams({ importance: toggle(params.importance, lvl) })}
            label={lvl === "high" ? "High" : lvl === "normal" ? "Normal" : "Low"}
            count={counts.importance[lvl] ?? 0}
          />
        ))}
      </Group>

      <Group
        id="design"
        title="Design"
        active={designActive}
        open={isOpen("design", designActive)}
        onOpenChange={onOpenChange}
      >
        {DESIGN_KEYS.map((d) => (
          <Option
            key={d}
            checked={params.design.includes(d)}
            onChange={() => void setParams({ design: toggle(params.design, d) })}
            label={DESIGN_FILTER_LABELS[d]}
            count={counts.design[d] ?? 0}
          />
        ))}
        <p className="px-1.5 pt-2 pb-1 text-2xs font-medium text-subtle-foreground">Issues</p>
        <div className="flex flex-wrap gap-1 px-1.5">
          {ISSUE_KEYS.map((i) => {
            const on = params.issues.includes(i);
            const n = counts.issues[i] ?? 0;
            return (
              <button
                key={i}
                type="button"
                aria-pressed={on}
                onClick={() => void setParams({ issues: toggle(params.issues, i) })}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full px-2 text-2xs font-medium ring-1 ring-inset transition-colors",
                  on
                    ? "bg-band-poor-soft text-band-poor-ink ring-transparent"
                    : n === 0
                      ? "text-subtle-foreground ring-border"
                      : "text-muted-foreground ring-border hover:bg-surface-muted",
                )}
              >
                {ISSUE_LABELS[i]}
                <span className="tabular opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      </Group>

      <Group
        id="fonts"
        title="Font family"
        active={fontActive}
        open={isOpen("fonts", fontActive)}
        onOpenChange={onOpenChange}
      >
        <div className="flex flex-col gap-2 px-1.5 pt-1">
          <MultiCombobox
            label="Font family"
            hideLabel
            placeholder="Search fonts…"
            emptyText="No fonts with that name."
            options={fonts
              .filter((f) => f.key.length <= MAX_FONT_NAME)
              .map((f) => ({ value: f.key, label: f.label, count: f.count }))}
            value={params.fonts}
            onValueChange={(v) => void setParams({ fonts: capFonts(v) })}
          />
        </div>
        <div className="mt-1">
          <ToggleRow
            checked={params.webFonts}
            onChange={(v) => void setParams({ webFonts: v })}
            label="Uses web fonts"
          />
        </div>
      </Group>

      <Group
        id="sender"
        title="Sender"
        active={senderActive}
        open={isOpen("sender", senderActive)}
        onOpenChange={onOpenChange}
      >
        <ToggleRow
          checked={params.newSenders}
          onChange={(v) => void setParams({ newSenders: v })}
          label="New senders"
        />
        <ToggleRow
          checked={params.stillSending}
          onChange={(v) => void setParams({ stillSending: v })}
          label="Unsubscribed, still sending"
        />
        <p className="px-1.5 pt-2 pb-0.5 text-2xs font-medium text-subtle-foreground">
          How often they send
        </p>
        {FREQ_KEYS.map((f) => (
          <Option
            key={f}
            checked={params.frequency.includes(f)}
            onChange={() => void setParams({ frequency: toggle(params.frequency, f) })}
            label={FREQUENCY_LABELS[f]}
          />
        ))}
      </Group>

      <Group
        id="engagement"
        title="Engagement"
        active={engagementActive}
        open={isOpen("engagement", engagementActive)}
        onOpenChange={onOpenChange}
      >
        <ToggleRow
          checked={params.unread}
          onChange={(v) => void setParams({ unread: v })}
          label="Unread"
          count={counts.unread}
        />
        <ToggleRow
          checked={params.notOpened}
          onChange={(v) => void setParams({ notOpened: v })}
          label="Not opened in app"
        />
        <ToggleRow
          checked={params.pinned}
          onChange={(v) => void setParams({ pinned: v })}
          label="Pinned"
        />
        <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5">
          <span className="text-[0.8125rem] text-foreground">Done</span>
          <SegmentedControl<"any" | "not_done" | "done">
            aria-label="Done"
            size="sm"
            value={params.done ?? "any"}
            onValueChange={(v) => void setParams({ done: v === "any" ? null : v })}
            options={[
              { value: "any", label: "Any" },
              { value: "not_done", label: "Not done" },
              { value: "done", label: "Done" },
            ]}
          />
        </div>
      </Group>

      <Group
        id="deals"
        title="Deals"
        active={params.deals.length}
        open={isOpen("deals", params.deals.length)}
        onOpenChange={onOpenChange}
      >
        {DEAL_KEYS.map((d) => (
          <Option
            key={d}
            checked={params.deals.includes(d)}
            onChange={() => void setParams({ deals: toggle(params.deals, d) })}
            label={DEAL_FILTER_LABELS[d]}
            count={counts.deals[d] ?? 0}
          />
        ))}
      </Group>

      <div className="border-b border-border/70 py-1.5">
        <ToggleRow
          checked={params.suspicious}
          onChange={(v) => void setParams({ suspicious: v })}
          label="Suspicious"
          count={counts.suspicious}
          icon={
            <ShieldAlert
              className={cn(
                "size-3.5",
                counts.suspicious > 0 ? "text-danger" : "text-subtle-foreground",
              )}
              aria-hidden
            />
          }
        />
      </div>

      <Group
        id="date"
        title="Date"
        active={params.date ? 1 : 0}
        open={isOpen("date", params.date ? 1 : 0)}
        onOpenChange={onOpenChange}
      >
        <div className="flex flex-wrap gap-1 px-1.5 pt-1" role="radiogroup" aria-label="Received">
          {([null, "24h", "7d", "30d", "90d"] as const).map((d) => {
            const on = params.date === d;
            return (
              <button
                key={d ?? "any"}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => void setParams({ date: d })}
                className={cn(
                  "h-6 rounded-full px-2.5 text-2xs font-medium ring-1 ring-inset transition-colors",
                  on
                    ? "bg-foreground text-background ring-transparent"
                    : "text-muted-foreground ring-border hover:bg-surface-muted",
                )}
              >
                {d === null ? "Any time" : DATE_LABELS[d].replace("Last ", "")}
              </button>
            );
          })}
        </div>
      </Group>
    </nav>
  );
}
