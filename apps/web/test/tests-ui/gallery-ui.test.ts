/**
 * Gallery presentation logic (no database): the card crop and hover drift, the verdict + score
 * rule, near-duplicate grouping, the full page's back link, per-card preview-URL retries, the load
 * scheduler, and the signed-in redirect from the site root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { backLinkOf, DEFAULT_BACK } from "@/lib/back-link";
import { groupSimilar, shownScore } from "@/lib/gallery-display";
import {
  cardCrop,
  cardLayout,
  CONTENT_BOTTOM_ALLOWANCE,
  fullFrame,
  MAX_CANVAS_WIDTH,
  phoneFit,
  previewFrameOf,
  RENDER_WIDTH,
} from "@/lib/gallery-preview";
import {
  LoadScheduler,
  MAX_ATTEMPTS,
  PreviewUrlStore,
  gaveUp,
} from "@/components/gallery/preview-urls";
import { proxy } from "@/proxy";

describe("card crop", () => {
  // A real case from the browser audit (LinkedIn): the analysis' main container was x=110..689
  // while the visible content spans x=8..792 — cropping to the box trimmed the design's edges.
  const RAW = {
    desktopHeight: 1000,
    mobileHeight: 1400,
    desktopContentWidth: 800,
    mobileContentWidth: 375,
    nomqContentWidth: null,
    k: 1,
    kNomq: null,
    mainContainer: { x: 110, y: 40, w: 579, h: 500 },
    content: { left: 8, right: 792, bottom: 700 },
  };
  /** The same facts as score_summary.layout keeps them (@edf/design SummaryLayout). */
  const SUMMARY = {
    desktopHeight: 1000,
    mobileHeight: 1400,
    mobileContentWidth: 375,
    mainContainer: { x: 110, y: 40, w: 579, h: 500 },
    content: { left: 8, right: 792, bottom: 700 },
    desktopContentWidth: 800,
  };

  it("crops to the measured visible content, never to the main container, from either saved shape", () => {
    const expected = {
      x: 8,
      width: 784,
      contentBottom: 700 + CONTENT_BOTTOM_ALLOWANCE,
      phoneBottom: 1400,
    };
    expect(previewFrameOf(RAW)).toEqual(expected);
    expect(previewFrameOf(SUMMARY)).toEqual(expected);
    // A summary saved before desktopContentWidth existed reads the same.
    const { desktopContentWidth: _dcw, ...olderSummary } = SUMMARY;
    expect(previewFrameOf(olderSummary)).toEqual(expected);
    // Fractional measurements: whole px, never tighter than measured (left down, right up).
    expect(
      previewFrameOf({ ...RAW, content: { left: 99.6, right: 700.2, bottom: 650.3 } }),
    ).toMatchObject({
      x: 99,
      width: 602,
      contentBottom: Math.round(650.3 + CONTENT_BOTTOM_ALLOWANCE),
    });
  });

  it("no usable content measurement: no horizontal box (the whole canvas), whatever the main container says", () => {
    const { content: _c, ...absent } = RAW;
    for (const content of [
      undefined,
      null,
      "8..792",
      [],
      {},
      { left: -1, right: 700, bottom: 500 },
      { left: 700, right: 700, bottom: 500 },
      { left: 792, right: 8, bottom: 500 },
      { left: 0, right: 600, bottom: 0 },
      { left: 0, right: 600, bottom: -4 },
      { left: "8", right: 792, bottom: 500 },
      { left: 8, right: Number.NaN, bottom: 500 },
      { left: 8, right: Number.POSITIVE_INFINITY, bottom: 500 },
      { left: 8, right: 792 },
    ]) {
      const f = previewFrameOf(content === undefined ? absent : { ...RAW, content });
      expect(f, JSON.stringify(content)).toEqual({ contentBottom: 1000, phoneBottom: 1400 });
    }
    // The audit's other failure: a 260 px footer scrap at the bottom of a long page as "the design".
    expect(
      previewFrameOf({
        desktopHeight: 4588.5,
        mainContainer: { x: 120, y: 4272.8, w: 260, h: 243 },
        content: null,
      }),
    ).toEqual({ contentBottom: 4589 });
  });

  it("content ends at the real height on a long page, at the last visible thing (plus room for trailing space) on a short one", () => {
    // Taller than the viewport: the measured document height, as before.
    expect(
      previewFrameOf({
        ...RAW,
        desktopHeight: 1624.4,
        content: { left: 8, right: 792, bottom: 1500 },
      })?.contentBottom,
    ).toBe(1624);
    // No taller than the viewport: the content's bottom plus room for the invisible space the
    // document runs on past it, never past the page.
    expect(CONTENT_BOTTOM_ALLOWANCE).toBeGreaterThanOrEqual(64);
    expect(
      previewFrameOf({ ...RAW, content: { left: 8, right: 792, bottom: 310 } })?.contentBottom,
    ).toBe(310 + CONTENT_BOTTOM_ALLOWANCE);
    expect(
      previewFrameOf({ ...RAW, content: { left: 8, right: 792, bottom: 990 } })?.contentBottom,
    ).toBe(1000);
    // Unmeasured: the viewport height stands (the main container's bottom is not an estimate any
    // more — an inner block would cut the email off in the detail view's full-length frame).
    expect(previewFrameOf({ ...RAW, content: null })?.contentBottom).toBe(1000);
    // No render (or nonsense height): no frame at all.
    for (const bad of [
      null,
      undefined,
      "x",
      {},
      { ...RAW, desktopHeight: "1318" },
      { ...RAW, desktopHeight: 0 },
      { mainContainer: RAW.mainContainer, content: RAW.content },
    ])
      expect(previewFrameOf(bad)).toBeNull();
  });

  it("an email wider than the 800 px render gets a wider canvas (capped at 1600) instead of being cut off", () => {
    // A fixed 886 px layout.
    expect(
      previewFrameOf({
        ...RAW,
        desktopContentWidth: 886,
        content: { left: 0, right: 886, bottom: 900 },
      }),
    ).toEqual({
      x: 0,
      width: 886,
      contentBottom: 900 + CONTENT_BOTTOM_ALLOWANCE,
      canvasWidth: 886,
      phoneBottom: 1400,
    });
    // Unmeasured content: the document's own width decides.
    expect(previewFrameOf({ ...RAW, desktopContentWidth: 886, content: null })).toEqual({
      contentBottom: 1000,
      canvasWidth: 886,
      phoneBottom: 1400,
    });
    expect(previewFrameOf({ ...RAW, desktopContentWidth: 810.2, content: null })?.canvasWidth).toBe(
      811,
    );
    // Measured content decides over a wider document: an invisible spacer mustn't widen the canvas
    // (that would re-centre the design away from where it was measured).
    expect(previewFrameOf({ ...RAW, desktopContentWidth: 1000 })).toEqual({
      x: 8,
      width: 784,
      contentBottom: 700 + CONTENT_BOTTOM_ALLOWANCE,
      phoneBottom: 1400,
    });
    // Runaway widths: at most 1600 px, the content box cut there.
    expect(
      previewFrameOf({
        ...RAW,
        desktopContentWidth: 2400,
        content: { left: 100, right: 2400, bottom: 900 },
      }),
    ).toMatchObject({ x: 100, width: 1500, canvasWidth: MAX_CANVAS_WIDTH });
    expect(
      previewFrameOf({ ...RAW, desktopContentWidth: 50_000, content: null })?.canvasWidth,
    ).toBe(MAX_CANVAS_WIDTH);
    expect(
      previewFrameOf({
        ...RAW,
        desktopContentWidth: 4000,
        content: { left: 1700, right: 4000, bottom: 900 },
      }),
    ).toEqual({
      contentBottom: 900 + CONTENT_BOTTOM_ALLOWANCE,
      canvasWidth: MAX_CANVAS_WIDTH,
      phoneBottom: 1400,
    });
    // Fits the render: no canvas width.
    for (const desktopContentWidth of [800, 640, undefined, Number.NaN])
      expect(
        previewFrameOf({ ...RAW, desktopContentWidth, content: null })?.canvasWidth,
      ).toBeUndefined();
  });

  it("already-built frames pass through unchanged (the client re-validating what the server sent); nonsense doesn't", () => {
    const built = [
      previewFrameOf(RAW)!,
      previewFrameOf({ ...RAW, content: null })!,
      previewFrameOf({
        ...RAW,
        mobileContentWidth: 624,
        desktopContentWidth: 886,
        content: { left: 0, right: 886, bottom: 900 },
      })!,
      previewFrameOf({ ...RAW, desktopContentWidth: 3000, content: null })!,
      { x: 80, width: 640, contentBottom: 827 },
    ];
    for (const f of built) expect(previewFrameOf(f)).toEqual(f);
    expect(previewFrameOf(built[2]!)).toMatchObject({ canvasWidth: 886, phoneWidth: 624 });
    // A canvas width that makes no sense is dropped…
    for (const canvasWidth of [700, 800, 5000, "900", Number.NaN])
      expect(previewFrameOf({ contentBottom: 500, canvasWidth })).toEqual({ contentBottom: 500 });
    // …and a box that then sticks out of the canvas, or never fitted it, is nonsense.
    for (const bad of [
      { x: -5, width: 600, contentBottom: 10 },
      { x: 500, width: 600, contentBottom: 10 },
      { x: 0, width: 886, contentBottom: 10 },
      { x: 0, width: 886, contentBottom: 10, canvasWidth: 5000 },
      { x: 0, width: 900, contentBottom: 10, canvasWidth: 886 },
      { x: 0, width: 0, contentBottom: 10 },
      { x: 0, width: 600, contentBottom: 0 },
    ])
      expect(previewFrameOf(bad), JSON.stringify(bad)).toBeNull();
    // Half a box is dropped, the height kept.
    expect(previewFrameOf({ x: 80, contentBottom: 827 })).toEqual({ contentBottom: 827 });
  });

  it("zooms to the content plus a 24 px gutter (at least 520 px wide), inside the canvas", () => {
    // Unmeasured, or not rendered: the whole canvas.
    expect(cardCrop(null)).toEqual({
      renderWidth: RENDER_WIDTH,
      cropX: 0,
      cropWidth: RENDER_WIDTH,
      contentBottom: null,
    });
    expect(cardCrop({ contentBottom: 500 })).toEqual({
      renderWidth: 800,
      cropX: 0,
      cropWidth: 800,
      contentBottom: 500,
    });
    // A classic 600 px column, centred.
    expect(cardCrop({ x: 100, width: 600, contentBottom: 500 })).toEqual({
      renderWidth: 800,
      cropX: 76,
      cropWidth: 648,
      contentBottom: 500,
    });
    // Nearly full width (the LinkedIn case): the whole render, nothing trimmed.
    expect(cardCrop(previewFrameOf(RAW))).toMatchObject({ cropX: 0, cropWidth: 800 });
    // A very narrow design isn't blown up: a 520 px slice around it.
    expect(cardCrop({ x: 250, width: 300, contentBottom: 300 })).toMatchObject({
      cropX: 140,
      cropWidth: 520,
    });
    // Off-centre content is followed, but the slice stays inside the render.
    expect(cardCrop({ x: 0, width: 600, contentBottom: 300 })).toMatchObject({
      cropX: 0,
      cropWidth: 648,
    });
    expect(cardCrop({ x: 200, width: 600, contentBottom: 300 })).toMatchObject({
      cropX: 152,
      cropWidth: 648,
    });
    // A wider canvas: the iframe lays out at it, and the slice can use all of it.
    expect(cardCrop({ x: 0, width: 886, contentBottom: 924, canvasWidth: 886 })).toEqual({
      renderWidth: 886,
      cropX: 0,
      cropWidth: 886,
      contentBottom: 924,
    });
    expect(cardCrop({ contentBottom: 1000, canvasWidth: 1600 })).toMatchObject({
      renderWidth: 1600,
      cropX: 0,
      cropWidth: 1600,
    });
    expect(cardCrop({ x: 100, width: 600, contentBottom: 500, canvasWidth: 1000 })).toMatchObject({
      renderWidth: 1000,
      cropX: 76,
      cropWidth: 648,
    });
  });

  it("the slice always holds the whole measured content, in whole px", () => {
    for (const canvasWidth of [undefined, 886, 1600])
      for (let x = 0; x < (canvasWidth ?? 800); x += 37)
        for (const width of [1, 40, 300, 471.5, 600, 752, 800, 1200]) {
          const canvas = canvasWidth ?? 800;
          if (x + width > canvas) continue;
          const c = cardCrop({
            x,
            width,
            contentBottom: 500,
            ...(canvasWidth ? { canvasWidth } : {}),
          });
          const at = JSON.stringify({ x, width, canvasWidth });
          expect(c.renderWidth, at).toBe(canvas);
          expect(Number.isInteger(c.cropX) && Number.isInteger(c.cropWidth), at).toBe(true);
          expect(c.cropX, at).toBeGreaterThanOrEqual(0);
          expect(c.cropX + c.cropWidth, at).toBeLessThanOrEqual(canvas);
          expect(c.cropX, at).toBeLessThanOrEqual(x);
          expect(c.cropX + c.cropWidth, at).toBeGreaterThanOrEqual(Math.floor(x + width));
          expect(c.cropWidth, at).toBeGreaterThanOrEqual(Math.min(canvas, 520));
        }
  });

  it("drifts on hover only as far as the email goes, and not at all for a short or unknown one", () => {
    const box = { w: 324, h: 324 }; // scale 0.5 for a 648 crop
    const short = cardLayout(cardCrop({ x: 100, width: 600, contentBottom: 500 }), box.w, box.h);
    expect(short.scale).toBeCloseTo(0.5);
    expect(short.drift).toBe(0);
    const unknown = cardLayout(cardCrop(null), box.w, box.h);
    expect(unknown.drift).toBe(0);
    const medium = cardLayout(cardCrop({ x: 100, width: 600, contentBottom: 900 }), box.w, box.h);
    expect(medium.drift).toBe(450 - 324);
    const long = cardLayout(cardCrop({ x: 100, width: 600, contentBottom: 54_290 }), box.w, box.h);
    expect(long.drift).toBe(324); // at most one more box
    // The frame is tall enough that drifting never shows a gap below the email.
    expect(long.frameHeight * long.scale).toBeGreaterThanOrEqual(box.h + long.drift);
  });

  it("a box grown taller than its shape (an unscored card in a taller row) is still covered, and drifts less", () => {
    const crop = cardCrop({ x: 100, width: 600, contentBottom: 900 });
    const grown = cardLayout(crop, 324, 390);
    expect(grown.scale).toBeCloseTo(0.5);
    expect(grown.drift).toBe(450 - 390);
    expect(grown.frameHeight * grown.scale).toBeGreaterThanOrEqual(390 + grown.drift);
    // An email that fits the grown box doesn't drift at all (a 24 px wiggle isn't worth it).
    expect(cardLayout(crop, 324, 440).drift).toBe(0);
    const long = cardLayout(cardCrop({ x: 100, width: 600, contentBottom: 5000 }), 324, 390);
    expect(long.drift).toBe(390);
    expect(long.frameHeight * long.scale).toBeGreaterThanOrEqual(390 + 390);
  });
});

