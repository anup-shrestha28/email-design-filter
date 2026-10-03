/**
 * ScoreSummary.layout: the render's size and visible content extent, kept after compaction so the
 * gallery can show every email full length and crop its card to the design (its viewer iframe is
 * script-free and can't measure the email itself).
 */
import { describe, expect, it } from "vitest";
import { renderFeaturesSchema, scoreEmail, summarizeScore, summaryLayout } from "../src/index";
import { baseCtx, baseFeatures } from "./helpers/factory";

describe("summary layout", () => {
  const f = baseFeatures();
  const render = f.render!;
  const result = scoreEmail(f, baseCtx());

  it("copies the render's heights, widths and main container (and nothing else)", () => {
    const l = summaryLayout(render);
    expect(l).toEqual({
      desktopHeight: render.layout.desktopHeight,
      mobileHeight: render.layout.mobileHeight,
      mobileContentWidth: render.layout.mobileContentWidth,
      desktopContentWidth: render.layout.desktopContentWidth,
      mainContainer: render.layout.mainContainer
        ? {
            x: render.layout.mainContainer.x,
            y: render.layout.mainContainer.y,
            w: render.layout.mainContainer.w,
            h: render.layout.mainContainer.h,
          }
        : null,
    });
  });

  it("copies the visible content extent: an extent, null (nothing visible), or absent (older render)", () => {
    const content = { left: 100, right: 700, bottom: 1318 };
    const measured = summaryLayout({ ...render, layout: { ...render.layout, content } });
    expect(measured.content).toEqual(content);
    expect(measured.content).not.toBe(content);
    const wide = summaryLayout({
      ...render,
      layout: {
        ...render.layout,
        desktopContentWidth: 886,
        content: { left: 0, right: 886, bottom: 900 },
      },
    });
    expect(wide.desktopContentWidth).toBe(886);
    expect(wide.content).toEqual({ left: 0, right: 886, bottom: 900 });
    const none = summaryLayout({ ...render, layout: { ...render.layout, content: null } });
    expect(none).toHaveProperty("content", null);
    const older = summaryLayout({ ...render, layout: { ...render.layout, content: undefined } });
    expect(older).not.toHaveProperty("content");
    expect("content" in render.layout).toBe(false);
    expect(summaryLayout(render)).not.toHaveProperty("content");
  });

  it("render features validate with or without the extent (older features still parse)", () => {
    expect("content" in render.layout).toBe(false);
    expect(renderFeaturesSchema.safeParse(render).success).toBe(true);
    for (const content of [null, { left: 8, right: 792, bottom: 2400.5 }]) {
      const r = renderFeaturesSchema.safeParse({
        ...render,
        layout: { ...render.layout, content },
      });
      expect(r.success, JSON.stringify(content)).toBe(true);
      expect(r.success && r.data.layout.content).toEqual(content);
    }
    for (const content of [
      { left: -1, right: 700, bottom: 10 },
      { left: 0, right: 700 },
      { left: 0, right: "700", bottom: 10 },
      { left: 0, right: 2_000_000, bottom: 10 },
    ]) {
      const r = renderFeaturesSchema.safeParse({
        ...render,
        layout: { ...render.layout, content },
      });
      expect(r.success, JSON.stringify(content)).toBe(false);
    }
  });

  it("keeps a missing main container as null", () => {
    const l = summaryLayout({ ...render, layout: { ...render.layout, mainContainer: null } });
    expect(l.mainContainer).toBeNull();
  });

  it("is in the summary with a render, and absent without one", () => {
    expect(summarizeScore(result, null, render).layout).toEqual(summaryLayout(render));
    const content = { left: 100, right: 700, bottom: 900 };
    const measured = { ...render, layout: { ...render.layout, content } };
    expect(summarizeScore(result, null, measured).layout?.content).toEqual(content);
    expect(summarizeScore(result, null)).not.toHaveProperty("layout");
    expect(summarizeScore(result, null, null)).not.toHaveProperty("layout");
  });
});
