/**
 * The gallery's verdict and reason rules for summaries saved by scoring 2026.5 or later
 * (lib/gallery.ts VERDICT POLICY / REASON POLICY, set on the 2026-10-01 verdict audit), no
 * database (gallery-verdict-signals.test.ts checks the SQL twin against the same rules):
 *  - each Bad rule at its edges: pictures that didn't load, text in pictures, phones, the
 *    unsubscribe link after Gmail's cut, marketing mail without an unsubscribe link — and rows
 *    scored before 2026.5 keep the v1.5 rules;
 *  - the Problems options map one to one to the Bad rules: a scored design has an option exactly
 *    when it is Bad;
 *  - the reasons: a "not Good because" line per failed Excellent-gate bar with the value and the
 *    bar, weak problems never lead a card, no strength the facts don't back up or a problem
 *    contradicts;
 *  - the bars and limits agree with the scoring engine's own.
 * Every fixture is synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  CLIP_BYTES,
  excellenceGate,
  METHODOLOGY_VERSION,
  PHONE_PROBLEM_SHARE as ENGINE_PHONE_SHARE,
  SCORING_VERSION,
} from "@edf/design";
import { RENDERER_VERSION } from "@edf/render";
import * as ENGINE from "../../../../packages/design/src/scoring/excellence";
import {
  COMPETING_BUTTONS_MIN,
  CTA_SALIENCE_MIN,
  GALLERY_PROBLEMS,
  GMAIL_CLIP_KB,
  GOOD_SCORE_MIN,
  HEADLINE_RATIO_MIN,
  HERO_BAND_CONTRAST_MIN,
  HERO_PICTURE_AREA_MIN,
  HERO_PICTURE_WIDTH_MIN,
  HTML_PASS_METHODOLOGY,
  HTML_PASS_RENDERER,
  IMAGERY_SHARE_MIN,
  PHONE_PROBLEM_SHARE,
  SHRINK_K_MAX,
  TINY_PHONE_TEXT_PX,
  currentHtmlPass,
  currentSignals,
  galleryCategoryOf,
  galleryProblemsOf,
  galleryReason,
  picturesUnknown,
  severeTriggers,
  verdictOf,
  type RenderFacts,
  type VerdictInput,
} from "@/lib/gallery";

/** Signals as scoring 2026.5 saves them for a clean, phone-friendly marketing email. */
const CURRENT = {
  imgShare: 0.2,
  legibleChars: null,
  phoneTextPx: 16,
  layoutK: 1,
  unsubscribe: "before_clip",
  primaryType: "promotional",
  headlineRatio: 2,
  hasHeadline: true,
  ctaSalience: 1,
  ctaMostProminent: true,
  ctaFirstScreen: true,
  ctaLabelContrast: 7,
  gate: [] as string[],
  htmlContentImages: 4,
  drawnContentImages: 4,
  imagesOff: false,
  imagesUnknownShare: 0,
  staticUnsubscribe: "found",
  renderUnsubscribe: "found",
  unsubscribeUnion: "before_clip",
  liveTextChars: 900,
  htmlKB: 40,
};
const sig = (over: Record<string, unknown>) => ({ ...CURRENT, ...over });
/** Stored render and HTML-pass facts that back up "no main button" (nothing like a button). */
const BACKED: RenderFacts = {
  staticButtons: 0,
  buttons: 0,
  buttonLabels: 0,
  buttonStyles: 0,
  bigLinks: 0,
  missedImageReasons: [],
};

const scored = (signals: unknown, over: Partial<VerdictInput> = {}): VerdictInput => ({
  score: 88,
  band: "excellent",
  capped: false,
  provisional: false,
  caps: [],
  issues: [],
  source: "render",
  coverageConfidence: 0.9,
  signals,
  ...over,
});

type Item = { key: string; title: string; points: number; ai: boolean };
const item = (key: string, title: string, points = 1): Item => ({ key, title, points, ai: false });
const check = (id: string, status: string, value: Record<string, unknown> = {}, lost?: number) => ({
  id,
  status,
  w: 2,
  pointsLost: lost ?? (status === "pass" ? 0 : 1),
  value,
});
const empty = { needsImprovement: [] as Item[], good: [] as Item[] };

describe("current rules: each Bad rule at its edges", () => {
  it("only summaries with the 2026.5 keys use them", () => {
    expect(currentSignals(CURRENT)).toBe(true);
    expect(currentSignals({ ...CURRENT, unsubscribeUnion: null })).toBe(true);
    const { unsubscribeUnion: _gone, ...legacy } = CURRENT;
    expect(currentSignals(legacy)).toBe(false);
    for (const junk of [null, undefined, 3, "x", [], [CURRENT]])
      expect(currentSignals(junk)).toBe(false);
    expect(severeTriggers(CURRENT)).toEqual([]);
    expect(verdictOf(scored(CURRENT))).toBe("good");
  });

  it("just pictures that didn't load: ≥ 1 declared, none drawn, < 200 characters of real text", () => {
    const at = (over: Record<string, unknown>) =>
      severeTriggers(sig({ liveTextChars: 51, ...over }));
    expect(at({ htmlContentImages: 1, drawnContentImages: 0 })).toEqual(["pictures_not_loaded"]);
    expect(at({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: 199 })).toEqual([
      "pictures_not_loaded",
    ]);
    expect(at({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: 200 })).toEqual([]);
    expect(at({ htmlContentImages: 1, drawnContentImages: 1 })).toEqual([]);
    expect(at({ htmlContentImages: 0, drawnContentImages: 0 })).toEqual([]);
    // Images off for the email (our choice, not the sender's): drawn is null and never counts.
    expect(at({ htmlContentImages: 2, drawnContentImages: null, imagesOff: true })).toEqual([]);
    expect(at({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: null })).toEqual([]);
    expect(
      verdictOf(scored(sig({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: 51 }))),
    ).toBe("bad");
  });

  it("doesn't fit phones: shrinks below 80% AND text under 12.5 px", () => {
    const at = (layoutK: number | null, phoneTextPx: number | null) =>
      severeTriggers(sig({ layoutK, phoneTextPx }));
    expect(at(0.79, 12.4)).toEqual(["tiny_phone_text"]);
    expect(at(SHRINK_K_MAX, 10)).toEqual([]);
    expect(at(0.7, TINY_PHONE_TEXT_PX)).toEqual([]);
    // v1.5 called this Bad (any shrink, under 11.5 px); now it's Okay.
    expect(at(0.81, 11.3)).toEqual([]);
    expect(at(null, 9)).toEqual([]);
  });

  it("the unsubscribe link after Gmail's cut is Bad for every type", () => {
    for (const primaryType of ["promotional", "social", "notification", "transactional"])
      expect(
        severeTriggers(sig({ primaryType, unsubscribeUnion: "after_clip" })),
        primaryType,
      ).toEqual(["unsubscribe_clipped"]);
    expect(severeTriggers(sig({ unsubscribeUnion: "before_clip" }))).toEqual([]);
  });

  it("no unsubscribe link: marketing mail only, whatever the subscription flag said", () => {
    expect(severeTriggers(sig({ unsubscribeUnion: "none", unsubscribe: null }))).toEqual([
      "no_unsubscribe",
    ]);
    for (const primaryType of [
      "notification",
      "transactional",
      "account_notice",
      "lifecycle",
      "social",
      "newsletter",
    ])
      expect(severeTriggers(sig({ primaryType, unsubscribeUnion: "none" })), primaryType).toEqual(
        [],
      );
    // One pass found nothing and the other couldn't look: not known, never Bad.
    expect(severeTriggers(sig({ unsubscribeUnion: null }))).toEqual([]);
    // The v1.5 signal (only where U1 applies) no longer decides once the union is saved.
    expect(severeTriggers(sig({ unsubscribe: "none", unsubscribeUnion: "before_clip" }))).toEqual(
      [],
    );
  });

  it("rows scored before 2026.5 keep the v1.5 rules", () => {
    const legacy = {
      imgShare: 0.1,
      legibleChars: null,
      phoneTextPx: 11.3,
      layoutK: 0.81,
      unsubscribe: "none",
    };
    expect(severeTriggers(legacy)).toEqual(["tiny_phone_text", "no_unsubscribe"]);
    expect(severeTriggers({ ...legacy, phoneTextPx: 16, unsubscribe: "after_clip" })).toEqual([]);
  });

  it("Bad always wins over a high score; Good needs ≥ 85 and nothing Bad", () => {
    expect(verdictOf(scored(sig({ unsubscribeUnion: "after_clip" }), { score: 95 }))).toBe("bad");
    expect(verdictOf(scored(CURRENT, { score: 84, band: "good" }))).toBe("ok");
    expect(verdictOf(scored(CURRENT, { score: 59, band: "needs_work" }))).toBe("bad");
  });
});