describe("verdict + score", () => {
  it("shows the number only when it agrees with the word", () => {
    expect(shownScore("good", 92)).toBe(92);
    expect(shownScore("ok", 71)).toBe(71);
    expect(shownScore("ok", 98)).toBeNull(); // never "Okay · 98"
    expect(shownScore("ok", 85)).toBeNull();
    // Bad: never on cards (a capped "Bad · 69" could read as better than an "Okay · 55"); the
    // detail's large badge shows it below 70.
    expect(shownScore("bad", 41)).toBeNull();
    expect(shownScore("bad", 41, { detail: true })).toBe(41);
    expect(shownScore("bad", 59, { detail: true })).toBe(59);
    expect(shownScore("bad", 80, { detail: true })).toBeNull();
    expect(shownScore("unscored", 50)).toBeNull();
    expect(shownScore("good", null)).toBeNull();
    expect(shownScore("good", 91.6)).toBe(92);
  });
});

describe("near-duplicate grouping", () => {
  const item = (
    id: string,
    subject: string | null,
    verdict: "good" | "bad" | "ok" = "good",
    domain = "tidewell.com",
  ) => ({
    id,
    subject,
    verdict,
    sender: { name: "Tidewell", domain },
  });
  it("collapses same sender + subject + verdict, keeping order", () => {
    const g = groupSimilar([
      item("a", "Rain shells, 25% off this weekend"),
      item("b", "Other"),
      item("c", "rain shells — 25% off this weekend!"),
      item("d", "Rain shells, 25% off this weekend", "bad"),
      item("e", "Rain shells, 25% off this weekend", "good", "else.com"),
      item("f", null),
      item("g", null),
    ]);
    expect(g.map((x) => [x.item.id, x.similar.map((s) => s.id)])).toEqual([
      ["a", ["c"]],
      ["b", []],
      ["d", []],
      ["e", []],
      ["f", []],
      ["g", []],
    ]);
  });
  it("the group's card is its cleanest version (fewest problems, then best score), at the group's place", () => {
    const g = groupSimilar([
      { ...item("new", "Rain shells"), problems: ["Shows stray text"], score: 100 },
      item("other", "Other"),
      { ...item("clean", "Rain shells"), problems: [], score: 100 },
      { ...item("older", "Rain shells"), problems: [], score: 99 },
    ]);
    expect(g.map((x) => [x.item.id, x.similar.map((s) => s.id)])).toEqual([
      ["clean", ["new", "older"]],
      ["other", []],
    ]);
  });
  it("a tie goes to the oldest version, never to whichever copy is listed first (the newest)", () => {
    const at = (d: number) => new Date(Date.UTC(2026, 8, d)).toISOString();
    const g = groupSimilar([
      { ...item("newest", "Rain shells"), problems: [], score: 100, receivedAt: at(20) },
      { ...item("first", "Rain shells"), problems: [], score: 100, receivedAt: at(1) },
      { ...item("middle", "Rain shells"), problems: [], score: 100, receivedAt: at(10) },
    ]);
    expect(g.map((x) => x.item.id)).toEqual(["first"]);
  });
});

