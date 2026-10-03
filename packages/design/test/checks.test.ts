import { describe, expect, it } from "vitest";
import {
  CHECK_FUNCTIONS,
  CHECK_IDS,
  fontProfile,
  type CheckId,
  type ContrastGroup,
  type DesignFeatures,
  type ScoreContext,
  type TextRole,
} from "../src/index";
import { inapplicableReason } from "../src/scoring/applicability";
import { labelClarity } from "../src/scoring/checks/hierarchy";
import { bigramSimilarity, isAllCapsSubject } from "../src/scoring/checks/content";
import type { CheckInput } from "../src/scoring/kit";
import { baseAi, baseCtx, baseFeatures } from "./helpers/factory";

type Over = Parameters<typeof baseFeatures>[0];

function input(over?: Over, ctx?: Partial<ScoreContext>, own = true): CheckInput {
  const f: DesignFeatures = baseFeatures(over);
  const coverage = f.renderSource === "none" || !f.render ? "static" : f.renderSource;
  return {
    static: f.static,
    render: coverage === "static" ? null : f.render,
    renderSource: coverage === "static" ? "none" : f.renderSource,
    fonts: f.fonts,
    fontProfile: fontProfile(f.fonts, { source: coverage === "static" ? "static" : coverage }),
    ai: f.ai,
    ctx: baseCtx(ctx),
    ownRender: own && coverage === "render",
  };
}

function run(id: CheckId, over?: Over, ctx?: Partial<ScoreContext>) {
  return CHECK_FUNCTIONS[id](input(over, ctx));
}

describe("every check on the baseline email", () => {
  it("returns a valid outcome; credits in [0,1]; status matches credit", () => {
    for (const id of CHECK_IDS) {
      const o = CHECK_FUNCTIONS[id](input());
      if (o.s !== null) {
        expect(o.s).toBeGreaterThanOrEqual(0);
        expect(o.s).toBeLessThanOrEqual(1);
        expect(o.status).toBe(o.s >= 0.9 ? "pass" : o.s > 0 ? "partial" : "fail");
      } else {
        expect(["not_applicable", "not_evaluated", "needs_review"]).toContain(o.status);
      }
    }
  });
  it("render checks are not_evaluated without a render; static checks still run", () => {
    const i = input({ render: null, ai: null });
    expect(CHECK_FUNCTIONS.M1(i).status).toBe("not_evaluated");
    expect(CHECK_FUNCTIONS.A1(i).status).toBe("not_evaluated");
    expect(CHECK_FUNCTIONS.X1(i).status).toBe("pass");
    expect(CHECK_FUNCTIONS.H1(i).status).toBe("pass");
    expect(CHECK_FUNCTIONS.A13(i).status).toBe("not_evaluated");
  });
});

