/**
 * Regression tests for the verdict policy (DECISIONS.md "Verdict policy", t-2026.2 / conf-2026.3):
 * caps fire only for severe, visible problems; explanations name the root cause once, in words a
 * reader can check; strengths lead with what is distinctive.
 */
import { describe, expect, it } from "vitest";
import {
  excellenceGate,
  scoreEmail,
  scoreEmailDetailed,
  summarizeScore,
  type ContrastGroup,
  type ScoreResult,
} from "../src/index";
import { tallyLoads } from "../src/scoring/checks/images";
import { describeColour } from "../src/util/color";
import { weightedQuantile } from "../src/util/math";
import { firstMergeTag } from "../src/util/patterns";
import { baseCtx, baseFeatures } from "./helpers/factory";

type Over = Parameters<typeof baseFeatures>[0];

function group(over: Partial<ContrastGroup>): ContrastGroup {
  return {
    fg: "#374151",
    bg: "#ffffff",
    ratio: 10.31,
    p90: null,
    method: "color",
    large: false,
    role: "body",
    rendered: true,
    short: false,
    chars: 100,
    ...over,
  };
}

function score(over?: Over, ctx?: Parameters<typeof baseCtx>[0]): ScoreResult {
  return scoreEmail(baseFeatures(over), baseCtx(ctx));
}

function reconciles(over: Over): void {
  const d = scoreEmailDetailed(baseFeatures(over), baseCtx());
  const limit = d.capHits.length > 0 ? Math.min(...d.capHits.map((c) => c.limit)) : Infinity;
  const total = d.all.reduce((s, i) => s + i.points, 0);
  expect(total).toBeCloseTo(100 - Math.min(d.rawExact!, limit, d.ceiling ?? Infinity), 9);
}

describe("CAP_CONTRAST judges the main content, not the footer or fine print", () => {
  const grey = { fg: "#888888", bg: "#ffffff", ratio: 3.54 };
  it("a grey legal footer never caps (Friendlane / Metricly regression)", () => {
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ fg: "#222222", ratio: 15.91, chars: 80 }),
            group({ ...grey, role: "footer", chars: 400 }),
          ],
        },
      },
    });
    expect(r.caps).not.toContain("CAP_CONTRAST");
  });
  it("grey fine print outside the footer is an A1 deduction, not the cap", () => {
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ fg: "#222222", ratio: 15.91, chars: 120 }),
            group({ ...grey, chars: 110, fine: true }),
          ],
        },
      },
    });
    expect(r.caps).not.toContain("CAP_CONTRAST");
    const a1 = r.checks.find((c) => c.id === "A1")!;
    expect(a1.status).not.toBe("pass");
    const item = r.needsImprovement.find((i) => i.checkIds.includes("A1"));
    expect(item?.title).toBe("The small print is hard to read: grey on white (3.54:1)");
  });
  it("faint body copy still caps, with the colours named in plain words", () => {
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ fg: "#bbbbbb", ratio: 1.9, chars: 1500 }),
            group({ role: "footer", chars: 200 }),
          ],
        },
      },
    });
    expect(r.caps).toContain("CAP_CONTRAST");
    expect(r.needsImprovement[0]!.key).toBe("cap:CAP_CONTRAST");
    expect(r.needsImprovement[0]!.title).toBe(
      "Body text is light grey on white (1.90:1): too faint to read",
    );
    expect(r.needsImprovement[0]!.measured).toContain("#bbbbbb on #ffffff");
  });
  it("a faint headline counts as main content", () => {
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ chars: 100 }),
            group({ fg: "#c4c4c4", ratio: 1.74, role: "heading", large: true, chars: 200 }),
          ],
        },
      },
    });
    expect(r.caps).toContain("CAP_CONTRAST");
    expect(r.needsImprovement[0]!.title).toMatch(
      /^67% of the main text is light grey on white \(1\.74:1\): too faint$/,
    );
  });
});

describe("broken images: only definitive failures are the designer's fault", () => {
  const ctx = baseCtx();
  it("timeouts, network/DNS errors, blocks, our size limit, 403/429/5xx are not evaluated", () => {
    const t = tallyLoads(
      [
        { status: "timeout", decoded: false },
        { status: "error", decoded: false },
        { status: "blocked", decoded: false },
        { status: "too_large", decoded: false },
        { status: "missing", decoded: false },
        { status: 403, decoded: false },
        { status: 429, decoded: false },
        { status: 500, decoded: false },
        { status: 503, decoded: false },
        { status: 301, decoded: false },
      ],
      ctx,
    );
    expect(t).toEqual({
      evaluated: 0,
      ok: 0,
      broken: 0,
      missing: 0,
      notImage: 0,
      failed: 0,
      svg: 0,
      brokenArea: null,
    });
    const r = score({
      render: {
        images: {
          loads: [
            { status: 503, decoded: false },
            { status: "timeout", decoded: false },
            { status: 403, decoded: false },
          ],
        },
      },
    });
    expect(r.caps).not.toContain("CAP_BROKEN_IMAGES");
    expect(r.checks.find((c) => c.id === "I3")?.status).toBe("not_evaluated");
  });
  it("404/410 and a 2xx non-image are broken", () => {
    const t = tallyLoads(
      [
        { status: 404, decoded: false },
        { status: 410, decoded: false },
        { status: 200, decoded: false },
        { status: 200, decoded: true },
      ],
      ctx,
    );
    expect(t).toMatchObject({ evaluated: 4, ok: 1, broken: 3, missing: 2, notImage: 1 });
  });
  it("one missing logo (1 of 1) is an I3 deduction, not a cap (Brightleaf regression)", () => {
    const r = score({
      render: { images: { content: 1, loads: [{ status: 404, decoded: false }] } },
    });
    expect(r.caps).not.toContain("CAP_BROKEN_IMAGES");
    const i3 = r.checks.find((c) => c.id === "I3")!;
    expect(i3.status).toBe("fail");
    expect(r.needsImprovement.find((i) => i.key === "check:I3")?.title).toBe(
      "1 of 1 images are missing: the sender's server says they don't exist",
    );
  });
  it("most images definitively missing (≥ 2) still caps", () => {
    const r = score({
      render: {
        images: {
          loads: [
            { status: 404, decoded: false },
            { status: 404, decoded: false },
            { status: 200, decoded: true },
          ],
        },
      },
    });
    expect(r.caps).toContain("CAP_BROKEN_IMAGES");
    expect(r.needsImprovement[0]!.title).toBe(
      "2 of 3 images are missing: the sender's server says they don't exist",
    );
  });
});

describe("CAP_MOBILE_BROKEN only for a genuinely broken phone layout", () => {
  const fixed = (width: number, bodyPx: number, extra: Over = {}): Over => ({
    ...extra,
    render: {
      layout: { k: 375 / width, mobileContentWidth: width, kNomq: 375 / width },
      text: { body: { mobile: bodyPx, desktop: bodyPx } },
      ...(extra?.render ?? {}),
    },
  });
  it("a readable non-responsive 600px email is not capped: one fixed-width deduction", () => {
    for (const [w, px] of [
      [600, 16],
      [600, 14],
      [624, 15],
      [640, 16],
    ] as const) {
      const r = score(fixed(w, px));
      expect(r.caps, `${w}px @ ${px}px`).not.toContain("CAP_MOBILE_BROKEN");
      expect(r.capped).toBe(false);
      const items = r.needsImprovement.filter((i) => i.checkIds.includes("M1"));
      expect(items).toHaveLength(1);
      expect(items[0]!.key).toBe("group:fixed-width");
      expect(items[0]!.title).toMatch(new RegExp(`^Not built for phones: the fixed ${w}px layout`));
    }
  });
  it("text below the phone legibility floor after scaling caps (700px @ 14px → 7.5px)", () => {
    const r = score(fixed(700, 14));
    expect(r.caps).toContain("CAP_MOBILE_BROKEN");
    expect(r.needsImprovement[0]!.title).toBe(
      "Unreadable on phones: the fixed 700px layout shrinks to 54%, body text ~7.5px",
    );
    reconciles(fixed(700, 14));
  });
  it("a layout more than twice the phone width caps (sideways scroll / under half size)", () => {
    const r = score(fixed(900, 22));
    expect(r.caps).toContain("CAP_MOBILE_BROKEN");
    expect(r.needsImprovement[0]!.title).toMatch(/^Too wide for phones: the 900px layout/);
  });
  it("a primary button shrunk below 16px caps; a small button on a fluid layout doesn't", () => {
    const tiny = {
      cta: {
        primary: {
          target: { x: 20, y: 400, w: 60, h: 20 },
          visual: { x: 20, y: 400, w: 60, h: 20 },
        },
      },
    };
    const shrunk = score({
      render: {
        layout: { k: 0.625, mobileContentWidth: 600, kNomq: 0.625 },
        ...tiny,
      },
    });
    expect(shrunk.caps).toContain("CAP_MOBILE_BROKEN");
    expect(shrunk.needsImprovement[0]!.title).toMatch(
      /^Unusable on phones: the 600px layout shrinks the main button to ~13px$/,
    );
    const fluid = score({ render: tiny });
    expect(fluid.caps).not.toContain("CAP_MOBILE_BROKEN");
  });
});

