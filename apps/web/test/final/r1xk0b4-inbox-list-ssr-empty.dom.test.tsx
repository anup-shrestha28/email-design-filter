/**
 * The inbox list's first paint and its smart-view empty state.
 * - R1-38: with the real virtualizer, the server HTML had no rows at all (no scroll element to
 *   measure → a zero-height viewport → an empty range), so a hard load showed a blank list between
 *   the loading skeleton and hydration. It now renders the first screen of rows on the server.
 * - R1-39: a smart view with no matches (and no other filter) said "There's no mail in this scope
 *   yet", which is false when the scope has mail; it now names the view and offers to leave it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FacetCounts, InboxFilters, InboxItem, InboxPage } from "@/server/queries/types";
import { ClockProvider } from "@/components/providers/clock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { click, render, stubRouter } from "../support/render";

const h = vi.hoisted(() => ({
  params: { view: null as string | null, sort: "newest" },
  setParams: vi.fn(),
}));

vi.mock("@/app/(app)/inbox/actions", () => ({ queryInbox: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/server/actions/email", () => ({ setDone: vi.fn(), setPinned: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/email/inbox-row", () => ({
  InboxRow: ({ item }: { item: InboxItem }) => <div data-row={item.id} />,
}));
vi.mock("@/components/shell/topbar", () => ({ ScopeToggle: () => null }));
vi.mock("@/components/inbox/facet-rail", () => ({ FacetRail: () => null }));
vi.mock("@/components/inbox/filter-chips", () => ({ CLEARED_FILTERS: { view: null, types: [] }, FilterChips: () => null }));
vi.mock("@/components/inbox/preview-pane", () => ({
  PreviewPane: () => null,
  previewQueryKey: (id: string) => ["email-preview", id],
  fetchPreview: vi.fn(),
}));
vi.mock("@/components/inbox/use-inbox-filters", () => ({
  useInboxFilters: () => ({ params: h.params, setParams: h.setParams, pending: false }),
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
} as unknown as InboxFilters;
const COUNTS: FacetCounts = { total: 40, types: {}, importance: {}, design: {}, issues: {}, deals: {}, unread: 0, suspicious: 0 };
const item = (id: string): InboxItem => ({ id, subject: id, done: false, pinned: false, openedInApp: false }) as InboxItem;
const pageOf = (n: number): InboxPage => ({
  items: Array.from({ length: n }, (_, i) => item(`e${i}`)),
  nextCursor: null,
  pinned: [],
});

function serverHtml(node: ReactNode): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <AppRouterContext.Provider value={stubRouter()}>
      <QueryClientProvider client={queryClient}>
        <ClockProvider value={{ serverNow: Date.now(), locale: "en-US", timeZone: "UTC" }}>
          <TooltipProvider delay={0}>{node}</TooltipProvider>
        </ClockProvider>
      </QueryClientProvider>
    </AppRouterContext.Provider>,
  );
}

describe("inbox list", () => {
  beforeEach(() => {
    h.params = { view: null, sort: "newest" };
    h.setParams.mockReset();
  });

  it("renders the first screen of rows in the server HTML (real virtualizer)", () => {
    const html = serverHtml(<InboxView filters={FILTERS} page={pageOf(40)} counts={COUNTS} fonts={[]} hasMailbox />);
    const rows = html.match(/data-row="/g) ?? [];
    expect(rows.length).toBeGreaterThan(5);
    // Still virtualized: not the whole list.
    expect(rows.length).toBeLessThan(40);
    expect(html).toContain('data-row="e0"');
  });

  it("an empty smart view names the view and offers to leave it, instead of 'no mail in this scope'", async () => {
    h.params = { view: "best_designed", sort: "newest" };
    const filters = { ...FILTERS, view: "best_designed" } as InboxFilters;
    const r = await render(<InboxView filters={filters} page={pageOf(0)} counts={COUNTS} fonts={[]} hasMailbox />);
    const text = r.container.textContent ?? "";
    expect(text).not.toContain("There's no mail in this scope yet");
    expect(text).toContain("Best designed");
    const button = [...r.container.querySelectorAll("button")].find((b) => /show all mail/i.test(b.textContent ?? ""));
    expect(button).toBeTruthy();
    await click(button!);
    expect(h.setParams).toHaveBeenCalledWith({ view: null });
  });

  it("with no view and no filters the scope really is empty: 'All clear'", async () => {
    const r = await render(<InboxView filters={FILTERS} page={pageOf(0)} counts={COUNTS} fonts={[]} hasMailbox />);
    expect(r.container.textContent).toContain("There's no mail in this scope yet");
  });
});
