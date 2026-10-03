/**
 * R1-19 (UI side): the governor computed "images click-to-load" (friends at L1 / Fast Origin
 * Transfer soft, everyone at L2 / its self-cap) and "UI sync-status polling off" (L1), but nothing
 * applied them: images always loaded through edf-view, and the page kept polling sync status every
 * 10 s. The viewer now opens with images off when the page's data says click-to-load, and the sync
 * provider sets no timer while polling is off.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailDetail, SyncStatus } from "@/server/queries/types";
import { click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({
  pollSyncStatus: vi.fn(),
  syncNow: vi.fn(),
}));
vi.mock("@/app/(app)/actions", () => ({ pollSyncStatus: h.pollSyncStatus }));
vi.mock("@/server/actions/settings", () => ({ syncNow: h.syncNow }));

const { EmailViewer } = await import("@/components/email/email-viewer");
const { SyncProvider } = await import("@/components/providers/sync");

const EMAIL = "0b8f8c52-6a4e-4d1c-9a57-2f5a3c2d1e10";
const viewer = (): NonNullable<EmailDetail["viewer"]> => ({
  src: `https://view.test/v/t-img/${EMAIL}`,
  srcImagesOff: `https://view.test/v/t-noimg/${EMAIL}`,
  expiresAt: new Date(Date.now() + 240_000).toISOString(),
});

describe("images click-to-load", () => {
  beforeEach(() => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      referrerPolicy = "";
      set src(_v: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const frameSrc = async (c: HTMLElement) =>
    waitFor(() => {
      const f = c.querySelector("iframe");
      if (!f) throw new Error("no frame yet");
      return f.getAttribute("src");
    });

  it("opens with images off, and the reader can still turn them on", async () => {
    const v = viewer();
    const r = await render(<EmailViewer viewer={v} layout={null} clickToLoad />);
    expect(await frameSrc(r.container)).toBe(v.srcImagesOff);
    expect(r.container.textContent).toMatch(/free limits/);
    await click(r.container.querySelector('[role="switch"]')!);
    expect(await frameSrc(r.container)).toBe(v.src);
  });

  it("loads images as usual when the governor doesn't ask for click-to-load", async () => {
    const v = viewer();
    const r = await render(<EmailViewer viewer={v} layout={null} />);
    expect(await frameSrc(r.container)).toBe(v.src);
  });
});

describe("sync-status polling", () => {
  const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
    mailboxes: [],
    syncing: true,
    lastSyncedAt: null,
    banner: null,
    ...over,
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    h.pollSyncStatus.mockReset();
    h.pollSyncStatus.mockResolvedValue({ ok: true, data: status() });
  });
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
    });

  it("sets no timer while the governor has polling off", async () => {
    await render(
      <SyncProvider initial={status({ pollingOff: true })}>
        <span />
      </SyncProvider>,
    );
    await advance(35_000);
    expect(h.pollSyncStatus).not.toHaveBeenCalled();
  });

  it("polls every 10 s while syncing otherwise", async () => {
    await render(
      <SyncProvider initial={status()}>
        <span />
      </SyncProvider>,
    );
    await advance(10_500);
    expect(h.pollSyncStatus).toHaveBeenCalledTimes(1);
  });
});