describe("root cause first: symptoms of the fixed-width shrink are one problem", () => {
  it("a full-size button and a normal unsubscribe link shrunk by the layout fold into the group", () => {
    const over: Over = {
      render: {
        layout: { k: 0.625, mobileContentWidth: 600, kNomq: 0.625 },
        text: { body: { mobile: 16 } },
        cta: {
          primary: {
            // The <a> is only the label line; the painted button cell is 46px tall.
            target: { x: 20, y: 400, w: 180, h: 18 },
            visual: { x: 20, y: 400, w: 200, h: 46 },
          },
        },
        footer: { unsubscribe: { px: 12, contrast: 7.5 } },
      },
    };
    const r = score(over);
    expect(r.caps).toEqual([]);
    const group = r.needsImprovement.find((i) => i.key === "group:fixed-width")!;
    expect(group.checkIds).toEqual(expect.arrayContaining(["M1", "M4", "U2"]));
    expect(r.needsImprovement.filter((i) => i.checkIds.includes("M4"))).toHaveLength(1);
    expect(r.needsImprovement.filter((i) => i.checkIds.includes("U2"))).toHaveLength(1);
    reconciles(over);
  });
  it("a button that is small at its own size stays its own problem", () => {
    const r = score({
      render: {
        layout: { k: 0.625, mobileContentWidth: 600, kNomq: 0.625 },
        cta: {
          primary: {
            target: { x: 20, y: 400, w: 120, h: 30 },
            visual: { x: 20, y: 400, w: 120, h: 30 },
          },
        },
      },
    });
    const m4 = r.needsImprovement.find((i) => i.key === "check:M4");
    expect(m4?.title).toBe("The main button “Shop rain shells” is only 19px tall on phones");
  });
  it("in an image-only email the missing button folds into the image-only cap", () => {
    const r = score(
      {
        static: { cta: { buttonLike: 0, labels: [], primaryLabel: null, primaryOffset: null } },
        render: {
          text: { chars: { legible: 0 } },
          images: { share: 0.95 },
          imagesOff: { on: 0, off: 0 },
          cta: { primary: null, buttonLike: 0, labels: [] },
        },
      },
      {},
    );
    expect(r.caps).toContain("CAP_IMAGE_ONLY");
    expect(r.needsImprovement[0]!.title).toBe(
      "All images, no real text: it's blank when images are off",
    );
    expect(r.needsImprovement.filter((i) => i.checkIds.includes("H1"))).toHaveLength(1);
    expect(r.needsImprovement.find((i) => i.key === "group:no-cta")).toBeUndefined();
  });
});

describe("cap titles name what a reader can see", () => {
  it("merge tag: quotes the tag", () => {
    const subj = score({}, { subject: "Hi *|FNAME|*, 20% off" });
    expect(subj.needsImprovement[0]!.title).toBe(
      "Shows a raw merge tag in the subject: “*|FNAME|*”",
    );
    const screen = score({
      static: { mergeTags: { body: 1, firstScreen: true, sample: "{{ first_name }}" } },
      render: { mergeTagFirstViewport: true },
    });
    expect(screen.needsImprovement[0]!.title).toBe(
      "Shows a raw merge tag at the top: “{{ first_name }}”",
    );
    // Both: the visible headline tag (with its words) leads; the subject is mentioned second.
    const both = score(
      {
        static: {
          mergeTags: {
            body: 1,
            firstScreen: true,
            sample: "{{ first_name }}",
            snippet: "Hi {{ first_name }}",
          },
        },
        render: { mergeTagFirstViewport: true },
      },
      { subject: "Hi *|FNAME|*, 20% off" },
    );
    expect(both.needsImprovement[0]!.title).toBe(
      "Shows a raw merge tag at the top: “Hi {{ first_name }}” (also in subject)",
    );
  });
  it("clipped: size and the [Message clipped] notice", () => {
    const r = score({
      static: { htmlBytes: 116_000 },
      render: { clip: { afterClipChars: 100, ctaAfterClip: true } },
    });
    expect(r.needsImprovement[0]!.title).toBe(
      "Cut off in Gmail: 116 KB, so readers see “[Message clipped]” before the button",
    );
  });
  it("no cap title carries the internal '(score capped at N)' note; it moves to `measured`", () => {
    const r = score({}, { subject: "Hi *|FNAME|*" });
    expect(r.needsImprovement[0]!.title).not.toMatch(/capped/);
    expect(r.needsImprovement[0]!.measured).toMatch(/score capped at 69/);
  });
});

describe("strengths: distinctive first, generic last", () => {
  it("a well-designed email leads with hierarchy + CTA, then the phone layout, with measured facts", () => {
    const r = score();
    expect(r.good[0]!.title).toBe(
      "A big 28px headline and one clear “Shop rain shells” button up top",
    );
    expect(r.good[0]!.checkIds).toEqual(expect.arrayContaining(["H6", "H3", "H2"]));
    expect(r.good[1]!.title).toBe("Built for phones: fits a 375px screen with 16px body text");
    const titles = r.good.map((g) => g.title);
    expect(titles.indexOf("Text meets WCAG AA contrast")).not.toBe(0);
    expect(titles.join("|")).not.toMatch(/Text is easy to read/);
  });
  it("without a strong headline the CTA and phone layout still lead", () => {
    const r = score({ render: { text: { firstViewportMaxPx: 16 } } });
    expect(r.good[0]!.key).toBe("good:cta");
    expect(r.good[0]!.title).toBe("One clear “Shop rain shells” button in the first screen");
    expect(r.good[1]!.key).toBe("good:mobile");
  });
  it("a fixed-width email never claims to be built for phones", () => {
    const r = score({ render: { layout: { k: 0.625, mobileContentWidth: 600, kNomq: 0.625 } } });
    expect(r.good.map((g) => g.key)).not.toContain("good:mobile");
  });
  it("every strength is unique and ≤ 80 characters for the common case", () => {
    const r = score();
    expect(new Set(r.good.map((g) => g.title)).size).toBe(r.good.length);
    // AI evidence is quoted as written (the saved summary cuts it at a word boundary).
    for (const g of r.good.filter((x) => !x.ai))
      expect(Array.from(g.title).length, g.title).toBeLessThanOrEqual(80);
  });
});

