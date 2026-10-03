/**
 * R1-13: "This is personal" from the inbox preview deleted the email, then pushed a bare "/inbox"
 * (losing the filters in the URL), and the pane kept showing the deleted email from react-query's
 * cache (previewId survives a same-route navigation). Now the pane closes, its cached copy is
 * dropped, the sender's rows leave the list, and the URL is left alone.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailDetail, FacetCounts, InboxFilters, InboxItem, InboxPage } from "@/server/queries/types";
import { click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({ getEmailPreview: vi.fn() }));

vi.mock("@/app/(app)/inbox/actions", () => ({
  queryInbox: () => new Promise(() => {}),
  getEmailPreview: h.getEmailPreview,
}));
vi.mock("@/server/actions/email", () => ({ setDone: vi.fn(), setPinned: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
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
        scrollToOffset: () => {},
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
  InboxRow: ({ item, onOpen }: { item: InboxItem; onOpen: () => void }) => (
    <button type="button" data-row={item.id} onClick={() => onOpen()}>
      {item.id}
    </button>
  ),
}));
// The detail view itself is covered elsewhere; here it only shows which email it has and exposes
// the removal EmailActions reports after "This is personal".
vi.mock("@/components/email/email-detail", () => ({
  EmailDetailView: ({ detail, onRemoved }: { detail: EmailDetail; onRemoved?: () => void }): ReactNode => (
    <div data-preview={detail.id}>
      <button type="button" data-remove onClick={onRemoved}>
        removed
      </button>
    </div>
  ),
}));
vi.mock("@/components/shell/topbar", () => ({ ScopeToggle: () => null }));
vi.mock("@/components/inbox/facet-rail", () => ({ FacetRail: () => null }));
vi.mock("@/components/inbox/filter-chips", () => ({ CLEARED_FILTERS: {}, FilterChips: () => null }));
vi.mock("@/components/inbox/use-inbox-filters", () => ({
  useInboxFilters: () => ({ params: { view: null, sort: "newest" }, setParams: vi.fn(), pending: false }),
}));
vi.mock("@/components/ui/select", () => ({ Select: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Sheet: () => null }));

const { InboxView } = await import("@/components/inbox/inbox-view");
const { previewQueryKey } = await import("@/components/inbox/preview-pane");

// Filters are active (unread): pushing a bare "/inbox" would drop them.
const FILTERS = {
  scope: "all", view: null, types: [], subtypes: [], importance: [], design: [], issues: [], fonts: [],
  webFonts: false, senderId: null, newSenders: false, frequency: [], stillSending: false, unread: true,
  notOpened: false, done: null, pinned: false, deals: [], suspicious: false, date: null, mailboxId: null,
  language: null, sort: "newest",
} as InboxFilters;
const COUNTS = { total: 3, types: {}, importance: {}, design: {}, issues: {}, deals: {}, unread: 0, suspicious: 0 } as FacetCounts;
const item = (id: string, senderId: string): InboxItem =>
  ({ id, subject: id, senderId, done: false, pinned: false, openedInApp: false }) as InboxItem;
const PAGE: InboxPage = { items: [item("a1", "s1"), item("b1", "s2"), item("a2", "s1")], nextCursor: null, pinned: [] };
const detailOf = (id: string) =>
  ({ id, senderId: "s1", state: { doneAt: null, pinnedAt: null, openedInAppAt: null } }) as unknown as EmailDetail;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  h.getEmailPreview.mockImplementation(async (id: string) => ({ ok: true, data: detailOf(id) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const rowIds = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-row]")].map((el) => el.dataset.row);

describe("'This is personal' from the inbox preview (R1-13)", () => {
  it("closes the pane, forgets the cached email, drops the sender's rows and keeps the URL", async () => {
    const r = await render(<InboxView filters={FILTERS} page={PAGE} counts={COUNTS} fonts={[]} hasMailbox />);
    await click(r.container.querySelector('[data-row="a1"]')!);
    await waitFor(() => expect(r.container.querySelector('[data-preview="a1"]')).not.toBeNull());

    await click(r.container.querySelector("[data-remove]")!);

    expect(r.container.querySelector("[data-preview]")).toBeNull();
    expect(r.container.textContent).toContain("Select an email to preview it");
    expect(r.queryClient.getQueryData(previewQueryKey("a1"))).toBeUndefined();
    expect(rowIds(r.container)).toEqual(["b1"]);
    expect(r.router.calls.filter((c) => c.startsWith("push:"))).toEqual([]);
  });
});