describe("Problems options: one per Bad rule", () => {
  it("each rule has its option, and a scored design has an option exactly when it is Bad", () => {
    const cases: Array<[VerdictInput, string[]]> = [
      [scored(CURRENT), []],
      [
        scored(sig({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: 0 })),
        ["image_only"],
      ],
      [scored(sig({ imgShare: 0.9, legibleChars: 40 })), ["image_only"]],
      [scored(sig({ layoutK: 0.6, phoneTextPx: 9 })), ["mobile"]],
      [scored(sig({ unsubscribeUnion: "after_clip" })), ["clipped"]],
      [scored(sig({ unsubscribeUnion: "none" })), ["no_unsubscribe"]],
      [
        scored(CURRENT, { caps: ["CAP_CONTRAST"], capped: true, score: 59, band: "needs_work" }),
        ["contrast", "low_score"],
      ],
      [scored(CURRENT, { caps: ["CAP_MERGE_TAG"], score: 69, band: "needs_work" }), ["merge_tag"]],
      [
        scored(CURRENT, {
          caps: ["CAP_CLIPPED"],
          issues: ["clipped"],
          score: 69,
          band: "needs_work",
        }),
        ["clipped"],
      ],
      [
        scored(CURRENT, { caps: ["CAP_BROKEN_IMAGES"], score: 59, band: "needs_work" }),
        ["broken_images", "low_score"],
      ],
      [scored(CURRENT, { caps: ["CAP_MOBILE_BROKEN"], score: 64, band: "needs_work" }), ["mobile"]],
      [
        scored(CURRENT, { caps: ["CAP_IMAGE_ONLY"], score: 49, band: "poor" }),
        ["image_only", "low_score"],
      ],
      [scored(CURRENT, { score: 55, band: "needs_work" }), ["low_score"]],
      [scored(CURRENT, { score: null, band: null, caps: ["CAP_CLIPPED"] }), []],
    ];
    for (const [d, want] of cases) {
      const got = galleryProblemsOf(d);
      expect(got, JSON.stringify(d)).toEqual(want);
      if (d.score !== null) expect(got.length > 0, JSON.stringify(d)).toBe(verdictOf(d) === "bad");
    }
    // Every option is reachable from some Bad rule.
    const reached = new Set(cases.flatMap(([, w]) => w));
    expect([...reached].sort()).toEqual([...GALLERY_PROBLEMS].sort());
  });
});

