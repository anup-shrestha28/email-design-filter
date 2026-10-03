/**
 * Design gallery model (src/lib/gallery.ts), no database:
 *  - the VERDICT POLICY at every boundary: score 84/85 and 49/50, a cap (binding or not, and
 *    whatever 'provisional' says) → Bad, 'provisional' from the email type only → Good allowed,
 *    'provisional' from low design coverage → not Good, static-only coverage → never Good; the
 *    thresholds agree with the scoring engine's own
 *  - the REASON POLICY: root cause first (most visible cap, symptoms folded into their cause),
 *    specific plain words, deduplicated; distinctive strengths before baseline ones, combined when
 *    short; contradicting strengths dropped; ≤ 3 per detail list
 *  - the category mapping is total over @edf/core's types and subtypes, and the SQL rules derived
 *    from it put every (type, subtype) pair in exactly one category
 *  - URL params: defaults, field-by-field fallback, the same q normalisation as the client, links
 */
import { describe, expect, it } from "vitest";
import { EMAIL_SUBTYPES, EMAIL_TYPES } from "@edf/core/types";
import { bandOf, confidenceBandOf } from "@edf/design";
import { CAP_IDS } from "@edf/design/types";
import {
  COVERAGE_CONFIDENCE_MIN,
  DEFAULT_GALLERY_PARAMS,
  EMAIL_GALLERY_CATEGORY_IDS,
  GALLERY_CATEGORIES,
  GALLERY_Q_MAX,
  GOOD_SCORE_MIN,
  IMAGE_TEXT_CHARS_MAX,
  IMAGE_TEXT_SHARE_MIN,
  LEGACY_SHRINK_K_MAX,
  LEGACY_TINY_PHONE_TEXT_PX,
  POOR_SCORE_MAX,
  REASON_MAX,
  SHRINK_K_MAX,
  TINY_PHONE_TEXT_PX,
  VERDICT_LABELS,
  categoryRules,
  colourName,
  compatibleStrengthItems,
  galleryCategoryOf,
  galleryHref,
  galleryReason,
  hasSevereProblem,
  mergeTagSnippet,
  parseGalleryParams,
  severeTriggers,
  trimReason,
  legacySummaryCut,
  verdictOf,
  type EmailGalleryCategory,
  type VerdictInput,
} from "@/lib/gallery";

const v = (over: Partial<VerdictInput>): VerdictInput => ({
  score: 90,
  band: "excellent",
  capped: false,
  provisional: false,
  caps: [],
  issues: [],
  source: "render",
  coverageConfidence: 0.8,
  ...over,
});

