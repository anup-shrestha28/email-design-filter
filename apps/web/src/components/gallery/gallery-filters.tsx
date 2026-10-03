"use client";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import {
  CLEAR_ADVANCED,
  DEFAULT_GALLERY_PARAMS,
  GALLERY_DATES,
  GALLERY_DATE_LABELS,
  GALLERY_PROBLEMS,
  GALLERY_PROBLEM_LABELS,
  GALLERY_SENDERS_MAX,
  GALLERY_SORTS,
  GALLERY_WEB_FONTS,
  GALLERY_WEB_FONT_LABELS,
  parseGalleryParams,
  sharedSenderNames,
  type GalleryDate,
  type GalleryParams,
  type GalleryPatch,
  type GallerySort,
  type GalleryWebFonts,
} from "@/lib/gallery";
import { galleryDraftFacets } from "@/server/actions/gallery-facets";
import type { GalleryFacets } from "@/server/queries/types";

const SORT_LABEL: Record<GallerySort, string> = {
  newest: "Newest first",
  best: "Best design first",
  worst: "Worst design first",
};

/**
 * The "Filters" button: labelled from tablets up, an icon on phones. The badge counts the filters
 * the panel holds (on phones that includes font and sort, which live in the panel there).
 */
export function FiltersButton({
  count,
  onClick,
  compact,
  className,
}: {
  count: number;
  onClick: () => void;
  compact?: boolean;
  className?: string;
}) {
  const label = count > 0 ? `Filters, ${count} on` : "Filters";
  const badge =
    count > 0 ? (
      <span
        aria-hidden
        className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.6875rem] leading-4 font-semibold text-accent-foreground tabular"
      >
        {count}
      </span>
    ) : null;
  if (compact)
    return (
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        onClick={onClick}
        className={cn(
          "relative flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-foreground hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {badge ? <span className="absolute -top-1.5 -right-1.5">{badge}</span> : null}
      </button>
    );
  return (
    <Button
      variant="secondary"
      aria-label={label}
      aria-haspopup="dialog"
      onClick={onClick}
      className={className}
    >
      <SlidersHorizontal aria-hidden />
      Filters
      {badge}
    </Button>
  );
}

/** Loads the counts for a draft (the Server Action; tests pass their own). */
export type LoadFacets = (draft: GalleryParams) => Promise<GalleryFacets>;

/**
 * The Filters panel: a sheet from the right (tablets and up) or from the bottom (phones). Changes
 * are a draft until "Show designs"; "Clear all" empties the panel's filters at once. On phones it
 * also holds font and sort, so the bar above the designs stays one short row. Its counts follow
 * the draft (useDraftFacets), so each number is what applying the draft would show.
 */
export function FiltersPanel({
  open,
  onOpenChange,
  params,
  facets,
  onApply,
  stale = false,
  loadFacets = galleryDraftFacets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: GalleryParams;
  facets: GalleryFacets;
  onApply: (patch: GalleryPatch) => void;
  /** `facets` are still the previous filters' (a change is loading). */
  stale?: boolean;
  loadFacets?: LoadFacets;
}) {
  const wide = useMediaQuery("(min-width: 640px)");
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side={wide ? "right" : "bottom"}
      title="Filters"
      className={wide ? "w-[min(24rem,92vw)]" : undefined}
    >
      {/* Mounted fresh on every open, so the draft always starts from what's applied. */}
      <PanelBody
        params={params}
        facets={facets}
        stale={stale}
        loadFacets={loadFacets}
        withFontAndSort={!wide}
        onApply={(patch) => {
          onApply(patch);
          onOpenChange(false);
        }}
      />
    </Sheet>
  );
}