describe("phone preview and card box", () => {
  it("phoneFit shrinks a layout wider than the phone like a phone mail app, however wide", () => {
    expect(phoneFit(null)).toEqual({ layoutWidth: 375, scale: 1 });
    expect(phoneFit({})).toEqual({ layoutWidth: 375, scale: 1 });
    expect(phoneFit({ phoneWidth: 624 })).toEqual({ layoutWidth: 624, scale: 375 / 624 });
    // Wider than twice the phone: still shrunk to fit, never running off the screen.
    expect(phoneFit({ phoneWidth: 800 })).toEqual({ layoutWidth: 800, scale: 375 / 800 });
    expect(
      previewFrameOf({
        desktopHeight: 1000,
        mobileContentWidth: 624,
        mainContainer: { x: 88, y: 0, w: 624, h: 900 },
      })?.phoneWidth,
    ).toBe(624);
    expect(
      previewFrameOf({
        desktopHeight: 1000,
        mobileContentWidth: 375,
        mainContainer: { x: 100, y: 0, w: 600, h: 900 },
      })?.phoneWidth,
    ).toBeUndefined();
  });
  it("every card keeps the same box, and the email's own document always fills it (no empty block under a short email)", () => {
    const box = { w: 324, h: 324 }; // scale 0.5 for a 648 crop: the box holds 648 render px
    const crop = (contentBottom: number | null) => ({
      renderWidth: 800,
      cropX: 76,
      cropWidth: 648,
      contentBottom,
    });
    for (const contentBottom of [100, 474, 2000, null]) {
      const l = cardLayout(crop(contentBottom), box.w, box.h);
      // The frame covers the box (box height ÷ scale, in render px) plus the hover drift.
      expect(l.frameHeight * l.scale).toBeGreaterThanOrEqual(box.h + l.drift);
      expect(l.frameHeight).toBeGreaterThanOrEqual(Math.ceil(box.h / l.scale));
    }
    // A short (or unknown-length) email never drifts; a long one drifts at most one more box.
    expect(cardLayout(crop(100), box.w, box.h).drift).toBe(0);
    expect(cardLayout(crop(null), box.w, box.h).drift).toBe(0);
    expect(cardLayout(crop(2000), box.w, box.h).drift).toBe(box.h);
    // The same on a phone's wide 5:4 box.
    const phone = cardLayout(crop(100), 358, 286);
    expect(phone.frameHeight * phone.scale).toBeGreaterThanOrEqual(286);
  });
});