describe("strengths never contradict a listed problem (methodology 2026.4)", () => {
  it("text running to the screen edge: no 'Built for phones', whitespace or clean-layout praise", () => {
    const r = score({ render: { text: { gutters: [[4, 1500]] } } });
    expect(r.needsImprovement.some((i) => i.checkIds.includes("M7"))).toBe(true);
    const titles = r.good.map((g) => g.title).join("|");
    expect(r.good.map((g) => g.key)).not.toContain("good:mobile");
    expect(titles).not.toMatch(/Built for phones|Balanced whitespace|uncluttered/);
  });
  it("'reads fine with images off' only when the email has images", () => {
    const withImages = score();
    const none = score({ render: { images: { content: 0 } } });
    expect(none.good.some((g) => g.checkIds.includes("I2"))).toBe(false);
    // (the base email may or may not list I2; it's never removed for an email with images)
    expect(
      withImages.good.every((g) => !g.checkIds.includes("I2") || /images off/.test(g.title)),
    ).toBe(true);
  });
  it("stray button fragments are named, with no change to the score", () => {
    const clean = score();
    const r = score({ static: { strayButtons: 6 } });
    expect(r.score).toBe(clean.score);
    const note = r.needsImprovement.find((i) => i.key === "note:stray-buttons");
    expect(note?.title).toBe(
      "Shows 6 stray button fragments: coloured slivers with unreadable text",
    );
    expect(note?.points).toBe(0);
    expect(
      score({ static: { strayButtons: 1 } }).needsImprovement.some(
        (i) => i.key === "note:stray-buttons",
      ),
    ).toBe(false);
    reconciles({ static: { strayButtons: 6 } });
  });
});

describe("explanation wording for known mislabels", () => {
  it("blurry-only images say blurry, not 'don't adapt'", () => {
    const r = score({
      render: {
        images: {
          adapt: [
            { withinViewport: true, aspectDev: 0.01, sharpRatio: 1, renderedWidth: 600 },
            { withinViewport: true, aspectDev: 0.01, sharpRatio: 1, renderedWidth: 600 },
          ],
        },
      },
    });
    expect(r.needsImprovement.find((i) => i.key === "check:M5")?.title).toBe(
      "2 images look blurry on sharp phone screens (low resolution)",
    );
  });
  it("dark mode: readable text but a vanishing transparent logo names the logo", () => {
    const r = score({ render: { images: { darkMode: [{ partial: 0.1, full: 0.1 }] } } });
    expect(r.needsImprovement.find((i) => i.key === "check:M6")?.title).toBe(
      "A transparent image (often the logo) gets hard to see in dark mode",
    );
  });
  it("hidden text is called hidden, not faint", () => {
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ chars: 1500 }),
            group({ fg: "#ffffff", ratio: 1, rendered: false, chars: 500 }),
          ],
        },
      },
    });
    expect(r.needsImprovement.find((i) => i.checkIds.includes("A1"))?.title).toBe(
      "Some text is hidden: it's the same colour as its background (1.00:1)",
    );
  });
});

describe("helpers", () => {
  it("describeColour names colours coarsely", () => {
    expect(describeColour("#ffffff")).toBe("white");
    expect(describeColour("#b8b8b8")).toBe("light grey");
    expect(describeColour("#888888")).toBe("grey");
    expect(describeColour("#222222")).toBe("dark grey");
    expect(describeColour("#000000")).toBe("black");
    expect(describeColour("#0b5fff")).toBe("blue");
    expect(describeColour("#e50914")).toBe("red");
    expect(describeColour("#6d28d9")).toBe("purple");
    expect(describeColour("not-a-colour")).toBeNull();
  });
  it("weightedQuantile", () => {
    expect(
      weightedQuantile(
        [
          [12, 123],
          [16, 79],
        ],
        0.75,
      ),
    ).toBe(16);
    expect(weightedQuantile([[12, 100]], 0.75)).toBe(12);
    expect(weightedQuantile([], 0.5)).toBeNull();
  });
  it("firstMergeTag returns the tag token only", () => {
    expect(firstMergeTag("Hi {{ first_name }}, welcome")).toBe("{{ first_name }}");
    expect(firstMergeTag("Hi *|FNAME|*")).toBe("*|FNAME|*");
    expect(firstMergeTag("Nothing here")).toBeNull();
  });
  it("summary titles are cut at a word boundary with an ellipsis", () => {
    const r = score({}, { subject: "Hi *|FNAME|*" });
    const long: ScoreResult = {
      ...r,
      good: [
        {
          ...r.good[0]!,
          title:
            "Visual hierarchy: rated 5/5 — “One dominant hero image, a bold headline and a single high-contrast button”",
        },
      ],
    };
    const s = summarizeScore(long, null);
    const t = s.good[0]!.title;
    const original = long.good[0]!.title;
    expect(Array.from(t).length).toBeLessThanOrEqual(80);
    expect(t.endsWith("…")).toBe(true);
    const kept = t.slice(0, -1);
    expect(original.startsWith(kept)).toBe(true);
    expect(original[kept.length]).toBe(" ");
  });
});

