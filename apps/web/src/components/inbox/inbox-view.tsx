"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Check,
  Inbox as InboxIcon,
  ListFilter,
  LoaderCircle,
  PanelLeftClose,
  Pin,
  SearchX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { queryInbox } from "@/app/(app)/inbox/actions";
import { InboxRow } from "@/components/email/inbox-row";
import { ScopeToggle } from "@/components/shell/topbar";
import { Button, LinkButton } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Select } from "@/components/ui/select";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { cn } from "@/lib/cn";
import { SMART_VIEW_LABELS } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { activeFilterCount } from "@/lib/inbox-params";
import { SORT_LABELS } from "@/lib/labels";
import { setDone, setPinned } from "@/server/actions/email";
import type {
  EmailDetail,
  FacetCounts,
  FontOption,
  InboxFilters,
  InboxItem,
  InboxPage,
  SortKey,
} from "@/server/queries/types";
import { FacetRail } from "./facet-rail";
import { CLEARED_FILTERS, FilterChips } from "./filter-chips";
import { fetchPreview, PreviewPane, previewQueryKey } from "./preview-pane";
import { useInboxFilters } from "./use-inbox-filters";

type Row =
  | { kind: "header"; key: string; label: string; icon?: "pin" }
  | { kind: "email"; key: string; item: InboxItem; emailIndex: number }
  | { kind: "footer"; key: string };

const SORTS: SortKey[] = ["newest", "oldest", "score", "importance", "deal_ending"];
const isWidth = (v: unknown): v is number => typeof v === "number" && v >= 320 && v <= 720;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
/** The list's assumed size before it can be measured (server render and hydration). */
const SSR_LIST_RECT = { width: 440, height: 800 };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** `value` as first seen for this `key`: a new object with the same key keeps the old identity. */
function useStableByKey<T>(value: T, key: string): T {
  const [held, setHeld] = useState({ key, value });
  if (held.key !== key) {
    setHeld({ key, value });
    return value;
  }
  return held.value;
}

/**
 * The list after a refresh of the same filters when "load more" had extended it: the refreshed
 * first page, then the loaded items after the one that ends that page (an item pushed off the
 * first page by new mail is kept; one that moved up into the first page from a later loaded page
 * is shown once, in its new place). Null — the caller starts over from the fresh page — when the
 * merge could hide mail the kept cursor would never fetch again:
 * - the page's last item isn't in the loaded list (more new mail than a page holds, or an item that
 *   jumped up from past the loaded pages), so whatever ranks between the two would be skipped;
 * - a loaded item that ranked above that last item is missing from the fresh page: it either left
 *   the view or now ranks lower (a score or importance change, or the last item jumped up past it),
 *   and a lower rank puts it inside the loaded range where the old cursor can't reach it.
 * Loaded pages after the first are kept as they were fetched, so mail that joined their range since
 * (an import back-filling older mail, or a never-loaded item that moved up under sort=score after a
 * score change) shows up on the next reset.
 */
function mergeRefreshedPage(old: InboxItem[], fresh: InboxItem[]): InboxItem[] | null {
  const last = fresh.at(-1);
  if (!last) return null;
  const boundary = old.findIndex((i) => i.id === last.id);
  if (boundary < 0) return null;
  const freshIds = new Set(fresh.map((i) => i.id));
  if (old.slice(0, boundary).some((i) => !freshIds.has(i.id))) return null;
  return [...fresh, ...old.slice(boundary + 1).filter((i) => !freshIds.has(i.id))];
}

function desktop(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches;
}