describe("detail view: the full-length frame (click to open)", () => {
  it("content + 2 px, shown at the frame's scale; unknown → null", () => {
    expect(fullFrame(1600, 0.5)).toEqual({ frameHeight: 1602, shownHeight: 801 });
    expect(fullFrame(900.4, 1)).toEqual({ frameHeight: 903, shownHeight: 903 });
    for (const bad of [null, undefined, 0, -5, Number.NaN]) expect(fullFrame(bad, 1)).toBeNull();
    expect(fullFrame(100, 0)).toBeNull();
  });

  it("a short email's full-length frame holds its whole document, trailing invisible space included (no nested scrollbar)", () => {
    // Measured in Chrome at the 800 × 1000 desktop pass: `content` per the render contract, and the
    // document's real height. The frame is interactive, so were it shorter than the document it
    // would scroll — and a classic scrollbar narrows the layout to 785 px and reflows the email.
    const cases = [
      // Grey page, 100% wrapper td with padding 40px 16px, a white 600 px card and a footer line.
      { content: { left: 100, right: 700, bottom: 242 }, documentHeight: 282 },
      // A plain note: default body margins and a trailing 40 px spacer row.
      { content: { left: 103, right: 666, bottom: 28 }, documentHeight: 83 },
    ];
    for (const { content, documentHeight } of cases) {
      const frame = previewFrameOf({
        desktopHeight: 1000,
        mobileHeight: 900,
        mobileContentWidth: 375,
        mainContainer: null,
        content,
        desktopContentWidth: 800,
      })!;
      const full = fullFrame(frame.contentBottom, 1)!;
      expect(full.frameHeight, JSON.stringify(content)).toBeGreaterThanOrEqual(documentHeight);
      // …and never taller than the page the render reported.
      expect(frame.contentBottom).toBeLessThanOrEqual(1000);
    }
  });
});