describe("accessibility (§5.1)", () => {
  const g = (
    ratio: number,
    role: TextRole = "body",
    chars = 1000,
    extra: Partial<ContrastGroup> = {},
  ): ContrastGroup => ({
    fg: "#777777",
    bg: "#ffffff",
    ratio,
    p90: null,
    method: "color",
    large: false,
    role,
    rendered: true,
    short: false,
    chars,
    ...extra,
  });
  it("A1 ramps the AA pass share; sub-1.3 hidden long runs fail; short/hidden-normal excluded", () => {
    expect(
      run("A1", { render: { contrast: { groups: [g(5, "body", 980), g(3, "body", 20)] } } }).s,
    ).toBeCloseTo(1, 5);
    expect(
      run("A1", { render: { contrast: { groups: [g(5, "body", 840), g(3, "body", 160)] } } }).s,
    ).toBeCloseTo(0.5, 5);
    const hidden = run("A1", {
      render: {
        contrast: { groups: [g(5, "body", 700), g(1.05, "body", 300, { rendered: false })] },
      },
    });
    expect(hidden.s).toBe(0);
    const shortHidden = run("A1", {
      render: {
        contrast: {
          groups: [g(5, "body", 700), g(1.05, "body", 300, { rendered: false, short: true })],
        },
      },
    });
    expect(shortHidden.s).toBe(1);
    const underImage = run("A1", {
      render: { contrast: { groups: [g(5, "body", 700), g(9, "body", 300, { rendered: false })] } },
    });
    expect(underImage.s).toBe(1);
    expect(run("A1", { render: { contrast: { groups: [g(4.4999, "body", 1000)] } } }).s).toBe(0);
    expect(
      run("A1", { render: { contrast: { groups: [g(3.1, "heading", 1000, { large: true })] } } }).s,
    ).toBe(1);
  });
  it("A1 pixel method: undecidable runs → needs_review when > 50% of chars", () => {
    const px = (chars: number) => g(2, "body", chars, { method: "pixel", p90: 8 });
    expect(
      run("A1", { render: { contrast: { groups: [px(600), g(7, "body", 400)] } } }).status,
    ).toBe("needs_review");
    const mostlyDecided = run("A1", {
      render: { contrast: { groups: [px(300), g(7, "body", 700)] } },
    });
    expect(mostlyDecided.status).toBe("pass");
  });
  it("A2 = 0.5·alt share + 0.5·meaningful share; N/A without images; rendered sizes only for an own render", () => {
    expect(
      run("A2", {
        static: { images: { content: 4, withAlt: 2 } },
        render: {
          images: { alt: { total: 4, withAlt: 2, informative: 2, informativeMeaningful: 1 } },
        },
      }).s,
    ).toBeCloseTo(0.5, 5);
    expect(run("A2", { static: { images: { content: 0 } } }).status).toBe("not_applicable");
  });
  it("A3 penalises unnamed and generic links", () => {
    expect(run("A3", { static: { links: { total: 4, named: 4, generic: 2 } } }).s).toBeCloseTo(
      0.75,
      5,
    );
    expect(run("A3", { static: { links: { total: 0 } } }).status).toBe("not_applicable");
  });
  it("A4 wrapper 1, <html> only 0.5, none 0, ×0.5 on mismatch", () => {
    expect(run("A4").s).toBe(1);
    expect(run("A4", { static: { lang: { html: "en", wrapper: null } } }).s).toBe(0.5);
    expect(run("A4", { static: { lang: { html: null, wrapper: null } } }).s).toBe(0);
    expect(run("A4", {}, { language: "de" }).s).toBe(0.5);
  });
  it("A5 uses axe for an own render, else the static heuristic", () => {
    expect(
      run("A5", {
        render: { axe: { layoutTables: 4, presentationalLayoutTables: 1, violations: [] } },
      }).s,
    ).toBe(0.25);
    expect(
      CHECK_FUNCTIONS.A5(
        input({ static: { tables: { total: 2, layout: 2, presentational: 1 } } }, {}, false),
      ).s,
    ).toBe(0.5);
  });
  it("A6, A7 (k and spacing exception), A8, A9, A10, A11, A12, A13", () => {
    expect(
      run("A6", { render: { text: { headings: { visual: 4, markedUp: 2, h1: 1 } } } }).s,
    ).toBeCloseTo(0.65, 5);
    expect(
      run("A6", { render: { text: { headings: { visual: 0, markedUp: 0, h1: 0 } } } }).status,
    ).toBe("not_applicable");
    expect(
      run("A7", {
        render: {
          links: {
            targets: [
              [40, 30, false],
              [30, 10, false],
              [30, 10, true],
            ],
          },
        },
      }).s,
    ).toBeCloseTo(2 / 3, 5);
    expect(
      run("A7", { render: { layout: { k: 0.5 }, links: { targets: [[40, 40, false]] } } }).s,
    ).toBe(0);
    expect(run("A8", { render: { links: { inline: 4, inlineDistinguishable: 3 } } }).s).toBe(0.75);
    expect(run("A9", { static: { title: false } }).s).toBe(0);
    expect(run("A10", { static: { aria: { roleButtonOnLink: 1 } } }).s).toBe(0);
    expect(
      run("A11", {
        static: { script: { kind: "rtl", cased: false }, dir: { html: "ltr", wrapper: null } },
      }).s,
    ).toBe(0);
    expect(
      run("A11", {
        static: { script: { kind: "rtl", cased: false }, dir: { html: "rtl", wrapper: null } },
      }).s,
    ).toBe(1);
    expect(run("A12", { render: { text: { readingOrderTau: 0.89 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("A13").status).toBe("not_evaluated");
  });
});

describe("mobile (§5.2)", () => {
  it("M1/M2 ramp k and k_nomq; M2 not evaluated in the lite profile", () => {
    expect(run("M1", { render: { layout: { k: 0.85 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("M2", { render: { layout: { kNomq: 0.875 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("M2", { render: { layout: { kNomq: null } } }).status).toBe("not_evaluated");
  });
  it("M3 and M7 apply k to widths and gutters", () => {
    expect(
      run("M3", {
        render: {
          layout: { k: 0.625 },
          text: {
            blockWidths: [
              [380, 500],
              [600, 500],
            ],
          },
        },
      }).s,
    ).toBe(0.5);
    // render-2026.4 `proseWidths`: only paragraph text under 200px (× k) is squeezed; a 170px
    // card grid's blurbs (in blockWidths, not proseWidths) are not.
    expect(
      run("M3", {
        render: {
          layout: { k: 1 },
          text: {
            blockWidths: [
              [170, 600],
              [340, 400],
            ],
            proseWidths: [
              [170, 150],
              [340, 400],
            ],
          },
        },
      }).s,
    ).toBeCloseTo(0.85, 5);
    expect(
      run("M3", {
        render: {
          layout: { k: 0.5 },
          text: { blockWidths: [[340, 400]], proseWidths: [[340, 400]] },
        },
      }).s,
    ).toBe(0);
    expect(
      run("M7", {
        render: {
          layout: { k: 0.5 },
          text: {
            gutters: [
              [20, 800],
              [30, 200],
            ],
          },
        },
      }).s,
    ).toBeCloseTo(0.2, 5);
  });
  it("M4 ramps the visible button's min side × k; N/A without a CTA", () => {
    const box = { x: 0, y: 0, w: 200, h: 30 };
    expect(run("M4", { render: { cta: { primary: { target: box, visual: box } } } }).s).toBeCloseTo(
      0.5,
      5,
    );
    expect(run("M4", { render: { cta: { primary: null } } }).status).toBe("not_applicable");
  });
  it("M4 sizes the painted button, not its inner link; only-the-text-tappable costs half", () => {
    // A 46px padded cell around a 20px link (methodology 2026.5: was "only 20px tall").
    const cell = { target: { x: 0, y: 0, w: 120, h: 20 }, visual: { x: 0, y: 0, w: 200, h: 46 } };
    const seen = run("M4", { render: { cta: { primary: cell } } });
    expect(seen.s).toBe(1);
    expect(seen.value).toMatchObject({ minSidePx: 46, targetPx: 20, textOnlyTap: false });
    const textOnly = run("M4", { render: { cta: { primary: { ...cell, textOnlyTap: true } } } });
    expect(textOnly.s).toBeCloseTo((1 + 4 / 28) / 2, 5);
    expect(textOnly.value).toMatchObject({ textOnlyTap: true, shrinkOnly: false });
  });
  it("M5 averages viewport fit, aspect and sharpness", () => {
    const s = run("M5", {
      render: {
        images: {
          adapt: [
            { withinViewport: false, aspectDev: 0.2, sharpRatio: 1, renderedWidth: 600 },
            { withinViewport: true, aspectDev: 0, sharpRatio: 2, renderedWidth: 600 },
          ],
        },
      },
    }).s;
    expect(s).toBeCloseTo(0.5, 5);
  });
  it("M6 simulates partial and full inversion; pure black on white loses under full inversion", () => {
    const safe = run("M6").s!;
    const black = run("M6", {
      render: {
        contrast: {
          groups: [
            {
              fg: "#000000",
              bg: "#ffffff",
              ratio: 21,
              p90: null,
              method: "color",
              large: false,
              role: "body",
              rendered: true,
              short: false,
              chars: 1000,
            },
          ],
        },
      },
    }).s!;
    expect(black).toBeGreaterThanOrEqual(0.5);
    expect(safe).toBeGreaterThan(0);
    const darkLogo = run("M6", {
      render: { images: { darkMode: [{ partial: 0.1, full: 0.1 }] } },
    }).s!;
    expect(darkLogo).toBeLessThan(safe);
  });
});

describe("typography (§5.3)", () => {
  it("T1 applies k; T2 desktop size; T3–T5 need ≥ 3 paragraph lines", () => {
    expect(
      run("T1", { render: { layout: { k: 0.875 }, text: { body: { mobile: 16 } } } }).s,
    ).toBeCloseTo(0.5, 5);
    expect(run("T2", { render: { text: { body: { desktop: 12.5 } } } }).s).toBeCloseTo(0.5, 5);
    expect(run("T3", { render: { text: { lineRatio: 1.25 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("T3", { render: { text: { paragraphLines: 2 } } }).status).toBe("not_applicable");
    expect(run("T4", { render: { text: { charsPerLine: 95 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("T4", { render: { text: { script: "cjk", charsPerLine: 30 } } }).s).toBe(1);
    expect(run("T5", { render: { text: { alignment: { chars: 1000, badChars: 250 } } } }).s).toBe(
      0.75,
    );
  });
  it("T6 counts families by metric alias group and sizes ≥ 1%", () => {
    const five = {
      used: {
        v: 1 as const,
        stacks: ["Arial", "Helvetica", "Georgia", "Verdana", "Tahoma", "Courier New"].map(
          (css) => ({
            css,
            chars: 200,
            cjkChars: 0,
            roles: { heading: 0, body: 200, button: 0, navigation: 0, footer: 0 },
            weights: [[400, 200]] as Array<[number, number]>,
            otherWeightChars: 0,
          }),
        ),
        otherChars: 0,
        totalChars: 1200,
        imageTextCount: null,
      },
    };
    expect(run("T6", { fonts: five }).s).toBeCloseTo(0.5, 5);
    expect(run("T6").s).toBe(1);
  });
  it("T7 render measure for an own render, static heuristic otherwise; N/A for caseless scripts", () => {
    expect(run("T7", { render: { text: { caps: { chars: 1000, caps: 175 } } } }).s).toBeCloseTo(
      0.5,
      5,
    );
    expect(run("T7", { render: { text: { caps: null } } }).status).toBe("not_applicable");
    expect(
      CHECK_FUNCTIONS.T7(input({ static: { caps: { chars: 1000, caps: 300 } } }, {}, false)).s,
    ).toBe(0);
  });
  it("T8 English only, ≥ 100 words", () => {
    expect(run("T8").status).toBe("pass");
    expect(run("T8", {}, { language: "fr" }).status).toBe("not_applicable");
    expect(
      run("T8", { static: { prose: { words: 50, sentences: 3, syllables: 60 } } }).status,
    ).toBe("not_applicable");
  });
});

describe("hierarchy (§5.4)", () => {
  it("H1 button-like CTA; H2 bottom edge × k; H3 components; H5 distinct actions; H6 scale", () => {
    expect(run("H1", { render: { cta: { buttonLike: 0, primary: null } } }).s).toBe(0);
    expect(
      run("H2", { render: { cta: { primary: { visual: { x: 0, y: 1152, w: 200, h: 48 } } } } }).s,
    ).toBeCloseTo(0.5, 5);
    expect(
      run("H2", { render: { cta: { primary: { visual: { x: 0, y: 3000, w: 200, h: 48 } } } } }).s,
    ).toBe(0.1);
    expect(run("H2", { render: { cta: { primary: null } } }).s).toBe(0);
    expect(
      run("H3", {
        render: {
          cta: {
            primary: {
              labelContrast: 3.75,
              fillLumRatio: 1,
              fillDeltaE: 22.5,
              mostProminent: false,
            },
          },
        },
      }).s,
    ).toBeCloseTo(0.5, 5);
    expect(run("H5", { render: { cta: { firstTwoViewportsDistinct: 4 } } }).s).toBe(0.4);
    expect(
      run("H6", { render: { text: { firstViewportMaxPx: 21.6, medianAll: { mobile: 16 } } } }).s,
    ).toBeCloseTo(0.5, 5);
  });
  it("H4 label clarity lexicon", () => {
    expect(labelClarity("Shop rain shells", "en")).toBe(1);
    expect(labelClarity("Click here", "en")).toBe(0.4);
    expect(labelClarity("Learn more", "en")).toBe(0.4);
    expect(labelClarity("Your autumn picks", "en")).toBe(0.7);
    expect(labelClarity("Découvrir la collection", "fr")).toBe(1);
  });
  it("applicability matrix: H1–H2 action types only; H3–H5 only with a button for other types", () => {
    const promo = input();
    const news = input({}, { primaryType: "newsletter" });
    const newsNoButton = input(
      { render: { cta: { buttonLike: 0, primary: null } } },
      { primaryType: "newsletter" },
    );
    expect(inapplicableReason("H1", promo)).toBeNull();
    expect(inapplicableReason("H2", news)).toBe("type");
    expect(inapplicableReason("H3", news)).toBeNull();
    expect(inapplicableReason("H3", newsNoButton)).toBe("type_without_button");
    for (const t of ["promotional", "product_update", "lifecycle", "event", "survey"] as const)
      expect(inapplicableReason("H1", input({}, { primaryType: t }))).toBeNull();
    for (const t of [
      "newsletter",
      "community",
      "social",
      "notification",
      "transactional",
      "account_security",
      "account_notice",
      "other",
    ] as const) {
      expect(inapplicableReason("H2", input({}, { primaryType: t }))).toBe("type");
    }
    expect(inapplicableReason("H6", newsNoButton)).toBeNull();
    expect(inapplicableReason("H7", newsNoButton)).toBeNull();
  });
});

describe("images (§5.5)", () => {
  it("I1 N/A below 25% image share; I2 without OCR; I3 link rot; I4; I5", () => {
    expect(run("I1", { render: { images: { share: 0.2 } } }).status).toBe("not_applicable");
    expect(
      run("I1", { render: { images: { share: 0.6 }, text: { chars: { legible: 275 } } } }).s,
    ).toBeCloseTo(0.5, 5);
    expect(
      run("I2", {
        render: { text: { firstViewportLegible: 25 }, cta: { primary: { live: false } } },
      }).s,
    ).toBeCloseTo(0.25, 5);
    const ok = Array.from({ length: 9 }, () => ({ status: 200, decoded: true }));
    expect(
      run("I3", {
        render: {
          images: {
            loads: [...ok, { status: 404, decoded: false }, { status: "blocked", decoded: false }],
          },
        },
      }).s,
    ).toBeCloseTo(0.5, 5);
    expect(
      run("I3", {
        render: { images: { loads: [...ok.slice(0, 3), { status: 200, decoded: false }] } },
      }).s,
    ).toBe(0);
    expect(
      run("I3", { render: { images: { loads: [{ status: "blocked", decoded: false }] } } }).status,
    ).toBe("not_evaluated");
    expect(run("I4", { render: { imagesOff: { on: 100, off: 50 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("I4", { render: { imagesOff: null } }).status).toBe("not_evaluated");
    expect(run("I5", { render: { images: { bytes: 2 * 1024 * 1024 } } }).s).toBeCloseTo(0.5, 5);
  });
});

describe("layout (§5.6)", () => {
  it("L1 band; L2/L3 priors; L4; L5; L6; L7", () => {
    expect(
      run("L1", { render: { layout: { mainContainer: { x: 0, y: 0, w: 380, h: 100 } } } }).s,
    ).toBeCloseTo(0.5, 5);
    expect(run("L2").status).toBe("pass");
    expect(run("L2", { render: { pixels: { whitespace: 0.1 } } }).s).toBe(0);
    expect(run("L3").status).toBe("pass");
    expect(
      run("L3", { render: { pixels: { edgeDensity: 0.4, pngBytesPerPixel: 4, xyLeaves: 150 } } }).s,
    ).toBe(0);
    expect(run("L4", { render: { text: { alignmentAnchors: 10 } } }).s).toBeCloseTo(0.5, 5);
    expect(
      run("L6", { render: { cta: { buttonStyles: 4 }, components: { gapClusters: 5 } } }).s,
    ).toBeCloseTo(0.65, 5);
    expect(
      run("L7", { render: { images: { logoTop: false }, components: { accentHues: 3 } } }).s,
    ).toBeCloseTo(0.25, 5);
  });
});

describe("content (§5.7)", () => {
  it("C1 subject rules", () => {
    expect(run("C1").s).toBe(1);
    expect(run("C1", {}, { subject: "FLASH SALE EVERYTHING MUST GO NOW!!! ?!" }).s!).toBeLessThan(
      0.7,
    );
    expect(run("C1", {}, { subject: "" }).s).toBe(0);
    expect(run("C1", {}, { subject: null }).status).toBe("not_evaluated");
    expect(isAllCapsSubject("RE: BIG NEWS FOR YOU")).toBe(true);
    expect(isAllCapsSubject("SALE")).toBe(false);
  });
  it("C2 preview text: boilerplate 0, length band, subject similarity penalty", () => {
    expect(run("C2", {}, { snippet: "View this email in your browser" }).s).toBe(0);
    expect(run("C2", {}, { snippet: "Rain shells, 25% off this weekend" }).s!).toBeLessThan(0.9);
    expect(bigramSimilarity("abc def", "abc def")).toBe(1);
  });
  it("C3 N/A under 150 words; C5 by type", () => {
    expect(run("C3", { render: { text: { words: 100 } } }).status).toBe("not_applicable");
    expect(run("C5", { render: { layout: { mobileHeight: 5400 } } }).s).toBeCloseTo(0.5, 5);
    expect(
      run("C5", { render: { layout: { mobileHeight: 2700 } } }, { primaryType: "transactional" }).s,
    ).toBeCloseTo(0.5, 5);
    expect(inapplicableReason("C5", input({}, { primaryType: "newsletter" }))).toBe("type");
  });
});

describe("technical and footer (§5.8, §5.9)", () => {
  it("X1 near and over the clip", () => {
    expect(run("X1", { static: { htmlBytes: 96_000 } }).s).toBeCloseTo(0.75, 5);
    expect(
      run("X1", {
        static: { htmlBytes: 130_000 },
        render: { clip: { visibleChars: 1000, afterClipChars: 500 } },
      }).s,
    ).toBeCloseTo(0.25, 5);
  });
  it("X2 compatibility risk falls with unsupported features lacking fallbacks", () => {
    expect(run("X2").s).toBe(1);
    const flex = run("X2", { static: { compat: [{ id: "flex", fallback: false }] } }).s!;
    const flexFallback = run("X2", { static: { compat: [{ id: "flex", fallback: true }] } }).s!;
    expect(flex).toBeLessThan(1);
    expect(flexFallback).toBe(1);
    const tnr = run("X2", {
      fonts: {
        static: {
          declarations: [
            {
              family: "Helvetica",
              provider: "Google Fonts",
              method: "link",
              weights: [400],
              variable: null,
              italic: false,
              msoFontAlt: null,
              hiddenFromOutlook: false,
            },
          ],
        },
      },
    }).s!;
    expect(tnr).toBeLessThan(1);
  });
  it("X3 defect classes and https share; X4 style budget", () => {
    expect(run("X3", { static: { mergeTags: { body: 1 } } }).s).toBe(0.75);
    expect(
      run("X3", { static: { links: { emptyOrHash: 1, placeholder: 1, http: 3, https: 3 } } }).s,
    ).toBeCloseTo(0.375, 5);
    expect(run("X3", {}, { linkDnsFailures: 2 }).s).toBe(0.75);
    expect(run("X4", { static: { style: { bytes: 24 * 1024 } } }).s).toBeCloseTo(0.5, 5);
    expect(run("X4", { static: { style: { bytes: 8000, mediaAfterLimit: true } } }).s).toBe(0.5);
  });
  it("U1–U4 and footer applicability", () => {
    expect(
      run("U1", {
        static: { footer: { unsubscribe: "after_clip" } },
        render: { clip: { unsubscribeAfterClip: true } },
      }).s,
    ).toBe(0.3);
    expect(
      run("U2", {
        render: { layout: { k: 1 }, footer: { unsubscribe: { px: 10.5, contrast: 3.5 } } },
      }).s,
    ).toBeCloseTo(0.5, 5);
    expect(run("U3", { static: { footer: { preferences: false } } }).s).toBe(0);
    for (const t of ["transactional", "account_security", "account_notice"] as const)
      expect(inapplicableReason("U1", input({}, { primaryType: t }))).not.toBeNull();
    expect(inapplicableReason("U1", input({}, { isSubscription: false }))).not.toBeNull();
    expect(inapplicableReason("U1", input())).toBeNull();
  });
});

describe("AI checks (§6)", () => {
  it("credit (level−1)/4; pending, refused and C4-from-template are not evaluated; I6 null → N/A", () => {
    expect(run("H7").s).toBe(0.75);
    expect(run("H7", { ai: null }).status).toBe("not_evaluated");
    expect(run("L8", { ai: baseAi({ refused: true }) }).status).toBe("not_evaluated");
    expect(run("C4", { ai: baseAi({ source: "template" }) }).status).toBe("not_evaluated");
    expect(
      run("I6", { ai: baseAi({ criteria: { I6: { level: null, evidence: "", region: "top" } } }) })
        .status,
    ).toBe("not_applicable");
    expect(run("I6", { render: { images: { content: 0 } } }).status).toBe("not_applicable");
  });
  it("flagged reviews are capped at the corpus median (never skipped)", () => {
    const five = baseAi({
      criteria: { H7: { level: 5, evidence: "x", region: "top" } },
      injectionPatternHit: true,
    });
    const o = run("H7", { ai: five });
    expect(o.status).toBe("partial");
    expect(o.s).toBe(0.5);
  });
});