describe("reasons for the current rules", () => {
  it("each Bad rule leads its card in plain, checkable words", () => {
    const card = (signals: unknown) => galleryReason("bad", empty, { signals }).reason?.text;
    expect(card(sig({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: 51 }))).toBe(
      "Most of this email is one picture that didn't load: only 51 characters of real text",
    );
    // Pictures that did load: the text-in-pictures wording.
    expect(card(sig({ imgShare: 0.87, legibleChars: 97, liveTextChars: 97 }))).toBe(
      "Most of this email is pictures: only 97 characters of real text",
    );
    // One decimal, as the detail and "How we judged this" say it, never rounded onto the bar.
    expect(card(sig({ layoutK: 0.66, phoneTextPx: 10.508 }))).toBe(
      "Doesn't fit phones: text shrinks to about 10.5 px",
    );
    expect(card(sig({ layoutK: 0.6, phoneTextPx: 12.46 }))).toBe(
      "Doesn't fit phones: text shrinks to about 12.4 px",
    );
    const phone = galleryReason("bad", empty, {
      signals: sig({ layoutK: 0.66, phoneTextPx: 10.508 }),
    });
    expect(phone.problems[0]).toBe(
      "Doesn't fit phones: the layout shrinks to 66%, so body text is only about 10.5 px",
    );
    expect(card(sig({ unsubscribeUnion: "after_clip", htmlKB: 136.4 }))).toBe(
      "Gmail cuts this email off (136 KB; Gmail's limit is 102 KB) and hides the unsubscribe link",
    );
    // Just over the limit never reads "102 KB; Gmail's limit is 102 KB".
    expect(card(sig({ unsubscribeUnion: "after_clip", htmlKB: 102.3 }))).toBe(
      "Gmail cuts this email off (just over 102 KB; Gmail's limit is 102 KB) and hides the unsubscribe link",
    );
    expect(card(sig({ unsubscribeUnion: "none" }))).toBe(
      "No unsubscribe link anywhere in this marketing email",
    );
  });

  it("the clipping cap says what the cut hides", () => {
    const capped = galleryReason(
      "bad",
      {
        needsImprovement: [
          item(
            "cap:CAP_CLIPPED",
            "Cut off in Gmail: 131 KB, so readers see “[Message clipped]” before the button",
            9,
          ),
        ],
        good: [],
      },
      { signals: sig({ unsubscribeUnion: "after_clip", htmlKB: 131 }), caps: ["CAP_CLIPPED"] },
    );
    expect(capped.reason?.text).toBe(
      "Gmail cuts this email off (131 KB; Gmail's limit is 102 KB) and hides the main button and the unsubscribe link",
    );
    // One root cause: the unsubscribe-after-the-cut line isn't repeated.
    expect(capped.problems).toHaveLength(1);
    const share = galleryReason(
      "bad",
      {
        needsImprovement: [
          item(
            "cap:CAP_CLIPPED",
            "Cut off in Gmail: 140 KB, readers see “[Message clipped]” and miss 40% of it",
            9,
          ),
        ],
        good: [],
      },
      { signals: sig({ htmlKB: 140 }), caps: ["CAP_CLIPPED"] },
    );
    expect(share.reason?.text).toBe(
      "Gmail cuts this email off (140 KB; Gmail's limit is 102 KB), hiding 40% of it",
    );
  });

  it("a missing unsubscribe link is listed for marketing mail only", () => {
    const u1 = { needsImprovement: [item("check:U1", "No unsubscribe link", 2)], good: [] };
    const listed = (primaryType: string) =>
      galleryReason("ok", u1, { signals: sig({ primaryType, unsubscribeUnion: "none" }) }).problems;
    expect(listed("newsletter")).toEqual(["No visible unsubscribe link"]);
    expect(listed("lifecycle")).toEqual([]);
    expect(listed("notification")).toEqual([]);
  });

  const gated = (
    gate: string[],
    over: Record<string, unknown> = {},
    checks: unknown[] = [],
    render: RenderFacts | null = BACKED,
  ) =>
    galleryReason(
      "ok",
      {
        needsImprovement: [
          item(
            "gate:excellence",
            "Plain design: headline 1.1× the body text, no standout button",
            6,
          ),
        ],
        good: [],
      },
      { signals: sig({ gate, primaryType: "notification", ...over }), checks, render },
    );

  it("one 'not Good because' line per failed bar, with what was measured and what Good needs", () => {
    const r = gated(["headline", "button", "imagery"], {
      headlineRatio: 1.14,
      ctaSalience: 0.4,
      imgShare: 0.031,
    });
    expect(r.problems).toEqual([
      "No real headline (the biggest text is 1.1× the body text; Good needs 1.5×)",
      "The main button doesn't stand out enough: its colour is close to the background's",
      "Few pictures for this kind of email (3%; Good needs 8%)",
    ]);
    expect(r.reason).toEqual({ kind: "problem", text: r.problems[0] });
    // Never rounded up to the bar it misses.
    expect(gated(["headline"], { headlineRatio: 1.49 }).problems[0]).toBe(
      "No real headline (the biggest text is 1.4× the body text; Good needs 1.5×)",
    );
    expect(gated(["imagery"], { imgShare: 0.0799 }).problems[0]).toBe(
      "Few pictures for this kind of email (7%; Good needs 8%)",
    );
    expect(gated(["imagery"], { imgShare: 0.004 }).problems[0]).toBe(
      "Few pictures for this kind of email (under 1%; Good needs 8%)",
    );
  });

  it("each bar is worded by what the facts say", () => {
    expect(gated(["headline"], { hasHeadline: false, htmlContentImages: 0 }).problems[0]).toBe(
      "No headline (Good needs one at least 1.5× the body text)",
    );
    expect(gated(["headline"], { hasHeadline: false, htmlContentImages: 3 }).problems[0]).toBe(
      "No headline in real text (Good needs one at least 1.5× the body text)",
    );
    // No button measured, and the stored render and HTML pass back it up: the line may lead.
    const none = gated(["button"], { ctaSalience: null });
    expect(none.problems[0]).toBe("No main button (Good needs one that stands out)");
    expect(none.reason?.text).toBe(none.problems[0]);
    // …not when either pass suggests a button the render missed, nor when they aren't stored.
    expect(
      gated(["button"], { ctaSalience: null }, [], { ...BACKED, staticButtons: 1 }).problems,
    ).toEqual([]);
    expect(
      gated(["button"], { ctaSalience: null }, [], { ...BACKED, bigLinks: 1 }).problems,
    ).toEqual([]);
    expect(gated(["button"], { ctaSalience: null }, [], null).problems).toEqual([]);
    // The main action is a picture (I2: not live text): a button the reader sees is part of it.
    expect(
      gated(["button"], { ctaSalience: null, imgShare: 0.86 }, [
        check("I2", "fail", { ctaLive: false, firstViewportChars: 20 }),
      ]).problems[0],
    ).toBe("No real button: any button here is part of a picture (Good needs one that stands out)");
    // Pictures covering most of it aren't enough on their own (background pictures behind links).
    expect(gated(["button"], { ctaSalience: null, imgShare: 0.86 }).problems[0]).toBe(
      "No main button (Good needs one that stands out)",
    );
    // A bold button that doesn't lead: not "doesn't stand out".
    const h3 = check("H3", "partial", {
      present: true,
      label: "Apply now",
      salience: 1,
      mostProminent: false,
    });
    expect(
      gated(["button"], { ctaMostProminent: false, ctaFirstScreen: null }, [h3]).problems[0],
    ).toBe("Another link or picture in the email is bigger than the main button “Apply now”");
    expect(
      gated(["button"], { ctaMostProminent: false, ctaFirstScreen: false }, [h3]).problems[0],
    ).toBe(
      "The main button “Apply now” sits below the first phone screen, and another link or picture is bigger",
    );
    expect(gated(["imagery_unknown"]).problems[0]).toBe(
      "Most of its pictures couldn't be loaded, so they can't count toward Good",
    );
    expect(gated(["phone_narrow"], {}, [check("M3", "fail", { wideShare: 0.3 })]).problems[0]).toBe(
      "On phones, 70% of the text is squeezed into narrow columns (Good needs under 50%)",
    );
  });

  it("the gate's lines absorb the checks they stand for, and rule out the strengths they deny", () => {
    const checks = [
      check("H6", "partial", { ratio: 1.14, headline: true }),
      check("H3", "partial", { present: true, label: "Go", salience: 0.4, mostProminent: true }),
      check("H5", "pass", { distinct: 1 }),
      check("H1", "pass", { present: true }),
      check("M1", "pass", { k: 1 }),
    ];
    const r = gated(["headline", "button"], { headlineRatio: 1.14, ctaSalience: 0.4 }, checks);
    expect(r.problems).toEqual([
      "No real headline (the biggest text is 1.1× the body text; Good needs 1.5×)",
      "The main button “Go” doesn't stand out enough: its colour is close to the background's",
    ]);
    expect(r.strengths.join(" | ")).not.toMatch(/headline|main button|clear button/i);
    expect(r.strengths).toContain("Fits a phone screen without shrinking");
  });

  it("older summaries without the bars keep one plain line, and a bold button isn't called weak", () => {
    const r = galleryReason(
      "ok",
      {
        needsImprovement: [
          item(
            "gate:excellence",
            "Plain design, nothing stands out: headline 1.1× the body text, weak button",
            6,
          ),
        ],
        good: [],
      },
      {
        checks: [
          check("H6", "fail", { ratio: 1.1 }),
          check("H3", "partial", { present: true, salience: 1, mostProminent: false }),
        ],
      },
    );
    expect(r.problems[0]).toBe(
      "A plain design: a headline no bigger than the text, and a main button that a bigger link outweighs",
    );
  });

  it("weak problems are listed but never lead the card", () => {
    const needs = {
      needsImprovement: [
        item("check:A1", "The small print is hard to read: grey on white (2.1:1)", 3),
        item("check:M3", "30% of body text sits in columns narrower than 250px on phones", 2),
        item("check:T4", "Lines average 5 characters", 2),
        item("check:A2", "3 of 4 images have no alt text", 2),
        item("check:T1", "Body text is 13px on phones", 1),
      ],
      good: [],
    };
    const checks = [
      check(
        "A1",
        "partial",
        { failShare: 0.05, worst: { fg: "#999999", bg: "#ffffff", ratio: 2.1, fine: true } },
        3,
      ),
      check("M3", "partial", { wideShare: 0.7 }, 2),
      check("T4", "partial", { charsPerLine: 5 }, 2),
      check("A2", "partial", { missingAlt: 3, images: 4 }, 2),
      check("T1", "partial", { px: 13 }, 1),
    ];
    const r = galleryReason("ok", needs, { checks, signals: sig({}) });
    // The one strong problem leads, the card and the list; the weak ones follow it.
    expect(r.reason?.text).toBe("Body text is only 13 px on phones");
    expect(r.problems).toEqual([
      "Body text is only 13 px on phones",
      "The small print is faint: light grey on white (2.1:1)",
      "On phones, 30% of the text is squeezed into narrow columns",
    ]);
    // Narrow columns on half the text or more is strong enough to lead.
    const half = galleryReason(
      "ok",
      {
        needsImprovement: [
          item("check:M3", "60% of body text sits in columns narrower than 250px on phones", 2),
        ],
        good: [],
      },
      { checks: [check("M3", "partial", { wideShare: 0.4 }, 2)] },
    );
    expect(half.reason?.text).toBe("On phones, 60% of the text is squeezed into narrow columns");
  });

  it("no alt-text problem for tracking pixels, no phone-styles what-if for an email that fits", () => {
    const r = galleryReason(
      "ok",
      {
        needsImprovement: [
          item("check:A2", "1 of 1 images have no alt text", 2),
          item("check:M2", "Without media queries the layout shrinks to 63%", 2),
        ],
        good: [],
      },
      {
        checks: [
          check("A2", "partial", { missingAlt: 1, images: 1 }, 2),
          check("M2", "partial", { kNomq: 0.63 }, 2),
          check("M1", "pass", { k: 1 }),
        ],
        signals: sig({ htmlContentImages: 0 }),
      },
    );
    expect(r.problems).toEqual([]);
  });

  it("a headline is only faulted in marketing mail", () => {
    const h6 = {
      needsImprovement: [item("check:H6", "The headline is barely larger than the text (1.1×)", 2)],
      good: [],
    };
    const listed = (primaryType: string, ratio = 1.3) =>
      galleryReason("ok", h6, {
        checks: [check("H6", "partial", { ratio, headline: true }, 2)],
        signals: sig({ primaryType }),
      }).problems;
    expect(listed("promotional")).toEqual([
      "The headline is barely bigger than the body text (1.3×)",
    ]);
    // Nothing bigger than the body text at the top: no headline to call "barely bigger".
    expect(listed("newsletter", 1)).toEqual([
      "No headline that stands out: the biggest text at the top is the size of the body text",
    ]);
    expect(listed("social")).toEqual([]);
    expect(
      galleryReason("ok", h6, {
        checks: [check("H6", "partial", { ratio: 1, headline: false, pictures: false }, 2)],
        signals: sig({}),
      }).problems,
    ).toEqual(["No headline"]);
  });

  it("strengths are claimed only when the facts back them", () => {
    const base = [
      check("H6", "pass", { ratio: 2, headline: true }),
      check("H5", "pass", { distinct: 1 }),
      check("H2", "pass", {}),
      check("M5", "pass", {}),
      check("I4", "pass", {}),
    ];
    const strengths = (h3: Record<string, unknown>, over: Record<string, unknown> = {}) =>
      galleryReason("good", empty, {
        checks: [...base, check("H3", "pass", { present: true, label: "Shop", ...h3 })],
        signals: sig(over),
      }).strengths.join(" | ");
    expect(strengths({ salience: 1, mostProminent: true })).toMatch(/A standout “Shop” button/);
    // Without H3's own pass (faint words), the focused-top strength still holds for a bold button.
    const focused = galleryReason("good", empty, {
      checks: [
        ...base,
        check("H3", "partial", {
          present: true,
          label: "Shop",
          salience: 1,
          mostProminent: true,
          labelContrast: 3.1,
        }),
      ],
      signals: sig({}),
    });
    expect(focused.strengths).toContain("One clear main button at the top");
    expect(
      galleryReason("good", empty, {
        checks: [
          ...base.filter((c) => c.id !== "H2"),
          check("H2", "fail", {}),
          check("H3", "partial", { present: true, salience: 1, mostProminent: true }),
        ],
        signals: sig({}),
      }).strengths.join(" | "),
    ).not.toMatch(/at the top/);
    // A filled button a bigger link outweighs isn't "standout", nor the one clear button up top.
    expect(strengths({ salience: 1, mostProminent: false })).not.toMatch(/standout|One clear/);
    expect(strengths({ salience: 0.5, mostProminent: true })).not.toMatch(/standout|One clear/);
    // Pictures that never loaded don't "resize cleanly".
    expect(strengths({ salience: 1, mostProminent: true }, { drawnContentImages: 0 })).not.toMatch(
      /resize cleanly|images turned off/,
    );
    expect(
      strengths({ salience: 1, mostProminent: true }, { imagesUnknownShare: 0.8 }),
    ).not.toMatch(/resize cleanly/);
    // No headline praise without heading text.
    const noHead = galleryReason("ok", empty, {
      checks: [check("H6", "pass", { ratio: 2, headline: false })],
      signals: sig({}),
    });
    expect(noHead.strengths.join(" | ")).not.toMatch(/headline/);
  });

  it("an email that is just pictures gets no text, layout or picture-button praise", () => {
    const checks = [
      check("I2", "fail", { ctaLive: false, firstViewportChars: 0 }),
      check("H3", "partial", {
        present: true,
        label: "Button: Save 55%",
        salience: 0,
        labelContrast: null,
        mostProminent: true,
      }),
      check("H2", "pass", { label: "Button: Save 55%" }),
      check("M1", "pass", { k: 1 }),
      check("L5", "pass", {}),
      check("T3", "pass", {}),
      check("M6", "pass", {}),
      check("M5", "pass", {}),
    ];
    const r = galleryReason("bad", empty, {
      checks,
      signals: sig({ imgShare: 0.87, legibleChars: 97 }),
    });
    expect(r.reason?.text).toBe("Most of this email is pictures: only 97 characters of real text");
    // Not even "Images resize cleanly on phones": its layout is the pictures.
    expect(r.strengths).toEqual([]);
    // Its picture button, its live text's size and its missing live headline are that one problem.
    const lost = [
      ...checks.filter((c) => c.id !== "H3"),
      check("T1", "fail", { px: 10 }, 2),
      check("H6", "fail", { ratio: 1, headline: false, pictures: true }, 2),
      check(
        "H3",
        "partial",
        {
          present: true,
          label: "Button: Save 55%",
          salience: 0,
          labelContrast: null,
          mostProminent: true,
        },
        2,
      ),
    ];
    expect(
      galleryReason("bad", empty, {
        checks: lost,
        signals: sig({ imgShare: 0.87, legibleChars: 97 }),
      }).problems,
    ).toEqual(["Most of this email is pictures: only 97 characters of real text"]);
  });

  it("no main button reads as such, never 'doesn't stand out'", () => {
    const noButton = {
      needsImprovement: [item("check:H3", "The main button “” doesn't stand out", 3)],
      good: [],
    };
    const h3 = [check("H3", "fail", { present: false }, 3)];
    const listed = (render: RenderFacts | null, over: Record<string, unknown> = {}, more = h3) =>
      galleryReason("ok", noButton, {
        checks: more,
        signals: sig({ ctaSalience: null, ...over }),
        render,
      });
    // Backed up by the stored render and HTML pass: listed, but never the card's line (a letter
    // or a notice needs no button).
    const backed = listed(BACKED);
    expect(backed.problems).toEqual(["No clear button for the main action"]);
    expect(backed.reason?.kind).not.toBe("problem");
    // Not listed when the HTML pass found a link painted as a button, the render a link box a
    // button's size (a long-label or table-cell button the render's finder missed), or when
    // neither is stored.
    expect(listed({ ...BACKED, staticButtons: 1 }).problems).toEqual([]);
    expect(listed({ ...BACKED, bigLinks: 2 }).problems).toEqual([]);
    expect(listed(null).problems).toEqual([]);
    expect(listed({ ...BACKED, staticButtons: null }).problems).toEqual([]);
    // The main action is a picture (I2): the button the reader sees is in it.
    expect(
      listed(BACKED, { imgShare: 0.86, legibleChars: 305 }, [
        ...h3,
        check("I2", "fail", { ctaLive: false, firstViewportChars: 40 }, 1),
      ]).problems,
    ).toContain("No real button for the main action: any button here is part of a picture");
    // Background pictures behind live-text links: not "part of a picture".
    expect(listed(BACKED, { imgShare: 0.86, legibleChars: 305 }).problems).toContain(
      "No clear button for the main action",
    );
    // In an email that is just pictures, the button (if any) is in the picture: nothing to add.
    const pictures = sig({
      ctaSalience: null,
      htmlContentImages: 1,
      drawnContentImages: 0,
      liveTextChars: 51,
    });
    expect(
      galleryReason("bad", noButton, { checks: h3, signals: pictures, render: BACKED }).problems,
    ).toEqual([
      "Most of this email is one picture that didn't load: only 51 characters of real text",
    ]);
  });

  it("phone text called small is never also called comfortable", () => {
    const r = galleryReason(
      "ok",
      { needsImprovement: [item("check:T1", "Body text is 14px on phones", 2)], good: [] },
      { checks: [check("T1", "partial", { px: 14 }, 2), check("T2", "pass", { px: 14 })] },
    );
    expect(r.problems).toEqual(["Body text is a little small on phones (14 px)"]);
    expect(r.strengths.join(" | ")).not.toMatch(/14 px/);
  });

  it("smaller wording fixes: SVG images, text-only tap areas, alt-text counts, short lines", () => {
    const one = (id: string, value: Record<string, unknown>, title = "") =>
      galleryReason(
        "ok",
        { needsImprovement: [item(`check:${id}`, title, 2)], good: [] },
        { checks: [check(id, "partial", value, 2)] },
      ).problems[0];
    expect(one("I3", { svg: 1, failed: 0, evaluated: 2 })).toBe(
      "One image is an SVG file, which Gmail doesn't show",
    );
    expect(one("M4", { minSidePx: 46, textOnlyTap: true, label: "Read more" })).toBe(
      "Only the words on the main button “Read more” can be tapped, not the whole button",
    );
    expect(one("M4", { minSidePx: 20, textOnlyTap: false })).toBe(
      "The main button is only 20 px tall on a phone — hard to tap",
    );
    expect(one("M4", { minSidePx: 36, textOnlyTap: false })).toBe(
      "The main button is a little small to tap on a phone (36 px tall)",
    );
    expect(one("A2", { missingAlt: 1, images: 6 })).toBe(
      "1 of 6 images has no description for people who can't see them",
    );
    expect(one("A2", { missingAlt: 1, images: 1 })).toBe(
      "Its only image has no description for people who can't see it",
    );
    expect(one("T4", { charsPerLine: 33 })).toBe("Lines are short (about 33 characters)");
    expect(one("T4", { charsPerLine: 14 })).toBe("Lines are very short (about 14 characters)");
  });

  it("a Bad design with no cap or severe problem says it's the low score", () => {
    const r = galleryReason(
      "bad",
      { needsImprovement: [item("check:A2", "3 of 4 images have no alt text", 2)], good: [] },
      { checks: [check("A2", "partial", { missingAlt: 3, images: 4 }, 2)], score: 55 },
    );
    expect(r.reason?.text).toBe(
      "Several problems add up to a low score (55 of 100; Bad is under 60)",
    );
  });
});