describe("verdictOf: really good / really bad", () => {
  it("good needs ≥ 85 (84 is only okay)", () => {
    expect(verdictOf(v({ score: 85, band: "excellent" }))).toBe("good");
    expect(verdictOf(v({ score: 100, band: "excellent" }))).toBe("good");
    expect(verdictOf(v({ score: 84, band: "good" }))).toBe("ok");
    expect(verdictOf(v({ score: 70, band: "good" }))).toBe("ok");
    // null flags count as "no" (older rows); omitted optional inputs aren't checked
    expect(verdictOf({ score: 85, band: "excellent", capped: null, provisional: null })).toBe(
      "good",
    );
  });

  it("good needs a real design coverage: own render or template render, never static-only", () => {
    expect(verdictOf(v({ source: "render" }))).toBe("good");
    expect(verdictOf(v({ source: "template" }))).toBe("good");
    expect(verdictOf(v({ source: "static" }))).toBe("ok");
    expect(verdictOf(v({ source: "none" }))).toBe("ok");
    expect(verdictOf(v({ source: null }))).toBe("ok");
  });

  it("'provisional' only from an unsure email TYPE doesn't block good", () => {
    // Design coverage is fine (≥ 0.70): the provisional flag came from the type-confidence drop.
    expect(verdictOf(v({ score: 98, provisional: true, coverageConfidence: 0.83 }))).toBe("good");
    expect(verdictOf(v({ score: 85, provisional: true, coverageConfidence: 0.7 }))).toBe("good");
    // email_analysis.confidence is a float4: 0.70 comes back a hair under.
    expect(
      verdictOf(v({ score: 85, provisional: true, coverageConfidence: Math.fround(0.7) })),
    ).toBe("good");
    // …but it never lifts an 84.
    expect(
      verdictOf(v({ score: 84, band: "good", provisional: true, coverageConfidence: 0.9 })),
    ).toBe("ok");
  });

  it("'provisional' from low design coverage blocks good (e.g. template render without AI, 0.64)", () => {
    expect(
      verdictOf(v({ score: 95, provisional: true, source: "template", coverageConfidence: 0.64 })),
    ).toBe("ok");
    expect(verdictOf(v({ score: 95, provisional: true, coverageConfidence: 0.699 }))).toBe("ok");
    // Unknown coverage: can't tell why it's provisional, so no Good.
    expect(verdictOf(v({ score: 95, provisional: true, coverageConfidence: null }))).toBe("ok");
    expect(verdictOf({ score: 95, band: "excellent", capped: false, provisional: true })).toBe(
      "ok",
    );
  });

  it("a cap is a severe problem: bad whatever the score, and whatever 'provisional' says", () => {
    expect(
      verdictOf(v({ score: 59, band: "needs_work", capped: true, caps: ["CAP_CONTRAST"] })),
    ).toBe("bad");
    expect(verdictOf(v({ score: 69, band: "needs_work", capped: true }))).toBe("bad");
    expect(verdictOf(v({ score: 90, band: "excellent", capped: true }))).toBe("bad");
    // capped + provisional (the AI review can't lift a score over its cap) → still bad
    expect(
      verdictOf(
        v({
          score: 69,
          band: "needs_work",
          capped: true,
          provisional: true,
          caps: ["CAP_MERGE_TAG"],
        }),
      ),
    ).toBe("bad");
    expect(
      verdictOf(
        v({
          score: 59,
          band: "needs_work",
          capped: true,
          provisional: true,
          coverageConfidence: 0.5,
        }),
      ),
    ).toBe("bad");
  });

  it("a cap that fired but doesn't bind (raw already under it) is still severe → bad", () => {
    expect(
      verdictOf(v({ score: 66, band: "needs_work", capped: false, caps: ["CAP_MERGE_TAG"] })),
    ).toBe("bad");
    expect(
      verdictOf(v({ score: 88, band: "excellent", capped: false, caps: ["CAP_CLIPPED"] })),
    ).toBe("bad");
    // an issue chip alone (older rows without the analysis caps) counts the same
    expect(
      verdictOf(
        v({ score: 64, band: "needs_work", capped: false, caps: null, issues: ["mobile"] }),
      ),
    ).toBe("bad");
    expect(hasSevereProblem({ capped: false, caps: [], issues: [] })).toBe(false);
    expect(hasSevereProblem({ capped: null, caps: null, issues: null })).toBe(false);
  });

  it("a low score (< 60) is bad, provisional or not; 60 without a severe problem is only okay", () => {
    expect(verdictOf(v({ score: 49, band: "poor" }))).toBe("bad");
    expect(verdictOf(v({ score: 0, band: "poor" }))).toBe("bad");
    expect(
      verdictOf(v({ score: 30, band: "poor", provisional: true, coverageConfidence: 0.5 })),
    ).toBe("bad");
    // Raised from 50 to 60 (v1.5): the bottom of Needs work is Bad too.
    expect(verdictOf(v({ score: 50, band: "needs_work" }))).toBe("bad");
    expect(verdictOf(v({ score: 59, band: "needs_work", provisional: true }))).toBe("bad");
    expect(verdictOf(v({ score: 60, band: "needs_work" }))).toBe("ok");
    expect(verdictOf(v({ score: 60, band: "needs_work", provisional: true }))).toBe("ok");
  });

  // Real signals from the owner's mailbox (score_summary.signals), and the edges of each rule.
  const GRUNS = {
    imgShare: 0.871,
    legibleChars: 97,
    phoneTextPx: 10,
    layoutK: 1,
    unsubscribe: "none",
  };
  const LINKEDIN = {
    imgShare: 0.127,
    legibleChars: null,
    phoneTextPx: 10.508,
    layoutK: 0.657,
    unsubscribe: "before_clip",
  };
  const UNSTOP = {
    imgShare: 0.005,
    legibleChars: null,
    phoneTextPx: 13,
    layoutK: 1,
    unsubscribe: "before_clip",
  };
  const CHANTY = {
    imgShare: 1,
    legibleChars: 367,
    phoneTextPx: 16,
    layoutK: 1,
    unsubscribe: "none",
  };
  const CLEAN = {
    imgShare: 0.1,
    legibleChars: null,
    phoneTextPx: 16,
    layoutK: 1,
    unsubscribe: "before_clip",
  };

  it("severe problems without a cap: text in images, text shrunk to ≈ 11 px, no unsubscribe link", () => {
    expect(severeTriggers(GRUNS)).toEqual(["text_in_images", "no_unsubscribe"]);
    expect(severeTriggers(LINKEDIN)).toEqual(["tiny_phone_text"]);
    expect(severeTriggers(UNSTOP)).toEqual([]);
    expect(severeTriggers(CHANTY)).toEqual(["no_unsubscribe"]);
    expect(severeTriggers(CLEAN)).toEqual([]);
    expect(verdictOf(v({ score: 73, band: "good", signals: GRUNS }))).toBe("bad");
    expect(verdictOf(v({ score: 74, band: "good", signals: LINKEDIN }))).toBe("bad");
    expect(verdictOf(v({ score: 72, band: "good", signals: UNSTOP }))).toBe("ok");
    // Bad wins over Good: an 85 with no unsubscribe link is Bad.
    expect(verdictOf(v({ score: 85, band: "excellent", signals: CHANTY }))).toBe("bad");
    expect(verdictOf(v({ score: 85, band: "excellent", signals: CLEAN }))).toBe("good");
    expect(hasSevereProblem({ capped: false, caps: [], issues: [], signals: CHANTY })).toBe(true);
  });

  it("each severe rule at its edges", () => {
    const at = (over: Record<string, unknown>) => severeTriggers({ ...CLEAN, ...over });
    // text in images: share ≥ 0.5 AND < 200 live characters (alt text doesn't matter)
    expect(at({ imgShare: IMAGE_TEXT_SHARE_MIN, legibleChars: IMAGE_TEXT_CHARS_MAX - 1 })).toEqual([
      "text_in_images",
    ]);
    expect(at({ imgShare: 0.499, legibleChars: 10 })).toEqual([]);
    expect(at({ imgShare: 0.9, legibleChars: IMAGE_TEXT_CHARS_MAX })).toEqual([]);
    expect(at({ imgShare: 0.9, legibleChars: 0 })).toEqual(["text_in_images"]);
    expect(at({ imgShare: 0.9, legibleChars: null })).toEqual([]); // not measured
    // tiny phone text (v1.5 rows): any shrink AND text under 11.5 px (≈ 11 px or less)
    expect(at({ phoneTextPx: 11.49, layoutK: 0.9 })).toEqual(["tiny_phone_text"]);
    expect(at({ phoneTextPx: LEGACY_TINY_PHONE_TEXT_PX, layoutK: 0.9 })).toEqual([]);
    expect(at({ phoneTextPx: 10, layoutK: LEGACY_SHRINK_K_MAX })).toEqual([]); // fits: tiny CSS text is a T1 deduction
    expect(at({ phoneTextPx: 10, layoutK: null })).toEqual([]);
    // no unsubscribe: only "none" (a link after Gmail's clip is the clipping problem; null = exempt)
    expect(at({ unsubscribe: "none" })).toEqual(["no_unsubscribe"]);
    expect(at({ unsubscribe: "after_clip" })).toEqual([]);
    expect(at({ unsubscribe: null })).toEqual([]);
    // junk never triggers (nor throws)
    for (const junk of [null, undefined, 3, "none", [], { imgShare: "0.9", legibleChars: "5" }])
      expect(severeTriggers(junk)).toEqual([]);
  });

  it("severe problems lead the Bad card in plain words, after any cap, and survive compaction", () => {
    const empty = { needsImprovement: [], good: [] };
    const gruns = galleryReason("bad", empty, { signals: GRUNS });
    expect(gruns.reason).toEqual({
      kind: "problem",
      text: "Most of this email is pictures: only 97 characters of real text",
    });
    expect(gruns.problems).toEqual([
      "Most of this email is pictures: only 97 characters of real text",
      "No unsubscribe link anywhere in the email",
    ]);
    const linkedin = galleryReason("bad", empty, { signals: LINKEDIN });
    // The card rounds as the detail does (one decimal), so the two never disagree.
    expect(linkedin.reason?.text).toBe("Doesn't fit phones: text shrinks to about 10.5 px");
    expect(linkedin.problems[0]).toBe(
      "Doesn't fit phones: the layout shrinks to 66%, so body text is only about 10.5 px",
    );
    expect(galleryReason("bad", empty, { signals: CHANTY }).reason?.text).toBe(
      "No unsubscribe link anywhere in the email",
    );
    // read from summary.signals when not passed separately
    expect(galleryReason("bad", { ...empty, signals: CHANTY } as never).reason?.text).toBe(
      "No unsubscribe link anywhere in the email",
    );
    // a cap still leads
    const capped = galleryReason("bad", empty, { caps: ["CAP_CONTRAST"], signals: CHANTY });
    expect(capped.reason?.text).toBe("Body text is too faint to read against its background");
    expect(capped.problems[1]).toBe("No unsubscribe link anywhere in the email");
    // one problem per root cause: the engine's own U1 / I1 / T1 items fold into the severe line
    const summary = {
      needsImprovement: [
        { key: "check:U1", title: "No visible unsubscribe link", points: 2, ai: false },
        { key: "check:T1", title: "Body text is 10.5px on phones", points: 2, ai: false },
      ],
      good: [{ key: "good:U1", title: "Easy to unsubscribe", points: 1, ai: false }],
    };
    const both = galleryReason("bad", summary, { signals: { ...LINKEDIN, unsubscribe: "none" } });
    expect(both.problems).toEqual([
      "Doesn't fit phones: the layout shrinks to 66%, so body text is only about 10.5 px",
      "No unsubscribe link anywhere in the email",
    ]);
    expect(both.strengths).not.toContain("Easy to unsubscribe");
  });

  it("no score is unscored, whatever else is set", () => {
    expect(verdictOf(v({ score: null, band: null, capped: null, provisional: null }))).toBe(
      "unscored",
    );
    expect(
      verdictOf(v({ score: null, band: "poor", capped: true, caps: ["CAP_IMAGE_ONLY"] })),
    ).toBe("unscored");
  });

  it("thresholds agree with the scoring engine", () => {
    expect(bandOf(GOOD_SCORE_MIN)).toBe("excellent");
    expect(bandOf(GOOD_SCORE_MIN - 1)).toBe("good");
    // The Bad floor (60) sits inside Needs work (50–69); everything Poor is under it.
    expect(bandOf(POOR_SCORE_MAX)).toBe("needs_work");
    expect(bandOf(POOR_SCORE_MAX - 1)).toBe("needs_work");
    expect(bandOf(49)).toBe("poor");
    // The text-in-images rule reuses CAP_IMAGE_ONLY's image and text thresholds (caps.ts).
    expect(IMAGE_TEXT_SHARE_MIN).toBe(0.5);
    expect(IMAGE_TEXT_CHARS_MAX).toBe(200);
    // The phone rule starts where the engine's own cap stops (text < 8 px is CAP_MOBILE_BROKEN,
    // MOBILE_UNREADABLE_PX) and stays under T1's comfortable size (16 px); v1.5's under 12 px.
    expect(TINY_PHONE_TEXT_PX).toBeGreaterThan(8);
    expect(TINY_PHONE_TEXT_PX).toBeLessThan(16);
    expect(SHRINK_K_MAX).toBeLessThan(LEGACY_SHRINK_K_MAX);
    expect(LEGACY_TINY_PHONE_TEXT_PX).toBeLessThan(12);
    expect(confidenceBandOf(COVERAGE_CONFIDENCE_MIN, null)).not.toBe("low");
    expect(confidenceBandOf(COVERAGE_CONFIDENCE_MIN - 0.001, null)).toBe("low");
  });

  it("labels", () => {
    expect(VERDICT_LABELS).toEqual({
      good: "Good design",
      bad: "Bad design",
      ok: "Okay",
      unscored: "Not scored yet",
    });
  });
});

