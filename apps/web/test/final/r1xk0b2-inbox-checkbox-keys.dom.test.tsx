/**
 * R1-16: the inbox list is one Tab stop (roving tabindex on the row links, hover actions at -1), but
 * each row's selection checkbox (Base UI renders a span role=checkbox, tabIndex 0 by default) was
 * tabbable, so Tab walked ~20 invisible checkboxes; and Enter on one opened the *active* email, not
 * anything to do with the focused row. The checkbox is now out of the Tab order (x selects), and
 * Enter on a control inside a row is left to that control.
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
import type * as InboxRowModule from "@/components/email/inbox-row";
import { click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({ realRow: false }));

vi.mock("@/app/(app)/inbox/actions", () => ({
  queryInbox: () => new Promise(() => {}),
  getEmailPreview: vi.fn(async (id: string) => ({
    ok: true,
    data: { id, senderId: "s1", state: { doneAt: null, pinnedAt: null, openedInAppAt: null } },
  })),
}));
vi.mock("@/server/actions/email", () => ({ setDone: vi.fn(), setPinned: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
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
// A row as the list sees it: its link (the roving Tab stop) and a checkbox-like control inside it.
vi.mock("@/components/email/inbox-row", async (importOriginal) => {
  const real = await importOriginal<typeof InboxRowModule>();
  return {
    InboxRow: (props: { item: InboxItem; onOpen: () => void; tabIndex?: number }) =>
      h.realRow ? (
        <real.InboxRow {...props} />
      ) : (
        <div>
          <a
            href={`/email/${props.item.id}`}
            data-row={props.item.id}
            tabIndex={props.tabIndex}
            onClick={(e) => {
              e.preventDefault();
              props.onOpen();
            }}
          >
            {props.item.id}
          </a>
          <span role="checkbox" aria-checked="false" tabIndex={-1} data-check={props.item.id} />
        </div>
      ),
  };
});
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
const { InboxRow } = await import("@/components/email/inbox-row");

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
    receivedAt: "2026-09-20T10:00:00.000Z",
    subject: `Subject ${id}`,
    snippet: "snippet",
    fromName: "Northwind",
    fromAddress: "hello@northwind.example",
    senderId: "s1",
    senderDomain: "northwind.example",
    primaryType: "promotional",
    typeGroup: "promotions",
    subtype: null,
    typeSource: "rule",
    importance: "normal",
    importanceReasons: [],
    design: { status: "pending" } as InboxItem["design"],
    deal: null,
    isUnread: true,
    openedInApp: false,
    done: false,
    pinned: false,
    starred: false,
    suspicious: false,
    securitySensitive: false,
    isSubscription: true,
    fontFamilies: [],
    trackerCount: 0,
  }) as InboxItem;
const PAGE: InboxPage = {
  items: [item("a1"), item("a2"), item("a3")],
  nextCursor: null,
  pinned: [],
};

beforeEach(() => {
  h.realRow = false;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => vi.unstubAllGlobals());

const enter = (target: EventTarget) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });

describe("inbox row checkboxes and the list's keyboard", () => {
  it("keeps each row's checkbox out of the Tab order", async () => {
    h.realRow = true;
    const r = await render(
      <InboxRow item={item("a1")} onOpen={() => {}} onCheckedChange={() => {}} tabIndex={-1} />,
    );
    const box = r.container.querySelector('[role="checkbox"]');
    expect(box).not.toBeNull();
    expect(box!.getAttribute("tabindex")).toBe("-1");
  });

  it("Enter on a row's checkbox doesn't open the active email; Enter on the list still does", async () => {
    const r = await render(
      <InboxView filters={FILTERS} page={PAGE} counts={COUNTS} fonts={[]} hasMailbox />,
    );
    await click(r.container.querySelector('[data-row="a1"]')!);
    await waitFor(() => expect(r.container.querySelector('[data-preview="a1"]')).not.toBeNull());

    await enter(r.container.querySelector('[data-check="a3"]')!);
    expect(r.router.calls.filter((c) => c.startsWith("push:"))).toEqual([]);

    await enter(r.container.querySelector('[data-row="a1"]')!);
    expect(r.router.calls).toContain("push:/email/a1?back=%2Finbox");
  });
});