describe("review fixes (2026-10-01 policy review)", () => {
  it("text in pictures isn't Bad when most of the picture area wasn't drawn", () => {
    // A YouTube alert: its thumbnail blocked by our privacy proxy read as "pictures cover 100%".
    const youtube = sig({
      imgShare: 1,
      legibleChars: 65,
      liveTextChars: 65,
      imagesUnknownShare: 0.522,
    });
    expect(picturesUnknown(youtube)).toBe(true);
    expect(severeTriggers(youtube)).toEqual([]);
    expect(verdictOf(scored(youtube, { score: 72, band: "good" }))).toBe("ok");
    expect(galleryProblemsOf(scored(youtube, { score: 72, band: "good" }))).toEqual([]);
    // Half or less unknown: the share is trusted.
    expect(severeTriggers({ ...youtube, imagesUnknownShare: 0.5 })).toEqual(["text_in_images"]);
    expect(severeTriggers({ ...youtube, imagesUnknownShare: null })).toEqual(["text_in_images"]);
    // Rows scored before 2026.5 keep the v1.5 rule.
    const legacy = {
      imgShare: 1,
      legibleChars: 65,
      phoneTextPx: 16,
      layoutK: 1,
      unsubscribe: null,
      imagesUnknownShare: 0.9,
    };
    expect(severeTriggers(legacy)).toEqual(["text_in_images"]);
    // Pictures that didn't load at all stay Bad whatever the reason (the poster that is the email).
    expect(
      severeTriggers(
        sig({
          htmlContentImages: 1,
          drawnContentImages: 0,
          liveTextChars: 51,
          imagesUnknownShare: 1,
        }),
      ),
    ).toEqual(["pictures_not_loaded"]);
    // Its I1 line doesn't say how much of it is pictures either.
    const r = galleryReason(
      "ok",
      {
        needsImprovement: [
          item("check:I1", "The email is mostly images with only 65 characters of live text", 2),
        ],
        good: [],
      },
      { checks: [check("I1", "partial", { imgShare: 1, legibleChars: 65 }, 2)], signals: youtube },
    );
    expect(r.problems.join(" | ")).not.toMatch(/pictures/i);
  });

  it("no unsubscribe link: the email's type now decides, as its category chip shows", () => {
    const none = sig({ primaryType: "promotional", unsubscribeUnion: "none" });
    // Corrected to an account notice (Correct this): no longer Bad, and in Notifications.
    const fixed = scored(none, { primaryType: "account_notice" });
    expect(severeTriggers(none, "account_notice")).toEqual([]);
    expect(verdictOf(fixed)).toBe("good");
    expect(galleryProblemsOf(fixed)).toEqual([]);
    expect(galleryCategoryOf("account_notice", null)).toBe("notifications");
    expect(
      galleryReason("good", empty, {
        signals: none,
        primaryType: "account_notice",
      }).problems.join(),
    ).not.toMatch(/unsubscribe/i);
    // A notification the AI later settles as promotional: Bad, and in Promotions.
    const settled = scored(sig({ primaryType: "notification", unsubscribeUnion: "none" }), {
      primaryType: "promotional",
    });
    expect(verdictOf(settled)).toBe("bad");
    expect(galleryProblemsOf(settled)).toEqual(["no_unsubscribe"]);
    expect(
      galleryReason("bad", empty, { signals: settled.signals, primaryType: "promotional" }).reason
        ?.text,
    ).toBe("No unsubscribe link anywhere in this marketing email");
    // Omitted: the type the score used.
    expect(verdictOf(scored(none))).toBe("bad");
  });

  it("the pictures line says what was measured, never the 'Mostly pictures' option's words", () => {
    const i1 = (imgShare: number, legibleChars: number) =>
      galleryReason(
        "good",
        {
          needsImprovement: [
            item("check:I1", "The email is mostly images with only 242 characters of live text", 1),
          ],
          good: [],
        },
        {
          checks: [check("I1", "partial", { imgShare, legibleChars }, 1)],
          signals: sig({ imgShare, legibleChars }),
        },
      ).problems;
    expect(i1(0.254, 242)).toEqual([
      "Pictures cover 25% of it, with only 242 characters of real text",
    ]);
    expect(i1(0.499, 242)).toEqual([
      "Pictures cover 49% of it, with only 242 characters of real text",
    ]);
    expect(i1(0.62, 305)).toEqual([
      "Pictures cover 62% of it, with only 305 characters of real text",
    ]);
    // A banner over a full text section: its layout is still praised (it isn't "just pictures").
    const banner = galleryReason(
      "good",
      { needsImprovement: [item("check:I1", "", 1)], good: [] },
      {
        checks: [
          check("I1", "partial", { imgShare: 0.254, legibleChars: 242 }, 1),
          check("M1", "pass", { k: 1 }),
          check("I4", "pass", {}),
        ],
        signals: sig({ imgShare: 0.254, legibleChars: 242 }),
      },
    );
    expect(banner.strengths).toContain("Fits a phone screen without shrinking");
    expect(banner.strengths.join(" | ")).not.toMatch(/images turned off/);
  });

  it("a picture we couldn't load says whose side that was on", () => {
    const poster = sig({
      htmlContentImages: 1,
      drawnContentImages: 0,
      liveTextChars: 51,
      imagesUnknownShare: 1,
    });
    const card = (render: RenderFacts | null, signals = poster) =>
      galleryReason("bad", empty, { signals, render }).reason?.text;
    expect(card({ ...BACKED, missedImageReasons: ["too_large"] })).toBe(
      "Most of this email is one huge picture (too big for us to load): only 51 characters of real text",
    );
    expect(card({ ...BACKED, missedImageReasons: ["too_many_pixels", "budget"] })).toMatch(
      /one huge picture \(too big for us to load\)/,
    );
    expect(card({ ...BACKED, missedImageReasons: ["timeout"] })).toBe(
      "Most of this email is one picture we couldn't load: only 51 characters of real text",
    );
    expect(card(null)).toBe(
      "Most of this email is one picture we couldn't load: only 51 characters of real text",
    );
    // The sender's server failed it (nothing on our side): it didn't load for readers either.
    expect(card(null, { ...poster, imagesUnknownShare: 0 })).toBe(
      "Most of this email is one picture that didn't load: only 51 characters of real text",
    );
  });

  it("one of several buttons that look the same is never 'the standout' one", () => {
    const base = [
      check("H6", "pass", { ratio: 2, headline: true }),
      check("H2", "pass", {}),
      check("H3", "pass", {
        present: true,
        label: "Try AI in Sheets",
        salience: 1,
        mostProminent: true,
      }),
    ];
    const good = (more: unknown[], render: RenderFacts | null = null) =>
      galleryReason("good", empty, { checks: [...base, ...more], signals: sig({}), render });
    // Three identical blue pills, three actions (H5 3, one button look).
    const google = good([
      check("H5", "partial", { distinct: 3 }),
      check("L6", "pass", { buttonStyles: 1 }),
    ]);
    expect(google.reason?.text).toBe("A big headline and clear, bold buttons");
    expect(google.strengths.join(" | ")).not.toMatch(/standout/);
    // Three identical navy buttons down the email (one in the first two screens).
    const three = good(
      [check("H5", "pass", { distinct: 1 }), check("L6", "pass", { buttonStyles: 1 })],
      {
        ...BACKED,
        buttons: 3,
        buttonLabels: 1,
        buttonStyles: 1,
      },
    );
    expect(three.strengths).toContain("Clear, bold buttons");
    // The same button again at the end is still one button.
    const twice = good(
      [check("H5", "pass", { distinct: 1 }), check("L6", "pass", { buttonStyles: 1 })],
      {
        ...BACKED,
        buttons: 2,
        buttonLabels: 1,
        buttonStyles: 1,
      },
    );
    expect(twice.reason?.text).toBe("A big headline and a standout “Try AI in Sheets” button");
  });

  it("a standout main button over buttons of another look isn't 'competing' with them", () => {
    const needs = {
      needsImprovement: [item("check:H5", "3 different buttons and links compete", 1)],
      good: [],
    };
    const run = (buttonStyles: number, h3: Record<string, unknown>) =>
      galleryReason("ok", needs, {
        checks: [
          check("H5", "partial", { distinct: 3 }, 1),
          check("L6", "pass", { buttonStyles }),
          check("H3", "pass", { present: true, label: "Get started", ...h3 }),
        ],
        signals: sig({}),
      });
    // A filled "Get started" above outline "Start sharing" / "Search for jobs".
    expect(run(2, { salience: 1, mostProminent: true }).problems).toEqual([]);
    expect(run(2, { salience: 1, mostProminent: true }).strengths).toContain(
      "A standout “Get started” button",
    );
    // The same look, or no standout: they compete, in the first two phone screens (not "at the top").
    expect(run(1, { salience: 1, mostProminent: true }).problems).toEqual([
      "3 different buttons compete for attention in the first two phone screens",
    ]);
    expect(run(2, { salience: 1, mostProminent: false }).problems).toEqual([
      "3 different buttons compete for attention in the first two phone screens",
    ]);
  });

  it("Gmail's size limit: the Bad rule's words only when the cut hides what matters", () => {
    const x1 = (signals: unknown) =>
      galleryReason(
        "ok",
        { needsImprovement: [item("check:X1", "HTML is 103 KB, so Gmail clips it", 1)], good: [] },
        {
          checks: [check("X1", "partial", { clipped: true, bytes: 103_400, afterShare: 0.09 }, 1)],
          signals,
        },
      ).problems;
    expect(x1(sig({ htmlKB: 103.4 }))).toEqual([
      "Over Gmail's size limit (103 KB; the limit is 102 KB): the last 9% of it is behind “[Message clipped]”",
    ]);
    expect(galleryProblemsOf(scored(sig({ htmlKB: 103.4 })))).toEqual([]);
    // The unsubscribe link after the cut: the Bad rule, and its option.
    const hidden = sig({ htmlKB: 103.4, unsubscribeUnion: "after_clip" });
    expect(galleryProblemsOf(scored(hidden))).toEqual(["clipped"]);
    expect(galleryReason("bad", empty, { signals: hidden }).reason?.text).toBe(
      "Gmail cuts this email off (103 KB; Gmail's limit is 102 KB) and hides the unsubscribe link",
    );
  });

  it("a stray-text note from an older HTML pass, and praise a listed problem contradicts, stay out", () => {
    const r = galleryReason(
      "ok",
      {
        needsImprovement: [
          item(
            "note:stray-text",
            "Shows stray text addressed to AI or review software, which readers see too",
            0,
          ),
          item("check:M7", "94% of body text touches the screen edge on phones", 2),
          item("check:H6", "No headline in live text", 2),
        ],
        good: [],
      },
      {
        checks: [
          check("M7", "fail", { okShare: 0.06 }, 2),
          check("H6", "fail", { ratio: 1, headline: false, pictures: true }, 2),
          check("M3", "pass", { wideShare: 1 }),
          check("I2", "pass", { ctaLive: null, firstViewportChars: 300 }),
          check("I4", "pass", {}),
        ],
        signals: sig({}),
      },
    );
    expect(r.problems).toEqual([
      "On phones, 94% of the text runs right to the screen edge",
      "No headline in real text (it may be in a picture)",
    ]);
    // Not "text columns stay readable" next to text at the screen edge, nor "reads fine with
    // images off" next to a headline that may be a picture.
    expect(r.strengths.join(" | ")).not.toMatch(
      /columns stay readable|images off|images turned off/,
    );
  });
});

