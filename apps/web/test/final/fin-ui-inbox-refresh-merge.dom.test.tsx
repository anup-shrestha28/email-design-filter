/**
 * R1-05 follow-up: merging a refreshed first page into a list "load more" had extended must never
 * hide mail. The merge used to cut the loaded list at the furthest old position of ANY item on the
 * fresh page, so an item jumping up from a later loaded page (an Analyze under sort=score) silently
 * dropped every loaded item between the first page and its old position, and the kept cursor never
 * fetched them again. Now it anchors on the page's last item and starts over whenever loaded mail
 * ranked above it would go missing.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FacetCounts, InboxFilters, InboxItem, InboxPage } from "@/server/queries/types";
import { render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({
  queryInbox: vi.fn(),
  scrollToOffset: vi.fn(),
}));

vi.mock("@/app/(app)/inbox/actions", () => ({ queryInbox: h.queryInbox }));
vi.mock("@/server/actions/email", () => ({ setDone: vi.fn(), setPinned: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
// jsdom has no layout, so the real virtualizer would show no rows: this one shows every row and
// records scroll calls. Like the real hook, it keeps one instance per component.
vi.mock("@tanstack/react-virtual", async () => {
  const { useState } = await import("react");
  interface Opts {
    count: number;
    getItemKey: (i: number) => string | number;
  }
  return {
    useVirtualizer: (opts: Opts) => {
      const [inst] = useState(() => ({
        opts,
        scrollToOffset: h.scrollToOffset,
        scrollToIndex: () => {},
        measureElement: () => {},
        getTotalSize: () => inst.opts.count * 86,
        getVirtualItems: () =>
          Array.from({ length: inst.opts.count }, (_, index) => ({ index, key: inst.opts.getItemKey(index), start: index * 86 })),
      }));
      inst.opts = opts;
      return inst;
    },
  };
});
vi.mock("@/components/email/inbox-row", () => ({
  InboxRow: ({ item, checked, onCheckedChange }: { item: InboxItem; checked: boolean; onCheckedChange: (on: boolean) => void }) => (
    <div data-row={item.id}>
      <input type="checkbox" data-check={item.id} checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />
    </div>
  ),
}));
vi.mock("@/components/shell/topbar", () => ({ ScopeToggle: () => null }));
vi.mock("@/components/inbox/facet-rail", () => ({ FacetRail: () => null }));
vi.mock("@/components/inbox/filter-chips", () => ({ CLEARED_FILTERS: {}, FilterChips: () => null }));
vi.mock("@/components/inbox/preview-pane", () => ({
  PreviewPane: () => null,
  previewQueryKey: (id: string) => ["email-preview", id],
  fetchPreview: vi.fn(),
}));
vi.mock("@/components/inbox/use-inbox-filters", () => ({
  useInboxFilters: () => ({ params: { view: null, sort: "newest" }, setParams: vi.fn(), pending: false }),
}));
vi.mock("@/components/ui/select", () => ({ Select: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Sheet: () => null }));

const { InboxView } = await import("@/components/inbox/inbox-view");

const FILTERS: InboxFilters = {
  scope: "all",
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
  sort: "newest",
} as InboxFilters;

const COUNTS: FacetCounts = { total: 9, types: {}, importance: {}, design: {}, issues: {}, deals: {}, unread: 0, suspicious: 0 };

const item = (id: string): InboxItem => ({ id, subject: id, done: false, pinned: false, openedInApp: false }) as InboxItem;
const pageOf = (ids: string[], nextCursor: string | null): InboxPage => ({ items: ids.map(item), nextCursor, pinned: [] });
const result = (ids: string[], nextCursor: string | null) => ({ ok: true, data: { page: pageOf(ids, nextCursor), counts: null } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const never = () => new Promise(() => {});

function ui(filters: InboxFilters, page: InboxPage, counts: FacetCounts = COUNTS) {
  return <InboxView filters={filters} page={page} counts={counts} fonts={[]} hasMailbox />;
}

const rowIds = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-row]")].map((el) => el.dataset.row);

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const calls = (cursor: string) => h.queryInbox.mock.calls.filter((c) => c[2] === cursor).length;

describe("InboxView refresh merge", () => {
  beforeEach(() => {
    h.queryInbox.mockReset();
    h.scrollToOffset.mockReset();
  });

  async function loaded() {
    const pending = deferred<unknown>();
    h.queryInbox
      .mockResolvedValueOnce(result(["b1", "b2", "b3", "b4", "b5"], "c2"))
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(never);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2", "a3", "a4", "a5"], "c1")));
    await waitFor(() => expect(rowIds(r.container)).toEqual(["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4", "b5"]));
    await waitFor(() => expect(calls("c2")).toBe(1));
    return { r, pending };
  }

  it("an item jumping up from a later loaded page into the first page keeps every other loaded item", async () => {
    const { r, pending } = await loaded();
    await r.rerender(ui(structuredClone(FILTERS), pageOf(["b5", "a1", "a2", "a3", "a4"], "c1b"), structuredClone(COUNTS)));
    await settle();
    expect(rowIds(r.container)).toEqual(["b5", "a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4"]);
    // The kept cursor still continues after the loaded pages.
    await act(async () => {
      pending.resolve(result(["late"], "c9"));
    });
    await settle();
    expect(rowIds(r.container)).not.toContain("late");
    await waitFor(() => expect(calls("c2")).toBe(2));
  });

  it("the page's last item jumping up from a later loaded page starts over instead of hiding what it passed", async () => {
    const { r, pending } = await loaded();
    await r.rerender(ui(structuredClone(FILTERS), pageOf(["a1", "a2", "a3", "a4", "b5"], "cB5"), structuredClone(COUNTS)));
    await settle();
    expect(rowIds(r.container)).toEqual(["a1", "a2", "a3", "a4", "b5"]);
    await act(async () => {
      pending.resolve(result(["late"], "c9"));
    });
    await settle();
    // a5 and b1..b4 now rank after b5: the next page is fetched from the fresh cursor.
    await waitFor(() => expect(h.queryInbox).toHaveBeenLastCalledWith(FILTERS, "", "cB5"));
  });

  it("a first-page item missing from the refresh (it may now rank lower) starts over", async () => {
    const { r, pending } = await loaded();
    await r.rerender(ui(structuredClone(FILTERS), pageOf(["a1", "a3", "a4", "a5", "b1"], "cB1"), structuredClone(COUNTS)));
    await settle();
    expect(rowIds(r.container)).toEqual(["a1", "a3", "a4", "a5", "b1"]);
    await act(async () => {
      pending.resolve(result(["late"], "c9"));
    });
    await settle();
    await waitFor(() => expect(h.queryInbox).toHaveBeenLastCalledWith(FILTERS, "", "cB1"));
  });
});