describe("Excellent gate: 85+ needs every bar (methodology 2026.5)", () => {
  // Fixture 29 shape: a two-line notification — no headline, no button, text at the screen edge.
  const plainNotification: Over = {
    ai: null,
    render: {
      text: { firstViewportMaxPx: 16, gutters: [[4, 1500]] },
      cta: { primary: null, buttonLike: 0, labels: [], firstTwoViewportsDistinct: 0 },
    },
    static: { cta: { buttonLike: 0 } },
  };
  const notification = { primaryType: "notification" as const };

  it("a plain notification is held at 84 (never Excellent / Good design)", () => {
    const d = scoreEmailDetailed(baseFeatures(plainNotification), baseCtx(notification));
    expect(d.rawExact!).toBeGreaterThan(85);
    expect(d.result.score).toBe(84);
    expect(d.result.band).toBe("good");
    // Not a cap: never a Bad design.
    expect(d.result.caps).toEqual([]);
    expect(d.result.capped).toBe(false);
    expect(d.ceiling).toBe(84);
    const gate = d.result.needsImprovement[0]!;
    expect(gate.key).toBe("gate:excellence");
    expect(gate.title).toBe("Plain design: headline 1× the body, no main button");
    expect(d.result.signals?.gate).toEqual(["headline", "button", "phone_edge"]);
    reconciles(plainNotification);
  });

  it("without an AI rating, a headline and a standout button are both required", () => {
    const full = score({ ai: null });
    expect(full.score).toBeGreaterThanOrEqual(85);
    expect(full.signals?.gate).toEqual([]);
    // A real headline alone (no button) no longer opens it…
    const noButton = score(
      {
        ai: null,
        render: { cta: { primary: null, buttonLike: 0, labels: [], firstTwoViewportsDistinct: 0 } },
        static: { cta: { buttonLike: 0 } },
      },
      notification,
    );
    expect(noButton.score).toBe(84);
    expect(noButton.signals?.gate).toEqual(["button"]);
    expect(noButton.needsImprovement[0]!.title).toBe("Plain design: no main button");
    // …nor a standout button without a headline (1.1× the body text).
    const flat = score({ ai: null, render: { text: { firstViewportMaxPx: 17.6 } } });
    expect(flat.score).toBe(84);
    expect(flat.signals?.gate).toEqual(["headline"]);
    expect(flat.needsImprovement[0]!.title).toBe("Plain design: headline 1.1× the body");
  });

  it("a button that doesn't stand out, or a bigger link outweighs further down, misses G2", () => {
    const pale = score({
      ai: null,
      render: { cta: { primary: { fillLumRatio: 1.2, fillDeltaE: 8 } } },
    });
    expect(pale.signals?.gate).toEqual(["button"]);
    expect(pale.needsImprovement[0]!.title).toBe("Plain design: no standout button");
    // A filled button below the first screen that a bigger link or picture outweighs: there is a
    // standout button, just not the lead — worded so, never "no standout button".
    const low = { x: 20, y: 1200, w: 200, h: 48 };
    const second = score({
      ai: null,
      render: { cta: { primary: { mostProminent: false, visual: low, target: low } } },
    });
    expect(second.signals).toMatchObject({
      gate: ["button"],
      ctaMostProminent: false,
      ctaFirstScreen: false,
    });
    expect(second.needsImprovement[0]!.title).toBe(
      "Plain design: a bigger link outweighs the button",
    );
    // H3's own item, when an AI rating opens the gate (else the gate item absorbs it).
    const rated = score({
      render: { cta: { primary: { mostProminent: false, visual: low, target: low } } },
    });
    expect(rated.needsImprovement.find((i) => i.key === "check:H3")?.title).toBe(
      "A bigger link or picture outweighs the “Shop rain shells” button",
    );
  });

  it("a filled button in the first phone screen leads even when a card link is bigger (Canva)", () => {
    const r = score({ ai: null, render: { cta: { primary: { mostProminent: false } } } });
    expect(r.signals).toMatchObject({ gate: [], ctaMostProminent: false, ctaFirstScreen: true });
    expect(r.score).toBeGreaterThanOrEqual(85);
    // No "standout button" praise next to the H3 item that names the bigger link.
    expect(r.good.map((g) => g.title).join("|")).not.toMatch(/standout|one clear/i);
  });

  it("a button that clears G2 but loses a little fill credit isn't said not to stand out", () => {
    const r = score({
      ai: null,
      render: { cta: { primary: { fillLumRatio: 2.9, fillDeltaE: 10 } } },
    });
    expect(r.signals).toMatchObject({ gate: [], ctaSalience: 0.933 });
    expect(r.needsImprovement.find((i) => i.key === "check:H3")?.title).toBe(
      "The “Shop rain shells” button's fill could contrast a little more",
    );
  });

  it("a weak button label is its own problem, not a gate miss (FlexJobs orange buttons)", () => {
    const r = score({ ai: null, render: { cta: { primary: { labelContrast: 3.22 } } } });
    expect(r.signals).toMatchObject({ gate: [], ctaSalience: 1, ctaLabelContrast: 3.22 });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.needsImprovement.find((i) => i.key === "check:H3")?.title).toBe(
      "The text on the “Shop rain shells” button is hard to read (3.22:1)",
    );
  });

  it("system mail also needs imagery (≥ 8% of the email); promotional mail doesn't", () => {
    const bare: Over = { ai: null, render: { images: { share: 0.02 } } };
    const system = score(bare, notification);
    expect(system.score).toBe(84);
    expect(system.signals?.gate).toEqual(["imagery"]);
    expect(system.needsImprovement[0]!.title).toBe(
      "Little imagery for this kind of email: pictures cover only 2% of it",
    );
    expect(score(bare).score).toBeGreaterThanOrEqual(85);
    expect(
      score({ ai: null, render: { images: { share: 0.08 } } }, notification).score,
    ).toBeGreaterThanOrEqual(85);
  });

  it("G3 compares the share as it is saved (3 decimals), so the signal and the bar agree", () => {
    const at = (share: number) => score({ ai: null, render: { images: { share } } }, notification);
    expect(at(0.0798).signals).toMatchObject({ imgShare: 0.08, gate: [] });
    const under = at(0.0794);
    expect(under.signals).toMatchObject({ imgShare: 0.079, gate: ["imagery"] });
    expect(under.needsImprovement[0]!.title).toBe(
      "Little imagery for this kind of email: pictures cover only 7% of it",
    );
  });

  it("imagery that mostly didn't load can't pass G3 (expired links, blocked trackers)", () => {
    const r = score(
      {
        ai: null,
        render: {
          images: {
            loads: [
              { status: 403, decoded: false, reason: "expired" },
              { status: "blocked", decoded: false, reason: "tracker" },
              { status: 200, decoded: true },
            ],
          },
        },
      },
      notification,
    );
    expect(r.signals?.imagesUnknownShare).toBeCloseTo(0.667, 3);
    expect(r.signals?.gate).toEqual(["imagery_unknown"]);
    expect(r.score).toBe(84);
    // With image areas (render-2026.4) a missing hero outweighs the icons that loaded.
    const icon = { status: 200, decoded: true, area: 800 };
    const hero = score(
      {
        ai: null,
        render: {
          images: {
            loads: [
              icon,
              icon,
              icon,
              { status: "timeout", decoded: false, reason: "timeout", area: 120_000 },
            ],
          },
        },
      },
      notification,
    );
    expect(hero.signals?.imagesUnknownShare).toBeCloseTo(0.98, 2);
    expect(hero.signals?.gate).toEqual(["imagery_unknown"]);
    // No image praise next to "Most of its images didn't load".
    expect(hero.needsImprovement[0]!.title).toBe(
      "Most of its images didn't load, so its imagery can't be judged",
    );
    expect(hero.good.map((g) => g.title).join("|")).not.toMatch(/Images scale|images off/i);
  });

  it("few images are few images, even when some didn't load (GitHub, Google family group)", () => {
    // Renders before render-2026.4 logged only images that laid out, inside the 1.3% share: had
    // they loaded, the email would still be under 8%.
    const timedOut = { status: "timeout" as const, decoded: false };
    const github = score(
      { ai: null, render: { images: { content: 2, share: 0.013, loads: [timedOut, timedOut] } } },
      notification,
    );
    expect(github.signals).toMatchObject({ imagesUnknownShare: 1, gate: ["imagery"] });
    expect(github.needsImprovement[0]!.title).toBe(
      "Little imagery for this kind of email: pictures cover only 1% of it",
    );
    // Half the images loaded is not "most didn't load" (G3's unknown needs more than half).
    const half = score(
      {
        ai: null,
        render: {
          images: { content: 2, share: 0.02, loads: [{ status: 200, decoded: true }, timedOut] },
        },
      },
      notification,
    );
    expect(half.signals).toMatchObject({ imagesUnknownShare: 0.5, gate: ["imagery"] });
    // With areas (render-2026.4): blamed on loading only when the missing ones could reach 8%.
    const icon = { status: 200, decoded: true, area: 2_000 };
    const lost = (area: number) => ({
      status: "timeout" as const,
      decoded: false,
      reason: "timeout" as const,
      area,
    });
    const missing = (...areas: number[]) =>
      score(
        { ai: null, render: { images: { share: 0.01, loads: [icon, ...areas.map(lost)] } } },
        notification,
      ).signals?.gate;
    // A 20,000 px² picture that didn't load couldn't have been a hero either (G4, 2026.6): an
    // icon alone is no hero.
    expect(missing(20_000)).toEqual(["imagery", "hero"]);
    expect(missing(200_000)).toEqual(["imagery_unknown"]);
    // Missing pictures with no known size (laid out flat) could be any size: counted, not weighed.
    expect(missing(0, 0)).toEqual(["imagery_unknown"]);
  });

  it("images off for the email (our policy) isn't 'didn't load', 'image-only' or few images", () => {
    // A short receipt with a logo: images aren't requested for transactional mail.
    const off = { status: "blocked" as const, decoded: false, reason: "images_off" as const };
    const receipt: Over = {
      ai: null,
      render: {
        text: { chars: { legible: 180 } },
        images: { content: 1, share: 0, declared: 1, drawn: 0, loads: [off] },
      },
    };
    const r = score(receipt, { primaryType: "transactional", isSubscription: false });
    expect(r.signals).toMatchObject({
      htmlContentImages: 1,
      drawnContentImages: null,
      imagesOff: true,
      imagesUnknownShare: null,
      liveTextChars: 180,
      gate: [],
    });
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.needsImprovement.map((i) => i.title).join("|")).not.toMatch(/didn't load|images/i);
    // Not text in pictures: the phone-layout and type strengths stay; no image praise.
    const good = r.good.map((g) => g.title).join("|");
    expect(good).toMatch(/Built for phones/);
    expect(good).not.toMatch(/Images scale|images off/i);
    // Privacy mode: the same for a notification (G3 isn't judged, G1 and G2 still are).
    const plain = score(
      {
        ...receipt,
        render: { ...receipt.render, text: { ...receipt.render!.text, firstViewportMaxPx: 16 } },
      },
      notification,
    );
    expect(plain.signals?.gate).toEqual(["headline"]);
  });

  it("G2's first phone screen is measured for every type, not only where H2 is scored (2026.6)", () => {
    // A social notification: H2 doesn't apply, but the button's position still decides G2, so
    // a template's verdict doesn't hang on a link further down (LinkedIn "new message").
    const social = { primaryType: "social" as const };
    const outweighed = score(
      { ai: null, render: { cta: { primary: { mostProminent: false } } } },
      social,
    );
    expect(outweighed.checks.find((c) => c.id === "H2")?.status).toBe("not_applicable");
    expect(outweighed.signals).toMatchObject({ ctaFirstScreen: true, gate: [] });
    const low = { x: 20, y: 1200, w: 200, h: 48 };
    const below = score(
      {
        ai: null,
        render: { cta: { primary: { mostProminent: false, visual: low, target: low } } },
      },
      social,
    );
    expect(below.signals).toMatchObject({ ctaFirstScreen: false, gate: ["button"] });
  });

  it("G2: one of three look-alike buttons for different actions is no main button (2026.6)", () => {
    // Three identical pills for three actions (Google Workspace's "Try AI in Slides / Sheets /
    // Drive"): the "most prominent" one only wins by a hair, so none leads.
    const cta = (over: object) => ({
      ai: null,
      render: { cta: { buttonLike: 3, buttonStyles: 1, firstTwoViewportsDistinct: 3, ...over } },
    });
    const three = scoreEmailDetailed(baseFeatures(cta({})), baseCtx());
    expect(three.rawExact!).toBeGreaterThan(85);
    expect(three.result.score).toBe(84);
    expect(three.result.signals).toMatchObject({
      gate: ["button"],
      ctaCompeting: true,
      ctaMostProminent: true,
      ctaFirstScreen: true,
    });
    expect(three.result.needsImprovement[0]!.title).toBe(
      "Plain design: look-alike buttons, none the main one",
    );
    // Three cards with the same action, a second button style, or only two actions: a main
    // button can still lead (Abekus's "Explore course" cards, LinkedIn's filled + outline pair).
    for (const over of [
      { firstTwoViewportsDistinct: 1 },
      { buttonStyles: 2 },
      { firstTwoViewportsDistinct: 2 },
      { buttonLike: 2 },
    ]) {
      const r = score(cta(over));
      expect(r.signals, JSON.stringify(over)).toMatchObject({ gate: [], ctaCompeting: false });
    }
    // An AI rating of 4+ still stands in for the bars.
    expect(
      score({ render: { cta: { buttonLike: 3, buttonStyles: 1, firstTwoViewportsDistinct: 3 } } })
        .signals?.gate,
    ).toEqual([]);
  });

  it("G4: a stock template — no large picture, no headline band — is held at 84 (2026.6)", () => {
    // A logo, a plain headline on white, a few lines and a filled button (MongoDB, FlexJobs
    // "account created", LinkedIn "new message"): every other bar passes.
    const logo = { status: 200, decoded: true, area: 9_000 };
    const stock: Over = {
      ai: null,
      render: { images: { share: 0.1, loads: [logo], adapt: [] } },
    };
    const r = scoreEmailDetailed(baseFeatures(stock), baseCtx());
    expect(r.rawExact!).toBeGreaterThan(85);
    expect(r.result.score).toBe(84);
    expect(r.result.signals).toMatchObject({ gate: ["hero"], heroPicture: false, heroBand: false });
    expect(r.result.needsImprovement[0]!.title).toBe(
      "No large picture and no headline on a coloured band: a stock template look",
    );
    reconciles(stock);
    // A wide logo strip (436 × 70) is not a hero picture: it needs ≥ 40,000 px² too.
    const strip = { status: 200, decoded: true, area: 30_520 };
    const wideLogo = score({
      ai: null,
      render: {
        images: {
          loads: [strip],
          adapt: [{ withinViewport: true, aspectDev: 0, sharpRatio: 2, renderedWidth: 436 }],
        },
      },
    });
    expect(wideLogo.signals).toMatchObject({ gate: ["hero"], heroPicture: false });
    // A hero picture (600 px wide, 600 × 300) passes…
    const heroImg = { status: 200, decoded: true, area: 180_000 };
    expect(score({ ai: null, render: { images: { loads: [heroImg] } } }).signals).toMatchObject({
      gate: [],
      heroPicture: true,
    });
    // …and so does a headline on a painted band with no picture at all (Betterbrand's dark green
    // header, Remote's tinted hero, a dark theme); a near-white page (#f3f2f0) is no band.
    const band = (bg: string) =>
      score({
        ai: null,
        render: {
          images: { loads: [logo], adapt: [] },
          contrast: {
            groups: [
              group({ chars: 1500 }),
              group({ role: "heading", large: true, chars: 26, fg: "#ffffff", bg, ratio: 12 }),
            ],
          },
        },
      }).signals;
    expect(band("#1b3a2d")).toMatchObject({ gate: [], heroBand: true });
    expect(band("#e4ecf0")).toMatchObject({ gate: [], heroBand: true });
    expect(band("#f3f2f0")).toMatchObject({ gate: ["hero"], heroBand: false });
  });

  it("G4: a large picture that didn't load leaves the hero unknown, not missing (2026.6)", () => {
    const logo = { status: 200, decoded: true, area: 9_000 };
    const expired = (area: number) => ({
      status: 403,
      decoded: false,
      reason: "expired" as const,
      area,
    });
    const gate = (area: number) =>
      score({ ai: null, render: { images: { loads: [logo, expired(area)], adapt: [] } } }).signals
        ?.gate;
    expect(gate(150_000)).toEqual(["imagery_unknown"]);
    expect(gate(20_000)).toEqual(["hero"]);
    // Images off for the email (our policy): G4 isn't judged, like G3.
    const off = { status: "blocked" as const, decoded: false, reason: "images_off" as const };
    expect(
      score({ ai: null, render: { images: { loads: [off], adapt: [] } } }).signals?.gate,
    ).toEqual([]);
  });

  it("an AI hierarchy / polish / imagery rating of 4+ stands in for the bars", () => {
    const withAi = score(
      {
        ...plainNotification,
        ai: undefined,
        render: { ...plainNotification.render, text: { firstViewportMaxPx: 16 } },
      },
      notification,
    );
    const withoutAi = score(
      {
        ...plainNotification,
        render: { ...plainNotification.render, text: { firstViewportMaxPx: 16 } },
      },
      notification,
    );
    expect(withoutAi.score).toBe(84);
    expect(withAi.score).toBeGreaterThanOrEqual(85);
    expect(withAi.signals?.gate).toEqual([]);
  });

  it("most text squeezed into narrow phone columns blocks Excellent (Hollow Pine regression)", () => {
    const narrow: Over = { render: { text: { blockWidths: [[200, 1500]] } } };
    const d = scoreEmailDetailed(baseFeatures(narrow), baseCtx());
    if (Math.round(d.rawExact!) >= 85) {
      expect(d.result.score).toBe(84);
      expect(d.result.needsImprovement[0]!.title).toBe(
        "On phones, 100% of the text is squeezed into narrow columns",
      );
    }
    reconciles(narrow);
  });

  it("an email already below 85 is untouched, but its bars are still saved", () => {
    const d = scoreEmailDetailed(
      baseFeatures({
        ...plainNotification,
        render: { ...plainNotification.render, layout: { k: 0.6 } },
      }),
      baseCtx(notification),
    );
    expect(d.ceiling).toBeNull();
    expect(d.result.needsImprovement.some((i) => i.key === "gate:excellence")).toBe(false);
    expect(d.result.signals?.gate).toEqual(expect.arrayContaining(["headline", "button"]));
  });
});

