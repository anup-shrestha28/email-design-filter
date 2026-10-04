/**
 * The live gallery in the DOM (components/gallery/live-updates.tsx inside the app's SyncProvider):
 *  - the app's sync finding mail asks the gallery to check now (instead of a blunt page refresh);
 *  - new designs away from the top of Newest → a pill "3 new designs · Show" at the top of the grid
 *    (keyboard reachable, announced politely); Show goes to page 1 (Newest) or refreshes;
 *  - on page 1 of Newest at the top, with nothing open and nothing hovered → applied at once;
 *  - new scores on screen → refreshed in place, no pill;
 *  - while the governor has UI polling off the gallery never checks: the sync refreshes as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useLayoutEffect, type ReactNode } from "react";
import { LiveSlot, LiveUpdates } from "@/components/gallery/live-updates";
import { SyncProvider, useSync } from "@/components/providers/sync";
import { DEFAULT_GALLERY_PARAMS, type GalleryParams } from "@/lib/gallery";
import type { GalleryStamp } from "@/lib/gallery-live";
import type { SyncStatus } from "@/server/queries/types";
import { render } from "../support/render";

const m = vi.hoisted(() => ({
  checkGallery: vi.fn(),
  syncNow: vi.fn(),
  open: null as string | null,
}));
vi.mock("@/server/actions/gallery-live", () => ({ checkGallery: m.checkGallery }));
vi.mock("@/server/actions/settings", () => ({ syncNow: m.syncNow }));
vi.mock("@/app/(app)/actions", () => ({
  pollSyncStatus: vi.fn(async () => ({ ok: false, error: "x" })),
}));
vi.mock("@/components/gallery/use-gallery-params", () => ({
  useOpenCard: () => [m.open, vi.fn()],
}));

const stamp: GalleryStamp = {
  total: 10,
  newest: "2026-09-30 14:00:00.5+00",
  scored: 8,
  typing: 0,
  analyzedAt: "2026-09-30 14:00:00.5+00",
  renderAt: null,
};
const sync = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  mailboxes: [{ id: "m1", backfill: { state: "done" } } as SyncStatus["mailboxes"][number]],
  syncing: false,
  lastSyncedAt: null,
  banner: null,
  ...over,
});
const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
  ...DEFAULT_GALLERY_PARAMS,
  ...over,
});

/** The app's "check for new mail" (the sync chip's button). */
function SyncButton() {
  const { refresh } = useSync();
  return (
    <button type="button" data-testid="sync" onClick={refresh}>
      Sync
    </button>
  );
}

function page(p: GalleryParams, status = sync(), st: GalleryStamp = stamp) {
  return (
    <SyncProvider initial={status}>
      <SyncButton />
      <main id="main" tabIndex={-1}>
        <div data-testid="grid">
          <LiveSlot />
          <ul>
            <li>
              <button type="button" data-card-id="c1">
                A card
              </button>
            </li>
          </ul>
        </div>
      </main>
      <LiveUpdates stamp={st} params={p} total={10} regroup={false} />
    </SyncProvider>
  );
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => Promise.resolve());
};

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  m.open = null;
  m.checkGallery.mockReset();
  m.syncNow.mockReset();
  m.syncNow.mockResolvedValue({ ok: true, data: { newMessages: 0, syncing: false } });
});

/** The app's sync finds new mail (as the sync chip's button, the load-time or background sync would). */
async function mailArrives(r: Awaited<ReturnType<typeof render>>) {
  m.syncNow.mockResolvedValue({ ok: true, data: { newMessages: 2, syncing: false } });
  await act(async () =>
    r.container.querySelector<HTMLButtonElement>('[data-testid="sync"]')!.click(),
  );
  await settle();
}
afterEach(() => {
  vi.useRealTimers();
});

const changed = (view: { total: number; added: number; rescored: number }) => ({
  ok: true,
  data: {
    stamp: { ...stamp, total: view.total, newest: "2026-09-30 14:05:00+00" },
    pollingOff: false,
    view,
  },
});