type Item = { key: string; title: string; points: number; ai: boolean };
const item = (key: string, title: string, points = 1): Item => ({ key, title, points, ai: false });
const check = (
  id: string,
  status: string,
  value: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  id,
  status,
  s: status === "pass" ? 1 : 0.5,
  w: 2,
  points: 1,
  pointsLost: status === "pass" ? 0 : 1,
  value,
  ...extra,
});

describe("galleryReason: problems, root cause first", () => {
  const contrastCap = item(
    "cap:CAP_CONTRAST",
    "46% of body text fails contrast (#a0a0a0 on #ffffff = 2.6:1) (score capped at 59)",
    7,
  );

  it("bad + capped → the cap, in plain, specific words (colours named, ratio kept)", () => {
    const r = galleryReason(
      "bad",
      {
        needsImprovement: [item("check:A2", "3 of 11 images have no alt text", 1.8), contrastCap],
        good: [],
      },
      { capped: true },
    );
    expect(r.reason).toEqual({
      kind: "problem",
      text: "Body text is light grey on white (2.6:1) — hard to read",
    });
    expect(r.problems).toEqual([
      "Body text is light grey on white (2.6:1) — hard to read",
      "3 of 11 images have no description for people who can't see them",
    ]);
  });

  it("the most visible cap leads, not the one with the lowest limit (a broken logo vs a layout that doesn't fit)", () => {
    const summary = {
      needsImprovement: [
        item("cap:CAP_BROKEN_IMAGES", "1 of 1 images are broken (score capped at 59)", 20),
        item(
          "cap:CAP_MOBILE_BROKEN",
          "The layout is a fixed 624px, so on phones it shrinks to 60%: body text becomes ~",
          9,
        ),
      ],
      good: [],
    };
    const r = galleryReason("bad", summary, { capped: true });
    // The card says what a reader sees; the detail keeps the measured sentence.
    expect(r.reason?.text).toBe(
      "Too wide for phones: it shrinks to 60%, so the text is too small to read",
    );
    expect(r.problems).toEqual([
      "Too wide for a phone: the 624 px layout shrinks to 60%",
      "Its only image doesn't load (broken link)",
    ]);
  });

  it("the stored checks fill in what the summary's 80-character titles cut off", () => {
    const summary = {
      needsImprovement: [
        item(
          "cap:CAP_MOBILE_BROKEN",
          "The layout is a fixed 700px, so on phones it shrinks to 54%: body text becomes ~",
          30,
        ),
      ],
      good: [],
    };
    const checks = [
      check("M1", "fail", { contentWidth: 700, k: 0.54 }),
      check("T1", "partial", { px: 7.5 }),
    ];
    const r = galleryReason("bad", summary, { capped: true, checks });
    expect(r.reason?.text).toBe(
      "Too wide for phones: text shrinks to about 7.5 px, too small to read",
    );
    expect(r.problems[0]).toBe(
      "Too wide for a phone: the 700 px layout shrinks to 54%, so body text is about 7.5 px",
    );
  });

  it("symptoms of a shrinking fixed-width layout (small button, weak headline, tiny tap targets) are ONE problem", () => {
    const summary = {
      needsImprovement: [
        item(
          "cap:CAP_MOBILE_BROKEN",
          "The layout is a fixed 612px, so on phones it shrinks to 61%: body text becomes ~",
          30,
        ),
        item("check:M4", "The main button's tap area is 28.2px on phones", 1.8),
        item("check:H6", "The headline is barely larger than the text (1.375×)", 1.1),
      ],
      good: [],
    };
    const checks = [check("A7", "partial", { small: 4, targets: 6 }), check("U3", "fail")];
    const r = galleryReason("bad", summary, { capped: true, checks });
    // (U3 "no preferences link" is a phrase match the gallery doesn't list, PHRASE_ONLY.)
    expect(r.problems).toEqual(["Too wide for a phone: the 612 px layout shrinks to 61%"]);
    // Without the shrinking layout, the same findings are separate problems.
    const alone = galleryReason("ok", {
      needsImprovement: summary.needsImprovement.slice(1),
      good: [],
    });
    expect(alone.problems).toEqual([
      "The main button is only 28.2 px tall on a phone — hard to tap",
      "The headline is barely bigger than the body text (1.4×)",
    ]);
  });

  it("one root cause, one problem: image-only, clipping and contrast each absorb their own symptoms", () => {
    const images = galleryReason(
      "bad",
      {
        needsImprovement: [
          item(
            "cap:CAP_IMAGE_ONLY",
            "Image-only email: 40 characters of live text, 5% left with images off (score capped at 49)",
            40,
          ),
          item(
            "check:I2",
            "The first screen has 12 characters of live text and the button is an image",
            3,
          ),
          item("check:I4", "With images off only 5% of the first two screens remains", 2),
        ],
        good: [],
      },
      { capped: true },
    );
    expect(images.problems).toEqual([
      "Most of this email is pictures: only 40 characters of real text",
    ]);

    const clipped = galleryReason(
      "bad",
      {
        needsImprovement: [
          item(
            "cap:CAP_CLIPPED",
            "Gmail clips this 116 KB email before the main button (score capped at 69)",
            10,
          ),
          item("check:U1", "The unsubscribe link is hidden behind Gmail's clip", 2),
          item("check:X1", "HTML is 116 KB, so Gmail clips it", 1),
        ],
        good: [],
      },
      { capped: true },
    );
    expect(clipped.reason?.text).toBe(
      "Gmail cuts this email off (116 KB; Gmail's limit is 102 KB) and hides the main button",
    );
    expect(clipped.problems).toHaveLength(1);

    const contrast = galleryReason("bad", {
      needsImprovement: [
        contrastCap,
        item("check:A1", "52% of text fails WCAG AA contrast (#aaaaaa on #ffffff = 2.32:1)", 3),
      ],
      good: [],
    });
    expect(contrast.problems).toEqual(["Body text is light grey on white (2.6:1) — hard to read"]);
  });

  it("a merge tag is quoted from the subject when the engine found it there", () => {
    const needs = [
      item(
        "cap:CAP_MERGE_TAG",
        "An unrendered merge tag is visible in the subject (score capped at 69)",
        5,
      ),
    ];
    expect(
      galleryReason(
        "bad",
        { needsImprovement: needs, good: [] },
        { subject: "Hi *|FNAME|*, rain shells are 25% off" },
      ).reason?.text,
    ).toBe("Shows a raw merge tag in the subject: “Hi *|FNAME|*”");
    // A quoted tag in the engine's own title is used as is.
    const quoted = [
      item(
        "cap:CAP_MERGE_TAG",
        "An unrendered merge tag is visible in the first screen: “Hi {{first_name}}” (score capped at 69)",
        5,
      ),
    ];
    expect(galleryReason("bad", { needsImprovement: quoted, good: [] }).reason?.text).toBe(
      "Shows a raw merge tag: “Hi {{first_name}}”",
    );
    // Only the cap id known (no summary text): still says what it is.
    expect(
      galleryReason("bad", { needsImprovement: [], good: [] }, { caps: ["CAP_MERGE_TAG"] }).reason
        ?.text,
    ).toMatch(/raw merge tag/);
  });

  it("every cap the engine has gives a Bad card a reason, even with no saved explanation", () => {
    for (const cap of CAP_IDS) {
      const r = galleryReason("bad", { needsImprovement: [], good: [] }, { caps: [cap] });
      expect(r.reason?.kind, cap).toBe("problem");
      expect(r.reason!.text.length, cap).toBeGreaterThan(10);
    }
    const fromIssue = galleryReason(
      "bad",
      { needsImprovement: [], good: [] },
      { capped: true, issues: ["image_only"] },
    );
    expect(fromIssue.reason?.text).toBe(
      "Most of this email is pictures, with very little real text",
    );
  });

  it("bad (poor score, no cap) → its biggest problem; ok → its main issue", () => {
    const summary = {
      needsImprovement: [
        item("check:T1", "Body text is 13px on phones", 4),
        item("check:C2", "The preview text could work harder (20 characters)", 1),
      ],
      good: [],
    };
    expect(galleryReason("bad", summary).reason).toEqual({
      kind: "problem",
      text: "Body text is only 13 px on phones",
    });
    expect(galleryReason("ok", summary).reason).toEqual({
      kind: "problem",
      text: "Body text is only 13 px on phones",
    });
    expect(galleryReason("ok", summary).problems).toEqual([
      "Body text is only 13 px on phones",
      "The inbox preview text is very short (20 characters)",
    ]);
  });

  it("names the preview-text problem the engine measured (too long / short / repeats the subject)", () => {
    const facts = (value: Record<string, unknown>) => [
      { id: "C2", status: "partial", w: 1, pointsLost: 0.3, value },
    ];
    const summary = {
      needsImprovement: [
        item("check:C2", "The preview text could work harder (180 characters)", 1),
      ],
      good: [],
    };
    expect(
      galleryReason("ok", summary, { checks: facts({ boilerplate: false, length: 180 }) }).problems,
    ).toEqual(["The inbox preview text is too long (180 characters), so it gets cut off"]);
    expect(
      galleryReason("ok", summary, {
        checks: facts({ boilerplate: false, length: 60, similarity: 0.9 }),
      }).problems,
    ).toEqual(["The inbox preview text just repeats the subject"]);
  });

  it("hidden text, small print and a faint headline are named as such, not 'hard to read' body text", () => {
    const a1 = (worst: Record<string, unknown>, title: string) =>
      galleryReason(
        "ok",
        { needsImprovement: [item("check:A1", title, 2)], good: [] },
        {
          checks: [
            { id: "A1", status: "partial", w: 5, pointsLost: 2, value: { failShare: 0.25, worst } },
          ],
        },
      ).problems[0];
    expect(
      a1(
        { fg: "#ffffff", bg: "#ffffff", ratio: 1, rendered: false },
        "Some text is hidden: it's the same colour as its background (1:1)",
      ),
    ).toBe("Some text is hidden: it's the same colour as its background");
    expect(
      a1(
        { fg: "#999999", bg: "#ffffff", ratio: 2.85, fine: true },
        "The small print is hard to read: grey on white (2.85:1)",
      ),
    ).toMatch(/^The small print is faint: .* \(2\.85?:1\)$/);
    expect(
      a1(
        { fg: "#cccccc", bg: "#ffffff", ratio: 1.6, role: "heading" },
        "The headline is too faint: light grey on white (1.6:1)",
      ),
    ).toMatch(/^The headline is .* on white \(1\.6:1\) — hard to read$/);
    // After compaction (no checks), the engine's plain title is shown as is.
    expect(
      galleryReason("ok", {
        scoringVersion: "2026.2+w",
        needsImprovement: [
          item("check:A1", "Some text is hidden: it's the same colour as its background (1:1)", 2),
        ],
        good: [],
      }).problems[0],
    ).toBe("Some text is hidden: it's the same colour as its background");
  });

  it("drops a strength the listed problems undermine ('Easy to unsubscribe' next to a tiny unsubscribe link)", () => {
    const r = galleryReason("bad", {
      needsImprovement: [item("check:U2", "The unsubscribe link is 5.6px", 1)],
      good: [
        item("good:U1", "Clear unsubscribe link", 1),
        item("good:A3", "Links describe where they go", 1),
      ],
    });
    expect(r.problems).toEqual(["The unsubscribe link is tiny or faint (5.6 px)"]);
    expect(r.strengths.join(" | ")).not.toMatch(/unsubscribe/i);
  });

  it("problems a reader can't see (code hygiene) or the HTML pass only guesses at are never listed", () => {
    const summary = {
      needsImprovement: [
        item("check:A11", "Text direction isn't declared"),
        item("check:X2", "Some code isn't supported by major email apps (max_width)"),
        // Found by set phrases only: LinkedIn's "Manage recommendations" and "You are receiving
        // … emails" slip past them, so these would be false on many cards.
        item("check:U3", "No link to manage preferences"),
        item("check:U4", "Doesn't say why you're receiving this"),
      ],
      good: [],
    };
    expect(galleryReason("ok", summary).problems).toEqual([]);
  });

  it("at most 3 problems, deduplicated", () => {
    const needs = ["check:T3", "check:T4", "check:T6", "check:L3", "check:L2"].map((k) =>
      item(k, "x"),
    );
    const r = galleryReason("ok", {
      needsImprovement: [...needs, item("check:T3", "x")],
      good: [],
    });
    expect(r.problems).toHaveLength(3);
    expect(new Set(r.problems).size).toBe(3);
  });
});

