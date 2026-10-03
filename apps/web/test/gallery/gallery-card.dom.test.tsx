/**
 * Gallery cards in the DOM: the face shows the design, who sent it and when, and (once scored) the
 * verdict and why — never the subject, which lives in the card button's name and tooltip. Every
 * card's preview has the same box shape (growing only to fill a taller grid row), showing the top
 * of the email laid out at the crop's canvas width (reallygoodemails.com style); the full design is
 * one click away, in the detail view.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GalleryCard, GalleryCardSkeleton } from "@/components/gallery/gallery-card";
import { PreviewUrlProvider } from "@/components/gallery/preview-urls";
import type { GalleryItem } from "@/server/queries/types";
import { describedByText, render, waitFor } from "../support/render";

vi.mock("@/server/actions/gallery", () => ({ galleryPreviewUrls: vi.fn(async () => ({})) }));

beforeAll(() => {
  // jsdom has no ResizeObserver (the card measures its preview box with one).
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const SUBJECT = "Rain shells, 25% off this weekend";
const item = (over: Partial<GalleryItem> = {}): GalleryItem => ({
  id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  sender: { name: "Tidewell", domain: "tidewell.com" },
  subject: SUBJECT,
  receivedAt: "2026-09-28T09:15:00Z",
  category: "promotions",
  score: 92,
  band: "excellent",
  verdict: "good",
  reason: { kind: "strength", text: "Clear headline with plenty of space around it" },
  problems: [],
  strengths: [],
  fonts: [],
  previewable: false,
  frame: null,
  ...over,
});

const card = (it: GalleryItem, extra: Partial<React.ComponentProps<typeof GalleryCard>> = {}) => (
  <PreviewUrlProvider>
    <ul>
      <GalleryCard item={it} onOpen={() => {}} {...extra} />
    </ul>
  </PreviewUrlProvider>
);

/** The card's visible text (screen-reader-only spans removed). */
function visibleText(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((e) => e.remove());
  return copy.textContent ?? "";
}