describe("footer statements and the stray-text note: only from the current HTML pass", () => {
  // As saved: the summary's scoring version and the email's own render (renderer_version).
  const NEW = "2026.6+w-2026.1+t-2026.3+priors-2026.1+conf-2026.3+lex-2026.3+claude-opus-5";
  const OLD = "2026.5+w-2026.1+t-2026.3+priors-2026.1+conf-2026.3+lex-2026.2+claude-opus-5";
  const STRAY = "Shows stray text addressed to AI or review software, which readers see too";
  const U3 = "No link to choose how often you get these emails";
  const U4 = "Doesn't say why you're getting this email";
  const fromSummary = (scoringVersion: string) => ({
    scoringVersion,
    needsImprovement: [
      item("note:stray-text", STRAY, 0),
      item("check:U3", "No link to manage email preferences", 1),
      item("check:U4", "Doesn't say why you're receiving this email", 1),
    ],
    good: [],
  });
  const footerChecks = [
    check("U3", "fail", { present: false }),
    check("U4", "fail", { present: false }),
  ];
  const reasons = (
    summary: { scoringVersion?: string; needsImprovement: Item[]; good: Item[] },
    rendererVersion: string | null | undefined,
    checks: unknown[] = [],
  ) =>
    galleryReason("ok", summary, {
      signals: sig({ primaryType: "newsletter" }),
      checks,
      rendererVersion,
    });

  it("currentHtmlPass needs both: a 2026.6+ summary and a render-2026.5+ render", () => {
    expect(currentHtmlPass(NEW, "render-2026.5")).toBe(true);
    expect(currentHtmlPass("2026.6", "render-2026.5")).toBe(true);
    expect(currentHtmlPass("2026.10+w", "render-2026.12")).toBe(true); // numbers, not text
    expect(currentHtmlPass("2027.1+w", "render-2027.0")).toBe(true);
    // A re-score from stored features (an AI review arriving) keeps the older render's facts.
    expect(currentHtmlPass(NEW, "render-2026.4")).toBe(false);
    expect(currentHtmlPass(OLD, "render-2026.5")).toBe(false);
    expect(currentHtmlPass(NEW, null)).toBe(false); // template coverage, or no render
    expect(currentHtmlPass(undefined, "render-2026.5")).toBe(false);
    expect(currentHtmlPass("test", "render-2026.5")).toBe(false);
    expect(currentHtmlPass(NEW, "render-latest")).toBe(false);
  });

  it("what the engine saves today passes; the minimums are the round that fixed the HTML pass", () => {
    expect(currentHtmlPass(SCORING_VERSION, RENDERER_VERSION)).toBe(true);
    expect(currentHtmlPass(METHODOLOGY_VERSION, RENDERER_VERSION)).toBe(true);
    expect(currentHtmlPass(HTML_PASS_METHODOLOGY, HTML_PASS_RENDERER)).toBe(true);
  });

  it("listed from the current pass: the summary's items and the stored checks alike", () => {
    expect(reasons(fromSummary(NEW), "render-2026.5").problems).toEqual([STRAY, U3, U4]);
    const checksOnly = reasons({ scoringVersion: NEW, ...empty }, "render-2026.5", footerChecks);
    expect(checksOnly.problems).toEqual([U3, U4]);
    // A real visible statement: it may lead an Okay card when nothing bigger is wrong.
    expect(checksOnly.reason).toEqual({ kind: "problem", text: U3 });
  });

  it("hidden for older rows: an older render, an older summary, template coverage, no version", () => {
    for (const [scoring, renderer] of [
      [NEW, "render-2026.4"],
      [OLD, "render-2026.5"],
      [NEW, null],
      [NEW, undefined],
    ] as const) {
      expect(reasons(fromSummary(scoring), renderer).problems).toEqual([]);
      const checksOnly = reasons({ scoringVersion: scoring, ...empty }, renderer, footerChecks);
      expect(checksOnly.problems).toEqual([]);
      expect(checksOnly.reason).toBeNull();
    }
    expect(
      reasons({ needsImprovement: fromSummary(NEW).needsImprovement, good: [] }, "render-2026.5")
        .problems,
    ).toEqual([]);
  });

  it("they never crowd out the deciding rule: a Bad card still leads with its own problem", () => {
    const summary = {
      ...fromSummary(NEW),
      needsImprovement: [
        item("check:U1", "No unsubscribe link", 2),
        ...fromSummary(NEW).needsImprovement,
      ],
    };
    const signals = sig({
      primaryType: "promotional",
      unsubscribeUnion: "none",
      unsubscribe: "none",
    });
    const r = galleryReason("bad", summary, { signals, rendererVersion: "render-2026.5" });
    expect(r.reason?.text).toBe("No unsubscribe link anywhere in this marketing email");
    expect(r.problems[0]).toBe("No unsubscribe link anywhere in this marketing email");
    expect(r.problems).toContain(STRAY);
  });
});