describe("phone content height", () => {
  const layout = (mobileHeight: unknown) => ({
    desktopHeight: 1000,
    mobileHeight,
    mobileContentWidth: 624,
    mainContainer: { x: 88, y: 0, w: 624, h: 900 },
  });
  it("reads mobileHeight as phoneBottom (rounded), and passes it through a built frame", () => {
    expect(previewFrameOf(layout(2400.6))?.phoneBottom).toBe(2401);
    expect(previewFrameOf({ x: 80, width: 640, contentBottom: 827, phoneBottom: 1900 })).toEqual({
      x: 80,
      width: 640,
      contentBottom: 827,
      phoneBottom: 1900,
    });
    // Scaled phone layouts: the page shows it at the fit scale.
    const f = previewFrameOf(layout(2400))!;
    const fit = phoneFit(f);
    expect(fullFrame(f.phoneBottom, fit.scale)!.shownHeight).toBe(Math.ceil(2402 * (375 / 624)));
  });
  it("drops nonsense (missing, zero, negative, not a number, over the renderer's cap) but keeps the frame", () => {
    for (const bad of [
      undefined,
      null,
      0,
      -10,
      0.5,
      "2000",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_000_001,
    ]) {
      const f = previewFrameOf(layout(bad));
      expect(f).not.toBeNull();
      expect(f?.phoneBottom).toBeUndefined();
    }
    expect(
      previewFrameOf({ x: 80, width: 640, contentBottom: 827, phoneBottom: -1 })?.phoneBottom,
    ).toBeUndefined();
  });
});