describe("excellenceGate (unit)", () => {
  const c = (id: string, status: string, s: number | null, value: unknown) =>
    ({ id, status, s, value }) as never;
  const facts = (over: object = {}) => ({
    primaryType: "notification" as const,
    imgShare: 0.2,
    imagesUnknownShare: 0,
    ...over,
  });
  const standout = c("H3", "pass", 1, { present: true, salience: 1, mostProminent: true });
  it("names every bar it misses, G1–G3 first", () => {
    const g = excellenceGate(
      [
        c("H6", "fail", 0, { ratio: 1 }),
        c("H3", "not_applicable", null, { reason: "type_without_button" }),
        c("M3", "fail", 0, { wideShare: 0 }),
        c("M7", "fail", 0, { okShare: 0 }),
      ],
      facts({ imgShare: 0.02 }),
    );
    expect(g.rule).toBe("bars");
    expect(g.misses).toEqual(["headline", "button", "imagery", "phone_narrow", "phone_edge"]);
  });
  it("the bars' thresholds: headline 1.5×, salience 0.9 + most prominent, imagery 8%", () => {
    const h6 = (ratio: number) => c("H6", "partial", 0.5, { ratio });
    expect(excellenceGate([h6(1.5), standout], facts({ imgShare: 0.08 })).misses).toEqual([]);
    expect(excellenceGate([h6(1.49), standout], facts()).misses).toEqual(["headline"]);
    const weak = c("H3", "partial", 0.6, { present: true, salience: 0.89, mostProminent: true });
    expect(excellenceGate([h6(2), weak], facts()).misses).toEqual(["button"]);
    expect(excellenceGate([h6(2), standout], facts({ imgShare: 0.079 })).misses).toEqual([
      "imagery",
    ]);
    expect(
      excellenceGate([h6(2), standout], facts({ primaryType: "promotional", imgShare: 0 })).misses,
    ).toEqual([]);
    // G3's unknown needs MORE than half (0.5 = half loaded); it fails below 8% only when the
    // missing images could have reached it.
    expect(excellenceGate([h6(2), standout], facts({ imagesUnknownShare: 0.5 })).misses).toEqual(
      [],
    );
    expect(excellenceGate([h6(2), standout], facts({ imagesUnknownShare: 0.51 })).misses).toEqual([
      "imagery_unknown",
    ]);
    const few = facts({ imgShare: 0.02, imagesUnknownShare: 0.8 });
    expect(excellenceGate([h6(2), standout], { ...few, imgShareIfLoaded: 0.05 }).misses).toEqual([
      "imagery",
    ]);
    expect(excellenceGate([h6(2), standout], { ...few, imgShareIfLoaded: 0.3 }).misses).toEqual([
      "imagery_unknown",
    ]);
    // Images off for the email: G3 isn't judged.
    expect(excellenceGate([h6(2), standout], { ...few, imagesOff: true }).misses).toEqual([]);
  });
  it("G1 needs heading text: a big button label alone isn't a headline", () => {
    const g = excellenceGate(
      [c("H6", "pass", 1, { ratio: 1.75, headline: false }), standout],
      facts(),
    );
    expect(g).toMatchObject({ misses: ["headline"], hasHeadline: false });
  });
  it("G2: a filled button that isn't the most prominent link passes in the first phone screen", () => {
    const second = c("H3", "partial", 0.83, { present: true, salience: 1, mostProminent: false });
    const h6 = c("H6", "pass", 1, { ratio: 2, headline: true });
    expect(excellenceGate([h6, second, c("H2", "pass", 1, {})], facts()).misses).toEqual([]);
    expect(excellenceGate([h6, second, c("H2", "partial", 0.5, {})], facts()).misses).toEqual([
      "button",
    ]);
  });
  it("G4 is judged only with its facts; first-screen facts override H2's status", () => {
    const h6 = c("H6", "pass", 1, { ratio: 2, headline: true });
    expect(
      excellenceGate([h6, standout], facts({ heroPicture: false, heroBand: false })).misses,
    ).toEqual(["hero"]);
    expect(
      excellenceGate([h6, standout], facts({ heroPicture: false, heroBand: true })).misses,
    ).toEqual([]);
    expect(
      excellenceGate(
        [h6, standout],
        facts({ heroPicture: false, heroBand: false, heroUnknown: true }),
      ).misses,
    ).toEqual(["imagery_unknown"]);
    expect(
      excellenceGate(
        [h6, standout],
        facts({ heroPicture: false, heroBand: false, imagesOff: true }),
      ).misses,
    ).toEqual([]);
    expect(excellenceGate([h6, standout], facts()).misses).toEqual([]);
    const second = c("H3", "partial", 0.83, { present: true, salience: 1, mostProminent: false });
    const na = c("H2", "not_applicable", null, { reason: "type" });
    expect(excellenceGate([h6, second, na], facts()).misses).toEqual(["button"]);
    expect(excellenceGate([h6, second, na], facts({ ctaFirstScreen: true })).misses).toEqual([]);
    expect(
      excellenceGate([h6, second, c("H2", "pass", 1, {})], facts({ ctaFirstScreen: false })).misses,
    ).toEqual(["button"]);
  });
  it("an AI rating of 4+ stands in for G1–G4, not for the phone layout", () => {
    const g = excellenceGate(
      [
        c("H6", "fail", 0, { ratio: 1 }),
        c("L8", "pass", 1, { level: 4 }),
        c("M7", "fail", 0, { okShare: 0 }),
      ],
      facts({ imgShare: 0 }),
    );
    expect(g).toMatchObject({ ai: true, misses: ["phone_edge"] });
  });
  it("without the bars' facts the v1.3 rule decides: a 1.5× headline, a standout button or an AI 4/5", () => {
    expect(excellenceGate([c("H6", "partial", 0.8, { ratio: 1.5 })]).misses).toEqual([]);
    expect(excellenceGate([c("H3", "pass", 1, { present: true })]).misses).toEqual([]);
    expect(excellenceGate([c("L8", "pass", 1, { level: 4 })]).misses).toEqual([]);
    expect(excellenceGate([c("I6", "partial", 0.75, { level: 4 })]).misses).toEqual([]);
    expect(excellenceGate([c("H7", "partial", 0.5, { level: 3 })]).misses).toEqual(["plain"]);
    // H6 not evaluated (no render) is a missing fact, not a miss.
    const g = excellenceGate(
      [c("H6", "not_evaluated", null, { reason: "no_render" }), standout],
      facts(),
    );
    expect(g.rule).toBe("legacy");
    expect(g.misses).toEqual([]);
  });
  it("under half the text cramped on phones doesn't block", () => {
    const g = excellenceGate([
      c("H6", "pass", 1, { ratio: 2 }),
      c("M3", "partial", 0.6, { wideShare: 0.6 }),
      c("M7", "partial", 0.55, { okShare: 0.55 }),
    ]);
    expect(g.misses).toEqual([]);
  });
});