describe("galleryReason: strengths, most distinctive first", () => {
  const passing = [
    check("A1", "pass", {}, { w: 5, points: 6 }),
    check("A3", "pass", {}, { w: 2.5 }),
    check("H6", "pass", { ratio: 2.2 }),
    check("H3", "pass", { label: "Shop now" }),
    check("M1", "pass", { k: 1 }),
  ];

  it("good → distinctive strengths (headline + button) combined when short, never a generic line", () => {
    const r = galleryReason(
      "good",
      {
        needsImprovement: [],
        good: [
          item("good:A1", "Text meets WCAG AA contrast", 6),
          item("good:A3", "Links describe where they go", 3),
        ],
      },
      { checks: passing },
    );
    expect(r.reason).toEqual({
      kind: "strength",
      text: "A big headline and a standout “Shop now” button",
    });
    expect(r.strengths).toEqual([
      "A big headline, 2.2× the size of the text",
      "A standout “Shop now” button",
      "Fits a phone screen without shrinking",
    ]);
    expect(r.strengths).not.toContain("Text is easy to read (good contrast)");
  });

  it("a long button label isn't combined into an over-long line", () => {
    const checks = [
      check("H6", "pass"),
      check("H3", "pass", { label: "Explore the complete autumn outdoor collection now" }),
    ];
    const r = galleryReason("good", { needsImprovement: [], good: [] }, { checks });
    expect(r.reason?.text).toBe("A big headline that clearly stands out");
  });

  it("a specific strength beats contrast even from the summary alone", () => {
    const summary = {
      needsImprovement: [],
      good: [
        item("good:A1", "Text meets WCAG AA contrast", 8),
        item("good:M1", "Fits a 375px phone without shrinking", 3),
      ],
    };
    expect(galleryReason("good", summary).reason?.text).toBe(
      "Fits a phone screen without shrinking",
    );
  });

  it("with only baseline strengths, the baseline one is used", () => {
    const summary = {
      needsImprovement: [],
      good: [item("good:A1", "Text meets WCAG AA contrast", 8)],
    };
    expect(galleryReason("good", summary).reason).toEqual({
      kind: "strength",
      text: "Text is easy to read (good contrast)",
    });
  });

  it("strengths that contradict a listed problem are dropped (no 'fits phones' next to a shrinking layout)", () => {
    const summary = {
      needsImprovement: [
        item(
          "cap:CAP_MOBILE_BROKEN",
          "The layout is a fixed 640px, so on phones it shrinks to 58%",
          30,
        ),
      ],
      good: [],
    };
    const checks = [
      check("M3", "pass"),
      check("M7", "pass"),
      check("H6", "pass"),
      check("L3", "pass"),
    ];
    const r = galleryReason("bad", summary, { capped: true, checks });
    // (A Bad design gets no generic baseline filler like "A clean, uncluttered layout".)
    expect(r.strengths).toEqual(["A big headline that clearly stands out"]);
  });

  it("one strength per theme, at most 3; AI levels ≥ 4 count, lower ones don't", () => {
    const checks = [
      check("H7", "pass", { level: 5 }),
      check("H6", "pass"),
      check("H3", "pass", { label: "Go" }),
      check("H5", "pass"),
      check("I6", "partial", { level: 3 }),
      check("L3", "pass"),
    ];
    const r = galleryReason("good", { needsImprovement: [], good: [] }, { checks });
    // Baseline hygiene ("A clean, uncluttered layout") never pads a list of real strengths.
    expect(r.strengths).toEqual(["Excellent visual hierarchy", "A standout “Go” button"]);
    expect(r.reason?.text).toBe("Excellent visual hierarchy and a standout “Go” button");
  });

  it("ok with no problems → its best strength", () => {
    expect(
      galleryReason("ok", {
        needsImprovement: [],
        good: [item("good:H6", "The headline clearly outranks body text")],
      }).reason,
    ).toEqual({
      kind: "strength",
      text: "A big headline that clearly stands out",
    });
  });

  it("an unknown engine finding still shows, tidied", () => {
    const r = galleryReason("ok", {
      needsImprovement: [item("check:Z9", "Something new is off (score capped at 59)")],
      good: [item("good:Z8", "Something new is good")],
    });
    expect(r.problems).toEqual(["Something new is off"]);
    expect(r.strengths).toEqual(["Something new is good"]);
  });
});