function clampScore(text: string, fallback: number): number {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

/** How long the draft must stay unchanged before its counts are asked for. */
const DRAFT_DEBOUNCE_MS = 300;

/** The view `params` with `patch` applied (null = back to the default), normalised like the URL. */
function withPatch(params: GalleryParams, patch: GalleryPatch): GalleryParams {
  const out: Record<string, unknown> = { ...params };
  for (const [k, v] of Object.entries(patch))
    out[k] = v === null ? DEFAULT_GALLERY_PARAMS[k as keyof GalleryParams] : v;
  return parseGalleryParams(out);
}

/** What the counts depend on: every filter and the search, not the page, page size or sort. */
function countsKey(p: GalleryParams): string {
  return JSON.stringify({ ...p, page: 1, size: DEFAULT_GALLERY_PARAMS.size, sort: "newest" });
}

/**
 * The counts for the panel's draft: the page's own `facets` while the draft is what they were read
 * for, else the draft's own, asked for once the draft stays unchanged for a moment. `fresh` is
 * false while those are on their way (the previous numbers stay, dimmed).
 */
function useDraftFacets(
  draft: GalleryParams,
  applied: GalleryParams,
  facets: GalleryFacets,
  stale: boolean,
  load: LoadFacets,
): { facets: GalleryFacets; fresh: boolean } {
  const key = countsKey(draft);
  const current = !stale && key === countsKey(applied);
  const [loaded, setLoaded] = useState<{ key: string; facets: GalleryFacets } | null>(null);
  useEffect(() => {
    if (current) return;
    let live = true;
    const t = setTimeout(() => {
      load(JSON.parse(key) as GalleryParams).then(
        (f) => {
          if (live) setLoaded({ key, facets: f });
        },
        () => {}, // the numbers simply stay dimmed; "Show designs" still works
      );
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, current, load]);
  if (current) return { facets, fresh: true };
  if (loaded?.key === key) return { facets: loaded.facets, fresh: true };
  return { facets: loaded?.facets ?? facets, fresh: false };
}

function PanelBody({
  params,
  facets: appliedFacets,
  stale,
  loadFacets,
  withFontAndSort,
  onApply,
}: {
  params: GalleryParams;
  facets: GalleryFacets;
  stale: boolean;
  loadFacets: LoadFacets;
  withFontAndSort: boolean;
  onApply: (patch: GalleryPatch) => void;
}) {
  const [smin, setSmin] = useState(String(params.smin));
  const [smax, setSmax] = useState(String(params.smax));
  const [date, setDate] = useState<GalleryDate>(params.date);
  const [since, setSince] = useState(params.since ?? "");
  const [until, setUntil] = useState(params.until ?? "");
  const [sender, setSender] = useState<string[]>(params.sender);
  const [problem, setProblem] = useState(params.problem);
  const [mailbox, setMailbox] = useState(params.mailbox);
  const [board, setBoard] = useState(params.board);
  const [webfonts, setWebfonts] = useState<GalleryWebFonts>(params.webfonts);
  const [font, setFont] = useState(params.font);
  const [sort, setSort] = useState<GallerySort>(params.sort);

  // The draft as the URL change "Show designs" makes.
  const patch = useMemo((): GalleryPatch => {
    let lo = clampScore(smin, 0);
    let hi = clampScore(smax, 100);
    if (lo > hi) [lo, hi] = [hi, lo];
    const custom = date === "custom" && (since !== "" || until !== "");
    const out: GalleryPatch = {
      smin: lo === 0 ? null : lo,
      smax: hi === 100 ? null : hi,
      date: date === "any" || (date === "custom" && !custom) ? null : date,
      since: custom && since ? since : null,
      until: custom && until ? until : null,
      sender: sender.length ? sender : null,
      problem: problem.length ? problem : null,
      mailbox: mailbox ?? null,
      webfonts: webfonts === "any" ? null : webfonts,
      board: board ?? null,
    };
    if (withFontAndSort) {
      out.font = font;
      out.sort = sort === "newest" ? null : sort;
    }
    return out;
  }, [
    smin,
    smax,
    date,
    since,
    until,
    sender,
    problem,
    mailbox,
    webfonts,
    board,
    font,
    sort,
    withFontAndSort,
  ]);
  const draft = useMemo(() => withPatch(params, patch), [params, patch]);
  const { facets, fresh } = useDraftFacets(draft, params, appliedFacets, stale, loadFacets);
  const apply = () => onApply(patch);
  const clearAll = () =>
    onApply(withFontAndSort ? { ...CLEAR_ADVANCED, font: null } : CLEAR_ADVANCED);
  /** Designs the draft shows (every filter, the type included): the button says it. */
  const total = facets.categories[draft.category] ?? 0;

  const showMailboxes = facets.mailboxes.length >= 2;
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-6 px-4 pt-2 pb-6">
        {withFontAndSort ? (
          <>
            <Section title="Sort">
              <RadioPills<GallerySort>
                name="gallery-sort"
                value={sort}
                onChange={setSort}
                options={GALLERY_SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
              />
            </Section>
            <FontSection facets={facets} fresh={fresh} value={font} onChange={setFont} />
          </>
        ) : null}
        <Section title="Design score" hint="0 is the worst, 100 the best.">
          <div className="flex items-center gap-2">
            <ScoreInput label="Lowest score" value={smin} onChange={setSmin} />
            <span className="text-sm text-muted-foreground">to</span>
            <ScoreInput label="Highest score" value={smax} onChange={setSmax} />
          </div>
        </Section>
        <Section title="Date received">
          <RadioPills<GalleryDate>
            name="gallery-date"
            value={date}
            onChange={setDate}
            options={GALLERY_DATES.map((d) => ({ value: d, label: GALLERY_DATE_LABELS[d] }))}
          />
          {date === "custom" ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <DateInput label="From" value={since} max={until || undefined} onChange={setSince} />
              <DateInput label="To" value={until} min={since || undefined} onChange={setUntil} />
            </div>
          ) : null}
        </Section>
        <SenderSection facets={facets} fresh={fresh} value={sender} onChange={setSender} />
        <Section
          title="Problems"
          hint="Each one makes a design Bad. Shows designs with any you tick."
        >
          <ul className="space-y-1">
            {GALLERY_PROBLEMS.map((x) => (
              <li key={x}>
                <CheckRow
                  checked={problem.includes(x)}
                  onChange={(on) =>
                    setProblem((cur) =>
                      on
                        ? GALLERY_PROBLEMS.filter((p) => p === x || cur.includes(p))
                        : cur.filter((p) => p !== x),
                    )
                  }
                  label={GALLERY_PROBLEM_LABELS[x]}
                  count={facets.problems[x]}
                  fresh={fresh}
                />
              </li>
            ))}
          </ul>
        </Section>
        {showMailboxes ? (
          <Section title="Mailbox">
            <RadioPills<string>
              name="gallery-mailbox"
              value={mailbox ?? ""}
              fresh={fresh}
              onChange={(v) => setMailbox(v === "" ? null : v)}
              options={[
                { value: "", label: "All mailboxes" },
                ...facets.mailboxes.map((m) => ({
                  value: m.id,
                  label: m.address,
                  count: m.count,
                })),
              ]}
            />
          </Section>
        ) : null}
        {facets.boards.length > 0 ? (
          <Section title="Board">
            <RadioPills<string>
              name="gallery-board"
              value={board ?? ""}
              fresh={fresh}
              onChange={(v) => setBoard(v === "" ? null : v)}
              options={[
                { value: "", label: "Any design" },
                ...facets.boards.map((b) => ({ value: b.id, label: b.name, count: b.count })),
              ]}
            />
          </Section>
        ) : null}
        <Section title="Fonts">
          <RadioPills<GalleryWebFonts>
            name="gallery-webfonts"
            value={webfonts}
            fresh={fresh}
            onChange={setWebfonts}
            options={GALLERY_WEB_FONTS.map((w) => ({
              value: w,
              label: GALLERY_WEB_FONT_LABELS[w],
              count:
                w === "yes" ? facets.webFonts.yes : w === "no" ? facets.webFonts.no : undefined,
            }))}
          />
        </Section>
      </div>
      <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface-overlay px-4 py-3">
        <Button variant="secondary" size="lg" className="flex-1" onClick={clearAll}>
          Clear all
        </Button>
        <Button variant="primary" size="lg" className="flex-1" onClick={apply} aria-busy={!fresh}>
          {fresh
            ? `Show ${formatNumber(total)} ${total === 1 ? "design" : "designs"}`
            : "Show designs"}
        </Button>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** A count; faint while the draft's own numbers are on their way (`fresh` false). */
function Count({ n, fresh = true }: { n: number; fresh?: boolean }) {
  return (
    <span
      className={cn(
        "text-xs text-subtle-foreground tabular transition-opacity",
        !fresh && "opacity-40",
      )}
    >
      {formatNumber(n)}
    </span>
  );
}

/** One choice out of a few, as pills (native radio buttons: arrow keys move between them). */
function RadioPills<T extends string>({
  name,
  value,
  onChange,
  options,
  fresh = true,
}: {
  name: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  fresh?: boolean;
}) {
  return (
    <div role="radiogroup" aria-busy={!fresh} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label
          key={o.value}
          className="relative inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors select-none hover:bg-surface-muted has-checked:border-foreground has-checked:bg-foreground has-checked:text-background has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          <span className="truncate">{o.label}</span>
          {o.count !== undefined ? (
            <span
              className={cn(
                "text-xs tabular transition-opacity",
                fresh ? "opacity-60" : "opacity-25",
              )}
            >
              {formatNumber(o.count)}
            </span>
          ) : null}
        </label>
      ))}
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  detail,
  count,
  fresh,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  detail?: string | null;
  count: number;
  fresh: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-surface-muted",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onChange} disabled={disabled} />
      <span className="min-w-0 flex-1 text-sm">
        <span className="block truncate">{label}</span>
        {detail ? (
          <span className="block truncate text-xs text-subtle-foreground">{detail}</span>
        ) : null}
      </span>
      <Count n={count} fresh={fresh} />
    </label>
  );
}

function ScoreInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      max={100}
      step={1}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-20 text-center tabular"
    />
  );
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        type="date"
        value={value}
        min={min ?? "2000-01-01"}
        max={max ?? "2100-12-31"}
        onChange={(e) => onChange(e.target.value)}
        className="h-9"
      />
    </div>
  );
}