describe("CAP_CONTRAST is one root cause (Autumn / fixture 05 regression)", () => {
  it("folds the live-text and dark-mode symptoms of faint text, and drops the faint headline as a strength", () => {
    const faint = { fg: "#c4c4c4", bg: "#ffffff", ratio: 1.74 };
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ ...faint, chars: 1500 }),
            group({ ...faint, role: "heading", large: true, chars: 200 }),
          ],
        },
        text: {
          chars: { legible: 40 },
          firstViewportLegible: 14,
        },
      },
    });
    expect(r.caps).toContain("CAP_CONTRAST");
    const cap = r.needsImprovement[0]!;
    expect(cap.key).toBe("cap:CAP_CONTRAST");
    expect(cap.checkIds).toContain("I2");
    expect(r.needsImprovement.some((i) => i.key === "check:I2")).toBe(false);
    expect(r.good.some((g) => g.checkIds.includes("H6"))).toBe(false);
    reconciles({
      render: {
        contrast: { groups: [group({ ...faint, chars: 1500 })] },
        text: { chars: { legible: 40 }, firstViewportLegible: 14 },
      },
    });
  });
});

describe("unsubscribe: the static pass ∪ the render (methodology 2026.5)", () => {
  const u1 = (r: ScoreResult) => r.checks.find((c) => c.id === "U1")!;
  it("a link only the render found counts, at the render's place (MJML font-size:0 wrappers)", () => {
    const r = score({ static: { footer: { unsubscribe: "none" } } });
    expect(u1(r).status).toBe("pass");
    expect(u1(r).value).toMatchObject({
      unsubscribe: "before_clip",
      static: "none",
      render: "found",
    });
    expect(r.signals).toMatchObject({
      unsubscribe: "before_clip",
      unsubscribeUnion: "before_clip",
      staticUnsubscribe: "none",
      renderUnsubscribe: "found",
    });
    const clipped = score({
      static: { footer: { unsubscribe: "none" } },
      render: { clip: { unsubscribeAfterClip: true } },
    });
    expect(u1(clipped).s).toBe(0.3);
    expect(clipped.signals?.unsubscribe).toBe("after_clip");
  });
  it("a link only the static pass found counts (a 'click here' sentence the render misses)", () => {
    const r = score({ render: { footer: { unsubscribe: null } } });
    expect(u1(r).value).toMatchObject({ unsubscribe: "before_clip", render: "none" });
    // The render's place wins when it found the link; the static pass's place otherwise.
    const late = score({
      static: { footer: { unsubscribe: "after_clip" } },
      render: { footer: { unsubscribe: null } },
    });
    expect(late.signals?.unsubscribeUnion).toBe("after_clip");
  });
  it("'none' only when both passes looked and found nothing", () => {
    const none = score({
      static: { footer: { unsubscribe: "none" } },
      render: { footer: { unsubscribe: null } },
    });
    expect(u1(none).s).toBe(0);
    expect(none.needsImprovement.some((i) => i.title === "No visible unsubscribe link")).toBe(true);
    expect(none.signals?.unsubscribe).toBe("none");
  });
  it("both passes' answers are saved even where U1 doesn't apply (marketing mail not marked as a subscription)", () => {
    const r = score(
      { static: { footer: { unsubscribe: "none" } }, render: { footer: { unsubscribe: null } } },
      { isSubscription: false },
    );
    expect(u1(r).status).toBe("not_applicable");
    expect(r.signals).toMatchObject({
      unsubscribe: null,
      unsubscribeUnion: "none",
      staticUnsubscribe: "none",
      renderUnsubscribe: "none",
      primaryType: "promotional",
    });
  });
  it("a link the static pass places before the clip wins over the render's footer link after it", () => {
    // An early "click here to unsubscribe" sentence (static) and a footer link past Gmail's cut.
    const r = score({
      static: { htmlBytes: 110_000, footer: { unsubscribe: "before_clip" } },
      render: { clip: { unsubscribeAfterClip: true, visibleChars: 2000, afterClipChars: 100 } },
    });
    expect(u1(r).value).toMatchObject({
      unsubscribe: "before_clip",
      static: "found",
      render: "after_clip",
    });
    expect(r.signals).toMatchObject({
      unsubscribe: "before_clip",
      unsubscribeUnion: "before_clip",
    });
  });
  it("a template sample's footer is another email's: the email's own static pass decides", () => {
    const r = score({
      renderSource: "template",
      static: { footer: { unsubscribe: "none" } },
      render: { clip: { unsubscribeAfterClip: true } },
    });
    expect(u1(r).s).toBe(0);
    expect(r.signals).toMatchObject({
      staticUnsubscribe: "none",
      renderUnsubscribe: null,
      unsubscribeUnion: "none",
    });
    // Only when this email's static pass failed is the sample all there is (still unplaced).
    const failed = score({
      renderSource: "template",
      static: { unavailable: true, footer: { unsubscribe: "none" } },
      render: { clip: { unsubscribeAfterClip: true } },
    });
    expect(failed.signals).toMatchObject({
      staticUnsubscribe: null,
      renderUnsubscribe: "found",
      unsubscribeUnion: "before_clip",
    });
  });
});