export function InboxView({
  filters,
  page,
  counts,
  fonts,
  hasMailbox,
}: {
  filters: InboxFilters;
  page: InboxPage;
  counts: FacetCounts;
  fonts: FontOption[];
  hasMailbox: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { params, setParams, pending: filtersPending } = useInboxFilters();

  // ── data: server page, replaced by search results and extended by "load more" ──
  // The server component rebuilds `filters`, `page` and `counts` on every render, so a
  // router.refresh() (sync poll, Analyze) hands us new objects for the same filters. Effects key on
  // the filters' content, not their identity: a refresh must not scroll to the top, drop the pages
  // "load more" added or clear the bulk selection.
  const filtersKey = JSON.stringify(filters);
  const stableFilters = useStableByKey(filters, filtersKey);
  const [items, setItems] = useState(page.items);
  const [pinned, setPinnedItems] = useState(page.pinned);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [facetCounts, setFacetCounts] = useState(counts);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const debouncedQuery = useDebounced(query.trim(), 250);
  /**
   * Bumped whenever the list is replaced or merged (new server page, search started or cleared),
   * so a search or "load more" response that arrives after that is dropped instead of being written
   * over (or appended to) a list it no longer belongs to.
   */
  const listSeq = useRef(0);
  /** The list as last committed, for merging a refreshed first page into it. */
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  /** What the list shows: the server page for these filters (and whether "load more" extended it), or search results. */
  const shown = useRef<{ filtersKey: string | null; extended: boolean }>({
    filtersKey,
    extended: false,
  });

  useEffect(() => {
    if (debouncedQuery) return;
    listSeq.current++;
    const prev = shown.current;
    shown.current = { filtersKey, extended: false };
    setPinnedItems(page.pinned);
    setFacetCounts(counts);
    const merged =
      prev.filtersKey === filtersKey && prev.extended && page.nextCursor
        ? mergeRefreshedPage(itemsRef.current, page.items)
        : null;
    if (merged) {
      // Same filters, refreshed data: take the new first page and keep the loaded pages after it
      // (and the cursor that continues them). A first page that is now the whole list, or that
      // doesn't line up with the loaded items (see mergeRefreshedPage), replaces them.
      shown.current.extended = true;
      setItems(merged);
      return;
    }
    setItems(page.items);
    setCursor(page.nextCursor);
  }, [page, counts, debouncedQuery, filtersKey]);

  useEffect(() => {
    const seq = ++listSeq.current;
    if (!debouncedQuery) {
      setSearching(false);
      return;
    }
    shown.current = { filtersKey: null, extended: false };
    setSearching(true);
    queryInbox(stableFilters, debouncedQuery).then((r) => {
      if (seq !== listSeq.current) return;
      setSearching(false);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setItems(r.data.page.items);
      setPinnedItems([]);
      setCursor(r.data.page.nextCursor);
      if (r.data.counts) setFacetCounts(r.data.counts);
    });
  }, [debouncedQuery, stableFilters]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const seq = listSeq.current;
    setLoadingMore(true);
    const r = await queryInbox(stableFilters, debouncedQuery, cursor);
    setLoadingMore(false);
    if (seq !== listSeq.current) return; // the list changed meanwhile; this page belongs to the old one
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (shown.current.filtersKey !== null) shown.current.extended = true;
    setItems((prev) => {
      const seen = new Set(prev.map((i) => i.id));
      return [...prev, ...r.data.page.items.filter((i) => !seen.has(i.id))];
    });
    setCursor(r.data.page.nextCursor);
  }, [cursor, loadingMore, stableFilters, debouncedQuery]);

  // ── rows for the virtual list ──
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let emailIndex = 0;
    const pinnedIds = new Set(pinned.map((p) => p.id));
    if (pinned.length) {
      out.push({
        kind: "header",
        key: "h:pinned",
        label: `Pinned · ${pinned.length}`,
        icon: "pin",
      });
      for (const item of pinned)
        out.push({ kind: "email", key: `p:${item.id}`, item, emailIndex: emailIndex++ });
      out.push({ kind: "header", key: "h:rest", label: "Everything else" });
    }
    for (const item of items) {
      if (pinnedIds.has(item.id)) continue;
      out.push({ kind: "email", key: item.id, item, emailIndex: emailIndex++ });
    }
    if (items.length) out.push({ kind: "footer", key: "footer" });
    return out;
  }, [items, pinned]);
  const emailRows = useMemo(
    () => rows.filter((r): r is Extract<Row, { kind: "email" }> => r.kind === "email"),
    [rows],
  );

  // ── selection ──
  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const activeIndex = activeId ? emailRows.findIndex((r) => r.item.id === activeId) : -1;

  useEffect(() => {
    setChecked(new Set());
  }, [filtersKey]);

  // ── virtualizer ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "email" ? 86 : rows[i]?.kind === "header" ? 32 : 64),
    overscan: 10,
    getItemKey: (i) => rows[i]?.key ?? i,
    // The server (and hydration's first render) has no scroll element to measure; without a starting
    // size the range is empty and a hard load shows a blank list until hydration. Assume a typical
    // viewport so the first screen of rows is in the HTML; the real size is measured on mount.
    initialRect: SSR_LIST_RECT,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems.at(-1)?.index ?? 0;

  useEffect(() => {
    if (cursor && !loadingMore && lastVisible >= rows.length - 6) void loadMore();
  }, [lastVisible, rows.length, cursor, loadingMore, loadMore]);

  useEffect(() => {
    virtualizer.scrollToOffset(0);
    // new result set (other filters, or a search) → back to the top; a refresh of the same one stays put
  }, [filtersKey, debouncedQuery, virtualizer]);

  // ── mutations (optimistic, with rollback) ──
  const patch = useCallback((id: string, change: Partial<InboxItem>) => {
    const apply = (list: InboxItem[]) => list.map((i) => (i.id === id ? { ...i, ...change } : i));
    setItems(apply);
    setPinnedItems(apply);
  }, []);

  const findItem = useCallback(
    (id: string) => items.find((i) => i.id === id) ?? pinned.find((i) => i.id === id),
    [items, pinned],
  );

  const toggleDone = useCallback(
    async (ids: string[]) => {
      const targets = ids.map(findItem).filter((i): i is InboxItem => Boolean(i));
      if (!targets.length) return;
      const next = !targets.every((t) => t.done);
      for (const t of targets) patch(t.id, { done: next });
      const results = await Promise.all(targets.map((t) => setDone(t.id, next)));
      const failed = targets.filter((_, i) => !results[i]?.ok);
      for (const t of failed) patch(t.id, { done: t.done });
      if (failed.length) {
        toast.error("Couldn't update some emails. Please try again.");
        return;
      }
      for (const t of targets)
        void queryClient.invalidateQueries({ queryKey: previewQueryKey(t.id) });
      toast.success(
        next
          ? targets.length > 1
            ? `${targets.length} emails marked done`
            : "Marked done"
          : "Marked not done",
        {
          action: {
            label: "Undo",
            onClick: () => {
              for (const t of targets) patch(t.id, { done: !next });
              // The open preview keeps its own cached copy of the email; refetch it once the
              // server has the undone state, or it would keep showing "Done".
              for (const t of targets)
                void setDone(t.id, !next).then(() =>
                  queryClient.invalidateQueries({ queryKey: previewQueryKey(t.id) }),
                );
            },
          },
        },
      );
    },
    [findItem, patch, queryClient],
  );

  const togglePin = useCallback(
    async (ids: string[]) => {
      const targets = ids.map(findItem).filter((i): i is InboxItem => Boolean(i));
      if (!targets.length) return;
      const next = !targets.every((t) => t.pinned);
      for (const t of targets) patch(t.id, { pinned: next });
      const results = await Promise.all(targets.map((t) => setPinned(t.id, next)));
      const failed = targets.filter((_, i) => !results[i]?.ok);
      for (const t of failed) patch(t.id, { pinned: t.pinned });
      if (failed.length) toast.error("Couldn't update some emails. Please try again.");
      else {
        for (const t of targets)
          void queryClient.invalidateQueries({ queryKey: previewQueryKey(t.id) });
        toast.success(
          next ? (targets.length > 1 ? `${targets.length} emails pinned` : "Pinned") : "Unpinned",
        );
      }
    },
    [findItem, patch, queryClient],
  );

  const onPreviewDetail = useCallback(
    (d: EmailDetail) =>
      patch(d.id, {
        done: d.state.doneAt !== null,
        pinned: d.state.pinnedAt !== null,
        openedInApp: d.state.openedInAppAt !== null,
      }),
    [patch],
  );

  /**
   * "This is personal" in the preview deleted the email and every stored one from its sender: drop
   * them from the list (search results aren't refreshed by the server re-render) and close the pane.
   * The URL, and so the filters, stay as they are.
   */
  const onPreviewRemoved = useCallback(
    (d: EmailDetail) => {
      const gone = new Set(
        [...items, ...pinned]
          .filter((i) => d.senderId !== null && i.senderId === d.senderId)
          .map((i) => i.id),
      ).add(d.id);
      setItems((list) => list.filter((i) => !gone.has(i.id)));
      setPinnedItems((list) => list.filter((i) => !gone.has(i.id)));
      setChecked((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      setActiveId((prev) => (prev && gone.has(prev) ? null : prev));
      setPreviewId((prev) => (prev && gone.has(prev) ? null : prev));
    },
    [items, pinned],
  );

  // ── open / move ──
  const openItem = useCallback(
    (id: string, e?: MouseEvent<HTMLAnchorElement>) => {
      if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return; // new tab etc.
      setActiveId(id);
      if (desktop()) {
        e?.preventDefault();
        setPreviewId(id);
      } else if (!e) {
        router.push(`/email/${id}?back=%2Finbox` as Route);
      }
    },
    [router],
  );

  const move = useCallback(
    (delta: number) => {
      if (!emailRows.length) return;
      const next = Math.max(
        0,
        Math.min(
          emailRows.length - 1,
          (activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex) + delta,
        ),
      );
      const row = emailRows[next];
      if (!row) return;
      setActiveId(row.item.id);
      if (desktop()) setPreviewId(row.item.id);
      const rowIndex = rows.indexOf(row);
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      requestAnimationFrame(() =>
        linkRefs.current.get(row.item.id)?.focus({ preventScroll: true }),
      );
      const ahead = emailRows[next + 1];
      if (ahead)
        void queryClient.prefetchQuery({
          queryKey: previewQueryKey(ahead.item.id),
          queryFn: () => fetchPreview(ahead.item.id),
          staleTime: 120_000,
        });
    },
    [activeIndex, emailRows, queryClient, rows, virtualizer],
  );

  const searchRef = useRef<HTMLInputElement>(null);
  /** Arrow keys and Enter act on the list only when focus is on the page or on a row. */
  const onList = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !t || t === document.body || t.id === "main" || Boolean(t.closest("[data-inbox-list]"));
  };
  const targetIds = () => (checked.size ? [...checked] : activeId ? [activeId] : []);
  useHotkeys([
    { keys: "j", handler: () => move(1) },
    { keys: "arrowdown", handler: (e) => (onList(e) ? move(1) : false) },
    { keys: "k", handler: () => move(-1) },
    { keys: "arrowup", handler: (e) => (onList(e) ? move(-1) : false) },
    {
      keys: "enter",
      handler: (e) => {
        if (!activeId || !onList(e)) return false;
        // Enter on a control inside a row (its checkbox) belongs to that control; only the page
        // itself or a row's link opens the active email.
        const t = e.target as HTMLElement | null;
        if (t?.closest?.("[data-inbox-list]") && t.tagName !== "A") return false;
        router.push(`/email/${activeId}?back=%2Finbox` as Route);
      },
    },
    { keys: "e", handler: () => void toggleDone(targetIds()) },
    { keys: "p", handler: () => void togglePin(targetIds()) },
    {
      keys: "x",
      handler: () => {
        if (!activeId) return;
        setChecked((prev) => {
          const n = new Set(prev);
          if (n.has(activeId)) n.delete(activeId);
          else n.add(activeId);
          return n;
        });
      },
    },
    {
      keys: "escape",
      allowInInput: true,
      handler: (e) => {
        if (document.activeElement === searchRef.current) {
          if (query) setQuery("");
          else searchRef.current?.blur();
          return;
        }
        if (checked.size) setChecked(new Set());
        else if (previewId) setPreviewId(null);
        else (e.target as HTMLElement | null)?.blur?.();
      },
    },
  ]);

  // ── layout prefs ──
  const [listWidth, setListWidth] = useLocalStorage("edf.inbox.listWidth", 440, isWidth);
  const [railOpen, setRailOpen] = useLocalStorage("edf.inbox.rail", true, isBool);
  const [sheetOpen, setSheetOpen] = useState(false);

  const filterCount = activeFilterCount(filters);
  const title = params.view ? SMART_VIEW_LABELS[params.view] : "Inbox";
  const total = debouncedQuery ? null : facetCounts.total;
  const busy = filtersPending || searching;

  function toggleFilters() {
    if (desktop()) setRailOpen(!railOpen);
    else setSheetOpen(true);
  }

  const list = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain transition-opacity",
          busy && "opacity-60",
        )}
        aria-busy={busy}
      >
        {rows.length === 0 ? (
          <ListEmpty
            hasMailbox={hasMailbox}
            searching={Boolean(debouncedQuery)}
            filtered={filterCount > 0}
            view={params.view ? SMART_VIEW_LABELS[params.view] : null}
            onClear={() => {
              setQuery("");
              void setParams(CLEARED_FILTERS);
            }}
            onLeaveView={() => void setParams({ view: null })}
          />
        ) : (
          <ul
            data-inbox-list
            aria-label={`${title}: emails`}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              return (
                <li
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${v.start}px)` }}
                  aria-setsize={row.kind === "email" ? emailRows.length : undefined}
                  aria-posinset={row.kind === "email" ? row.emailIndex + 1 : undefined}
                >
                  {row.kind === "header" ? (
                    <div className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-surface-muted/60 px-4 text-2xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
                      {row.icon === "pin" ? <Pin className="size-3 rotate-45" aria-hidden /> : null}
                      {row.label}
                    </div>
                  ) : row.kind === "footer" ? (
                    <div className="flex h-16 items-center justify-center text-xs text-subtle-foreground">
                      {cursor ? (
                        <span className="flex items-center gap-2">
                          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                          Loading more…
                        </span>
                      ) : (
                        <span>
                          That&apos;s everything
                          {total !== null ? ` · ${formatNumber(total)} emails` : ""}
                        </span>
                      )}
                    </div>
                  ) : (
                    <InboxRow
                      item={row.item}
                      active={row.item.id === activeId}
                      checked={checked.has(row.item.id)}
                      tabIndex={
                        row.item.id === activeId || (activeId === null && row.emailIndex === 0)
                          ? 0
                          : -1
                      }
                      linkRef={(el) => {
                        if (el) linkRefs.current.set(row.item.id, el);
                        else linkRefs.current.delete(row.item.id);
                      }}
                      onOpen={(e) => openItem(row.item.id, e)}
                      onToggleDone={() => void toggleDone([row.item.id])}
                      onTogglePin={() => void togglePin([row.item.id])}
                      onCheckedChange={(on) =>
                        setChecked((prev) => {
                          const n = new Set(prev);
                          if (on) n.add(row.item.id);
                          else n.delete(row.item.id);
                          return n;
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {checked.size > 0 ? (
        <div
          className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-xl border border-border bg-surface-overlay p-1.5 pl-3 shadow-overlay"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span className="text-[0.8125rem] font-medium text-foreground">
            {checked.size} selected
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => void toggleDone([...checked])}>
              <Check aria-hidden /> Done
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void togglePin([...checked])}>
              <Pin aria-hidden /> Pin
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection"
              onClick={() => setChecked(new Set())}
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Facet rail (desktop) */}
      {railOpen ? (
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border xl:flex">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-[0.8125rem] font-semibold text-foreground">Filters</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide filters"
              onClick={() => setRailOpen(false)}
            >
              <PanelLeftClose aria-hidden />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FacetRail counts={facetCounts} fonts={fonts} />
          </div>
        </aside>
      ) : null}

      {/* List */}
      <section
        aria-label={title}
        className="flex min-w-0 flex-1 flex-col border-r-0 border-border xl:w-(--list-w) xl:flex-none xl:border-r"
        style={{ "--list-w": `${listWidth}px` } as React.CSSProperties}
      >
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 truncate text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">
              {title}
              {total !== null ? (
                <span className="ml-2 text-xs font-normal text-subtle-foreground tabular">
                  {formatNumber(total)}
                </span>
              ) : null}
            </h1>
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin text-accent" aria-label="Updating" />
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Select<SortKey>
                aria-label="Sort"
                size="sm"
                value={params.sort}
                onValueChange={(v) => void setParams({ sort: v })}
                options={SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
                className="min-w-0"
              />
              <Button
                variant={filterCount > 0 ? "soft" : "ghost"}
                size="sm"
                onClick={toggleFilters}
                aria-label={`Filters${filterCount ? ` (${filterCount} active)` : ""}`}
                className={cn(railOpen && "xl:hidden")}
              >
                <ListFilter aria-hidden />
                <span className="hidden sm:inline">Filters</span>
                {filterCount > 0 ? <span className="tabular">{filterCount}</span> : null}
              </Button>
            </div>
          </div>
          <SearchField
            inputRef={searchRef}
            data-inbox-search
            value={query}
            onValueChange={setQuery}
            placeholder="Search subject and sender"
            aria-label="Search this inbox"
            hint="/"
            pending={searching}
          />
          <ScopeToggle className="[&_button]:flex-1" />
          <FilterChips fonts={fonts} />
        </div>
        {list}
      </section>

      {/* Resize handle + preview (desktop) */}
      <ResizeHandle width={listWidth} onChange={setListWidth} />
      <section
        aria-label="Preview"
        className="hidden min-w-0 flex-1 overflow-y-auto bg-background xl:block"
      >
        <PreviewPaneWithSync
          emailId={previewId}
          onDetail={onPreviewDetail}
          onRemoved={onPreviewRemoved}
        />
      </section>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen} side="left" title="Filters">
        <FacetRail counts={facetCounts} fonts={fonts} />
      </Sheet>
    </div>
  );
}

function PreviewPaneWithSync({
  emailId,
  onDetail,
  onRemoved,
}: {
  emailId: string | null;
  onDetail: (d: EmailDetail) => void;
  onRemoved: (d: EmailDetail) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <PreviewPane
      emailId={emailId}
      onRemoved={onRemoved}
      onChanged={() => {
        if (!emailId) return;
        void queryClient
          .fetchQuery({ queryKey: previewQueryKey(emailId), queryFn: () => fetchPreview(emailId) })
          .then(onDetail)
          .catch(() => undefined);
      }}
    />
  );
}

function ResizeHandle({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: width });
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize list"
      aria-valuenow={width}
      aria-valuemin={320}
      aria-valuemax={720}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(Math.max(320, width - 24));
        if (e.key === "ArrowRight") onChange(Math.min(720, width + 24));
      }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onChange(Math.max(320, Math.min(720, start.current.w + e.clientX - start.current.x)));
      }}
      onPointerUp={() => setDragging(false)}
      className={cn(
        "relative -ml-px hidden w-1.5 shrink-0 cursor-col-resize touch-none outline-none xl:block",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent",
        dragging && "after:bg-accent",
      )}
    />
  );
}

function ListEmpty({
  hasMailbox,
  searching,
  filtered,
  view,
  onClear,
  onLeaveView,
}: {
  hasMailbox: boolean;
  searching: boolean;
  filtered: boolean;
  /** The active smart view's label: it narrows the list like a filter (CLEARED_FILTERS clears it). */
  view: string | null;
  onClear: () => void;
  onLeaveView: () => void;
}) {
  if (!hasMailbox) {
    return (
      <EmptyState
        icon={<InboxIcon />}
        title="No mail yet"
        description="Connect your Gmail and your newsletters, deals and receipts appear here within a few minutes."
        action={
          <LinkButton href="/connect" variant="primary">
            Connect Gmail
          </LinkButton>
        }
      />
    );
  }
  if (searching || filtered) {
    return (
      <EmptyState
        icon={<SearchX />}
        title={searching ? "No emails match your search" : "Nothing matches these filters"}
        description={
          searching
            ? "Search looks at subjects, senders and a short excerpt. Try fewer words."
            : "Try removing a filter or two, or switch the scope to All."
        }
        action={
          <Button variant="secondary" onClick={onClear}>
            Clear {searching ? "search and filters" : "filters"}
          </Button>
        }
      />
    );
  }
  if (view) {
    return (
      <EmptyState
        icon={<InboxIcon />}
        title={`Nothing in ${view}`}
        description={`No mail in this scope is in “${view}” right now.`}
        action={
          <Button variant="secondary" onClick={onLeaveView}>
            Show all mail
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<InboxIcon />}
      title="All clear"
      description="There's no mail in this scope yet."
    />
  );
}
