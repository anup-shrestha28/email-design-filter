/**
 * R1-07: every fetch of the email detail signs new viewer URLs, and the viewer switched its frame to
 * them — so "Mark done", pin, a type change or a background refetch tore the frame down (a skeleton
 * while the origin was re-probed, then a fresh load from Gmail) and put the reader back at the top.
 * The frame now keeps its URL; it switches only for the other images mode or a refresh the reader
 * asked for once the URL expired.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailViewer } from "@/components/email/email-viewer";
import type { EmailDetail } from "@/server/queries/types";
import { buttonByText, click, render, waitFor } from "../support/render";

const EMAIL = "0b8f8c52-6a4e-4d1c-9a57-2f5a3c2d1e10";

function viewer(token: string, expiresInS: number): NonNullable<EmailDetail["viewer"]> {
  return {
    src: `https://view.test/v/${token}-img/${EMAIL}`,
    srcImagesOff: `https://view.test/v/${token}-noimg/${EMAIL}`,
    expiresAt: new Date(Date.now() + expiresInS * 1000).toISOString(),
  };
}

let probes = 0;
beforeEach(() => {
  probes = 0;
  // The reachability probe: an image on the viewer origin that always loads.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    referrerPolicy = "";
    set src(_v: string) {
      probes++;
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
afterEach(() => {
  vi.unstubAllGlobals();
});

const frame = (c: HTMLElement) => c.querySelector("iframe");
const ui = (v: EmailDetail["viewer"], onExpired?: () => void) => (
  <EmailViewer viewer={v} layout={null} onExpired={onExpired} />
);

describe("EmailViewer keeps its frame across refetches (R1-07)", () => {
  it("a refetch with freshly signed URLs doesn't reload the frame", async () => {
    const a = viewer("a", 240);
    const r = await render(ui(a));
    const first = await waitFor(() => {
      const f = frame(r.container);
      if (!f) throw new Error("no frame yet");
      return f;
    });
    expect(first.getAttribute("src")).toBe(a.src);
    expect(probes).toBe(1);

    // "Mark done" → the detail is fetched again → new signed URLs for the same email.
    await r.rerender(ui(viewer("b", 240)));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 10));
    });
    expect(r.container.querySelector('[role="status"]')).toBeNull(); // no "Loading preview" skeleton
    expect(frame(r.container)).toBe(first); // the same element: not remounted
    expect(first.getAttribute("src")).toBe(a.src);
    expect(probes).toBe(1); // the origin wasn't probed again

    // Turning images off is an explicit switch: it loads the latest URL for that mode.
    const c = viewer("c", 240);
    await r.rerender(ui(c));
    const toggle = r.container.querySelector<HTMLElement>('[role="switch"]')!;
    await click(toggle);
    await waitFor(() => expect(frame(r.container)?.getAttribute("src")).toBe(c.srcImagesOff));
  });

  it("an expired frame takes the fresh URLs after 'Refresh preview'", async () => {
    const onExpired = vi.fn();
    const old = viewer("old", -60);
    const r = await render(ui(old, onExpired));
    await waitFor(() => expect(frame(r.container)?.getAttribute("src")).toBe(old.src));
    await click(buttonByText(r.container, /Refresh preview/));
    expect(onExpired).toHaveBeenCalledTimes(1);
    const fresh = viewer("fresh", 240);
    await r.rerender(ui(fresh, onExpired));
    await waitFor(() => expect(frame(r.container)?.getAttribute("src")).toBe(fresh.src));
  });
});
