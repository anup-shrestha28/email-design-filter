/**
 * The live gallery's rules (src/lib/gallery-live.ts): what a change means for the page on screen
 * and when it may show without asking — never reshuffling the grid under the viewer:
 *  - new designs in the view → "N new designs · Show"; applied by itself only on page 1 of Newest,
 *    at the top, nothing open, the pointer and focus off the grid;
 *  - cards that may move (the view's size changed; a new score in a view sorted or filtered by
 *    score, verdict, problems or fonts; a new email type in a category view) → "Designs updated";
 *  - only badges and words change → in place at once (the open design and scroll stay), unless
 *    two cards could merge or split and the pointer is on the grid: then once it leaves.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_GALLERY_PARAMS, type GalleryParams } from "@/lib/gallery";
import {
  applyMode,
  classifyChange,
  pillText,
  regroupRisk,
  sameStamp,
  scoreStableView,
  type GalleryStamp,
  type ViewerState,
} from "@/lib/gallery-live";

const stamp = (over: Partial<GalleryStamp> = {}): GalleryStamp => ({
  total: 100,
  newest: "2026-09-30 14:00:00.983353+00",
  scored: 90,
  typing: 2,
  analyzedAt: "2026-09-30 14:10:00.1+00",
  renderAt: "2026-09-30 14:09:00+00",
  ...over,
});
const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
  ...DEFAULT_GALLERY_PARAMS,
  ...over,
});
const base = { stamp: stamp(), total: 100 };

describe("classifyChange", () => {
  it("nothing changed → nothing to do", () => {
    expect(sameStamp(stamp(), stamp())).toBe(true);
    expect(
      classifyChange(
        base,
        { stamp: stamp(), view: { total: 100, added: 0, rescored: 0 } },
        params(),
      ),
    ).toBeNull();
    for (const k of ["total", "newest", "scored", "typing", "analyzedAt", "renderAt"] as const) {
      const other = stamp({
        [k]: k === "total" || k === "scored" || k === "typing" ? 1 : "2026-10-01 00:00:00+00",
      });
      expect(sameStamp(stamp(), other)).toBe(false);
    }
  });

  it("new designs in the view → 'new', with the view's own count", () => {
    const now = stamp({ total: 103, newest: "2026-09-30 14:20:00+00" });
    expect(
      classifyChange(base, { stamp: now, view: { total: 103, added: 3, rescored: 0 } }, params()),
    ).toEqual({ kind: "new", added: 3 });
  });

  it("new mail outside the view (other category) changes only the counts → in place", () => {
    const now = stamp({
      total: 101,
      newest: "2026-09-30 14:20:00+00",
      analyzedAt: "2026-09-30 14:20:00+00",
    });
    expect(
      classifyChange(
        { stamp: stamp(), total: 40 },
        { stamp: now, view: { total: 40, added: 0, rescored: 0 } },
        params({ category: "product_updates" }),
      ),
    ).toEqual({ kind: "inplace" });
  });

  it("a design left or joined the view → 'moved'", () => {
    const now = stamp({ total: 99 });
    expect(
      classifyChange(base, { stamp: now, view: { total: 99, added: 0, rescored: 0 } }, params()),
    ).toEqual({ kind: "moved" });
    expect(
      classifyChange(base, { stamp: now, view: { total: 101, added: 0, rescored: 0 } }, params()),
    ).toEqual({ kind: "moved" });
  });

  it("new scores: in place on Newest without score filters; 'moved' where a score can move a card", () => {
    const now = stamp({ scored: 91, analyzedAt: "2026-09-30 14:30:00+00" });
    const view = { total: 100, added: 0, rescored: 1 };
    expect(classifyChange(base, { stamp: now, view }, params())).toEqual({ kind: "inplace" });
    expect(
      classifyChange(base, { stamp: now, view }, params({ q: "sale", category: "promotions" })),
    ).toEqual({ kind: "inplace" });
    for (const p of [
      params({ sort: "best" }),
      params({ sort: "worst" }),
      params({ design: "good" }),
      params({ design: "bad" }),
      params({ smin: 50 }),
      params({ smax: 90 }),
      params({ problem: ["contrast"] }),
      params({ font: "Inter" }),
      params({ webfonts: "yes" }),
    ]) {
      expect(scoreStableView(p)).toBe(false);
      expect(classifyChange(base, { stamp: now, view }, p)).toEqual({ kind: "moved" });
    }
    // A re-analysis of designs outside the view (rescored 0) never moves this view's cards.
    expect(
      classifyChange(
        base,
        { stamp: now, view: { ...view, rescored: 0 } },
        params({ sort: "best" }),
      ),
    ).toEqual({ kind: "inplace" });
  });

  it("an email type decided (AI) can move cards between categories: 'moved' only in a category view", () => {
    const now = stamp({ typing: 1 });
    const view = { total: 100, added: 0, rescored: 0 };
    expect(classifyChange(base, { stamp: now, view }, params())).toEqual({ kind: "inplace" });
    expect(classifyChange(base, { stamp: now, view }, params({ category: "promotions" }))).toEqual({
      kind: "moved",
    });
  });

  it("a render starting (the 'when it's scored' words) → in place", () => {
    expect(
      classifyChange(
        base,
        {
          stamp: stamp({ renderAt: "2026-09-30 14:31:00+00" }),
          view: { total: 100, added: 0, rescored: 0 },
        },
        params(),
      ),
    ).toEqual({ kind: "inplace" });
  });
});

describe("applyMode", () => {
  const calm: ViewerState = {
    page: 1,
    sort: "newest",
    atTop: true,
    open: false,
    onGrid: false,
    regroup: false,
  };

  it("new designs apply by themselves only on page 1 of Newest, at the top, nothing open, off the grid", () => {
    const change = { kind: "new", added: 2 } as const;
    expect(applyMode(change, calm)).toBe("apply");
    expect(applyMode(change, { ...calm, page: 2 })).toBe("pill");
    expect(applyMode(change, { ...calm, sort: "best" })).toBe("pill");
    expect(applyMode(change, { ...calm, atTop: false })).toBe("pill");
    expect(applyMode(change, { ...calm, open: true })).toBe("pill");
    expect(applyMode(change, { ...calm, onGrid: true })).toBe("pill");
  });

  it("moving cards apply by themselves at the top (any page or sort), else the pill", () => {
    const change = { kind: "moved" } as const;
    expect(applyMode(change, { ...calm, page: 3, sort: "best" })).toBe("apply");
    expect(applyMode(change, { ...calm, atTop: false })).toBe("pill");
    expect(applyMode(change, { ...calm, open: true })).toBe("pill");
    expect(applyMode(change, { ...calm, onGrid: true })).toBe("pill");
  });

  it("in-place changes apply at once — open design and scroll kept — unless cards could regroup under the pointer", () => {
    const change = { kind: "inplace" } as const;
    expect(applyMode(change, { ...calm, open: true, atTop: false, onGrid: true })).toBe("apply");
    expect(applyMode(change, { ...calm, regroup: true, onGrid: true })).toBe("defer");
    expect(applyMode(change, { ...calm, regroup: true, onGrid: false, open: true })).toBe("apply");
  });
});

describe("regroupRisk and the pill's words", () => {
  const card = (
    id: string,
    domain: string,
    subject: string | null,
    verdict: "good" | "unscored" = "unscored",
  ) => ({
    id,
    sender: { name: domain, domain },
    subject,
    verdict,
  });

  it("only when two cards share sender and subject (whatever their verdicts)", () => {
    expect(
      regroupRisk([
        card("1", "a.com", "Sale"),
        card("2", "b.com", "Sale"),
        card("3", "a.com", "Hello"),
      ]),
    ).toBe(false);
    expect(
      regroupRisk([card("1", "a.com", "Sale!", "good"), card("2", "A.com", "sale", "unscored")]),
    ).toBe(true);
    // No subject: never grouped, so no risk.
    expect(regroupRisk([card("1", "a.com", null), card("2", "a.com", "  ")])).toBe(false);
  });

  it("plain, short words", () => {
    expect(pillText({ kind: "new", added: 1 })).toBe("1 new design");
    expect(pillText({ kind: "new", added: 1250 })).toBe("1,250 new designs");
    expect(pillText({ kind: "moved" })).toBe("Designs updated");
  });
});