describe("categories", () => {
  it("app mail has chips of its own, so 'Other' holds only the rare kinds", () => {
    expect(galleryCategoryOf("social", null)).toBe("social");
    expect(galleryCategoryOf("community", "forum")).toBe("social");
    expect(galleryCategoryOf("notification", "activity")).toBe("notifications");
    expect(galleryCategoryOf("account_notice", "terms")).toBe("notifications");
    expect(galleryCategoryOf("survey", null)).toBe("notifications");
    expect(galleryCategoryOf("other", null)).toBe("other");
    expect(galleryCategoryOf("lifecycle", "trial_ending")).toBe("other");
  });
});

describe("the gallery's bars and limits are the engine's", () => {
  const gate = (h6: number, salience: number, imgShare: number) =>
    excellenceGate(
      [
        { id: "H6", status: "pass", s: 1, value: { ratio: h6, headline: true } },
        { id: "H3", status: "pass", s: 1, value: { present: true, salience, mostProminent: true } },
        { id: "H2", status: "pass", s: 1, value: {} },
      ],
      { primaryType: "notification", imgShare, imagesUnknownShare: 0 },
    ).misses;

  it("headline, button and imagery bars", () => {
    expect(gate(HEADLINE_RATIO_MIN, CTA_SALIENCE_MIN, IMAGERY_SHARE_MIN)).toEqual([]);
    expect(gate(HEADLINE_RATIO_MIN - 0.01, CTA_SALIENCE_MIN, IMAGERY_SHARE_MIN)).toEqual([
      "headline",
    ]);
    expect(gate(HEADLINE_RATIO_MIN, CTA_SALIENCE_MIN - 0.01, IMAGERY_SHARE_MIN)).toEqual([
      "button",
    ]);
    expect(gate(HEADLINE_RATIO_MIN, CTA_SALIENCE_MIN, IMAGERY_SHARE_MIN - 0.001)).toEqual([
      "imagery",
    ]);
    expect(PHONE_PROBLEM_SHARE).toBe(ENGINE_PHONE_SHARE);
  });

  it("Gmail's clipping limit", () => {
    expect(GMAIL_CLIP_KB * 1000).toBe(CLIP_BYTES);
  });

  it("the look-alike buttons and designed-hero bars (the How we score page quotes them)", () => {
    expect(COMPETING_BUTTONS_MIN).toBe(ENGINE.COMPETING_BUTTONS_MIN);
    expect(HERO_PICTURE_WIDTH_MIN).toBe(ENGINE.HERO_PICTURE_WIDTH_MIN);
    expect(HERO_PICTURE_AREA_MIN).toBe(ENGINE.HERO_PICTURE_AREA_MIN);
    expect(HERO_BAND_CONTRAST_MIN).toBe(ENGINE.HERO_BAND_CONTRAST_MIN);
    expect(GOOD_SCORE_MIN - 1).toBe(ENGINE.EXCELLENCE_CEILING);
  });
});