describe("back link", () => {
  it("accepts the gallery (with filters) and other list pages, nothing else", () => {
    expect(backLinkOf("/gallery?design=good&category=promotions")).toEqual({
      href: "/gallery?design=good&category=promotions",
      label: "All designs",
    });
    expect(backLinkOf("/inbox")).toEqual({ href: "/inbox", label: "Inbox" });
    expect(backLinkOf(["/senders/abc", "/x"])).toEqual({ href: "/senders/abc", label: "Senders" });
    for (const bad of [
      undefined,
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/gallery/../api",
      "/gallery\\x",
      "/%2f%2fevil",
      "/settings",
      "/gallery?x=//evil",
      "/galleryx",
      "javascript:alert(1)",
    ])
      expect(backLinkOf(bad as string)).toEqual(DEFAULT_BACK);
  });
});

describe("preview URL store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches first asks, and after a failed batch retries each card on its own with backoff", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    let fail = true;
    const store = new PreviewUrlStore(async (ids) => {
      calls.push(ids);
      if (fail) throw new Error("boom");
      return Object.fromEntries(
        ids.filter((id) => id !== "c").map((id) => [id, `https://view.test/v/t/${id}`]),
      );
    });
    store.request("a");
    store.request("b");
    store.request("c");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([["a", "b", "c"]]);
    const a1 = store.get("a");
    expect(a1).toMatchObject({ state: "error", attempts: 1 });
    // Too early: nothing goes out.
    store.request("a");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    // After the backoff, each failed card goes out by itself.
    fail = false;
    await vi.advanceTimersByTimeAsync(1_500);
    for (const id of ["a", "b", "c"]) store.request(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.slice(1).sort()).toEqual([["a"], ["b"], ["c"]]);
    expect(store.get("a")).toMatchObject({ state: "ready", url: "https://view.test/v/t/a" });
    expect(store.get("c")).toMatchObject({ state: "none" });
    expect(store.origin).toBe("https://view.test");
  });

  it("gives up on a card after its last attempt, until the detail view asks to try again", async () => {
    vi.useFakeTimers();
    let n = 0;
    const store = new PreviewUrlStore(async () => {
      n++;
      throw new Error("down");
    });
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      store.request("x");
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(n).toBe(MAX_ATTEMPTS);
    expect(gaveUp(store.get("x"))).toBe(true);
    store.retry("x");
    await vi.advanceTimersByTimeAsync(100);
    expect(n).toBe(MAX_ATTEMPTS + 1);
  });
});