describe("GalleryCard", () => {
  it("scored: sender, verdict badge and reason on the face; the subject only in the name and tooltip", async () => {
    const r = await render(card(item()));
    const li = r.container.querySelector("li")!;
    const text = visibleText(li);
    expect(text).toContain("Tidewell");
    expect(text).not.toContain(SUBJECT);
    expect(li.querySelector("[data-verdict]")?.getAttribute("data-verdict")).toBe("good");
    expect(text).toContain("Clear headline with plenty of space around it");
    const button = li.querySelector("button[data-card-id]")!;
    expect(button.getAttribute("aria-label")).toBe(`Open Tidewell — ${SUBJECT}`);
    expect(button.getAttribute("title")).toBe(SUBJECT);
    expect(describedByText(button).join(" ")).toContain("Strength:");
  });

  it("unscored: says when the score comes, in the verdict's place — never 'still checking'", async () => {
    const r = await render(
      card(
        item({
          verdict: "unscored",
          score: null,
          band: null,
          reason: null,
          waiting: { state: "scoring" },
        }),
      ),
    );
    const li = r.container.querySelector("li")!;
    const text = visibleText(li);
    expect(text).toContain("Tidewell");
    expect(text).toContain("Scoring now");
    expect(text).toContain("Ready in a few minutes");
    expect(text).not.toContain("still checking");
    expect(text).not.toContain(SUBJECT);
    const badge = li.querySelector("[data-verdict]")!;
    expect(badge.getAttribute("data-verdict")).toBe("unscored");
    expect(badge.getAttribute("data-waiting")).toBe("scoring");
    // The same room as a scored card's badge (h-6) and reason line (h-8): nothing jumps when it's scored.
    expect(badge.parentElement!.className).toContain("h-6");
    expect(li.querySelector("p.h-8")).not.toBeNull();
    // Screen readers hear it through the card's description.
    const button = li.querySelector("button[data-card-id]")!;
    expect(describedByText(button).join(" ")).toContain("Scoring now");
    expect(button.getAttribute("title")).toBe(SUBJECT);
  });

  it("unscored: each waiting state has its own plain words", async () => {
    const cases: Array<[NonNullable<GalleryItem["waiting"]>, string, string]> = [
      [{ state: "soon" }, "Scoring soon", "Usually within the hour"],
      [{ state: "queued" }, "Not scored yet", "Waiting in line to be scored"],
      [{ state: "paused" }, "Not scored yet", "Scoring is paused for now"],
      [{ state: "off" }, "Not scored yet", "Scoring is switched off"],
      [{ state: "manual" }, "Not scored yet", "Open it to get a score"],
      [{ state: "mailbox" }, "Not scored yet", "Reconnect Gmail to score it"],
    ];
    for (const [waiting, badge, line] of cases) {
      const r = await render(
        card(item({ verdict: "unscored", score: null, band: null, reason: null, waiting })),
      );
      const text = visibleText(r.container);
      expect(text).toContain(badge);
      expect(text).toContain(line);
      await r.unmount();
    }
    // No waiting info (e.g. an older server): just "Not scored yet", no made-up time.
    const r = await render(
      card(item({ verdict: "unscored", score: null, band: null, reason: null })),
    );
    expect(visibleText(r.container)).toContain("Not scored yet");
  });

  it("every card keeps the same fixed box shape, rendered or not", async () => {
    const tall = await render(card(item({ frame: { x: 100, width: 600, contentBottom: 3160 } })));
    const box = tall.container.querySelector<HTMLElement>("[data-preview-box]")!;
    expect(box.className).toContain("aspect-[5/4]");
    expect(box.className).toContain("sm:aspect-square");
    expect(box.getAttribute("style") ?? "").not.toContain("aspect-ratio");
    await tall.unmount();

    const unknown = await render(card(item({ frame: null })));
    const sq = unknown.container.querySelector<HTMLElement>("[data-preview-box]")!;
    expect(sq.className).toContain("sm:aspect-square");
    expect(sq.getAttribute("style") ?? "").not.toContain("aspect-ratio");
  });

  it("the preview grows to fill a taller grid row (an unscored card beside scored ones): no empty strip", async () => {
    const r = await render(
      card(item({ verdict: "unscored", score: null, band: null, reason: null })),
    );
    const li = r.container.querySelector<HTMLElement>("li")!;
    const box = li.querySelector<HTMLElement>("[data-preview-box]")!;
    // The card is a column that stretches to its row; the preview is the part that takes up the
    // slack (flex-grow with its aspect-ratio height as the basis, so the shape is its minimum).
    expect(li.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
    expect(box.className.split(/\s+/)).toContain("grow");
    expect(box.className).not.toMatch(/\bflex-1\b|\bbasis-/);
    expect(box.className).toContain("sm:aspect-square");
    // The text under it never grows.
    expect(li.querySelector<HTMLElement>('[id$="-meta"]')!.className).not.toContain("grow");
  });

  it("the live preview lays out at the crop's canvas: 800 px, or the email's own width when wider", async () => {
    const at = async (id: string, frame: GalleryItem["frame"]) => {
      const url = `https://view.test/v/t/${id}`;
      const r = await render(
        <PreviewUrlProvider seed={{ mintedAt: Date.now(), urls: { [id]: url } }}>
          <ul>
            <GalleryCard item={item({ id, previewable: true, frame })} eager onOpen={() => {}} />
          </ul>
        </PreviewUrlProvider>,
      );
      const iframe = await waitFor(() => {
        const f = r.container.querySelector<HTMLIFrameElement>("iframe");
        if (!f) throw new Error("no frame yet");
        return f;
      });
      const widths = [iframe.style.width, iframe.parentElement!.style.width];
      await r.unmount();
      return widths;
    };
    expect(
      await at("0190a1b2-0000-7000-8000-000000000001", { x: 100, width: 600, contentBottom: 900 }),
    ).toEqual(["800px", "800px"]);
    expect(await at("0190a1b2-0000-7000-8000-000000000002", null)).toEqual(["800px", "800px"]);
    expect(
      await at("0190a1b2-0000-7000-8000-000000000003", {
        x: 0,
        width: 886,
        contentBottom: 924,
        canvasWidth: 886,
      }),
    ).toEqual(["886px", "886px"]);
  });

  it("still shows '+N similar'", async () => {
    const r = await render(card(item(), { similar: 2 }));
    const li = r.container.querySelector<HTMLElement>("li")!;
    expect(visibleText(li)).toContain("+2 similar");
  });
});

describe("GalleryCardSkeleton", () => {
  it("has the card's fixed box and the same text block", async () => {
    const r = await render(
      <ul>
        <GalleryCardSkeleton />
      </ul>,
    );
    const li = r.container.querySelector("li")!;
    expect(li.getAttribute("aria-hidden")).toBe("true");
    expect(li.firstElementChild!.className).toContain("sm:aspect-square");
  });
});
