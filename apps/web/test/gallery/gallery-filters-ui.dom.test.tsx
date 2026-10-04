/**
 * The gallery's page numbers, Filters panel, filter bar and active-filter chips in the DOM: the
 * right buttons with the right states, and each control hands back the URL change it stands for.
 * The panel's counts follow its draft; the bar's counts fade while a change is loading.
 */
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActiveFilters } from "@/components/gallery/active-filters";
import { FilterBar } from "@/components/gallery/filter-bar";
import { FiltersPanel } from "@/components/gallery/gallery-filters";
import { GalleryPagination } from "@/components/gallery/gallery-pagination";
import { DEFAULT_GALLERY_PARAMS, type GalleryParams } from "@/lib/gallery";
import type { GalleryFacets } from "@/server/queries/types";
import { render } from "../support/render";

// The panel's default loader is a Server Action; every test here passes its own.
vi.mock("@/server/actions/gallery-facets", () => ({
  galleryDraftFacets: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));

const A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const p = (over: Partial<GalleryParams> = {}): GalleryParams => ({
  ...DEFAULT_GALLERY_PARAMS,
  ...over,
});
const facets: GalleryFacets = {
  categories: {
    all: 10,
    newsletters: 0,
    promotions: 8,
    social: 0,
    notifications: 0,
    welcome: 2,
    abandoned_cart: 0,
    product_updates: 0,
    receipts: 0,
    other: 0,
  },
  design: { all: 10, good: 3, bad: 2 },
  fonts: [{ name: "Inter", count: 4 }],
  senders: [
    { id: A, name: "LinkedIn", domain: "linkedin.com", address: "jobs@linkedin.com", count: 6 },
    { id: B, name: "Shop", domain: "shop.example", address: "hi@shop.example", count: 4 },
  ],
  problems: {
    image_only: 1,
    contrast: 2,
    mobile: 0,
    clipped: 0,
    broken_images: 0,
    no_unsubscribe: 3,
    merge_tag: 0,
    low_score: 0,
  },
  mailboxes: [
    { id: A, address: "me@gmail.com", count: 7 },
    { id: B, address: "work@gmail.com", count: 3 },
  ],
  webFonts: { yes: 6, no: 4 },
  boards: [],
  saved: 1,
};

const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });
/** Lets the panel's draft settle (its 300 ms pause) and its counts arrive. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
const rowOf = (panel: ParentNode, text: string) =>
  [...panel.querySelectorAll("label")].find((l) => l.textContent?.includes(text))!;
const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll(selector)].find((e) => e.textContent?.trim() === text);

describe("GalleryPagination", () => {
  it("shows 1 … 4 5 6 … 12 with the current page marked, and steps with Prev / Next", async () => {
    const onPage = vi.fn();
    const onSize = vi.fn();
    const r = await render(
      <GalleryPagination page={5} pageCount={12} size={24} onPage={onPage} onSize={onSize} />,
    );
    const nav = r.container.querySelector('nav[aria-label="Pages"]')!;
    const labels = [...nav.querySelectorAll("li")].map((li) => li.textContent?.trim());
    expect(labels).toEqual(["Prev", "1", "…", "4", "5", "6", "…", "12", "Next"]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("5");
    await click(nav.querySelector('[aria-label="Next page"]'));
    await click(nav.querySelector('[aria-label="Previous page"]'));
    await click(nav.querySelector('[aria-label="Page 12"]'));
    expect(onPage.mock.calls).toEqual([[6], [4], [12]]);
  });

  it("disables Prev on the first page and Next on the last; no page buttons for one page", async () => {
    const first = await render(
      <GalleryPagination page={1} pageCount={3} size={24} onPage={() => {}} onSize={() => {}} />,
    );
    expect(
      first.container.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.disabled,
    ).toBe(true);
    const last = await render(
      <GalleryPagination page={3} pageCount={3} size={48} onPage={() => {}} onSize={() => {}} />,
    );
    expect(
      last.container.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.disabled,
    ).toBe(true);
    const one = await render(
      <GalleryPagination page={1} pageCount={1} size={24} onPage={() => {}} onSize={() => {}} />,
    );
    expect(one.container.querySelector("nav")).toBeNull();
    expect(one.container.textContent).toContain("Designs per page");
  });
});

describe("FiltersPanel", () => {
  beforeAll(() => {
    // jsdom has no matchMedia: a tablet-or-wider screen (the panel slides in from the right).
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  it("applies the draft only on 'Show designs', with defaults left out", async () => {
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    await render(
      <FiltersPanel
        open
        onOpenChange={onOpenChange}
        params={p({ sender: [B] })}
        facets={facets}
        onApply={onApply}
      />,
    );
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain("Design score");
    expect(panel.textContent).toContain("Mailbox"); // two mailboxes
    expect(panel.textContent).toContain("Hard-to-read text");
    // Tick a problem and a date, then apply.
    const contrast = [...panel.querySelectorAll("label")].find((l) =>
      l.textContent?.includes("Hard-to-read text"),
    )!;
    await click(contrast.querySelector('[role="checkbox"]'));
    const last30 = [...panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (i) => i.value === "30d",
    )!;
    await click(last30);
    expect(onApply).not.toHaveBeenCalled();
    await click(
      [...panel.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show ")),
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      smin: null,
      smax: null,
      date: "30d",
      since: null,
      until: null,
      sender: [B],
      problem: ["contrast"],
      mailbox: null,
      webfonts: null,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("'Clear all' empties every panel filter at once", async () => {
    const onApply = vi.fn();
    await render(
      <FiltersPanel
        open
        onOpenChange={() => {}}
        params={p({ smin: 50, problem: ["mobile"], webfonts: "yes" })}
        facets={{ ...facets, mailboxes: facets.mailboxes.slice(0, 1) }}
        onApply={onApply}
      />,
    );
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel.textContent).not.toContain("Mailbox"); // only one mailbox
    await click(byText(panel, "button", "Clear all"));
    expect(onApply.mock.calls[0]![0]).toMatchObject({
      smin: null,
      smax: null,
      date: null,
      sender: null,
      problem: null,
      mailbox: null,
      webfonts: null,
    });
  });
});

describe("FiltersPanel counts follow the draft", () => {
  it("asks for the draft's counts once it settles; until then the numbers are dimmed", async () => {
    const loadFacets = vi.fn(async (draft: GalleryParams) => ({
      ...facets,
      categories: { ...facets.categories, all: draft.problem.includes("contrast") ? 2 : 10 },
      problems: { ...facets.problems, no_unsubscribe: 1 },
      senders: facets.senders.map((s) => ({ ...s, count: s.id === A ? 1 : 0 })),
    }));
    await render(
      <FiltersPanel
        open
        onOpenChange={() => {}}
        params={p()}
        facets={facets}
        onApply={() => {}}
        loadFacets={loadFacets}
      />,
    );
    const panel = document.querySelector('[role="dialog"]')!;
    const button = () =>
      [...panel.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show "))!;
    // The applied view: the page's own counts, no request.
    expect(button().textContent).toBe("Show 10 designs");
    expect(rowOf(panel, "No unsubscribe link").textContent).toContain("3");
    await settle();
    expect(loadFacets).not.toHaveBeenCalled();
    // A change: the old numbers fade until the draft's arrive.
    await click(rowOf(panel, "Hard-to-read text").querySelector('[role="checkbox"]'));
    expect(button().textContent).toBe("Show designs");
    expect(button().getAttribute("aria-busy")).toBe("true");
    await settle();
    expect(loadFacets).toHaveBeenCalledTimes(1);
    expect(loadFacets.mock.calls[0]![0]).toMatchObject({ problem: ["contrast"], page: 1 });
    expect(button().textContent).toBe("Show 2 designs");
    expect(rowOf(panel, "No unsubscribe link").textContent).toContain("1");
    expect(rowOf(panel, "LinkedIn").textContent).toContain("1");
    // Back to the applied view: the page's counts again, without asking.
    await click(rowOf(panel, "Hard-to-read text").querySelector('[role="checkbox"]'));
    expect(button().textContent).toBe("Show 10 designs");
    await settle();
    expect(loadFacets).toHaveBeenCalledTimes(1);
  });

  it("while the page itself is still loading, the panel asks for its own counts", async () => {
    const loadFacets = vi.fn(async () => ({
      ...facets,
      categories: { ...facets.categories, all: 7 },
    }));
    await render(
      <FiltersPanel
        open
        onOpenChange={() => {}}
        params={p({ design: "good" })}
        facets={facets}
        onApply={() => {}}
        stale
        loadFacets={loadFacets}
      />,
    );
    const panel = document.querySelector('[role="dialog"]')!;
    await settle();
    expect(loadFacets).toHaveBeenCalledTimes(1);
    expect(
      [...panel.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show "))!
        .textContent,
    ).toBe("Show 7 designs");
  });

  it("senders that share a name show their address; the address is searchable", async () => {
    const twins: GalleryFacets = {
      ...facets,
      senders: [
        {
          id: A,
          name: "LinkedIn",
          domain: "linkedin.com",
          address: "jobs-noreply@linkedin.com",
          count: 45,
        },
        {
          id: B,
          name: "LinkedIn",
          domain: "linkedin.com",
          address: "messages-noreply@linkedin.com",
          count: 39,
        },
      ],
    };
    await render(
      <FiltersPanel open onOpenChange={() => {}} params={p()} facets={twins} onApply={() => {}} />,
    );
    const list = document.querySelector('[role="dialog"] ul[aria-label="Senders"]')!;
    const rows = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "LinkedInjobs-noreply@linkedin.com45",
      "LinkedInmessages-noreply@linkedin.com39",
    ]);
  });
});

describe("FilterBar while a change loads", () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("fades the type and Design counts (aria-busy) and shows the font without its count", async () => {
    const bar = (stale: boolean) => (
      <NuqsTestingAdapter>
        <FilterBar
          params={p({ font: "Inter" })}
          facets={facets}
          onChange={() => {}}
          onReset={() => {}}
          activeCount={0}
          stale={stale}
        />
      </NuqsTestingAdapter>
    );
    const r = await render(bar(false));
    const types = r.container.querySelector('[role="group"][aria-label="Email type"]')!;
    const design = r.container.querySelector(
      '[role="group"][aria-labelledby="gallery-design-label"]',
    )!;
    expect(types.getAttribute("aria-busy")).toBe("false");
    expect(types.textContent).toContain("All types10");
    const faint = () =>
      [...r.container.querySelectorAll("span.opacity-25")].map((s) => s.textContent);
    expect(faint()).toEqual([]);
    const font = () => r.container.querySelector('[aria-label="Font"]')!.textContent;
    expect(font()).toContain("Inter (4)");
    await r.rerender(bar(true));
    expect(font()).toContain("Inter");
    expect(font()).not.toContain("(4)");
    expect(types.getAttribute("aria-busy")).toBe("true");
    expect(design.getAttribute("aria-busy")).toBe("true");
    // All types, Promotions, Welcome (the others have no designs), Saved, then Any / Good / Bad.
    expect(faint()).toEqual(["10", "8", "2", "1", "10", "3", "2"]);
  });
});

describe("FilterBar: marketing types only, and Saved", () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  const withHidden: GalleryFacets = {
    ...facets,
    // Counts the server never sends for hidden types (they are left out of the gallery), but a
    // stale count must not bring a chip back either.
    categories: { ...facets.categories, social: 5, notifications: 4, newsletters: 3, receipts: 2, other: 1 },
  };
  const chipLabels = (root: Element) =>
    [...root.querySelectorAll('[role="group"][aria-label="Email type"] button')].map((b) =>
      (b.textContent ?? "").replace(/\d+$/, ""),
    );

  it("shows only the marketing types, then Saved; Saved and a type exclude each other", async () => {
    const calls: unknown[] = [];
    const bar = (params: GalleryParams) => (
      <NuqsTestingAdapter>
        <FilterBar
          params={params}
          facets={withHidden}
          onChange={(patch) => calls.push(patch)}
          onReset={() => {}}
          activeCount={0}
        />
      </NuqsTestingAdapter>
    );
    const r = await render(bar(p()));
    expect(chipLabels(r.container)).toEqual(["All types", "Promotions", "Welcome", "Saved"]);
    const button = (label: string) =>
      [...r.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Email type"] button')].find(
        (b) => (b.textContent ?? "").startsWith(label),
      )!;
    expect(button("Saved").textContent).toBe("Saved1");
    expect(button("Saved").getAttribute("aria-pressed")).toBe("false");
    // Saved shows every saved design, whatever its type.
    await act(async () => button("Saved").click());
    expect(calls.at(-1)).toEqual({ saved: "1", category: null });

    await r.rerender(bar(p({ saved: "1" })));
    expect(button("Saved").getAttribute("aria-pressed")).toBe("true");
    expect(button("All types").getAttribute("aria-pressed")).toBe("false");
    // Picking a type leaves Saved; pressing Saved again turns it off.
    await act(async () => button("Promotions").click());
    expect(calls.at(-1)).toEqual({ category: "promotions", saved: null });
    await act(async () => button("Saved").click());
    expect(calls.at(-1)).toEqual({ saved: null });
  });
});

describe("ActiveFilters", () => {
  it("one removable chip per filter, named from the facets; nothing when none is on", async () => {
    const onChange = vi.fn();
    const onClearAll = vi.fn();
    const r = await render(
      <ActiveFilters
        params={p({ smin: 60, date: "7d", sender: [A] })}
        facets={facets}
        onChange={onChange}
        onClearAll={onClearAll}
      />,
    );
    const chips = [...r.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(chips).toEqual(["Score 60–100", "Last 7 days", "LinkedIn", "Clear all"]);
    // Two senders with one name: each chip says which address it is.
    const twins = await render(
      <ActiveFilters
        params={p({ sender: [A, B] })}
        facets={{
          ...facets,
          senders: [
            {
              id: A,
              name: "LinkedIn",
              domain: "linkedin.com",
              address: "jobs@linkedin.com",
              count: 1,
            },
            {
              id: B,
              name: "LinkedIn",
              domain: "linkedin.com",
              address: "news@linkedin.com",
              count: 1,
            },
          ],
        }}
        onChange={onChange}
        onClearAll={onClearAll}
      />,
    );
    expect([...twins.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "LinkedIn (jobs@linkedin.com)",
      "LinkedIn (news@linkedin.com)",
      "Clear all",
    ]);
    await click(r.container.querySelector('[aria-label="Remove filter: LinkedIn"]'));
    expect(onChange).toHaveBeenCalledWith({ sender: [] });
    await click(byText(r.container, "button", "Clear all"));
    expect(onClearAll).toHaveBeenCalled();
    const none = await render(
      <ActiveFilters
        params={p({ font: "Inter" })}
        facets={facets}
        onChange={onChange}
        onClearAll={onClearAll}
      />,
    );
    expect(none.container.innerHTML).toBe("");
  });
});