describe("unsubscribe: a static-pass link the render shows hidden doesn't count (render-2026.6)", () => {
  const u1 = (r: ScoreResult) => r.checks.find((c) => c.id === "U1")!;
  // The static pass found a link at byte 5,000 (it can't see descendant selectors, @media rules
  // or text the colour of its background); the render's own detector found none.
  const staticFind = {
    footer: { unsubscribe: "before_clip" as const, unsubscribeOffsets: [5000] },
  };
  const noRenderLink = { footer: { unsubscribe: null } };
  it("the same element (by data-o offset) drawing nothing in either pass → no unsubscribe link", () => {
    const r = score({
      static: staticFind,
      render: { ...noRenderLink, links: { hidden: [1200, 5000] } },
    });
    expect(u1(r).s).toBe(0);
    expect(u1(r).value).toMatchObject({
      unsubscribe: "none",
      static: "found",
      render: "none",
      staticHidden: 1,
    });
    expect(r.signals).toMatchObject({
      unsubscribe: "none",
      unsubscribeUnion: "none",
      // Each pass's own answer is saved as it was.
      staticUnsubscribe: "found",
      renderUnsubscribe: "none",
    });
    expect(r.needsImprovement.some((i) => i.title === "No visible unsubscribe link")).toBe(true);
  });
  it("a link the render drew but didn't recognise still counts (Truecaller's 'Click here to unsubscribe')", () => {
    const r = score({ static: staticFind, render: { ...noRenderLink, links: { hidden: [1200] } } });
    expect(u1(r).value).toMatchObject({
      unsubscribe: "before_clip",
      static: "found",
      render: "none",
    });
    expect(u1(r).value).not.toHaveProperty("staticHidden");
    expect(r.signals?.unsubscribeUnion).toBe("before_clip");
  });
  it("only the hidden links drop out: a visible one after the clip offset stays, at its place", () => {
    const r = score({
      static: {
        htmlBytes: 120_000,
        footer: { unsubscribe: "before_clip", unsubscribeOffsets: [5000, 110_000] },
      },
      render: { ...noRenderLink, links: { hidden: [5000] } },
    });
    expect(r.signals?.unsubscribeUnion).toBe("after_clip");
    expect(u1(r).s).toBe(0.3);
  });
  it("past a full hidden list (`hiddenMore`) a static link counts as hidden; before it, as drawn", () => {
    const full = { ...noRenderLink, links: { hidden: [100, 200], hiddenMore: true } };
    expect(
      score({ static: { footer: { unsubscribeOffsets: [5000] } }, render: full }).signals
        ?.unsubscribeUnion,
    ).toBe("none");
    expect(
      score({ static: { footer: { unsubscribeOffsets: [150] } }, render: full }).signals
        ?.unsubscribeUnion,
    ).toBe("before_clip");
  });
  it("the render's own visible link still counts whatever the static link does", () => {
    const r = score({ static: staticFind, render: { links: { hidden: [5000] } } });
    expect(r.signals).toMatchObject({
      unsubscribeUnion: "before_clip",
      renderUnsubscribe: "found",
    });
  });
  it("the static answer stands without both lists: older passes, a template sample, no offsets", () => {
    // Rendered before render-2026.6 (no `links.hidden`): as before.
    expect(score({ static: staticFind, render: noRenderLink }).signals?.unsubscribeUnion).toBe(
      "before_clip",
    );
    // Extracted before (no offsets), or a link without a source position (null).
    for (const unsubscribeOffsets of [undefined, null]) {
      const r = score({
        static: { footer: { unsubscribe: "before_clip", unsubscribeOffsets } },
        render: { ...noRenderLink, links: { hidden: [5000] } },
      });
      expect(r.signals?.unsubscribeUnion).toBe("before_clip");
    }
    // A template sample's render is another email's: its hidden links say nothing about this one.
    const t = score({
      renderSource: "template",
      static: staticFind,
      render: { ...noRenderLink, links: { hidden: [5000] } },
    });
    expect(t.signals?.unsubscribeUnion).toBe("before_clip");
  });
});

describe("saved signals (methodology 2026.5)", () => {
  it("every key, for a well-designed promotional email", () => {
    const r = score();
    expect(r.signals).toEqual({
      imgShare: 0.3,
      legibleChars: 1700,
      phoneTextPx: 16,
      layoutK: 1,
      unsubscribe: "before_clip",
      primaryType: "promotional",
      headlineRatio: 1.75,
      hasHeadline: true,
      ctaSalience: 1,
      ctaMostProminent: true,
      ctaFirstScreen: true,
      ctaLabelContrast: 5.2,
      ctaCompeting: false,
      gate: [],
      heroPicture: true,
      heroBand: false,
      htmlContentImages: 3,
      drawnContentImages: 3,
      imagesOff: false,
      imagesUnknownShare: 0,
      staticUnsubscribe: "found",
      renderUnsubscribe: "found",
      unsubscribeUnion: "before_clip",
      liveTextChars: 1700,
      htmlKB: 24,
    });
    // The summary saves them as computed (they survive compaction there).
    expect(summarizeScore(r, null).signals).toEqual(r.signals);
  });
  it("image-only facts: declared vs drawn content images (render-2026.4), older renders by fallback", () => {
    const tooLarge = score({
      render: {
        text: { chars: { legible: 51 } },
        images: {
          content: 0,
          share: 0,
          declared: 1,
          drawn: 0,
          loads: [{ status: "too_large", decoded: false, reason: "too_large", area: 2_000_000 }],
        },
      },
    });
    expect(tooLarge.signals).toMatchObject({
      htmlContentImages: 1,
      drawnContentImages: 0,
      liveTextChars: 51,
      imagesUnknownShare: 1,
    });
    // No typography or layout praise for text baked into a picture.
    expect(tooLarge.good.map((g) => g.title).join("|")).not.toMatch(
      /line spacing|type|Fits a 375px|Built for phones|colour palette|grid/i,
    );
    // Before render-2026.4: the static pass's content images and the render's.
    const older = score({ render: { images: { content: 0, loads: [] } } });
    expect(older.signals).toMatchObject({ htmlContentImages: 3, drawnContentImages: 0 });
  });
  it("static-only coverage keeps the static facts and no gate", () => {
    const r = score({ render: null, ai: null });
    expect(r.score).toBeNull();
    expect(r.signals).toMatchObject({
      gate: null,
      renderUnsubscribe: null,
      staticUnsubscribe: "found",
      unsubscribeUnion: "before_clip",
      drawnContentImages: null,
      liveTextChars: null,
    });
  });
});