describe("LiveUpdates", () => {
  it("new designs while not on page 1: the pill; Show goes to the first page", async () => {
    m.checkGallery.mockResolvedValue(changed({ total: 13, added: 3, rescored: 0 }));
    const r = await render(page(params({ page: 2 })));
    await mailArrives(r);
    // The sync found mail → the gallery checked (with the page's params and stamp), no blunt refresh.
    expect(m.checkGallery).toHaveBeenCalledWith({ params: params({ page: 2 }), since: stamp });
    expect(r.router.calls).not.toContain("refresh");
    const slot = r.container.querySelector("[data-gallery-live-slot]")!;
    const pill = slot.querySelector("button")!;
    expect(pill.textContent).toBe("3 new designs·Show");
    expect(r.container.querySelector('[role="status"]')!.textContent).toBe(
      "3 new designs. Choose Show to see them.",
    );
    await act(async () => pill.click());
    expect(r.router.calls).toEqual(["push:/gallery"]);
    expect(slot.querySelector("button")).toBeNull();
  });

  it("new designs at the top of page 1 of Newest, nothing open: applied at once", async () => {
    m.checkGallery.mockResolvedValue(changed({ total: 11, added: 1, rescored: 0 }));
    const r = await render(page(params()));
    await mailArrives(r);
    expect(r.router.calls).toEqual(["refresh"]);
    expect(r.container.querySelector("[data-gallery-live-slot] button")).toBeNull();
    expect(r.container.querySelector('[role="status"]')!.textContent).toBe("1 new design added.");
  });

  it("an open design keeps it waiting behind the pill; Show refreshes", async () => {
    m.open = "c1";
    m.checkGallery.mockResolvedValue(changed({ total: 11, added: 1, rescored: 0 }));
    const r = await render(page(params()));
    await mailArrives(r);
    const pill = r.container.querySelector<HTMLButtonElement>("[data-gallery-live-slot] button")!;
    expect(pill.textContent).toContain("1 new design");
    await act(async () => pill.click());
    expect(r.router.calls).toEqual(["refresh"]);
  });

  it("new scores for designs on screen: refreshed in place, no pill", async () => {
    m.checkGallery.mockResolvedValue({
      ok: true,
      data: {
        stamp: { ...stamp, scored: 9, analyzedAt: "2026-09-30 14:06:00+00" },
        pollingOff: false,
        view: { total: 10, added: 0, rescored: 1 },
      },
    });
    m.open = "c1"; // even with a design open
    const r = await render(page(params({ page: 3 })));
    await mailArrives(r);
    expect(r.router.calls).toEqual(["refresh"]);
    expect(r.container.querySelector("[data-gallery-live-slot] button")).toBeNull();
  });

  /** Next's scroll handler: an ancestor of the page that may scroll the grid to the top as it commits. */
  function RouterJump({ jump, children }: { jump: boolean; children: ReactNode }) {
    useLayoutEffect(() => {
      if (jump) document.getElementById("main")!.scrollTop = 0;
    });
    return children;
  }
  const jumpy = (jump: boolean, st: GalleryStamp, p = params()) => (
    <RouterJump jump={jump}>{page(p, sync(), st)}</RouterJump>
  );

  it("an in-place refresh keeps the grid's scroll, even if the router jumps to the top behind an open design", async () => {
    m.checkGallery.mockResolvedValue({
      ok: true,
      data: {
        stamp: { ...stamp, scored: 9, analyzedAt: "2026-09-30 14:06:00+00" },
        pollingOff: false,
        view: { total: 10, added: 0, rescored: 1 },
      },
    });
    m.open = "c1";
    const r = await render(jumpy(false, stamp));
    const main = r.container.querySelector<HTMLElement>("#main")!;
    main.scrollTop = 640;
    await mailArrives(r);
    expect(r.router.calls).toEqual(["refresh"]);
    // The refreshed page commits (a new stamp) and the router scrolls the grid to the top.
    await r.rerender(jumpy(true, { ...stamp, scored: 9 }));
    expect(main.scrollTop).toBe(640);
    // A render we didn't ask for (a filter change, a navigation) is left to the router.
    await r.rerender(jumpy(true, { ...stamp, scored: 10 }));
    expect(main.scrollTop).toBe(0);
  });

  it("scrolling while an in-place refresh is on its way is never undone", async () => {
    m.checkGallery.mockResolvedValue({
      ok: true,
      data: {
        stamp: { ...stamp, scored: 9, analyzedAt: "2026-09-30 14:06:00+00" },
        pollingOff: false,
        view: { total: 10, added: 0, rescored: 1 },
      },
    });
    const r = await render(jumpy(false, stamp));
    const main = r.container.querySelector<HTMLElement>("#main")!;
    main.scrollTop = 300;
    await mailArrives(r);
    expect(r.router.calls).toEqual(["refresh"]);
    main.scrollTop = 900; // the viewer keeps scrolling during the round trip
    await r.rerender(jumpy(false, { ...stamp, scored: 9 }));
    expect(main.scrollTop).toBe(900);
  });

  it("without the live gallery (L1+), the sync's page refresh keeps the grid's scroll too — unless the viewer scrolled", async () => {
    m.open = "c1";
    const off = () => sync({ pollingOff: true });
    const r = await render(<RouterJump jump={false}>{page(params(), off())}</RouterJump>);
    const main = r.container.querySelector<HTMLElement>("#main")!;
    main.scrollTop = 640;
    await mailArrives(r);
    expect(r.router.calls).toEqual(["refresh"]);
    await r.rerender(<RouterJump jump>{page(params(), off())}</RouterJump>);
    expect(main.scrollTop).toBe(640);
    // The viewer scrolls while the next refresh is on its way: theirs stands.
    await mailArrives(r);
    main.scrollTop = 200;
    window.dispatchEvent(new Event("wheel"));
    await r.rerender(<RouterJump jump={false}>{page(params(), off())}</RouterJump>);
    expect(main.scrollTop).toBe(200);
  });

  it("a filter change while a refresh is on its way isn't held at the old scroll", async () => {
    m.checkGallery.mockResolvedValue({
      ok: true,
      data: {
        stamp: { ...stamp, scored: 9, analyzedAt: "2026-09-30 14:06:00+00" },
        pollingOff: false,
        view: { total: 10, added: 0, rescored: 1 },
      },
    });
    m.open = "c1";
    const r = await render(jumpy(false, stamp));
    const main = r.container.querySelector<HTMLElement>("#main")!;
    main.scrollTop = 640;
    await mailArrives(r);
    await r.rerender(jumpy(true, { ...stamp, scored: 9 }, params({ category: "welcome" })));
    expect(main.scrollTop).toBe(0);
  });

  it("scores that may reorder a 'Best first' page: the pill says 'Designs updated'", async () => {
    m.checkGallery.mockResolvedValue({
      ok: true,
      data: {
        stamp: { ...stamp, scored: 9, analyzedAt: "2026-09-30 14:06:00+00" },
        pollingOff: false,
        view: { total: 10, added: 0, rescored: 1 },
      },
    });
    m.open = "c1";
    const r = await render(page(params({ sort: "best" })));
    await mailArrives(r);
    expect(r.container.querySelector("[data-gallery-live-slot] button")!.textContent).toBe(
      "Designs updated·Show",
    );
    expect(r.router.calls).toEqual([]);
  });

  it("nothing changed: nothing happens", async () => {
    m.checkGallery.mockResolvedValue({ ok: true, data: { stamp, pollingOff: false, view: null } });
    const r = await render(page(params()));
    await mailArrives(r);
    expect(m.checkGallery).toHaveBeenCalledTimes(1);
    expect(r.router.calls).toEqual([]);
  });

  it("polls on its own about once a minute while the tab is visible, and not while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    m.checkGallery.mockResolvedValue({ ok: true, data: { stamp, pollingOff: false, view: null } });
    await render(page(params()));
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(m.checkGallery).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1_000));
    await settle();
    expect(m.checkGallery).toHaveBeenCalledTimes(1);
    // Hidden: nothing, however long.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    window.dispatchEvent(new Event("pointermove"));
    await act(async () => vi.advanceTimersByTime(10 * 60_000));
    expect(m.checkGallery).toHaveBeenCalledTimes(1);
    // Shown again: a check at once.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(m.checkGallery).toHaveBeenCalledTimes(2);
  });

  it("signed out: it stops checking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    m.checkGallery.mockResolvedValue({ ok: false, error: "Please sign in.", code: "unauthorized" });
    await render(page(params()));
    await act(async () => vi.advanceTimersByTime(60_000));
    await settle();
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event("pointermove"));
      await act(async () => vi.advanceTimersByTime(60_000));
    }
    expect(m.checkGallery).toHaveBeenCalledTimes(1);
  });

  it("the governor moves to L1 while the page is open: the background sync and the checks both stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    m.checkGallery.mockResolvedValue({ ok: true, data: { stamp, pollingOff: false, view: null } });
    m.syncNow.mockResolvedValue({ ok: true, data: { newMessages: 0, syncing: false, pollingOff: true } });
    await render(page(params()));
    await settle();
    const syncs = m.syncNow.mock.calls.length; // the load-time sync (once per app load), if any
    // An hour of use: the 10-minute sync runs once, learns about L1, and nothing runs after it.
    for (let i = 0; i < 60; i++) {
      window.dispatchEvent(new Event("pointermove"));
      await act(async () => vi.advanceTimersByTime(60_000));
      await settle();
    }
    expect(m.syncNow.mock.calls.length - syncs).toBeLessThanOrEqual(1);
    expect(m.checkGallery.mock.calls.length).toBeLessThanOrEqual(5);
    const checks = m.checkGallery.mock.calls.length;
    const after = m.syncNow.mock.calls.length;
    for (let i = 0; i < 30; i++) {
      window.dispatchEvent(new Event("pointermove"));
      await act(async () => vi.advanceTimersByTime(60_000));
      await settle();
    }
    expect(m.syncNow.mock.calls.length).toBe(after);
    expect(m.checkGallery.mock.calls.length).toBe(checks);
  });

  it("a gallery check that finds L1 stops the app's background sync too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    m.checkGallery.mockResolvedValue({ ok: true, data: { stamp, pollingOff: true, view: null } });
    await render(page(params()));
    await settle();
    const syncs = m.syncNow.mock.calls.length;
    for (let i = 0; i < 60; i++) {
      window.dispatchEvent(new Event("pointermove"));
      await act(async () => vi.advanceTimersByTime(60_000));
      await settle();
    }
    // The first check (at 1 minute) found L1: no more checks, and the 10-minute sync never ran.
    expect(m.checkGallery).toHaveBeenCalledTimes(1);
    expect(m.syncNow.mock.calls.length).toBe(syncs);
  });

  it("the governor's UI polling off: no checks at all; the sync refreshes the page as before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const r = await render(page(params(), sync({ pollingOff: true })));
    await act(async () => vi.advanceTimersByTime(30 * 60_000));
    vi.useRealTimers();
    await mailArrives(r);
    expect(m.checkGallery).not.toHaveBeenCalled();
    expect(r.router.calls).toEqual(["refresh"]);
  });
});