describe("galleryReason: edge cases", () => {
  it("unscored → nothing", () => {
    expect(
      galleryReason("unscored", {
        needsImprovement: [item("check:T1", "Body text is 12px on phones")],
        good: [],
      }),
    ).toEqual({ reason: null, problems: [], strengths: [] });
  });

  it("missing or malformed summaries and checks never throw", () => {
    expect(galleryReason("good", null).reason).toBeNull();
    expect(galleryReason("ok", {} as never).reason).toBeNull();
    expect(
      galleryReason("bad", { needsImprovement: "nope", good: [null, 3, { title: "" }] } as never)
        .reason,
    ).toBeNull();
    expect(galleryReason("good", null, { checks: "junk" }).reason).toBeNull();
    expect(
      galleryReason("good", null, {
        checks: [null, 1, { id: 3 }, { id: "H6", status: "pass", w: 2, value: "x" }],
      }).reason?.text,
    ).toBe("A big headline that clearly stands out");
  });

  it("reason text is ≤ 120 chars, cut at a word boundary with an ellipsis", () => {
    const long =
      "The layout is a fixed 640px so on phones it shrinks to 59 percent and the body text becomes about 8.8px which nobody can read comfortably at all";
    const r = galleryReason("ok", {
      needsImprovement: [{ key: "x", title: long, points: 1, ai: false }],
      good: [],
    });
    expect(r.reason!.text.length).toBeLessThanOrEqual(REASON_MAX);
    expect(r.reason!.text.endsWith("…")).toBe(true);
    expect(long.startsWith(r.reason!.text.slice(0, -1))).toBe(true);
    expect(long.charAt(r.reason!.text.length - 1)).toBe(" "); // cut before a space, not mid-word
  });
});

describe("trimReason", () => {
  it("tidies titles a legacy (pre-2026.2) summary cut at exactly 80 characters", () => {
    const cut = "The layout is a fixed 606px, so on phones it shrinks to 62%: body text becomes ~";
    expect(Array.from(cut)).toHaveLength(80);
    // Current summaries cut at a word boundary themselves, so an 80-character title is whole.
    expect(trimReason(cut)).toBe(cut);
    expect(trimReason(cut, 200, { summaryCut: true })).toBe(
      "The layout is a fixed 606px, so on phones it shrinks to 62%: body text becomes…",
    );
    expect(
      trimReason(
        "100% of body text fails contrast (#888888 on #ffffff = 3.54:1) (score capped at ",
        200,
        { summaryCut: true },
      ),
    ).toBe("100% of body text fails contrast (#888888 on #ffffff = 3.54:1)");
    expect(
      trimReason(
        "Some code isn't supported by major email apps (max_width, border_radius, web_fon",
        200,
        { summaryCut: true },
      ),
    ).toBe("Some code isn't supported by major email apps");
    // A legacy-looking 80 characters that already ends in "…" was cut properly: kept.
    const cutNew = `${"The main button “Choose the plan that fits your team best and".padEnd(79, "x")}…`;
    expect(trimReason(cutNew, 200, { summaryCut: true })).toBe(cutNew);
  });

  it("knows which saved summaries predate word-boundary cuts", () => {
    expect(legacySummaryCut({ scoringVersion: "2026.1+w-2026.1+t-2026.1" })).toBe(true);
    expect(legacySummaryCut({ scoringVersion: "2025.9+x" })).toBe(true);
    expect(legacySummaryCut({ scoringVersion: "2026.2+w-2026.1+t-2026.2" })).toBe(false);
    expect(legacySummaryCut({ scoringVersion: "2027.1+x" })).toBe(false);
    expect(legacySummaryCut({})).toBe(true);
    expect(legacySummaryCut(null)).toBe(true);
  });

  it("never drops the last word of a text that wasn't cut (79 or 81+ characters, or the gallery's own sentences)", () => {
    const t79 = "Comfortable line spacing and generous margins make every paragraph easy to read";
    expect(Array.from(t79)).toHaveLength(79);
    expect(trimReason(t79)).toBe(t79);
    const t81 = `${t79}!!`;
    expect(trimReason(t81)).toBe(t81);
    const t87 =
      "The whole email is images: it's blank with images off and unreadable for screen readers";
    expect(trimReason(t87, 200)).toBe(t87);
    const own80 =
      "Comfortable line spacing and generous margins make every paragraph easy to read.";
    expect(Array.from(own80)).toHaveLength(80);
    expect(trimReason(own80, 200, { summaryCut: false })).toBe(own80);
  });

  it("drops the cap note and cuts long text at a word boundary", () => {
    expect(trimReason("short one")).toBe("short one");
    expect(trimReason("1 of 1 images are broken (score capped at 59)")).toBe(
      "1 of 1 images are broken",
    );
    expect(trimReason("x".repeat(300)).length).toBe(REASON_MAX);
  });
});

