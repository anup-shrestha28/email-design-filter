/**
 * The Pinterest-style gallery's layout math (lib/gallery-preview.ts):
 *  - cardShape: the whole email at the card's width, clamped to 0.6–3× its width; longer ones are
 *    marked cut (the card fades them out); unknown lengths are square
 *  - masonryColumns: each card goes to the shortest column so far (leftmost on ties), so the first
 *    row reads in list order, every card is placed exactly once, and columns end up even
 */
import { describe, expect, it } from "vitest";
import {
  CARD_MAX_RATIO,
  CARD_MIN_RATIO,
  cardCrop,
  cardLayout,
  cardShape,
  masonryColumns,
} from "@/lib/gallery-preview";

describe("cardShape", () => {
  it("is the email's own height over the slice the card shows", () => {
    // 600 px of content + 2 × 24 px gutter = 648 px; 1500 + 2 px tall.
    const s = cardShape(cardCrop({ x: 100, width: 600, contentBottom: 1500 }));
    expect(s).toEqual({ ratio: 1502 / 648, capped: false, known: true });
  });

  it("cuts very long emails at 3× and keeps short ones from becoming strips", () => {
    expect(cardShape(cardCrop({ x: 0, width: 600, contentBottom: 9000 }))).toEqual({
      ratio: CARD_MAX_RATIO,
      capped: true,
      known: true,
    });
    expect(cardShape(cardCrop({ x: 0, width: 600, contentBottom: 120 }))).toEqual({
      ratio: CARD_MIN_RATIO,
      capped: false,
      known: true,
    });
    // Exactly 3×: whole, not cut.
    const exact = cardShape(cardCrop({ x: 0, width: 600, contentBottom: 648 * 3 - 2 }));
    expect(exact.capped).toBe(false);
    expect(exact.ratio).toBeCloseTo(3, 10);
  });

  it("is a square while the length is unknown", () => {
    expect(cardShape(cardCrop(null))).toEqual({ ratio: 1, capped: false, known: false });
    // Measured nothing below the top (no content found): unknown too.
    expect(cardShape(cardCrop({ x: 0, width: 600, contentBottom: 0 }))).toEqual({
      ratio: 1,
      capped: false,
      known: false,
    });
  });

  it("a whole email's frame covers its box with no hover drift", () => {
    const crop = cardCrop({ x: 100, width: 600, contentBottom: 1500 });
    const width = 320;
    const height = Math.round(width * cardShape(crop).ratio);
    const layout = cardLayout(crop, width, height);
    expect(layout.drift).toBe(0);
    expect(layout.frameHeight * layout.scale).toBeGreaterThanOrEqual(height);
  });
});

describe("masonryColumns", () => {
  it("puts each card in the shortest column, leftmost on ties", () => {
    // Heights at width 100 with no fixed part: 300, 100, 100, 100, 100. After three short cards
    // the right column is as tall as the left (300 each): the fifth goes left.
    expect(masonryColumns([3, 1, 1, 1, 1], 2, 100, 0)).toEqual([
      [0, 4],
      [1, 2, 3],
    ]);
    // The first row reads in list order.
    expect(masonryColumns([1, 2, 1.5, 1, 1, 1], 3, 100, 0).map((c) => c[0])).toEqual([0, 1, 2]);
  });

  it("places every card exactly once and keeps columns even", () => {
    const ratios = Array.from({ length: 60 }, (_, i) => 0.6 + ((i * 37) % 25) / 10);
    for (const cols of [1, 2, 3, 4, 5]) {
      const out = masonryColumns(ratios, cols, 300, 140);
      expect(out).toHaveLength(cols);
      expect(out.flat().sort((a, b) => a - b)).toEqual(ratios.map((_, i) => i));
      // Within a column, the list's order is kept.
      for (const c of out) expect([...c].sort((a, b) => a - b)).toEqual(c);
      const heights = out.map((c) => c.reduce((h, i) => h + ratios[i]! * 300 + 140, 0));
      // No column ends more than one tallest card (3 × 300 + 140) below another.
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(3 * 300 + 140);
    }
  });

  it("treats a bad ratio as a square and survives odd column counts", () => {
    expect(masonryColumns([Number.NaN, 1], 2, 100, 0)).toEqual([[0], [1]]);
    expect(masonryColumns([1, 1], 0, 100, 0)).toEqual([[0, 1]]);
    expect(masonryColumns([], 3, 100, 0)).toEqual([[], [], []]);
  });
});