describe("2026-10-01 verdict audit: measurement wording and weights", () => {
  it("fine print weighs at most 25% of A1: a faint footer disclaimer is never a whole-email fail", () => {
    const r = score({
      render: {
        contrast: {
          groups: [
            group({ chars: 400 }),
            group({ fg: "#b8c4bc", ratio: 1.67, chars: 600, fine: true }),
          ],
        },
      },
    });
    const a1 = r.checks.find((c) => c.id === "A1")!;
    expect(a1.s).toBeCloseTo(0.75, 5);
    expect(a1.value).toMatchObject({ fineWeight: 0.25, mainFailShare: 0 });
    expect(r.needsImprovement.find((i) => i.checkIds.includes("A1"))?.title).toBe(
      "The small print is hard to read: light grey on white (1.67:1)",
    );
    // Main text just under AA names its own share and reads "slightly low".
    const near = score({
      render: {
        contrast: {
          groups: [
            group({ chars: 300 }),
            group({ fg: "#6b7b6f", ratio: 4.48, chars: 100 }),
            group({ fg: "#b8c4bc", ratio: 1.67, chars: 400, fine: true }),
          ],
        },
      },
    });
    expect(near.needsImprovement.find((i) => i.checkIds.includes("A1"))?.title).toBe(
      "25% of the text has slightly low contrast: grey on white (4.48:1)",
    );
  });
  it("an email with no heading at all says 'No headline' ('in live text' when it has pictures)", () => {
    const noHeading = {
      chars: { heading: 0 },
      headings: { visual: 0, markedUp: 0, h1: 0 },
    };
    const textOnly = { content: 0, informative: 0, share: 0, loads: [], adapt: [] };
    const r = score({
      ai: null,
      render: { text: { firstViewportMaxPx: 16, ...noHeading }, images: textOnly },
    });
    expect(r.checks.find((c) => c.id === "H6")?.value).toMatchObject({
      headline: false,
      pictures: false,
    });
    // No picture and no band either (G4): named after the headline.
    expect(r.needsImprovement[0]!.title).toBe(
      "Plain design: no headline, no large picture or headline band",
    );
    // With pictures the headline may sit in one (a hero, a banner that didn't load).
    const pictured = scoreEmailDetailed(
      baseFeatures({ ai: null, render: { text: { firstViewportMaxPx: 16, ...noHeading } } }),
      baseCtx(),
    );
    expect(pictured.result.needsImprovement[0]!.title).toBe("Plain design: no live-text headline");
    // A 28px button label is the largest text, but not a headline: G1 fails, and no strength
    // calls it one.
    const label = score({ ai: null, render: { text: { firstViewportMaxPx: 28, ...noHeading } } });
    expect(label.signals).toMatchObject({
      hasHeadline: false,
      headlineRatio: 1.75,
      gate: ["headline"],
    });
    expect(label.good.map((g) => g.title).join("|")).not.toMatch(/headline|hierarchy|outranks/i);
    // A heading that is barely larger keeps the ratio wording.
    const flat = score({ render: { text: { firstViewportMaxPx: 17.6 } } });
    expect(flat.needsImprovement.find((i) => i.key === "check:H6")?.title).toBe(
      "The headline is barely larger than the text (1.1×)",
    );
  });
  it("an SVG is a small 'Gmail doesn't show it' finding, not broken images (SME regression)", () => {
    const svg = {
      status: "unsupported" as const,
      decoded: false,
      reason: "svg" as const,
      area: 4000,
    };
    const r = score({ render: { images: { content: 1, loads: [svg] } } });
    expect(r.caps).not.toContain("CAP_BROKEN_IMAGES");
    const i3 = r.checks.find((c) => c.id === "I3")!;
    expect(i3.s).toBeCloseTo(0.85, 5);
    expect(r.needsImprovement.find((i) => i.key === "check:I3")?.title).toBe(
      "An image is an SVG, which Gmail doesn't show",
    );
  });
  it("broken images must cover ≥ 20% of the image area to cap", () => {
    const loads = (brokenArea: number) => [
      { status: 404, decoded: false, area: brokenArea },
      { status: 404, decoded: false, area: brokenArea },
      { status: 200, decoded: true, area: 100_000 },
    ];
    expect(score({ render: { images: { loads: loads(5_000) } } }).caps).not.toContain(
      "CAP_BROKEN_IMAGES",
    );
    expect(score({ render: { images: { loads: loads(20_000) } } }).caps).toContain(
      "CAP_BROKEN_IMAGES",
    );
    // Areas that add up to 0 (broken images with no declared size lay out flat) say nothing:
    // the count rule decides, as without areas.
    const flat = { status: 404, decoded: false, reason: "http" as const, area: 0 };
    expect(tallyLoads([flat, flat], baseCtx()).brokenArea).toBeNull();
    expect(score({ render: { images: { loads: [flat, flat, flat] } } }).caps).toContain(
      "CAP_BROKEN_IMAGES",
    );
  });
  it("a load's reason is read before its status: an expired signed link's 410 isn't 'gone'", () => {
    const expired = { status: 410, decoded: false, reason: "expired" as const, area: 120_000 };
    const r = score({ render: { images: { loads: [expired, expired, expired] } } });
    expect(r.caps).not.toContain("CAP_BROKEN_IMAGES");
    expect(r.checks.find((c) => c.id === "I3")?.status).toBe("not_evaluated");
    expect(tallyLoads([expired], baseCtx())).toMatchObject({ evaluated: 0, broken: 0 });
  });
  it("fine print alone never fails A1; main text that can't be decided leaves it to review", () => {
    const a1 = (groups: ContrastGroup[]) =>
      score({ render: { contrast: { groups } } }).checks.find((c) => c.id === "A1")!;
    const faintFine = group({ fg: "#bbbbbb", ratio: 1.9, chars: 500, fine: true });
    // Copy over a picture (pixel method, undecided) and a faint disclaimer: not the disclaimer's call.
    const overPicture = a1([group({ method: "pixel", ratio: 3, p90: 6, chars: 400 }), faintFine]);
    expect(overPicture.status).toBe("needs_review");
    // Only fine print to judge: at most its 25%.
    const only = a1([faintFine]);
    expect(only.s).toBeCloseTo(0.75, 5);
    expect(only.value).toMatchObject({ fineWeight: 0.25 });
  });
  it("image strengths need a drawn image; button strengths a button that clears the gate's bar", () => {
    const undrawn = score({
      render: {
        images: {
          declared: 3,
          drawn: 0,
          loads: [
            { status: 403, decoded: false, reason: "expired" },
            { status: 403, decoded: false, reason: "expired" },
            { status: 403, decoded: false, reason: "expired" },
          ],
        },
      },
    });
    expect(undrawn.good.map((g) => g.title).join("|")).not.toMatch(/Images scale|images off/i);
    const pale = score({
      ai: null,
      render: { cta: { primary: { fillLumRatio: 1.2, fillDeltaE: 8 } } },
    });
    expect(pale.good.map((g) => g.title).join("|")).not.toMatch(
      /button|call to action|stands out/i,
    );
  });
});
