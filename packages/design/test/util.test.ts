import { describe, expect, it } from "vitest";
import { ByteOffsetMapper, utf8Length } from "../src/util/bytes";
import {
  colorDeltaE2000,
  contrastRatio,
  deltaE2000,
  isLargeText,
  luminance,
  parseColor,
} from "../src/util/color";
import {
  band,
  clamp,
  ramp,
  roundPreservingSum,
  roundWithinCaps,
  share,
  weightedMedian,
} from "../src/util/math";
import { countMergeTags, hasMergeTag, looksLikePostalAddress } from "../src/util/patterns";
import {
  capsChars,
  countedChars,
  displayWidth,
  fleschReadingEase,
  normalizeLabel,
  proseStats,
  scriptProfile,
  words,
} from "../src/util/text";

describe("scoring primitives (DESIGN-SCORE §2.2)", () => {
  it("ramp increases, decreases and clamps", () => {
    expect(ramp(0.7, 0.7, 0.98)).toBe(0);
    expect(ramp(0.98, 0.7, 0.98)).toBe(1);
    expect(ramp(0.84, 0.7, 0.98)).toBeCloseTo(0.5, 10);
    expect(ramp(3 * 1024 * 1024, 3 * 1024 * 1024, 1024 * 1024)).toBe(0);
    expect(ramp(2 * 1024 * 1024, 3 * 1024 * 1024, 1024 * 1024)).toBeCloseTo(0.5, 10);
    expect(ramp(-5, 0, 1)).toBe(0);
    expect(ramp(Number.NaN, 0, 1)).toBe(0);
  });
  it("band has no cliffs", () => {
    expect(band(25, 25, 45, 80, 110)).toBe(0);
    expect(band(35, 25, 45, 80, 110)).toBeCloseTo(0.5, 10);
    expect(band(60, 25, 45, 80, 110)).toBe(1);
    expect(band(95, 25, 45, 80, 110)).toBeCloseTo(0.5, 10);
    expect(band(110, 25, 45, 80, 110)).toBe(0);
  });
  it("share is N/A for no items", () => {
    expect(share(0, 0)).toBeNull();
    expect(share(4, 1)).toBe(0.25);
    expect(clamp(2, 0, 1)).toBe(1);
  });
  it("weighted median is character-weighted", () => {
    expect(
      weightedMedian([
        [12, 10],
        [16, 100],
        [30, 5],
      ]),
    ).toBe(16);
    expect(
      weightedMedian([
        [12, 60],
        [16, 40],
      ]),
    ).toBe(12);
    expect(weightedMedian([])).toBeNull();
  });
  it("rounding preserves the total and stays within caps", () => {
    const vals = [16.94, 13.43, 13.14, 12.42, 8.83, 7.61, 3.93, 4.62, 0.44];
    const r = roundPreservingSum(vals, 1);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(
      Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10,
      9,
    );
    const caps = [7.44, 5];
    const pts = [7.4449, 4];
    const within = roundWithinCaps(pts, roundPreservingSum(caps, 1), 1);
    expect(within[0]).toBeLessThanOrEqual(7.4);
  });
});

