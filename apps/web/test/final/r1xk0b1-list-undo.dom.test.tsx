/**
 * R1-09 (list Undo): pressing e in the inbox list marks the email done and refetches the open
 * preview, but the toast's Undo only patched the list rows and called setDone. The preview's cached
 * copy was never refetched, so it kept showing "Done" after the Undo. Now the Undo refetches the
 * preview once the server has the undone state.
 */
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmailDetail,
  FacetCounts,
  InboxFilters,
  InboxItem,
  InboxPage,
} from "@/server/queries/types";
import { click, render, waitFor } from "../support/render";

interface ToastCall {
  message: string;
  opts?: { action?: { onClick: () => void } };
}

const h = vi.hoisted(() => ({
  getEmailPreview: vi.fn(),
  done: new Map<string, boolean>(),
  toasts: [] as ToastCall[],
}));

vi.mock("@/app/(app)/inbox/actions", () => ({
  queryInbox: () => new Promise(() => {}),
  getEmailPreview: h.getEmailPreview,
}));
vi.mock("@/server/actions/email", () => ({
  setDone: vi.fn(async (id: string, value: boolean) => {
    await new Promise((res) => setTimeout(res, 10));
    h.done.set(id, value);
    return { ok: true, data: undefined };
  }),
  setPinned: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn((message: string, opts?: ToastCall["opts"]) => h.toasts.push({ message, opts })),
  },
}));
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
          Array.from({ length: inst.opts.count }, (_, index) => ({
            index,
            key: inst.opts.getItemKey(index),
            start: index * 86,
          })),
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
// Only which email the preview has, and whether its detail says done, matters here.
vi.mock("@/components/email/email-detail", () => ({
  EmailDetailView: ({ detail }: { detail: EmailDetail }): ReactNode => (
    <div data-preview={detail.id} data-done={String(detail.state.doneAt !== null)} />
  ),
}));
vi.mock("@/components/shell/topbar", () => ({ ScopeToggle: () => null }));
vi.mock("@/components/inbox/facet-rail", () => ({ FacetRail: () => null }));
vi.mock("@/components/inbox/filter-chips", () => ({
  CLEARED_FILTERS: {},
  FilterChips: () => null,
}));
vi.mock("@/components/inbox/use-inbox-filters", () => ({
  useInboxFilters: () => ({
    params: { view: null, sort: "newest" },
    setParams: vi.fn(),
    pending: false,
  }),
}));
vi.mock("@/components/ui/select", () => ({ Select: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Sheet: () => null }));

const { InboxView } = await import("@/components/inbox/inbox-view");

const FILTERS = {
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
const COUNTS = {
  total: 1,
  types: {},
  importance: {},
  design: {},
  issues: {},
  deals: {},
  unread: 0,
  suspicious: 0,
} as FacetCounts;
const item = (id: string): InboxItem =>
  ({
    id,
    subject: id,
    senderId: "s1",
    done: false,
    pinned: false,
    openedInApp: false,
  }) as InboxItem;
const PAGE: InboxPage = { items: [item("a1")], nextCursor: null, pinned: [] };

beforeEach(() => {
  h.done.clear();
  h.toasts.length = 0;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  h.getEmailPreview.mockImplementation(async (id: string) => ({
    ok: true,
    data: {
      id,
      senderId: "s1",
      state: {
        doneAt: h.done.get(id) ? "2026-01-01T00:00:00Z" : null,
        pinnedAt: null,
        openedInAppAt: null,
      },
    },
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("inbox list Undo refreshes the open preview", () => {
  it("shows not-done in the preview after e then Undo", async () => {
    const r = await render(
      <InboxView filters={FILTERS} page={PAGE} counts={COUNTS} fonts={[]} hasMailbox />,
    );
    await click(r.container.querySelector('[data-row="a1"]')!);
    await waitFor(() => expect(r.container.querySelector('[data-preview="a1"]')).not.toBeNull());
    const previewDone = () =>
      r.container.querySelector<HTMLElement>('[data-preview="a1"]')!.dataset.done;
    expect(previewDone()).toBe("false");

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    });
    await waitFor(() => expect(previewDone()).toBe("true"));

    const undo = h.toasts.at(-1)?.opts?.action?.onClick;
    expect(undo).toBeTypeOf("function");
    const fetchesBefore = h.getEmailPreview.mock.calls.length;
    await act(async () => {
      undo!();
    });
    await waitFor(() => expect(h.done.get("a1")).toBe(false));
    await waitFor(() => expect(previewDone()).toBe("false"));
    // The refetch happened after the server had the undone state.
    expect(h.getEmailPreview.mock.calls.length).toBeGreaterThan(fetchesBefore);
  });
});