describe("plain-English helpers", () => {
  it("colourName names colours the way a reader would", () => {
    expect(colourName("#ffffff")).toBe("white");
    expect(colourName("#fff")).toBe("white");
    expect(colourName("#000000")).toBe("black");
    expect(colourName("#888888")).toBe("grey");
    expect(colourName("#a0a0a0")).toBe("light grey");
    expect(colourName("#dddddd")).toBe("very light grey");
    expect(colourName("#333333")).toBe("dark grey");
    expect(colourName("#ff0000")).toBe("red");
    expect(colourName("#1a56db")).toBe("blue");
    expect(colourName("#60a5fa")).toBe("light blue");
    expect(colourName("#bfdbfe")).toBe("pale blue");
    expect(colourName("rgb(255, 255, 255)")).toBe("white");
    expect(colourName("not a colour")).toBeNull();
  });

  it("mergeTagSnippet quotes the tag with the words around it", () => {
    expect(mergeTagSnippet("Hi *|FNAME|*, rain shells are 25% off")).toBe("Hi *|FNAME|*");
    expect(mergeTagSnippet("Welcome aboard {{ first_name }}!")).toBe(
      "Welcome aboard {{ first_name }}",
    );
    expect(mergeTagSnippet("Dear [First Name], your order")).toBeNull(); // not a merge-tag family
    expect(mergeTagSnippet("Dear [FIRSTNAME], your order")).toBe("Dear [FIRSTNAME]");
    expect(mergeTagSnippet("Nothing to see")).toBeNull();
  });
});

describe("galleryCategoryOf", () => {
  const pairs = EMAIL_TYPES.flatMap((t) =>
    [null, ...(EMAIL_SUBTYPES[t] as readonly string[])].map((s) => [t, s] as const),
  );

  it("is total over every type and subtype in @edf/core", () => {
    for (const [t, s] of pairs)
      expect(EMAIL_GALLERY_CATEGORY_IDS).toContain(galleryCategoryOf(t, s));
    expect(galleryCategoryOf("not-a-type", null)).toBe("other");
    expect(galleryCategoryOf("promotional", "not-a-subtype")).toBe("promotions");
  });

  it("maps as the gallery promises", () => {
    for (const s of [null, ...EMAIL_SUBTYPES.newsletter])
      expect(galleryCategoryOf("newsletter", s)).toBe("newsletters");
    expect(galleryCategoryOf("promotional", "cart_reminder")).toBe("abandoned_cart");
    for (const s of [null, "sale", "coupon", "product_launch", "recommendation"])
      expect(galleryCategoryOf("promotional", s)).toBe("promotions");
    expect(galleryCategoryOf("lifecycle", "welcome")).toBe("welcome");
    expect(galleryCategoryOf("lifecycle", "onboarding")).toBe("welcome");
    expect(galleryCategoryOf("lifecycle", "trial_ending")).toBe("other");
    expect(galleryCategoryOf("lifecycle", null)).toBe("other");
    for (const s of [null, ...EMAIL_SUBTYPES.product_update])
      expect(galleryCategoryOf("product_update", s)).toBe("product_updates");
    for (const s of [null, ...EMAIL_SUBTYPES.event])
      expect(galleryCategoryOf("event", s)).toBe("events");
    for (const s of [null, ...EMAIL_SUBTYPES.transactional])
      expect(galleryCategoryOf("transactional", s)).toBe("receipts");
    // App mail has chips of its own, so "Other" stays small.
    const own = {
      social: "social",
      community: "social",
      notification: "notifications",
      account_notice: "notifications",
      account_security: "notifications",
      survey: "notifications",
      other: "other",
    } as const;
    for (const [t, want] of Object.entries(own) as Array<[keyof typeof own, string]>) {
      for (const s of [null, ...(EMAIL_SUBTYPES[t] as readonly string[])])
        expect(galleryCategoryOf(t, s), `${t}/${s}`).toBe(want);
    }
  });

  it("every category but 'all' is reachable, and the SQL rules place each pair in exactly its category", () => {
    const reached = new Set(pairs.map(([t, s]) => galleryCategoryOf(t, s)));
    expect([...reached].sort()).toEqual([...EMAIL_GALLERY_CATEGORY_IDS].sort());
    expect(GALLERY_CATEGORIES.map((c) => c.id)).toEqual(["all", ...EMAIL_GALLERY_CATEGORY_IDS]);
    const matches = (c: EmailGalleryCategory, t: string, s: string | null) =>
      categoryRules(c).some(
        (r) =>
          r.primaryType === t &&
          (r.byDefault ? s === null || !r.except.includes(s) : s !== null && r.only.includes(s)),
      );
    for (const [t, s] of [
      ...pairs,
      ["promotional", "odd_subtype"] as const,
      ["lifecycle", "odd_subtype"] as const,
    ]) {
      const hits = EMAIL_GALLERY_CATEGORY_IDS.filter((c) => matches(c, t, s));
      expect(hits, `${t}/${s}`).toEqual([galleryCategoryOf(t, s)]);
    }
  });
});