/** Font by name (phones only: from tablets up the font picker sits in the bar). */
function FontSection({
  facets,
  fresh,
  value,
  onChange,
}: {
  facets: GalleryFacets;
  fresh: boolean;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const id = useId();
  const known = facets.fonts.some((f) => f.name.toLowerCase() === value?.toLowerCase());
  return (
    <Section title="Font">
      <label htmlFor={id} className="sr-only">
        Font
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-foreground"
      >
        <option value="">Any font</option>
        {/* While the draft's counts load, names only (the old numbers would be wrong). */}
        {facets.fonts.map((f) => (
          <option key={f.name} value={f.name}>
            {fresh ? `${f.name} (${formatNumber(f.count)})` : f.name}
          </option>
        ))}
        {value && !known ? <option value={value}>{fresh ? `${value} (0)` : value}</option> : null}
      </select>
    </Section>
  );
}

/**
 * Senders: a searchable list (most designs first, ticked ones on top), up to 20 ticked. A sender
 * whose name another one shares (LinkedIn sends from four addresses) shows its address under it.
 */
function SenderSection({
  facets,
  fresh,
  value,
  onChange,
}: {
  facets: GalleryFacets;
  fresh: boolean;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  // The senders ticked when the panel opened go first; ticking another doesn't move rows around.
  const [pinned] = useState(() => new Set(value));
  const full = value.length >= GALLERY_SENDERS_MAX;
  const shared = useMemo(() => sharedSenderNames(facets.senders), [facets.senders]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = facets.senders.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        (s.domain ?? "").toLowerCase().includes(q) ||
        s.address.toLowerCase().includes(q),
    );
    return [
      ...matches.filter((s) => pinned.has(s.id)),
      ...matches.filter((s) => !pinned.has(s.id)),
    ];
  }, [facets.senders, query, pinned]);
  if (facets.senders.length === 0) return null;
  return (
    <Section
      title="Senders"
      hint={
        full
          ? `That's the most you can pick (${GALLERY_SENDERS_MAX}).`
          : value.length
            ? `${value.length} picked`
            : undefined
      }
    >
      {facets.senders.length > 8 ? (
        <SearchField
          value={query}
          onValueChange={setQuery}
          aria-label="Find a sender"
          placeholder="Find a sender"
          className="mb-2 w-full"
        />
      ) : null}
      {shown.length ? (
        <ul
          className="max-h-60 space-y-0.5 overflow-y-auto overscroll-contain"
          aria-label="Senders"
        >
          {shown.map((s) => {
            const on = value.includes(s.id);
            return (
              <li key={s.id}>
                <CheckRow
                  checked={on}
                  disabled={!on && full}
                  onChange={(next) =>
                    onChange(
                      next
                        ? [...value, s.id].slice(0, GALLERY_SENDERS_MAX)
                        : value.filter((x) => x !== s.id),
                    )
                  }
                  label={s.name}
                  detail={
                    shared.has(s.name.trim().toLowerCase())
                      ? s.address
                      : s.domain && s.domain !== s.name
                        ? s.domain
                        : null
                  }
                  count={s.count}
                  fresh={fresh}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-2 py-3 text-sm text-muted-foreground">No sender matches “{query}”.</p>
      )}
    </Section>
  );
}