describe("colour (WCAG 2.2)", () => {
  it("parses computed colours", () => {
    expect(parseColor("rgba(0, 0, 0, 0)")?.a).toBe(0);
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("oklch(0.5 0.1 200)")).not.toBeNull();
    expect(parseColor("not a colour")).toBeNull();
  });
  it("computes luminance with the 0.04045 threshold and never rounds ratios", () => {
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 10);
    const grey = contrastRatio(
      { r: 0x76, g: 0x76, b: 0x76, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    );
    expect(grey).toBeGreaterThan(4.5);
    expect(grey).toBeCloseTo(4.54, 2);
    const justBelow = contrastRatio(
      { r: 0x77, g: 0x77, b: 0x77, a: 1 },
      { r: 255, g: 255, b: 255, a: 1 },
    );
    expect(justBelow).toBeLessThan(4.5);
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(
      21,
      10,
    );
  });
  it("composites translucent text before measuring", () => {
    const half = contrastRatio({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(half).toBeLessThan(5);
    expect(half).toBeGreaterThan(3);
  });
  it("large text is ≥ 24px or ≥ 18.66px bold", () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.66, 600)).toBe(false);
    expect(isLargeText(18.5, 700)).toBe(false);
  });
  it("matches the Sharma et al. CIEDE2000 reference pairs", () => {
    expect(deltaE2000({ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 })).toBeCloseTo(
      2.0425,
      4,
    );
    expect(deltaE2000({ L: 50, a: 2.5, b: 0 }, { L: 73, a: 25, b: -18 })).toBeCloseTo(27.1492, 4);
    expect(
      deltaE2000({ L: 22.7233, a: 20.0904, b: -46.694 }, { L: 23.0331, a: 14.973, b: -42.5619 }),
    ).toBeCloseTo(2.0373, 4);
    expect(
      colorDeltaE2000({ r: 255, g: 255, b: 255, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }),
    ).toBe(0);
  });
});

describe("text", () => {
  it("counts characters: whitespace/fillers/emoji skipped, CJK ×2", () => {
    expect(countedChars("Hello world")).toBe(10);
    expect(countedChars("Hi\u{00A0}\u{034F}\u{200C}there")).toBe(7);
    expect(countedChars("漢字")).toBe(4);
    expect(countedChars("Sale 🎉")).toBe(4);
  });
  it("measures display width with full-width characters as 2", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("セール")).toBe(6);
  });
  it("segments words with Intl.Segmenter", () => {
    expect(words("Shop the sale now!", "en")).toEqual(["Shop", "the", "sale", "now"]);
    expect(normalizeLabel("  Shop NOW! 🎉 ")).toBe("shop now");
  });
  it("detects caps, scripts and readability", () => {
    expect(capsChars("FREE SHIPPING on all orders", "en").caps).toBe(12);
    expect(scriptProfile("مرحبا بالعالم").rtl).toBe(true);
    expect(scriptProfile("这是一个测试").kind).toBe("cjk");
    const fre = fleschReadingEase(
      proseStats("The cat sat on the mat. It was a sunny day. We went out to play."),
    );
    expect(fre).toBeGreaterThan(90);
  });
});

describe("bytes (X1)", () => {
  it("matches Buffer.byteLength and maps code-unit offsets to UTF-8 bytes", () => {
    const s = `${"a".repeat(600)}é漢😀${"b".repeat(1000)}`;
    expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
    const m = new ByteOffsetMapper(s);
    const idx = s.indexOf("b");
    expect(m.toBytes(idx)).toBe(Buffer.byteLength(s.slice(0, idx), "utf8"));
    expect(m.toBytes(s.length)).toBe(m.total);
  });
});

describe("patterns", () => {
  it("merge-tag patterns (DESIGN-SCORE §5.8)", () => {
    for (const t of [
      "*|FNAME|*",
      "{{ first_name }}",
      "%%FirstName%%",
      "[FirstName]",
      "[EMAIL]",
      "{$name}",
      "%recipient.first%",
    ]) {
      expect(hasMergeTag(`Hi ${t},`)).toBe(true);
    }
    expect(hasMergeTag("*|fname|*")).toBe(false);
    expect(hasMergeTag("Price [USD] and {braces}")).toBe(false);
    expect(countMergeTags("*|A|* and *|B|*")).toBe(2);
  });
  it("postal addresses", () => {
    expect(
      looksLikePostalAddress("Tidewell Inc., 410 Harbor Street, Suite 12, Portland, OR 97209, USA"),
    ).toBe(true);
    expect(looksLikePostalAddress("Brickline Supply, 22 Mill Road, Leeds LS1 4AP, UK")).toBe(true);
    expect(looksLikePostalAddress("Free shipping on orders over $75")).toBe(false);
  });
});