describe("gallery URL params", () => {
  it("defaults", () => {
    expect(DEFAULT_GALLERY_PARAMS).toEqual({
      category: "all",
      design: "all",
      font: null,
      q: "",
      sort: "newest",
      page: 1,
      size: 24,
      smin: 0,
      smax: 100,
      date: "any",
      since: null,
      until: null,
      sender: [],
      problem: [],
      mailbox: null,
      webfonts: "any",
      board: null,
    });
    expect(parseGalleryParams(undefined)).toEqual(DEFAULT_GALLERY_PARAMS);
    expect(parseGalleryParams({})).toEqual(DEFAULT_GALLERY_PARAMS);
    expect(parseGalleryParams("category=welcome")).toEqual(DEFAULT_GALLERY_PARAMS);
  });

  it("reads Next searchParams objects and URLSearchParams", () => {
    const want = {
      ...DEFAULT_GALLERY_PARAMS,
      category: "welcome",
      design: "good",
      font: "Inter",
      q: "autumn sale",
      sort: "best",
    };
    expect(
      parseGalleryParams({
        category: "welcome",
        design: "good",
        font: "Inter",
        q: "autumn sale",
        sort: "best",
      }),
    ).toEqual(want);
    expect(
      parseGalleryParams({
        category: ["welcome", "events"],
        design: "good",
        font: "Inter",
        q: " autumn sale ",
        sort: "best",
      }),
    ).toEqual(want);
    expect(
      parseGalleryParams(
        new URLSearchParams("category=welcome&design=good&font=Inter&q=autumn+sale&sort=best"),
      ),
    ).toEqual(want);
  });

  it("an invalid field falls back to its default and keeps the others", () => {
    expect(parseGalleryParams({ category: "spam", design: "bad", sort: "worst" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      design: "bad",
      sort: "worst",
    });
    expect(parseGalleryParams({ design: "excellent", category: "events" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      category: "events",
    });
    expect(parseGalleryParams({ q: 42, font: "Lato" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      font: "Lato",
    });
    expect(parseGalleryParams({ font: "", sort: "received_at; DROP TABLE email" })).toEqual(
      DEFAULT_GALLERY_PARAMS,
    );
    expect(parseGalleryParams({ font: "x".repeat(600), category: "receipts" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      category: "receipts",
    });
    expect(parseGalleryParams({ q: 42, category: "all" })).toEqual(DEFAULT_GALLERY_PARAMS);
  });

  it("q over 100 characters is cut exactly as the client cuts it (trim, then the first 100), never dropped", () => {
    const clientNormalise = (q: string) => q.trim().slice(0, GALLERY_Q_MAX); // use-gallery-params.ts / gallery-search.tsx
    for (const q of [
      "x".repeat(101),
      `  ${"ab ".repeat(60)}  `,
      "a".repeat(100),
      " spaced out  ",
      "é".repeat(150),
    ]) {
      expect(parseGalleryParams({ q }).q, q).toBe(clientNormalise(q));
    }
    expect(parseGalleryParams({ q: "x".repeat(101) }).q).toHaveLength(100);
  });

  it("galleryHref leaves defaults out and round-trips", () => {
    expect(galleryHref()).toBe("/gallery");
    expect(galleryHref({ category: "all", sort: "newest" })).toBe("/gallery");
    const href = galleryHref({
      category: "abandoned_cart",
      design: "bad",
      font: "DM Sans",
      q: "50% off",
      sort: "worst",
    });
    expect(href).toBe(
      "/gallery?category=abandoned_cart&design=bad&font=DM+Sans&q=50%25+off&sort=worst",
    );
    expect(parseGalleryParams(new URL(href, "http://x").searchParams)).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      category: "abandoned_cart",
      design: "bad",
      font: "DM Sans",
      q: "50% off",
      sort: "worst",
    });
    expect(galleryHref({ design: "good" }, "/")).toBe("/?design=good");
  });
});

describe("galleryReason: 'really good' fixes (gallery-fix round 3)", () => {
  it("an Okay non-responsive layout gets a plain card line; the detail keeps the measured sentence", () => {
    const summary = {
      needsImprovement: [
        item(
          "group:fixed-width",
          "Not built for phones: the fixed 624px layout shrinks to 60%, body text ~9.6px",
          9,
        ),
      ],
      good: [],
    };
    const checks = [
      check("M1", "fail", { contentWidth: 624, k: 0.6 }),
      check("T1", "fail", { px: 9.62 }),
    ];
    const r = galleryReason("ok", summary, { checks });
    expect(r.reason?.text).toBe("Doesn't resize for phones (text ≈ 9.6 px)");
    expect(r.problems[0]).toBe(
      "Doesn't resize for phones: the 624 px layout shrinks to 60%, so body text is about 9.6 px",
    );
  });

  it("the Excellent gate's plain-design item leads an Okay card and absorbs the headline problem", () => {
    const summary = {
      needsImprovement: [
        item(
          "gate:excellence",
          "Plain design, nothing stands out: headline 1× the body text, no button",
          5,
        ),
        item("check:M7", "85% of body text sits within 12px of the screen edge", 4),
        item("check:H6", "The headline is barely larger than the text (1×)", 3),
      ],
      good: [],
    };
    const checks = [
      check("H6", "fail", { ratio: 1 }),
      check("M7", "fail", { okShare: 0 }),
      check("M1", "pass", { k: 1 }),
      check("L3", "pass", {}),
      check("I2", "pass", { firstViewportChars: 77, ctaLive: null }),
      check("I4", "not_applicable", {}),
    ];
    const r = galleryReason("ok", summary, { checks });
    expect(r.reason?.text).toBe(
      "A plain design: a headline no bigger than the text, and no main button",
    );
    expect(r.problems).toEqual([
      "A plain design: a headline no bigger than the text, and no main button",
      "On phones, 100% of the text runs right to the screen edge",
    ]);
    // No "fits phones" next to text at the edge, no clean-layout praise of a plain design, and no
    // "reads fine with images off" for an email without images.
    expect(r.strengths.join(" | ")).not.toMatch(/phone screen|uncluttered|images off/);
  });

  it("'reads fine with images off' is only claimed with content images, and names a button only when there is one", () => {
    const base = [check("H6", "pass", { ratio: 2 }), check("M1", "pass", { k: 1 })];
    const noImages = galleryReason(
      "good",
      { needsImprovement: [], good: [] },
      {
        checks: [
          ...base,
          check("I2", "pass", { ctaLive: null }),
          check("I4", "not_applicable", {}),
        ],
      },
    );
    expect(noImages.strengths.join(" | ")).not.toMatch(/images off/);
    const withImages = galleryReason(
      "good",
      { needsImprovement: [], good: [] },
      {
        checks: [
          ...base,
          check("I2", "pass", { ctaLive: null }),
          check("I4", "pass", { ratio: 0.9 }),
        ],
      },
    );
    expect(withImages.strengths).toContain(
      "All the text is real text, so it reads fine with images off",
    );
    expect(withImages.strengths.join(" | ")).not.toMatch(/button/);
    // Never part of the combined Good line.
    expect(withImages.reason?.text).toBe("A big headline and a phone-friendly layout");
  });

  it("a real headline just short of 'bold' (1.5×) is a strength, not a problem", () => {
    const r = galleryReason(
      "good",
      {
        needsImprovement: [
          item("check:H6", "The headline is barely larger than the text (1.53×)", 0.5),
        ],
        good: [],
      },
      {
        checks: [check("H6", "partial", { ratio: 1.53 }), check("M1", "pass", { k: 1 })],
      },
    );
    expect(r.problems).toEqual([]);
    expect(r.reason?.text).toBe("A clear headline and a phone-friendly layout");
  });

  it("placeholder / http links are never a gallery problem; a 15 px body text is only 'a little small'", () => {
    const r = galleryReason("ok", {
      needsImprovement: [
        item("check:X3", "Links point to placeholder domains", 2),
        item("check:T1", "Body text is 15px on phones", 1),
      ],
      good: [],
    });
    expect(r.problems).toEqual(["Body text is a little small on phones (15 px)"]);
  });

  it("a merge tag the reader sees in the email is quoted before the subject", () => {
    const r = galleryReason(
      "bad",
      {
        needsImprovement: [
          item(
            "cap:CAP_MERGE_TAG",
            "Shows a raw merge tag at the top: “Hi {{ first_name }}” (also in subject)",
            31,
          ),
        ],
        good: [],
      },
      { capped: true, subject: "Hi *|FNAME|*, rain shells are 25% off" },
    );
    expect(r.reason?.text).toBe(
      "Shows a raw merge tag: “Hi {{ first_name }}” (also in the subject line)",
    );
  });

  it("small print just under AA is 'a little faint', and never leads the card", () => {
    const r = galleryReason(
      "ok",
      { needsImprovement: [], good: [] },
      {
        checks: [
          check(
            "A1",
            "partial",
            { failShare: 0.05, worst: { fg: "#6b7280", bg: "#ffffff", ratio: 4.47, fine: true } },
            { pointsLost: 1 },
          ),
        ],
      },
    );
    expect(r.problems[0]).toBe("The small print is a little faint: grey on white (4.4:1)");
    // An Okay card with nothing but faint small print says nothing about it on the card.
    expect(r.reason?.text ?? "").not.toMatch(/small print/);
  });

  it("faint main text: no 'bold headline' strength next to it", () => {
    const r = galleryReason(
      "bad",
      {
        needsImprovement: [
          item(
            "cap:CAP_CONTRAST",
            "Body text is very light grey on white (1.74:1): too faint to read",
            30,
          ),
        ],
        good: [],
      },
      {
        capped: true,
        checks: [check("H6", "pass", { ratio: 1.8 }), check("H3", "pass", { label: "Shop" })],
      },
    );
    expect(r.strengths.join(" | ")).not.toMatch(/headline/);
  });
});

describe("galleryReason: symptoms and strengths (gallery-fix round 4)", () => {
  const fixedWidth = item(
    "group:fixed-width",
    "Not built for phones: the fixed 640px layout shrinks to 59%, body text ~9.4px",
    6,
  );
  const m1 = check("M1", "fail", { contentWidth: 640, k: 0.59 });

  it("an unsubscribe link small only because the layout shrinks folds into the layout problem", () => {
    const summary = {
      needsImprovement: [fixedWidth, item("check:U2", "The unsubscribe link is 7.4px or faint", 1)],
      good: [],
    };
    const checks = [
      m1,
      check("U2", "partial", { px: 7.426, cssPx: 12, contrast: 6.987, shrinkOnly: true }),
    ];
    const r = galleryReason("ok", summary, { checks });
    expect(r.problems.join(" | ")).not.toMatch(/unsubscribe/i);
  });

  it("a faint unsubscribe link is its own problem, worded by what's visible (contrast, desktop size)", () => {
    const summary = {
      needsImprovement: [fixedWidth, item("check:U2", "The unsubscribe link is 7.2px or faint", 1)],
      good: [],
    };
    const checks = [
      m1,
      check("U2", "partial", { px: 7.212, cssPx: 12, contrast: 3.545, shrinkOnly: false }),
    ];
    const r = galleryReason("ok", summary, { checks });
    expect(r.problems).toContain("The unsubscribe link is faint (3.5:1 contrast) and hard to see");
    expect(r.problems.join(" | ")).not.toMatch(/7\.2 px/);
    const tiny = galleryReason(
      "ok",
      { needsImprovement: [item("check:U2", "x")], good: [] },
      {
        checks: [check("U2", "partial", { px: 9, cssPx: 9, contrast: 7, shrinkOnly: false })],
      },
    );
    expect(tiny.problems).toEqual(["The unsubscribe link is tiny (9 px)"]);
  });

  it("a button that's small at its own size stays its own problem next to a shrinking layout", () => {
    const summary = {
      needsImprovement: [fixedWidth, item("check:M4", "Tap area is 25px")],
      good: [],
    };
    const own = galleryReason("ok", summary, {
      checks: [m1, check("M4", "partial", { minSidePx: 25, shrinkOnly: false })],
    });
    expect(own.problems).toContain("The main button is only 25 px tall on a phone — hard to tap");
    const shrunk = galleryReason("ok", summary, {
      checks: [m1, check("M4", "partial", { minSidePx: 25, shrinkOnly: true })],
    });
    expect(shrunk.problems.join(" | ")).not.toMatch(/main button/);
  });

  it("an image wider than the phone next to a shrinking layout is the same problem", () => {
    const summary = {
      needsImprovement: [fixedWidth, item("check:M5", "1 image overflows")],
      good: [],
    };
    const r = galleryReason("ok", summary, {
      checks: [m1, check("M5", "partial", { overflowing: 1 })],
    });
    expect(r.problems.join(" | ")).not.toMatch(/sticks out/);
  });

  it("a genuinely broken phone layout (Bad) reads plainly on the card; the detail keeps the measurements", () => {
    const summary = {
      needsImprovement: [
        item(
          "cap:CAP_MOBILE_BROKEN",
          "Unreadable on phones: the fixed 700px layout shrinks to 54%, body text ~7.5px",
          30,
        ),
      ],
      good: [],
    };
    const r = galleryReason("bad", summary, { capped: true });
    expect(r.reason?.text).toBe(
      "Too wide for phones: text shrinks to about 7.5 px, too small to read",
    );
    expect(r.problems[0]).toMatch(/700 px layout shrinks to 54%/);
  });

  it("no whitespace / clean-layout praise next to edge-to-edge text or an over-wide column; no tap praise next to a small button", () => {
    const summary = {
      needsImprovement: [
        item("check:M7", "100% of body text touches the screen edge on phones"),
        item("check:L1", "The content column is 784px wide"),
        item("check:M4", "Tap area is 25px"),
      ],
      good: [],
    };
    const checks = [
      check("M7", "fail", { okShare: 0 }),
      check("L1", "partial", { width: 784 }),
      check("M4", "partial", { minSidePx: 25 }),
      check("L2", "pass"),
      check("L3", "pass"),
      check("A7", "pass"),
      check("L5", "pass"),
    ];
    const r = galleryReason("ok", summary, { checks });
    expect(r.strengths.join(" | ")).not.toMatch(/whitespace|uncluttered|tap/i);
    expect(r.strengths).toContain("A restrained colour palette");
  });

  it("an image-only email gets no typography or readability praise, and generic filler never pads a Bad list", () => {
    const summary = {
      needsImprovement: [item("cap:CAP_IMAGE_ONLY", "Mostly one big image", 30)],
      good: [],
    };
    const checks = [
      check("T6", "pass"),
      check("T3", "pass"),
      check("A1", "pass"),
      check("I3", "pass"),
      check("X1", "pass"),
    ];
    const r = galleryReason("bad", summary, { capped: true, checks });
    expect(r.strengths).toEqual([]);
  });

  it("an unstyled email (no fonts measured) isn't praised for typography, palette or grid", () => {
    const checks = [check("T6", "pass"), check("L5", "pass"), check("L4", "pass")];
    const r = galleryReason(
      "ok",
      { needsImprovement: [], good: [] },
      { checks, fontsMeasured: false },
    );
    expect(r.strengths).toEqual([]);
    // One text size throughout is unstyled too, whatever the font.
    const oneSize = [check("T6", "pass", { families: 1, sizes: 1 }), check("L5", "pass")];
    expect(
      galleryReason(
        "ok",
        { needsImprovement: [], good: [] },
        { checks: oneSize, fontsMeasured: true },
      ).strengths,
    ).toEqual([]);
    const styled = galleryReason(
      "ok",
      { needsImprovement: [], good: [] },
      { checks, fontsMeasured: true },
    );
    expect(styled.strengths).toContain("Disciplined typography: few fonts and sizes");
  });

  it("with nothing better, one baseline strength for Okay; none for Bad", () => {
    const checks = [check("I3", "pass"), check("X1", "pass")];
    expect(
      galleryReason("ok", { needsImprovement: [], good: [] }, { checks }).strengths,
    ).toHaveLength(1);
    expect(
      galleryReason(
        "bad",
        { needsImprovement: [item("check:T1", "Body text is 11px on phones")], good: [] },
        { checks },
      ).strengths,
    ).toEqual([]);
  });

  it("the full analysis page's Good list gets the same conflict rules", () => {
    const good = [
      {
        key: "good:mobile",
        checkIds: ["M1", "M3", "T1"],
        title: "Built for phones: fits a 375px screen with 17.8px body text",
      },
      {
        key: "good:I2",
        checkIds: ["I2"],
        title: "All the text is real text, so it reads fine with images off",
      },
      { key: "good:A7", checkIds: ["A7"], title: "Links are easy to tap on phones" },
      { key: "good:L5", checkIds: ["L5"], title: "A restrained colour palette" },
    ];
    const needs = [
      { key: "check:M7", title: "100% of body text touches the screen edge on phones" },
      { key: "check:M4", title: "The main button “View invoice” is only 25px tall on phones" },
    ];
    const checks = [
      check("M7", "fail", { okShare: 0 }),
      check("M4", "partial", { minSidePx: 25 }),
      check("I4", "not_applicable"),
    ];
    expect(compatibleStrengthItems(good, needs, { checks }).map((g) => g.key)).toEqual(["good:L5"]);
    // From a saved summary (no checks): the listed problems still rule strengths out.
    expect(compatibleStrengthItems(good, needs).map((g) => g.key)).toEqual(["good:I2", "good:L5"]);
  });
});