describe("server-minted preview URLs", () => {
  it("seeds fresh URLs, ignores stale ones, and never trusts a server clock that is ahead", () => {
    const store = new PreviewUrlStore(async () => ({}));
    const now = 1_000_000_000;
    expect(store.seed({ a: "https://view.test/v/t/a" }, now - 10_000, now)).toBe(true);
    expect(store.get("a")).toMatchObject({ state: "ready", at: now - 10_000 });
    expect(store.origin).toBe("https://view.test");
    // Minted too long ago (e.g. a page restored from the router cache): not used.
    expect(store.seed({ b: "https://view.test/v/t/b" }, now - 300_000, now)).toBe(false);
    expect(store.get("b")).toBeUndefined();
    // A server clock ahead of ours: the URL's age counts from our "now", not the future.
    store.seed({ c: "https://view.test/v/t/c" }, now + 60_000, now);
    expect(store.get("c")).toMatchObject({ at: now });
  });
});

describe("load scheduler", () => {
  it("runs at most N loads at once, on-screen cards first, then in order", () => {
    const s = new LoadScheduler(2);
    const granted: string[] = [];
    s.enqueue("near1", 1, () => granted.push("near1"));
    s.enqueue("near2", 1, () => granted.push("near2"));
    s.enqueue("near3", 1, () => granted.push("near3"));
    s.enqueue("vis1", 0, () => granted.push("vis1"));
    expect(granted).toEqual(["near1", "near2"]);
    s.done("near1");
    expect(granted).toEqual(["near1", "near2", "vis1"]);
    const cancel = s.enqueue("vis2", 0, () => granted.push("vis2"));
    cancel();
    s.done("near2");
    expect(granted).toEqual(["near1", "near2", "vis1", "near3"]);
    expect(s.activeCount).toBe(2);
    s.done("nobody"); // unknown ids are ignored
    expect(s.activeCount).toBe(2);
  });
});

describe("site root", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const run = (cookie?: string) => {
    vi.stubEnv("VIEW_ORIGIN", "https://view.test");
    return proxy(new NextRequest("https://app.test/?utm=x", { headers: cookie ? { cookie } : {} }));
  };
  it("sends a signed-in visitor straight to the gallery", () => {
    for (const c of ["edf.session_token=t", "__Secure-edf.session_token=t"]) {
      const res = run(c);
      expect([307, 308]).toContain(res.status);
      expect(res.headers.get("location")).toBe("https://app.test/gallery");
    }
  });
  it("leaves the static landing page alone for everyone else (no redirect, no nonce CSP)", () => {
    const res = run();
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(run("session_token=1").headers.get("location")).toBeNull();
  });
});
