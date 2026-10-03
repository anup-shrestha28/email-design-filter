/**
 * The inbox list survives a server re-render of the same filters, and late responses can't
 * overwrite a list they no longer belong to.
 * - R1-05: router.refresh() (sync poll, Analyze) hands InboxView new `filters`/`page`/`counts`
 *   objects with the same content; it used to scroll to the top, drop the pages "load more" added
 *   and clear the bulk selection.
 * - R1-06: clearing the search didn't invalidate the search in flight, and "load more" had no guard,
 *   so a late response replaced (or extended) the list after the search was cleared / filters changed.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FacetCounts, InboxFilters, InboxItem, InboxPage } from "@/server/queries/types";
import { click, render, waitFor } from "../support/render";

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
const box = (c: HTMLElement, id: string) => c.querySelector<HTMLInputElement>(`[data-check="${id}"]`)!;

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function typeSearch(c: HTMLElement, text: string) {
  const input = c.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("InboxView across server re-renders", () => {
  beforeEach(() => {
    h.queryInbox.mockReset();
    h.scrollToOffset.mockReset();
  });

  it("a refresh of the same filters keeps the loaded pages, the scroll position and the selection", async () => {
    h.queryInbox.mockResolvedValueOnce(result(["b1", "b2"], "c2")).mockImplementation(never);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2", "a3", "a4", "a5"], "c1")));
    await waitFor(() => expect(rowIds(r.container)).toEqual(["a1", "a2", "a3", "a4", "a5", "b1", "b2"]));
    expect(h.queryInbox).toHaveBeenCalledWith(FILTERS, "", "c1");
    await click(box(r.container, "a2"));
    expect(box(r.container, "a2").checked).toBe(true);
    h.scrollToOffset.mockClear();

    // router.refresh(): new objects, same filters; new mail pushed a5 off the first page.
    await r.rerender(ui(structuredClone(FILTERS), pageOf(["n0", "a1", "a2", "a3", "a4"], "c1b"), structuredClone(COUNTS)));
    await settle();

    expect(rowIds(r.container)).toEqual(["n0", "a1", "a2", "a3", "a4", "a5", "b1", "b2"]);
    expect(box(r.container, "a2").checked).toBe(true);
    expect(r.container.querySelector('[role="toolbar"][aria-label="Bulk actions"]')?.textContent).toContain("1 selected");
    expect(h.scrollToOffset).not.toHaveBeenCalled();
  });

  it("a refresh whose first page is the whole list replaces the loaded pages", async () => {
    h.queryInbox.mockResolvedValueOnce(result(["b1"], "c2")).mockImplementation(never);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2"], "c1")));
    await waitFor(() => expect(rowIds(r.container)).toEqual(["a1", "a2", "b1"]));
    // b1 was marked done elsewhere and the list now fits on one page.
    await r.rerender(ui(structuredClone(FILTERS), pageOf(["a1", "a2"], null)));
    await settle();
    expect(rowIds(r.container)).toEqual(["a1", "a2"]);
  });

  it("a refresh whose first page doesn't reach the loaded items starts over from it (no hidden gap)", async () => {
    const pending = deferred<unknown>();
    h.queryInbox
      .mockResolvedValueOnce(result(["b1", "b2"], "c2"))
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(never);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2", "a3", "a4", "a5"], "c1")));
    await waitFor(() => expect(rowIds(r.container)).toEqual(["a1", "a2", "a3", "a4", "a5", "b1", "b2"]));
    await waitFor(() => expect(h.queryInbox).toHaveBeenLastCalledWith(FILTERS, "", "c2"));

    // More new mail than a page holds: n6.. rank between n5 and a1 and must stay reachable.
    await r.rerender(ui(structuredClone(FILTERS), pageOf(["n1", "n2", "n3", "n4", "n5"], "cN5"), structuredClone(COUNTS)));
    await settle();
    expect(rowIds(r.container)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    // The old list's "load more" answers late and is dropped; the next one continues after n5
    // (the fresh cursor), not after b2.
    await act(async () => {
      pending.resolve(result(["b3"], "c3"));
    });
    await settle();
    expect(rowIds(r.container)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    await waitFor(() => expect(h.queryInbox).toHaveBeenLastCalledWith(FILTERS, "", "cN5"));
  });

  it("new filters still start a fresh list at the top with no selection", async () => {
    h.queryInbox.mockImplementation(never);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2"], null)));
    await click(box(r.container, "a1"));
    h.scrollToOffset.mockClear();

    await r.rerender(ui({ ...FILTERS, unread: true }, pageOf(["u1", "a1"], null)));
    await settle();
    expect(rowIds(r.container)).toEqual(["u1", "a1"]);
    expect(box(r.container, "a1").checked).toBe(false);
    expect(h.scrollToOffset).toHaveBeenCalledWith(0);
  });
});

describe("InboxView drops responses for a list it no longer shows", () => {
  beforeEach(() => {
    h.queryInbox.mockReset();
    h.scrollToOffset.mockReset();
  });

  it("a search that answers after the search box was cleared doesn't replace the inbox", async () => {
    const search = deferred<unknown>();
    h.queryInbox.mockImplementation(() => search.promise);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2"], null)));

    await typeSearch(r.container, "foo");
    await waitFor(() => expect(h.queryInbox).toHaveBeenCalledWith(FILTERS, "foo"));
    await typeSearch(r.container, "");
    await settle(400); // past the 250 ms debounce: the inbox is back

    await act(async () => {
      search.resolve({ ok: true, data: { page: pageOf(["s1"], "sc"), counts: { ...COUNTS, total: 1 } } });
    });
    await settle();
    expect(rowIds(r.container)).toEqual(["a1", "a2"]);
    expect(r.container.querySelector("h1")?.textContent).toContain("9");
  });

  it("a 'load more' page that arrives after the filters changed isn't appended to the new list", async () => {
    const more = deferred<unknown>();
    h.queryInbox.mockImplementationOnce(() => more.promise).mockImplementation(never);
    const r = await render(ui(FILTERS, pageOf(["a1", "a2"], "c1")));
    await waitFor(() => expect(h.queryInbox).toHaveBeenCalledWith(FILTERS, "", "c1"));

    await r.rerender(ui({ ...FILTERS, unread: true }, pageOf(["u1", "u2"], null)));
    await settle();
    await act(async () => {
      more.resolve(result(["old1", "old2"], "c9"));
    });
    await settle();
    expect(rowIds(r.container)).toEqual(["u1", "u2"]);
  });
});
