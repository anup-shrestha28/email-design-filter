/**
 * "How we judged this" (lib/gallery-evidence.ts), on synthetic facts:
 *  - for every verdict, the sentence names a rule verdictOf really used (thousands of random
 *    inputs around every limit), the serious rows fail exactly for galleryProblemsOf's options and
 *    the Good checklist reads the Excellent gate's own failed bars
 *  - each rule's sentence carries its measured value and its limit, rounded so a value never reads
 *    as being on the other side of the limit
 *  - an older analysis (v1.5 signals only) and a compacted one show what's known, never invented
 *  - notes: pictures that didn't load and why, pictures off, a template's score, the AI review
 *  - the detail's problem list drops exactly the lines a failed row already states (real
 *    galleryReason output), and the panel's copies of the engine's limits agree with the engine
 */
import { describe, expect, it } from "vitest";
import { EMAIL_TYPES } from "@edf/core/types";
import { EXCELLENCE_CEILING, excellenceGate } from "@edf/design";
import { AI_CHECK_IDS, CAP_DISPLAY_ORDER, type DesignBand } from "@edf/design/types";
import {
  galleryProblemsOf,
  galleryReason,
  ISSUE_CAP,
  severeTriggers,
  verdictOf,
  type VerdictInput,
} from "@/lib/gallery";
import {
  AI_CHECKS,
  CONTRAST_CAP_SHARE,
  GATE_CEILING,
  IMAGERY_EXEMPT_TYPES,
  verdictEvidence,
  withoutRestatedLines,
  type EvidenceInput,
  type VerdictEvidence,
} from "@/lib/gallery-evidence";
import { CONTRAST_CAP_SHARE as ENGINE_CONTRAST_SHARE } from "../../../../packages/design/src/scoring/weights";

/** A clean marketing email's signals as scoring 2026.5 saves them (override any key). */
const SIG = (over: Record<string, unknown> = {}) => ({
  imgShare: 0.3,
  legibleChars: 820,
  phoneTextPx: 16,
  layoutK: 1,
  unsubscribe: "before_clip",
  primaryType: "promotional",
  headlineRatio: 1.75,
  hasHeadline: true,
  ctaSalience: 1,
  ctaMostProminent: true,
  ctaFirstScreen: true,
  ctaLabelContrast: 6.1,
  gate: [],
  htmlContentImages: 4,
  drawnContentImages: 4,
  imagesOff: false,
  imagesUnknownShare: 0,
  staticUnsubscribe: "found",
  renderUnsubscribe: "found",
  unsubscribeUnion: "before_clip",
  liveTextChars: 820,
  htmlKB: 41.3,
  ...over,
});

/** The engine's pillar scores without the AI review (its 14 points spread over the rest). */
const PILLARS = [
  { id: "accessibility", points: 20.1, max: 22.8, nominal: 20 },
  { id: "mobile", points: 17.2, max: 18.1, nominal: 15 },
  { id: "typography", points: 15, max: 16.1, nominal: 15 },
  { id: "hierarchy", points: 11.4, max: 12.1, nominal: 15 },
  { id: "images", points: 10.2, max: 10.2, nominal: 10 },
  { id: "layout", points: 7.9, max: 8.1, nominal: 10 },
  { id: "content", points: 2.4, max: 2.7, nominal: 5 },
  { id: "technical", points: 4.9, max: 5, nominal: 5 },
  { id: "footer", points: 4.1, max: 5, nominal: 5 },
];

const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  score: 91,
  band: "excellent",
  capped: false,
  provisional: false,
  caps: [],
  issues: [],
  source: "render",
  coverageConfidence: 0.86,
  signals: SIG(),
  primaryType: "promotional",
  raw: 91.2,
  needs: [],
  pillars: PILLARS,
  aiReviewed: false,
  checks: null,
  imageLoads: [],
  compacted: false,
  ...over,
});

const ev = (over: Partial<EvidenceInput> = {}) => verdictEvidence(input(over))!;
const row = (e: VerdictEvidence, id: string) => [...e.good, ...e.serious].find((r) => r.id === id)!;
const verdictInput = (i: EvidenceInput): VerdictInput => ({
  score: i.score,
  band: i.band,
  capped: i.capped,
  provisional: i.provisional,
  caps: i.caps,
  issues: i.issues,
  source: i.source,
  coverageConfidence: i.coverageConfidence,
  signals: i.signals,
  // The type now, as the gallery passes e.primary_type (null: the type the score used).
  primaryType: i.primaryType ?? undefined,
});
/** An Okay held at 84 by the Excellent gate: the engine lists its item and the points add up to more. */
const HELD = {
  score: 84,
  band: "good" as DesignBand,
  raw: 88.4,
  needs: [{ key: "gate:excellence", title: "Plain design" }],
};

describe("the verdict sentence names the rule that decided it", () => {
  it("Bad: Gmail hides the unsubscribe link — the size, the limit and what the cut hides", () => {
    const e = ev({
      score: 78,
      band: "good",
      signals: SIG({ htmlKB: 136.2, unsubscribeUnion: "after_clip", unsubscribe: "after_clip" }),
    });
    expect(e.verdict).toBe("bad");
    expect(e.rule).toEqual({ kind: "severe", trigger: "unsubscribe_clipped" });
    expect(e.sentence).toBe(
      "Bad: Gmail cuts this email off — it's 136 KB and Gmail's limit is 102 KB, so the unsubscribe link is hidden.",
    );
    expect(row(e, "clipped")).toMatchObject({
      state: "fail",
      value: "136 KB: Gmail cuts it off and hides the unsubscribe link",
    });
    // The hidden link is one problem, counted once.
    expect(row(e, "no_unsubscribe").state).toBe("neutral");
    expect(row(e, "serious")).toMatchObject({ state: "fail", value: "1 found (below)" });
  });

  it("Bad: the clipping cap names the main button and the unsubscribe link, and the score it caps", () => {
    const e = ev({
      score: 69,
      band: "needs_work",
      capped: true,
      caps: ["CAP_CLIPPED"],
      issues: ["clipped"],
      raw: 81.6,
      needs: [{ key: "cap:CAP_CLIPPED", title: "Gmail clips it (139 KB) before the main button" }],
      signals: SIG({ htmlKB: 139.1, unsubscribeUnion: "after_clip" }),
    });
    expect(e.rule).toEqual({ kind: "cap", cap: "CAP_CLIPPED" });
    expect(e.sentence).toBe(
      "Bad: Gmail cuts this email off — it's 139 KB and Gmail's limit is 102 KB, so the main button and the unsubscribe link are hidden.",
    );
    expect(row(e, "score").value).toBe("69: capped by a serious problem (its points add up to 82)");
    expect(e.areas?.notes).toContain(
      "These add up to 82, but a serious problem caps the score at 69.",
    );
  });

  it("Bad: text in pictures, pictures that didn't load, a phone layout that shrinks too far", () => {
    const pictures = ev({
      score: 74,
      band: "good",
      signals: SIG({ imgShare: 0.871, legibleChars: 97, liveTextChars: 97 }),
    });
    expect(pictures.rule).toEqual({ kind: "severe", trigger: "text_in_images" });
    expect(pictures.sentence).toBe(
      "Bad: most of this email is pictures — they cover 87% of it, with only 97 characters of real text (Bad is half or more pictures with under 200 characters).",
    );
    expect(row(pictures, "image_only").value).toBe(
      "Pictures cover 87% of it, with 97 characters of real text",
    );

    const notLoaded = ev({
      score: 70,
      band: "good",
      signals: SIG({
        imgShare: 0.2,
        legibleChars: null,
        htmlContentImages: 3,
        drawnContentImages: 0,
        liveTextChars: 51,
      }),
    });
    expect(notLoaded.rule).toEqual({ kind: "severe", trigger: "pictures_not_loaded" });
    expect(notLoaded.sentence).toBe(
      "Bad: this email is just pictures, and they didn't load — none of its 3 pictures showed, leaving only 51 characters of real text (under 200 characters is too little).",
    );

    const phone = ev({
      score: 77,
      band: "good",
      signals: SIG({ layoutK: 0.7999, phoneTextPx: 12.46 }),
    });
    expect(phone.rule).toEqual({ kind: "severe", trigger: "tiny_phone_text" });
    // 79.99% and 12.46 px never read as the limits they miss (80%, 12.5 px).
    expect(phone.sentence).toBe(
      "Bad: it doesn't fit phones — the layout shrinks to 79%, so the text is about 12.4 px (Bad is under 80% and under 12.5 px).",
    );
    expect(row(phone, "mobile").value).toBe("Shrinks to 79% to fit, so text is only about 12.4 px");
    // Just inside both limits: fits, and says so with the same rounding.
    const fits = ev({ signals: SIG({ layoutK: 0.8, phoneTextPx: 12.5 }), score: 86 });
    expect(row(fits, "mobile")).toMatchObject({
      state: "pass",
      value: "Shrinks to 80% to fit, but text is still about 12.5 px",
    });
  });

  it("Bad: no unsubscribe link in marketing mail; other mail doesn't need one", () => {
    const e = ev({
      score: 80,
      band: "good",
      signals: SIG({ unsubscribeUnion: "none", unsubscribe: "none" }),
    });
    expect(e.rule).toEqual({ kind: "severe", trigger: "no_unsubscribe" });
    expect(e.sentence).toBe(
      "Bad: there's no unsubscribe link anywhere, and marketing emails must have one.",
    );
    expect(e.treatedAs).toBe("Treated as a marketing email, so it must have an unsubscribe link.");
    const notice = ev({
      primaryType: "notification",
      signals: SIG({
        primaryType: "notification",
        unsubscribeUnion: "none",
        unsubscribe: null,
        imgShare: 0.2,
      }),
    });
    expect(notice.verdict).toBe("good");
    expect(row(notice, "no_unsubscribe")).toMatchObject({ state: "neutral", value: "None found" });
    expect(notice.treatedAs).toBe(
      "Treated as an app notification, so a missing unsubscribe link doesn't make it Bad.",
    );
  });

  it("Bad: faint main text quotes the colours and the share against the 40% limit", () => {
    const e = ev({
      score: 59,
      band: "needs_work",
      capped: true,
      caps: ["CAP_CONTRAST"],
      issues: ["contrast"],
      raw: 66,
      checks: {
        A1: {
          status: "fail",
          value: {
            mainFailShare: 0.435,
            worst: { fg: "#88929e", bg: "#ffffff", fine: false, role: "body", ratio: 3.157 },
          },
        },
      },
    });
    // From the stored share alone (0.435): rounded as the gallery rounds it.
    expect(e.sentence).toBe(
      "Bad: the main text is too faint to read — 44% of it is grey on white (3.1:1), and Bad is over 40%. It has 1 more serious problem below.",
    );
    // The cap's own title rounds the exact share (43.49…%): it wins, so the full analysis agrees —
    // also once the checks are compacted away.
    const title = [
      {
        key: "cap:CAP_CONTRAST",
        title: "43% of the main text is grey on white (3.15:1): too faint",
      },
    ];
    const titled = ev({
      score: 59,
      band: "needs_work",
      capped: true,
      caps: ["CAP_CONTRAST"],
      needs: title,
    });
    expect(titled.sentence).toBe(
      "Bad: the main text is too faint to read — 43% of it is grey on white (3.1:1), and Bad is over 40%. It has 1 more serious problem below.",
    );
    expect(row(titled, "contrast")).toMatchObject({
      state: "fail",
      value: "43% of it is too faint: grey on white (3.1:1)",
    });
    // 59 is also under 60: the score row fails too, and counts.
    expect(row(e, "low_score")).toMatchObject({ state: "fail", value: "59" });
    // Faint fine print is never quoted as the main text.
    const fine = ev({
      checks: {
        A1: {
          status: "partial",
          value: {
            mainFailShare: 0.02,
            worst: { fg: "#aaaaaa", bg: "#ffffff", fine: true, role: "body", ratio: 2.3 },
          },
        },
      },
    });
    expect(row(fine, "contrast")).toMatchObject({ state: "pass", value: "2% of it is too faint" });
  });

  it("Bad for its score alone: the score and the limit", () => {
    const e = ev({ score: 55, band: "needs_work", raw: 55.4 });
    expect(e.rule).toEqual({ kind: "low_score" });
    expect(e.sentence).toBe(
      "Bad: lots of smaller problems add up to a low score — 55 out of 100, and Bad is under 60.",
    );
  });

  it("Okay held at 84: the first failed Good check with its value and limit, and the hold", () => {
    const e = ev({ ...HELD, signals: SIG({ headlineRatio: 1.149, gate: ["headline"] }) });
    expect(e.verdict).toBe("ok");
    expect(e.rule).toEqual({ kind: "gate", bar: "headline" });
    expect(e.sentence).toBe(
      "Okay: no serious problems, but not Good because the headline is barely bigger than the text (1.1×; Good needs 1.5×). That holds its score at 84 (its points add up to 88).",
    );
    expect(row(e, "headline")).toMatchObject({
      state: "fail",
      value: "Headline 1.1× the size of the text",
    });
    expect(row(e, "score").value).toBe(
      "84: held there for the checks below (its points add up to 88)",
    );
    // 1.49 is short of the 1.5 bar: never "1.5×".
    const short = ev({
      ...HELD,
      signals: SIG({ headlineRatio: 1.49, gate: ["headline", "button"], ctaSalience: 0.62 }),
    });
    expect(short.sentence).toBe(
      "Okay: no serious problems, but not Good because the headline is only 1.4× the size of the text (Good needs 1.5×). It misses 1 more Good check below. That holds its score at 84 (its points add up to 88).",
    );
    expect(row(short, "button")).toMatchObject({
      state: "fail",
      value: "The main button: its colour is too close to the background",
    });
  });

  it("Okay: the button, pictures and phone-layout bars", () => {
    const button = ev({
      ...HELD,
      signals: SIG({ gate: ["button"], ctaMostProminent: false, ctaFirstScreen: false }),
    });
    expect(button.sentence).toContain(
      "not Good because the main button sits below the first phone screen, and another link or picture is bigger.",
    );
    const imagery = ev({
      ...HELD,
      primaryType: "notification",
      signals: SIG({ primaryType: "notification", gate: ["imagery"], imgShare: 0.0799 }),
    });
    // 7.99% of a needed 8% reads 7%.
    expect(imagery.sentence).toContain(
      "pictures cover only 7% of it (Good needs 8% for this kind of email)",
    );
    expect(row(imagery, "imagery")).toMatchObject({
      state: "fail",
      value: "7% of the email is pictures",
    });
    const edge = ev({
      ...HELD,
      signals: SIG({ gate: ["phone_edge"] }),
      checks: {
        M7: { status: "fail", value: { okShare: 0.38 } },
        M3: { status: "pass", value: { wideShare: 1 } },
      },
    });
    expect(edge.sentence).toContain(
      "on a phone, 62% of the text runs right to the screen edge (Good needs under 50%)",
    );
    expect(row(edge, "phone")).toMatchObject({
      state: "fail",
      value: "0% of the text in narrow columns, 62% at the screen edge",
    });
  });

  it("Okay for its score, for thin evidence, and Good", () => {
    const score = ev({
      score: 79,
      band: "good",
      raw: 79.3,
      signals: SIG({ gate: ["headline", "button"] }),
    });
    expect(score.rule).toEqual({ kind: "score" });
    expect(score.sentence).toBe(
      "Okay: no serious problems, but not Good because it scored 79 and Good needs 85. It also misses 2 Good checks below.",
    );
    const thin = ev({
      score: 88,
      source: "template",
      provisional: true,
      coverageConfidence: 0.6228,
    });
    expect(thin.rule).toEqual({ kind: "coverage" });
    expect(thin.sentence).toBe(
      "Okay: no serious problems and it scored 88, but not Good because we couldn't measure enough of it to be sure (62% of the checks could run; Good needs 70%).",
    );
    expect(row(thin, "coverage")).toMatchObject({
      state: "fail",
      value: "62% of the checks could run",
    });
    expect(thin.notes).toContain(
      "Measured from another email with the same design (a template), so some values are that email's.",
    );
    // A template's score with thin evidence: every cross below is counted, the evidence one too.
    const template = ev({
      score: 81,
      band: "good",
      source: "template",
      provisional: true,
      coverageConfidence: 0.6228,
      primaryType: "notification",
      signals: SIG({
        primaryType: "notification",
        imgShare: 0.017,
        gate: ["headline", "button", "imagery"],
      }),
    });
    expect(template.sentence).toBe(
      "Okay: no serious problems, but not Good because it scored 81 and Good needs 85. It also misses 4 Good checks below.",
    );
    const good = ev();
    expect(good.rule).toEqual({ kind: "good" });
    expect(good.sentence).toBe("Good: it passed every check below.");
    expect(good.good.every((r) => r.state === "pass")).toBe(true);
    expect(good.serious.every((r) => r.state !== "fail")).toBe(true);
  });

  /** The words each rule's sentence must contain (and the number it must quote). */
  function names(e: VerdictEvidence, i: EvidenceInput): boolean {
    const r = e.rule;
    const s = e.sentence;
    switch (r.kind) {
      case "cap":
        return {
          CAP_IMAGE_ONLY: /^Bad: most of this email is pictures/,
          CAP_CONTRAST: /^Bad: the main text is too faint/,
          CAP_MERGE_TAG: /^Bad: it shows placeholder code/,
          CAP_MOBILE_BROKEN: /^Bad: it doesn't work on phones/,
          CAP_CLIPPED: /^Bad: Gmail cuts this email off/,
          CAP_BROKEN_IMAGES: /^Bad: most of its pictures are broken/,
        }[r.cap].test(s);
      case "severe":
        return {
          pictures_not_loaded: /^Bad: this email is just pictures, and they didn't load/,
          text_in_images: /^Bad: most of this email is pictures/,
          tiny_phone_text: /^Bad: it doesn't fit phones/,
          unsubscribe_clipped: /^Bad: Gmail cuts this email off/,
          no_unsubscribe: /^Bad: there's no unsubscribe link anywhere/,
        }[r.trigger].test(s);
      case "low_score":
        return s.startsWith(
          `Bad: lots of smaller problems add up to a low score — ${i.score} out of 100`,
        );
      case "capped":
        return s.startsWith(`Bad: a serious problem caps its score at ${i.score}`);
      case "good":
        return s.startsWith("Good: ");
      case "gate":
        return (
          s.startsWith("Okay: no serious problems, but not Good because ") &&
          {
            headline: /headline/,
            button: /main button|look the same/,
            imagery: /pictures cover/,
            imagery_unknown: /(picture|pictures|picture area) didn't load|pictures loaded/,
            hero: /no large picture and no headline on a coloured band/,
            phone_narrow: /narrow columns/,
            phone_edge: /screen edge/,
            plain: /nothing stands out/,
          }[r.bar].test(s) &&
          s.includes(`holds its score at ${GATE_CEILING}`)
        );
      case "score":
        return s.startsWith(
          `Okay: no serious problems, but not Good because it scored ${i.score} and Good needs 85.`,
        );
      case "coverage":
        return /^Okay: .*couldn't measure enough/.test(s);
      case "source":
        return /^Okay: .*only checked its code/.test(s);
    }
  }

  /** The rule is one verdictOf used: its facts are in verdictOf's input and lead to this verdict. */
  function used(e: VerdictEvidence, i: EvidenceInput): boolean {
    const d = verdictInput(i);
    const issueCap = ISSUE_CAP as Readonly<Record<string, string | undefined>>;
    const caps = new Set([...i.caps, ...i.issues.map((x) => issueCap[x] ?? "")]);
    const triggers = severeTriggers(i.signals);
    const score = i.score!;
    const r = e.rule;
    switch (r.kind) {
      case "cap":
        // The first cap in the order the card names them.
        return caps.has(r.cap) && CAP_DISPLAY_ORDER.find((c) => caps.has(c)) === r.cap;
      case "severe":
        return triggers[0] === r.trigger && ![...caps].some((c) => c !== "");
      case "low_score":
        return score < 60 || i.band === "poor";
      case "capped":
        return i.capped === true;
      case "good":
        return verdictOf(d) === "good";
      case "gate": {
        const gate = (i.signals as { gate?: unknown }).gate;
        return score < 85 && (Array.isArray(gate) ? gate.includes(r.bar) : r.bar === "plain");
      }
      case "score":
        return score < 85;
      case "coverage":
        return (
          score >= 85 && i.provisional === true && !((i.coverageConfidence ?? 0) + 1e-4 >= 0.7)
        );
      case "source":
        return score >= 85 && !["render", "template"].includes(i.source ?? "");
    }
  }

  it("on thousands of random inputs around every limit: always verdictOf's verdict and one of its rules", () => {
    let seed = 20261001;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const maybe = <T>(x: T, p = 0.5): T | null => (rnd() < p ? x : null);
    /** `missed` of `all` content pictures not drawn (features.render.images.loads). */
    const loadsOf = (missed: number, all: number) => [
      ...Array.from({ length: all - missed }, () => ({ status: 200, decoded: true })),
      ...Array.from({ length: missed }, () => ({ status: 403, decoded: false, reason: "expired" })),
    ];
    const kinds = new Set<string>();
    for (let n = 0; n < 4000; n++) {
      let score = rnd() < 0.05 ? null : pick([40, 55, 59, 60, 69, 74, 79, 84, 84, 85, 88, 93]);
      const type = pick([
        "promotional",
        "newsletter",
        "notification",
        "social",
        "event",
        "transactional",
      ]);
      const current = rnd() < 0.85;
      const aiReviewed = pick([true, false, null]);
      const sig = {
        primaryType: type,
        imgShare: pick([0.005, 0.0799, 0.08, 0.3, 0.4999, 0.5, 0.9]),
        legibleChars: maybe(pick([0, 97, 199, 200, 1229]), 0.7),
        liveTextChars: pick([0, 51, 199, 200, 1229]),
        layoutK: pick([0.5, 0.79, 0.7999, 0.8, 0.9, 1]),
        phoneTextPx: pick([7.5, 11.4, 12.46, 12.5, 14, 16]),
        unsubscribeUnion: pick(["before_clip", "after_clip", "none", null]),
        htmlContentImages: pick([0, 1, 3]),
        drawnContentImages: pick([0, 1, 3, null]),
        imagesOff: rnd() < 0.1,
        imagesUnknownShare: pick([0, 0.4, 0.75]),
        headlineRatio: maybe(pick([1, 1.149, 1.49, 1.5, 2]), 0.9),
        hasHeadline: pick([true, false, null]),
        ctaSalience: maybe(pick([0.5, 0.899, 0.9, 1]), 0.85),
        ctaMostProminent: pick([true, false, null]),
        ctaFirstScreen: pick([true, false, null]),
        htmlKB: pick([40, 101.9, 102.2, 136.2]),
        // G2's look-alike buttons (methodology 2026.6); null = scored before it.
        ctaCompeting: pick([true, false, false, null]),
        // G4 (methodology 2026.6); null = scored before it.
        heroPicture: pick([true, false, false, null]),
        heroBand: pick([true, false, null]),
      };
      // The engine's own inputs that aren't saved: the missing pictures could have reached 8%
      // (imgShareIfLoaded), a missing picture could have been the large one (heroUnknown).
      const couldReach = rnd() < 0.7;
      const heroUnknown = rnd() < 0.3;
      // The Excellent gate as the engine works it out from the same facts (an AI rating of 4+
      // stands in for the headline, button and picture bars), or not evaluated at all.
      const bars: string[] = [];
      if (!(aiReviewed === true && rnd() < 0.5)) {
        if (sig.hasHeadline === false || sig.headlineRatio === null || sig.headlineRatio < 1.5)
          bars.push("headline");
        if (
          sig.ctaSalience === null ||
          sig.ctaSalience < 0.9 ||
          sig.ctaCompeting === true ||
          (sig.ctaMostProminent !== true && sig.ctaFirstScreen !== true)
        )
          bars.push("button");
        if (IMAGERY_EXEMPT_TYPES.has(type) || sig.imagesOff) {
          // not judged
        } else if (sig.imgShare < 0.08)
          bars.push(sig.imagesUnknownShare > 0.5 && couldReach ? "imagery_unknown" : "imagery");
        else if (sig.imagesUnknownShare > 0.5) bars.push("imagery_unknown");
        // G4: a large picture or a headline band, every type (not with images off); a picture that
        // didn't load could have been it: then the miss is imagery_unknown (once).
        if (
          sig.heroPicture !== null &&
          !sig.imagesOff &&
          !sig.heroPicture &&
          sig.heroBand !== true
        ) {
          if (!heroUnknown) bars.push("hero");
          else if (!bars.includes("imagery_unknown")) bars.push("imagery_unknown");
        }
      }
      if (rnd() < 0.15) bars.push(pick(["phone_narrow", "phone_edge"]));
      const gate = rnd() < 0.1 ? null : bars;
      // 85+ needs every bar: the engine holds any other at 84.
      if (score !== null && score >= 85 && gate !== null && gate.length > 0) score = 84;
      const band: DesignBand | null =
        score === null
          ? null
          : score >= 85
            ? "excellent"
            : score >= 70
              ? "good"
              : score >= 50
                ? "needs_work"
                : "poor";
      const signals = current
        ? SIG({ ...sig, gate })
        : {
            imgShare: pick([0.1, 0.6, null]),
            legibleChars: pick([97, 800, null]),
            phoneTextPx: pick([10, 11.6, 16, null]),
            layoutK: pick([0.6, 0.995, 1, null]),
            unsubscribe: pick(["before_clip", "after_clip", "none", null]),
          };
      const caps = CAP_DISPLAY_ORDER.filter(() => rnd() < 0.06);
      const i = input({
        score,
        band,
        capped: score === null ? null : caps.length > 0 && rnd() < 0.7 ? true : rnd() < 0.02,
        provisional: score === null ? null : rnd() < 0.2,
        caps,
        issues:
          rnd() < 0.05
            ? [pick(["contrast", "mobile", "clipped", "image_only", "broken_images"])]
            : [],
        source: pick(["render", "render", "render", "template", "static"]),
        coverageConfidence: maybe(pick([0.5, 0.6228, 0.6999999881, 0.7, 0.86]), 0.95),
        signals,
        primaryType: type,
        raw: score === null ? null : score + pick([0, 0.4, 4.4]),
        needs: score === 84 && rnd() < 0.6 ? HELD.needs : [],
        aiReviewed,
        imageLoads: pick([[], loadsOf(1, 6), loadsOf(2, 20), loadsOf(5, 6), loadsOf(3, 3), null]),
        noButtonBacked: pick([true, false, null, undefined]),
      });
      const verdict = verdictOf(verdictInput(i));
      const e = verdictEvidence(i);
      if (verdict === "unscored") {
        expect(e).toBeNull();
        continue;
      }
      expect(e, JSON.stringify(i)).not.toBeNull();
      expect(e!.verdict).toBe(verdict);
      expect(used(e!, i), `${JSON.stringify(e!.rule)} ${JSON.stringify(i)}`).toBe(true);
      expect(names(e!, i), `${e!.sentence} ${JSON.stringify(e!.rule)}`).toBe(true);
      // "It misses N more Good checks below" counts the crosses a reader sees there.
      const crossed = e!.good.filter(
        (r) => r.state === "fail" && r.id !== "score" && r.id !== "serious",
      ).length;
      const also = /It also misses (\d+) Good/.exec(e!.sentence);
      if (also) expect(Number(also[1])).toBe(crossed);
      const more = /It misses (\d+) more Good/.exec(e!.sentence);
      if (more)
        expect(
          Number(more[1]),
          `${e!.sentence} ${JSON.stringify(e!.good)} ${JSON.stringify(i)}`,
        ).toBeLessThan(crossed);
      // The serious rows fail exactly for the gallery's Problems options (the "Bad because" chips).
      const fails = e!.serious
        .filter((r) => r.state === "fail")
        .map((r) => r.id)
        .sort();
      expect(fails).toEqual([...galleryProblemsOf(verdictInput(i))].sort());
      expect(row(e!, "serious").state).toBe(verdict === "bad" ? "fail" : "pass");
      // The Good checklist reads the gate's own bars (an AI rating may stand in for G1–G3).
      const saved = (signals as { gate?: unknown }).gate;
      if (Array.isArray(saved)) {
        // A tick is never next to a measured value that misses the bar, unless the AI stood in.
        if (
          i.aiReviewed === true &&
          !saved.includes("headline") &&
          row(e!, "headline").state === "pass"
        )
          expect(row(e!, "headline").value).not.toMatch(/^No headline/);
      }
      if (Array.isArray(saved) && i.aiReviewed !== true) {
        expect(row(e!, "headline").state).toBe(saved.includes("headline") ? "fail" : "pass");
        expect(row(e!, "button").state).toBe(saved.includes("button") ? "fail" : "pass");
        expect(row(e!, "phone").state).toBe(
          saved.includes("phone_edge") || saved.includes("phone_narrow") ? "fail" : "pass",
        );
      }
      // A Good email passed every bar (the engine holds any other at 84).
      if (verdict === "good" && Array.isArray(saved) && saved.length === 0)
        expect(e!.good.filter((r) => r.state === "fail")).toEqual([]);
      for (const r of [...e!.good, ...e!.serious])
        expect(`${r.value} ${r.limit}`).not.toMatch(/NaN|undefined|Infinity|\bnull%| {2}/);
      // "Real text, not just pictures" passes only when the rule can't fire, pictures or not.
      if (current && row(e!, "image_only").state === "pass")
        expect(
          sig.imgShare >= 0.5 && sig.legibleChars !== null && sig.legibleChars < 200,
          JSON.stringify(i),
        ).toBe(false);
      // "Most of its pictures" only when most of them, by the note's own count, didn't load.
      const said = [e!.sentence, ...[...e!.good, ...e!.serious].map((r) => r.value ?? "")].join(
        " ",
      );
      if (/most of its pictures didn't load/i.test(said) && i.imageLoads?.length) {
        const missed = i.imageLoads.filter((l) => l.decoded !== true).length;
        expect(missed * 2, said).toBeGreaterThan(i.imageLoads.length);
      }
      // G4's row: shown exactly when the score judged it, crossed exactly when it held the email.
      if (current && Array.isArray(saved)) {
        const hero = e!.good.find((r) => r.id === "hero");
        if (sig.heroPicture === null && sig.heroBand === null && !saved.includes("hero"))
          expect(hero, JSON.stringify(i)).toBeUndefined();
        else expect(hero, JSON.stringify(i)).toBeDefined();
        if (saved.includes("hero") && !sig.imagesOff) expect(hero!.state).toBe("fail");
        if (
          hero?.state === "pass" &&
          hero.value !== "The AI review rated the design highly instead"
        )
          expect(sig.heroPicture === true || sig.heroBand === true).toBe(true);
      }
      // The checklist shows exactly the bars the engine used: every saved bar has a crossed row,
      // and every crossed row (but the score, coverage and "no serious problem") a saved bar.
      if (current && Array.isArray(saved) && i.aiReviewed !== true) {
        const ROW_BARS: Record<string, readonly string[]> = {
          headline: ["headline", "plain"],
          button: ["button", "plain"],
          imagery: ["imagery", "imagery_unknown"],
          hero: ["hero", "imagery_unknown"],
          phone: ["phone_narrow", "phone_edge"],
        };
        const crossedRows = e!.good.filter((r) => r.state === "fail" && ROW_BARS[r.id]);
        for (const bar of saved as string[])
          expect(
            crossedRows.some((r) => ROW_BARS[r.id]!.includes(bar)),
            `${bar} ${JSON.stringify(e!.good)} ${JSON.stringify(i)}`,
          ).toBe(true);
        for (const r of crossedRows)
          expect(
            ROW_BARS[r.id]!.some((b) => (saved as string[]).includes(b)),
            `${r.id} ${JSON.stringify(saved)}`,
          ).toBe(true);
        // G3's own "few pictures" is worded as the share, never as pictures that didn't load.
        if ((saved as string[]).includes("imagery"))
          expect(row(e!, "imagery").value).toMatch(/of the email is pictures$/);
        // Look-alike buttons are named as such (a filled button the gate faulted for them).
        if (sig.ctaCompeting === true && sig.ctaSalience !== null && sig.ctaSalience >= 0.9)
          expect(row(e!, "button")).toMatchObject({
            state: "fail",
            value:
              "Several buttons look the same and lead to different actions, so none is the main one",
          });
      }
      // "No main button" is hedged exactly when the card's own test says a button may be missed.
      const buttonValue = row(e!, "button").value ?? "";
      if (current && sig.ctaSalience === null && /^No main button found/.test(buttonValue))
        expect(/may have missed one/.test(buttonValue), buttonValue).toBe(
          i.noButtonBacked === false,
        );
      // The rows the sentence states are failed rows (a Bad rule's problem, an Okay's held bar).
      for (const id of e!.stated) expect(row(e!, id)?.state, `${id} ${e!.sentence}`).toBe("fail");
      if (e!.rule.kind === "cap" || e!.rule.kind === "severe" || e!.rule.kind === "gate")
        expect(e!.stated.length, e!.sentence).toBeGreaterThan(0);
      kinds.add(
        e!.rule.kind === "cap"
          ? e!.rule.cap
          : e!.rule.kind === "severe"
            ? e!.rule.trigger
            : e!.rule.kind,
      );
    }
    // Every rule came up.
    expect([...kinds].sort()).toEqual(
      [
        ...CAP_DISPLAY_ORDER,
        "pictures_not_loaded",
        "text_in_images",
        "tiny_phone_text",
        "unsubscribe_clipped",
        "no_unsubscribe",
        "low_score",
        "capped",
        "good",
        "gate",
        "score",
        "coverage",
        "source",
      ].sort(),
    );
  });
});

describe("only what was measured", () => {
  it("an older analysis (v1.5 signals) shows the known values and marks the rest not measured", () => {
    const e = verdictEvidence(
      input({
        score: 82,
        band: "good",
        signals: {
          imgShare: 0.12,
          legibleChars: null,
          phoneTextPx: 10.508,
          layoutK: 0.657,
          unsubscribe: "before_clip",
        },
        checks: null,
        imageLoads: null,
        pillars: [],
      }),
    )!;
    // v1.5 rule: any shrink with text under 11.5 px.
    expect(e.rule).toEqual({ kind: "severe", trigger: "tiny_phone_text" });
    expect(e.sentence).toContain("(Bad is any shrinking with text under 11.5 px)");
    for (const id of ["headline", "button", "phone"])
      expect(row(e, id)).toMatchObject({ state: "unknown", value: null });
    expect(row(e, "clipped")).toMatchObject({ state: "unknown", value: null });
    expect(e.areas).toBeNull();
    expect(e.notes).toContain(
      "Scored with an older version of our checks, so some measurements weren't saved.",
    );
  });

  it("a compacted analysis works from the saved summary alone", () => {
    const e = ev({
      checks: null,
      imageLoads: null,
      compacted: true,
      signals: SIG({ imagesUnknownShare: 0.6 }),
    });
    expect(e.verdict).toBe("good");
    expect(row(e, "contrast")).toMatchObject({ state: "unknown", value: null });
    // A passing ratio is rounded as the gallery's own strength line rounds it.
    expect(row(e, "headline").value).toBe("Headline 1.8× the size of the text");
    expect(e.notes).toEqual([
      "Some of its pictures didn't load when we checked it, so the picture checks couldn't see them.",
      "The detailed measurements were cleared to save space, so a few values aren't shown.",
    ]);
  });

  it("pictures that didn't load, and why; pictures off for the email", () => {
    const loads = [
      ...Array.from({ length: 7 }, () => ({ status: 200, decoded: true })),
      ...Array.from({ length: 4 }, () => ({ status: 403, decoded: false, reason: "expired" })),
    ];
    expect(ev({ imageLoads: loads }).notes).toEqual([
      "4 of its 11 pictures didn't load: the links had expired.",
    ]);
    const mixed = [
      { status: 200, decoded: true },
      { status: "blocked", decoded: false, reason: "per_recipient" },
      { status: "too_large", decoded: false, reason: "too_large" },
    ];
    expect(ev({ imageLoads: mixed }).notes).toEqual([
      "2 of its 3 pictures didn't load: 1 because we block it to protect your privacy, 1 because it was too big to load.",
    ]);
    const off = ev({
      primaryType: "account_notice",
      signals: SIG({
        primaryType: "account_notice",
        imagesOff: true,
        drawnContentImages: null,
        imagesUnknownShare: null,
        htmlContentImages: 1,
        liveTextChars: 40,
        legibleChars: null,
      }),
    });
    // Pictures we didn't ask for never make an email "just pictures that didn't load".
    expect(off.verdict).toBe("good");
    expect(row(off, "imagery")).toMatchObject({
      state: "neutral",
      value: "Not checked: we don't load pictures for this kind of email",
    });
    expect(off.notes[0]).toBe(
      "We don't load pictures for this kind of email (account and order emails), so the picture checks were skipped.",
    );
  });

  it("the score by area: plain names, the AI review's share, the hold", () => {
    const e = ev({ ...HELD, signals: SIG({ gate: ["button"] }) });
    expect(e.areas!.rows.map((r) => r.label)).toEqual([
      "Easy for everyone to read",
      "Works on phones",
      "Text and fonts",
      "Headline and main button",
      "Pictures",
      "Layout and colours",
      "Subject and wording",
      "Works in every email app",
      "Unsubscribe and footer",
    ]);
    expect(e.areas!.notes).toEqual([
      "AI review is off, so the other areas count a bit more.",
      "These add up to 88, but the score is held at 84 because it misses a Good check.",
    ]);
    expect(ev({ aiReviewed: true }).areas!.notes).toEqual([]);
    // An area that doesn't apply (no footer checks) isn't listed.
    const noFooter = ev({
      pillars: PILLARS.map((p) => (p.id === "footer" ? { ...p, points: 0, max: 0 } : p)),
    });
    expect(noFooter.areas!.rows.map((r) => r.id)).not.toContain("footer");
  });

  it("no jargon in anything the panel says", () => {
    const all = [
      ev(),
      ev({ ...HELD, signals: SIG({ gate: ["headline", "button", "imagery", "phone_edge"] }) }),
      ev({
        score: 59,
        caps: ["CAP_CONTRAST", "CAP_MOBILE_BROKEN", "CAP_MERGE_TAG", "CAP_BROKEN_IMAGES"],
        capped: true,
      }),
    ];
    const text = all
      .flatMap((e) => [
        e.sentence,
        e.treatedAs ?? "",
        ...e.notes,
        ...(e.areas?.notes ?? []),
        ...(e.areas?.rows.map((r) => r.label) ?? []),
        ...[...e.good, ...e.serious].flatMap((r) => [r.label, r.value ?? "", r.limit ?? ""]),
      ])
      .join(" ");
    expect(text).not.toMatch(
      /salience|pillar|\bCTA\b|\bG[123]\b|\bWCAG\b|\bk\b|signal|render|viewport/i,
    );
  });
});

describe("the problem list doesn't repeat the panel", () => {
  /** galleryReason's problem lines for the same facts (real wording). */
  const problemsFor = (i: EvidenceInput, needs = i.needs) =>
    galleryReason(
      verdictOf(verdictInput(i)),
      { needsImprovement: needs.map((n) => ({ ...n, points: 3, ai: false })), good: [] },
      {
        capped: i.capped,
        caps: i.caps,
        signals: i.signals,
        primaryType: i.primaryType,
        score: i.score,
        checks: [],
      },
    ).problems;

  it("drops the deciding rule's line and the lines a failed check states, keeps the rest", () => {
    const cases: EvidenceInput[] = [
      input({
        score: 78,
        band: "good",
        signals: SIG({ htmlKB: 136.2, unsubscribeUnion: "after_clip" }),
      }),
      input({ score: 74, band: "good", signals: SIG({ imgShare: 0.871, legibleChars: 97 }) }),
      input({ score: 77, band: "good", signals: SIG({ layoutK: 0.7, phoneTextPx: 11 }) }),
      input({ score: 80, band: "good", signals: SIG({ unsubscribeUnion: "none" }) }),
      input({ score: 55, band: "needs_work" }),
      input({
        ...HELD,
        signals: SIG({ headlineRatio: 1.1, gate: ["headline", "button"], ctaSalience: 0.5 }),
      }),
      input({
        ...HELD,
        primaryType: "notification",
        signals: SIG({ primaryType: "notification", imgShare: 0.03, gate: ["imagery"] }),
      }),
    ];
    for (const i of cases) {
      const e = verdictEvidence(i)!;
      const problems = problemsFor(i);
      expect(problems.length, e.sentence).toBeGreaterThan(0);
      const kept = withoutRestatedLines(problems, e);
      // The first line is the deciding rule's: the sentence says it.
      expect(kept, `${e.sentence} | ${problems.join(" | ")}`).not.toContain(problems[0]);
    }
    // A different statement about the button (its words are faint) stays.
    const i = input({
      ...HELD,
      signals: SIG({ gate: ["headline"], headlineRatio: 1.1 }),
    });
    const kept = withoutRestatedLines(
      [
        "No real headline (the biggest text is 1.1× the body text; Good needs 1.5×)",
        "The words on the main button “Go” are hard to read (2.1:1)",
      ],
      verdictEvidence(i),
    );
    expect(kept).toEqual(["The words on the main button “Go” are hard to read (2.1:1)"]);
    // Without the evidence (still loading) nothing is dropped.
    expect(withoutRestatedLines(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("while the checks are folded, only the sentence's own statement is left out", () => {
    // Okay, held for the headline; the button misses too, but only the folded checks say so.
    const okay = input({
      ...HELD,
      signals: SIG({ headlineRatio: 1.1, gate: ["headline", "button"], ctaSalience: 0.5 }),
    });
    const e = verdictEvidence(okay)!;
    expect(e.stated).toEqual(["headline"]);
    const problems = problemsFor(okay);
    const head = problems.find((l) => /headline/i.test(l));
    const button = problems.find((l) => /main button/i.test(l));
    expect(head && button, problems.join(" | ")).toBeTruthy();
    expect(withoutRestatedLines(problems, e, false)).not.toContain(head);
    expect(withoutRestatedLines(problems, e, false)).toContain(button);
    expect(withoutRestatedLines(problems, e, true)).not.toContain(button);

    // Bad: the deciding problem's own row, for a cap, each kind of severe problem and a low score.
    const bad: Array<[EvidenceInput, string[]]> = [
      [
        input({ score: 69, band: "good", caps: ["CAP_CLIPPED"], signals: SIG({ htmlKB: 136.2 }) }),
        ["clipped"],
      ],
      [
        input({
          score: 78,
          band: "good",
          signals: SIG({ htmlKB: 136.2, unsubscribeUnion: "after_clip" }),
        }),
        ["clipped"],
      ],
      [
        input({ score: 74, band: "good", signals: SIG({ imgShare: 0.871, legibleChars: 97 }) }),
        ["image_only"],
      ],
      [
        input({ score: 77, band: "good", signals: SIG({ layoutK: 0.7, phoneTextPx: 11 }) }),
        ["mobile"],
      ],
      [
        input({ score: 80, band: "good", signals: SIG({ unsubscribeUnion: "none" }) }),
        ["no_unsubscribe"],
      ],
      [input({ score: 55, band: "needs_work" }), ["low_score"]],
    ];
    for (const [i, stated] of bad) {
      const b = verdictEvidence(i)!;
      expect(b.verdict, b.sentence).toBe("bad");
      expect(b.stated, b.sentence).toEqual(stated);
      const lines = problemsFor(i);
      // Folded or not, the deciding line (the card's first) is the sentence's.
      expect(withoutRestatedLines(lines, b, false)).not.toContain(lines[0]);
    }
    // Good and a plain low score Okay state no row.
    expect(verdictEvidence(input({}))!.stated).toEqual([]);
    expect(verdictEvidence(input({ score: 80, band: "good", raw: 80 }))!.stated).toEqual([]);
  });
});

describe("footer statements and the stray-text note (current HTML pass) stay in the list", () => {
  const STRAY = "Shows stray text addressed to AI or review software, which readers see too";
  const U3 = "No link to choose how often you get these emails";
  const U4 = "Doesn't say why you're getting this email";
  const FOOTER_NEEDS = [
    { key: "note:stray-text", title: STRAY },
    { key: "check:U3", title: "No link to manage email preferences" },
    { key: "check:U4", title: "Doesn't say why you're receiving this email" },
  ];
  /** galleryReason's lines for a methodology 2026.6 summary and a render-2026.5 render. */
  const linesFor = (i: EvidenceInput, rendererVersion: string | null) =>
    galleryReason(
      verdictOf(verdictInput(i)),
      {
        scoringVersion: "2026.6+w-2026.1+t-2026.3+lex-2026.3",
        needsImprovement: [...i.needs, ...FOOTER_NEEDS].map((n) => ({
          ...n,
          points: 1,
          ai: false,
        })),
        good: [],
      },
      {
        capped: i.capped,
        caps: i.caps,
        signals: i.signals,
        primaryType: i.primaryType,
        score: i.score,
        checks: [],
        rendererVersion,
      },
    ).problems;

  it("no row of the panel states them, so they are never dropped as said twice", () => {
    const cases: EvidenceInput[] = [
      input({
        score: 80,
        band: "good",
        primaryType: "newsletter",
        signals: SIG({ primaryType: "newsletter" }),
      }),
      input({ score: 91, primaryType: "newsletter", signals: SIG({ primaryType: "newsletter" }) }),
      input({
        ...HELD,
        signals: SIG({ headlineRatio: 1.1, gate: ["headline"] }),
      }),
      input({ score: 80, band: "good", signals: SIG({ unsubscribeUnion: "none" }) }),
      input({ score: 55, band: "needs_work" }),
    ];
    for (const i of cases) {
      const e = verdictEvidence(i)!;
      const lines = linesFor(i, "render-2026.5");
      const footer = lines.filter((l) => l === STRAY || l === U3 || l === U4);
      expect(footer.length, `${e.sentence} | ${lines.join(" | ")}`).toBeGreaterThan(0);
      for (const shown of [true, false])
        expect(withoutRestatedLines(lines, e, shown)).toEqual(expect.arrayContaining(footer));
    }
    // An Okay with nothing else to say lists all three, and the panel keeps all three.
    const plain = input({
      score: 80,
      band: "good",
      primaryType: "newsletter",
      signals: SIG({ primaryType: "newsletter" }),
    });
    expect(linesFor(plain, "render-2026.5")).toEqual([STRAY, U3, U4]);
    expect(withoutRestatedLines(linesFor(plain, "render-2026.5"), verdictEvidence(plain))).toEqual([
      STRAY,
      U3,
      U4,
    ]);
    // An older render: the card list doesn't have them, so the panel has nothing to keep.
    expect(linesFor(plain, "render-2026.4")).toEqual([]);
  });
});

describe("G4: a large picture or a headline on a coloured band (methodology 2026.6)", () => {
  /** The card's problem lines for the same facts (lib/gallery.ts galleryReason). */
  const cardLines = (i: EvidenceInput) =>
    galleryReason(
      verdictOf(verdictInput(i)),
      { needsImprovement: i.needs.map((n) => ({ ...n, points: 3, ai: false })), good: [] },
      { signals: i.signals, primaryType: i.primaryType, score: i.score, checks: [] },
    );
  const social = (over: Record<string, unknown>, rest: Partial<EvidenceInput> = {}) =>
    input({
      ...HELD,
      primaryType: "social",
      signals: SIG({ primaryType: "social", imgShare: 0.12, ...over }),
      ...rest,
    });

  it("a stock template held at 84: the sentence, a crossed row, and the card's line once", () => {
    const i = social({ heroPicture: false, heroBand: false, gate: ["hero"] });
    const e = verdictEvidence(i)!;
    expect(e.rule).toEqual({ kind: "gate", bar: "hero" });
    expect(e.sentence).toBe(
      "Okay: no serious problems, but not Good because there's no large picture and no headline on a coloured band (Good needs one of the two). That holds its score at 84 (its points add up to 88).",
    );
    expect(row(e, "hero")).toMatchObject({
      label: "A large picture or a headline on a coloured band",
      state: "fail",
      value: "Neither: no large picture, and no headline on a coloured band",
    });
    expect(e.stated).toEqual(["hero"]);
    const card = cardLines(i);
    const line = [card.reason?.text ?? "", ...card.problems].find((t) =>
      /^No large picture/.test(t),
    );
    expect(line).toBe(
      "No large picture and no headline on a coloured band (Good needs one of the two)",
    );
    expect(withoutRestatedLines(card.problems, e, false)).not.toContain(line);
  });

  it("what was found, an AI stand-in, images off, and scores from before G4", () => {
    expect(
      row(verdictEvidence(social({ heroPicture: true, heroBand: false }))!, "hero"),
    ).toMatchObject({ state: "pass", value: "A large picture" });
    expect(
      row(verdictEvidence(social({ heroPicture: false, heroBand: true }))!, "hero"),
    ).toMatchObject({ state: "pass", value: "A headline on a coloured band" });
    // An AI rating of 4+ stands in for G4 too: the tick says why.
    const ai = verdictEvidence(
      social(
        { heroPicture: false, heroBand: false, gate: [] },
        { aiReviewed: true, score: 88, band: "excellent", needs: [] },
      ),
    )!;
    expect(row(ai, "hero")).toMatchObject({
      state: "pass",
      value: "The AI review rated the design highly instead",
    });
    const off = verdictEvidence(social({ heroPicture: false, heroBand: false, imagesOff: true }))!;
    expect(row(off, "hero")).toMatchObject({
      state: "neutral",
      value: "Not checked: we don't load pictures for this kind of email",
    });
    // Scored before G4 (no hero facts saved): no row, never a guessed tick.
    expect(verdictEvidence(social({}))!.good.some((r) => r.id === "hero")).toBe(false);
  });

  it("a picture that didn't load could have been the large one: whose row says so", () => {
    const loads = [
      { status: 200, decoded: true },
      { status: 403, decoded: false, reason: "expired" },
    ];
    // Marketing mail has no picture bar: the hero row carries the miss.
    const promo = verdictEvidence(
      input({
        ...HELD,
        signals: SIG({
          heroPicture: false,
          heroBand: false,
          imagesUnknownShare: 0.8,
          gate: ["imagery_unknown"],
        }),
        imageLoads: loads,
      }),
    )!;
    expect(promo.good.some((r) => r.id === "imagery")).toBe(false);
    expect(row(promo, "hero")).toMatchObject({
      state: "fail",
      value: "Its biggest picture didn't load, so we can't tell if it has one",
    });
    expect(promo.sentence).toContain(
      "not Good because its biggest picture didn't load, so we can't tell if it has a large picture (Good needs one, or a headline on a coloured band).",
    );
    expect(promo.stated).toEqual(["hero"]);
    // A notification has the picture bar: it carries the miss, and G4 is "not measured".
    const note = verdictEvidence(
      input({
        ...HELD,
        primaryType: "notification",
        signals: SIG({
          primaryType: "notification",
          imgShare: 0.04,
          heroPicture: false,
          heroBand: false,
          imagesUnknownShare: 0.8,
          gate: ["imagery_unknown"],
        }),
        imageLoads: loads,
      }),
    )!;
    expect(row(note, "imagery").state).toBe("fail");
    expect(row(note, "hero")).toMatchObject({
      state: "unknown",
      value: "Its biggest picture didn't load, so we can't tell",
    });
    expect(note.stated).toEqual(["imagery"]);
    // Its pictures cover 12% (the picture bar passed) and most of the area was drawn: the miss is
    // G4's alone, never a cross on the 8% it reached.
    const reached = verdictEvidence(
      input({
        ...HELD,
        primaryType: "notification",
        signals: SIG({
          primaryType: "notification",
          imgShare: 0.12,
          heroPicture: false,
          heroBand: false,
          imagesUnknownShare: 0.3,
          gate: ["imagery_unknown"],
        }),
        imageLoads: loads,
      }),
    )!;
    expect(row(reached, "imagery")).toMatchObject({
      state: "pass",
      value: "12% of the email is pictures",
    });
    expect(row(reached, "hero")).toMatchObject({
      state: "fail",
      value: "Its biggest picture didn't load, so we can't tell if it has one",
    });
    expect(reached.stated).toEqual(["hero"]);
    expect(reached.sentence).toContain("so we can't tell if it has a large picture");
  });
});

describe("G2's look-alike buttons, a button we may have missed, and whose picture miss it is", () => {
  /** The card's problem lines for the same facts (lib/gallery.ts galleryReason). */
  const cardLines = (i: EvidenceInput) =>
    galleryReason(
      verdictOf(verdictInput(i)),
      { needsImprovement: i.needs.map((n) => ({ ...n, points: 3, ai: false })), good: [] },
      { signals: i.signals, primaryType: i.primaryType, score: i.score, checks: [] },
    );
  const note = (over: Record<string, unknown>, rest: Partial<EvidenceInput> = {}) =>
    input({
      ...HELD,
      primaryType: "notification",
      signals: SIG({ primaryType: "notification", imgShare: 0.12, ...over }),
      ...rest,
    });

  it("three look-alike buttons for different actions: none is the main one, said once", () => {
    const i = note({ ctaCompeting: true, gate: ["button"] });
    const e = verdictEvidence(i)!;
    expect(e.rule).toEqual({ kind: "gate", bar: "button" });
    expect(e.sentence).toBe(
      "Okay: no serious problems, but not Good because several buttons look the same and lead to different actions, so none is the main one (Good needs one that stands out). That holds its score at 84 (its points add up to 88).",
    );
    // Never "no other link or picture is bigger" next to the cross: that's not why it failed.
    expect(row(e, "button")).toMatchObject({
      state: "fail",
      value: "Several buttons look the same and lead to different actions, so none is the main one",
    });
    const card = cardLines(i);
    const line = [card.reason?.text ?? "", ...card.problems].find((t) => /look the same/.test(t));
    expect(line).toBe(
      "No main button: several buttons look the same and lead to different actions (Good needs one that stands out)",
    );
    expect(withoutRestatedLines(card.problems, e, false)).not.toContain(line);
    // An AI rating of 4+ stands in for G2 too: the tick says why.
    const ai = verdictEvidence(
      note(
        { ctaCompeting: true, gate: [] },
        { aiReviewed: true, score: 88, band: "excellent", needs: [] },
      ),
    )!;
    expect(row(ai, "button")).toMatchObject({
      state: "pass",
      value: "The AI review rated the design highly instead",
    });
    // Not competing, or scored before the rule: the button's own facts, as before.
    for (const c of [false, null])
      expect(row(verdictEvidence(note({ ctaCompeting: c }))!, "button")).toMatchObject({
        state: "pass",
        value: "The main button: a bold colour, and no other link or picture is bigger",
      });
  });

  it("no main button found where a button may have been missed: hedged, and never the lead", () => {
    const held = (backed: boolean | null) =>
      verdictEvidence(
        note(
          {
            imgShare: 0.04,
            ctaSalience: null,
            ctaMostProminent: null,
            ctaFirstScreen: null,
            gate: ["button", "imagery"],
          },
          { noButtonBacked: backed },
        ),
      )!;
    // A link painted as a button or a button-sized link: like the card, lead with the pictures.
    const maybe = held(false);
    expect(maybe.rule).toEqual({ kind: "gate", bar: "imagery" });
    expect(maybe.sentence).toBe(
      "Okay: no serious problems, but not Good because pictures cover only 4% of it (Good needs 8% for this kind of email). It misses 1 more Good check below. That holds its score at 84 (its points add up to 88).",
    );
    expect(row(maybe, "button")).toMatchObject({
      state: "fail",
      value: "No main button found, though we may have missed one",
    });
    expect(maybe.stated).toEqual(["imagery"]);
    // Backed up (or not known): the measured fact, in the card's order.
    for (const backed of [true, null]) {
      const e = held(backed);
      expect(e.rule).toEqual({ kind: "gate", bar: "button" });
      expect(row(e, "button").value).toBe("No main button found");
    }
    // The only bar: it still says why, hedged.
    const only = verdictEvidence(
      note(
        { ctaSalience: null, ctaMostProminent: null, ctaFirstScreen: null, gate: ["button"] },
        { noButtonBacked: false },
      ),
    )!;
    expect(only.sentence).toContain(
      "not Good because we found no main button, though we may have missed one (Good needs one that stands out).",
    );
  });

  it("few pictures and a large picture that didn't load: each bar in its own row", () => {
    const loads = [
      { status: 200, decoded: true },
      { status: 403, decoded: false, reason: "expired" },
    ];
    // G3 missed on its own count (the missing ones couldn't have reached 8%) and G4 couldn't see
    // a large picture: "few pictures" for G3, "can't tell" for G4 — never "didn't load" for G3.
    const e = verdictEvidence(
      note(
        {
          imgShare: 0.04,
          heroPicture: false,
          heroBand: false,
          imagesUnknownShare: 0.8,
          gate: ["imagery", "imagery_unknown"],
        },
        { imageLoads: loads },
      ),
    )!;
    expect(row(e, "imagery")).toMatchObject({
      state: "fail",
      value: "4% of the email is pictures",
    });
    expect(row(e, "hero")).toMatchObject({
      state: "fail",
      value: "Its biggest picture didn't load, so we can't tell if it has one",
    });
    expect(e.rule).toEqual({ kind: "gate", bar: "imagery" });
    expect(e.sentence).toContain("It misses 1 more Good check below.");
  });
});

describe("the panel's copies of the engine's limits are the engine's", () => {
  it("the picture bar's exempt types, the hold, the AI checks, the contrast cap", () => {
    for (const t of EMAIL_TYPES) {
      const misses = excellenceGate(
        [
          { id: "H6", status: "pass", s: 1, value: { ratio: 2, headline: true } },
          {
            id: "H3",
            status: "pass",
            s: 1,
            value: { present: true, salience: 1, mostProminent: true },
          },
          { id: "H2", status: "pass", s: 1, value: {} },
        ],
        { primaryType: t, imgShare: 0, imagesUnknownShare: 0 },
      ).misses;
      expect(misses.includes("imagery"), t).toBe(!IMAGERY_EXEMPT_TYPES.has(t));
    }
    expect(GATE_CEILING).toBe(EXCELLENCE_CEILING);
    expect([...AI_CHECKS]).toEqual([...AI_CHECK_IDS]);
    expect(CONTRAST_CAP_SHARE).toBe(ENGINE_CONTRAST_SHARE);
  });

  it("the Good checklist shows exactly the bars the engine's own gate used, on its own output", () => {
    let seed = 20261001;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    /** The rows each saved bar may be shown in. */
    const ROW_BARS: Record<string, readonly string[]> = {
      headline: ["headline", "plain"],
      button: ["button", "plain"],
      imagery: ["imagery", "imagery_unknown"],
      hero: ["hero", "imagery_unknown"],
      phone: ["phone_narrow", "phone_edge"],
    };
    let judged = 0;
    for (let n = 0; n < 3000; n++) {
      const type = pick(EMAIL_TYPES);
      const ai = rnd() < 0.15;
      const wideShare = pick([1, 0.6, 0.5, 0.4]);
      const okShare = pick([1, 0.51, 0.5]);
      const h6 = { ratio: pick([1, 1.149, 1.49, 1.5, 2]), headline: pick([true, true, false]) };
      const h3 =
        rnd() < 0.15
          ? null
          : {
              present: true,
              label: "Go",
              salience: pick([0.5, 0.899, 0.9, 1]),
              mostProminent: pick([true, false]),
            };
      const checks = [
        { id: "H6", status: "pass", s: 1, value: h6 },
        h3
          ? { id: "H3", status: "pass", s: 1, value: h3 }
          : { id: "H3", status: "not_applicable", s: null, value: { present: false } },
        { id: "M3", status: "pass", s: 1, value: { wideShare } },
        { id: "M7", status: "pass", s: 1, value: { okShare } },
        ...(ai ? [{ id: "H7", status: "pass", s: 1, value: { level: 4 } }] : []),
      ] as Parameters<typeof excellenceGate>[0];
      // Methodology 2026.6's facts, or a caller from before them.
      const v26 = rnd() < 0.75;
      const facts = {
        primaryType: type,
        imgShare: pick([0, 0.005, 0.0799, 0.08, 0.3]),
        imagesUnknownShare: pick([null, 0, 0.4, 0.75]),
        imgShareIfLoaded: pick([null, 0.02, 0.2]),
        imagesOff: rnd() < 0.1,
        ctaFirstScreen: pick([true, false, null]),
        ...(v26
          ? {
              ctaCompeting: pick([true, false, false]),
              heroPicture: pick([true, false, false]),
              heroBand: pick([true, false, false]),
              heroUnknown: pick([true, false, false]),
            }
          : {}),
      };
      const g = excellenceGate(checks, facts);
      // Saved as summary.ts scoreSignals saves them.
      const gate = g.rule === "bars" ? [...g.misses] : null;
      const signals = SIG({
        primaryType: type,
        headlineRatio: g.headlineRatio,
        hasHeadline: g.hasHeadline,
        ctaSalience: g.ctaSalience,
        ctaMostProminent: g.ctaMostProminent,
        ctaFirstScreen: g.ctaFirstScreen,
        ctaLabelContrast: g.ctaLabelContrast,
        ctaCompeting: g.ctaCompeting,
        gate,
        heroPicture: g.heroPicture,
        heroBand: g.heroBand,
        imgShare: facts.imgShare,
        imagesOff: facts.imagesOff,
        imagesUnknownShare: facts.imagesUnknownShare,
      });
      const held = g.misses.length > 0;
      const e = verdictEvidence(
        input({
          ...(held ? HELD : { score: 90, band: "excellent" as DesignBand, raw: 90.2, needs: [] }),
          primaryType: type,
          signals,
          aiReviewed: ai,
          checks: {
            H6: { status: "pass", value: h6 },
            ...(h3 ? { H3: { status: "pass", value: h3 } } : {}),
            M3: { status: "pass", value: { wideShare } },
            M7: { status: "pass", value: { okShare } },
          },
        }),
      )!;
      const ctx = `${JSON.stringify(g.misses)} ${JSON.stringify(facts)} ${JSON.stringify(e.good)}`;
      if (gate === null) {
        expect(
          e.good.some((r) => r.id === "hero"),
          ctx,
        ).toBe(false);
        continue;
      }
      judged++;
      const crossed = e.good.filter((r) => r.state === "fail" && ROW_BARS[r.id]);
      for (const bar of gate)
        expect(
          crossed.some((r) => ROW_BARS[r.id]!.includes(bar)),
          `${bar} not shown: ${ctx}`,
        ).toBe(true);
      for (const r of crossed)
        expect(
          ROW_BARS[r.id]!.some((b) => (gate as readonly string[]).includes(b)),
          `${r.id} crossed: ${ctx}`,
        ).toBe(true);
      // A row for each bar the engine judges for this email, and none for one it doesn't.
      const imagery = e.good.find((r) => r.id === "imagery");
      expect(!!imagery, ctx).toBe(!IMAGERY_EXEMPT_TYPES.has(type));
      if (imagery && facts.imagesOff) expect(imagery.state).toBe("neutral");
      const hero = e.good.find((r) => r.id === "hero");
      expect(!!hero, ctx).toBe(v26);
      if (hero && facts.imagesOff) expect(hero.state).toBe("neutral");
      // Held: the sentence names one of the engine's bars; passed: Good, every check ticked.
      if (held)
        expect(e.rule.kind === "gate" && gate.includes(e.rule.bar as never), ctx).toBe(true);
      else {
        expect(e.verdict, ctx).toBe("good");
        expect(
          e.good.filter((r) => r.state === "fail"),
          ctx,
        ).toEqual([]);
      }
    }
    expect(judged).toBeGreaterThan(2000);
  });
});

describe("review fixes (2026-10-01 policy review)", () => {
  it("pictures we couldn't see: the share isn't judged, and a too-big poster says so", () => {
    // A YouTube alert whose thumbnail our privacy proxy blocked: Okay, the share unknown.
    const youtube = ev({
      score: 72,
      band: "good",
      raw: 72.2,
      signals: SIG({ imgShare: 1, legibleChars: 65, liveTextChars: 65, imagesUnknownShare: 0.522 }),
    });
    expect(youtube.verdict).toBe("ok");
    expect(row(youtube, "image_only")).toMatchObject({
      state: "unknown",
      value:
        "Most of its picture area didn't load, so we can't tell how much of it is pictures (it has 65 characters of real text)",
    });
    expect(youtube.sentence).not.toMatch(/pictures cover/);
    // A poster too big for us to load: Bad, and the sentence says whose side that was on.
    const poster = ev({
      score: 71,
      band: "good",
      raw: 71,
      signals: SIG({
        htmlContentImages: 1,
        drawnContentImages: 0,
        liveTextChars: 51,
        imgShare: 0.87,
        legibleChars: 51,
        imagesUnknownShare: 1,
      }),
      imageLoads: [{ status: "too_large", reason: "too_large", decoded: false }],
    });
    expect(poster.sentence).toBe(
      "Bad: this email is just pictures, and its one picture is too big for us to load, leaving only 51 characters of real text (under 200 characters is too little).",
    );
  });

  it("the unsubscribe rule reads the email's type now, as its category does", () => {
    const signals = SIG({ unsubscribeUnion: "none", unsubscribe: null });
    const corrected = ev({ signals, primaryType: "account_notice" });
    expect(corrected.verdict).toBe("good");
    expect(row(corrected, "no_unsubscribe").state).toBe("neutral");
    expect(corrected.treatedAs).toBe(
      "Treated as an account email, so a missing unsubscribe link doesn't make it Bad.",
    );
    const asScored = ev({ signals, primaryType: "promotional" });
    expect(asScored.verdict).toBe("bad");
    expect(asScored.rule).toEqual({ kind: "severe", trigger: "no_unsubscribe" });
    // Null (not known): the type the score used.
    expect(ev({ signals, primaryType: null }).verdict).toBe("bad");
  });

  it("pictures we couldn't see: enough real text still passes, and the wording follows the loads", () => {
    // An Unstop alert whose two pictures our privacy proxy blocked: I1 couldn't count legible text,
    // but 681 characters of real text can never be "just pictures".
    const unstop = ev({
      score: 81,
      band: "good",
      raw: 81,
      primaryType: "notification",
      signals: SIG({
        primaryType: "notification",
        imgShare: 0.017,
        legibleChars: null,
        liveTextChars: 681,
        htmlContentImages: 2,
        drawnContentImages: 0,
        imagesUnknownShare: 1,
        gate: ["headline", "button", "imagery"],
      }),
      imageLoads: [
        { status: null, decoded: false, reason: "tracker" },
        { status: null, decoded: false, reason: "tracker" },
      ],
    });
    expect(unstop.verdict).toBe("ok");
    expect(row(unstop, "image_only")).toMatchObject({
      state: "pass",
      value: "681 characters of real text, so it isn't just pictures",
    });
    // The Good row's measured share and the serious row never disagree about the pictures.
    expect(row(unstop, "imagery")).toMatchObject({
      state: "fail",
      value: "1% of the email is pictures",
    });
    expect(unstop.notes[0]).toBe(
      "None of its 2 pictures loaded: we block them to protect your privacy.",
    );

    // Pictures that didn't load cover most of the picture area, but are few by count: the panel
    // says so in the note's own terms (never "most of its pictures" when 2 of 20 didn't load).
    const loads = (missed: number, all: number) => [
      ...Array.from({ length: all - missed }, () => ({ status: 200, decoded: true })),
      ...Array.from({ length: missed }, () => ({ status: 403, decoded: false, reason: "expired" })),
    ];
    const heldUnknown = (missed: number, all: number) =>
      ev({
        ...HELD,
        primaryType: "social",
        signals: SIG({
          primaryType: "social",
          imgShare: 0.04,
          imagesUnknownShare: 0.8,
          gate: ["imagery_unknown"],
        }),
        imageLoads: loads(missed, all),
      });
    const one = heldUnknown(1, 6);
    expect(one.sentence).toContain(
      "not Good because its biggest picture didn't load, so its pictures can't count toward Good.",
    );
    expect(row(one, "imagery").value).toBe(
      "Its biggest picture didn't load, so its pictures can't count",
    );
    expect(one.notes[0]).toBe("1 of its 6 pictures didn't load: the link had expired.");
    expect(row(heldUnknown(2, 20), "imagery").value).toBe(
      "Most of its picture area didn't load, so its pictures can't count",
    );
    expect(row(heldUnknown(5, 6), "imagery").value).toBe(
      "Most of its pictures didn't load, so they can't count",
    );
    for (const [m, n] of [
      [1, 6],
      [2, 20],
      [5, 6],
    ] as const) {
      const e = heldUnknown(m, n);
      const said = [e.sentence, ...e.good.map((r) => r.value ?? "")].join(" ");
      if (m * 2 <= n) expect(said).not.toMatch(/most of its pictures/i);
    }
  });

  it("the picture share reads the same in the sentence, both lists and the card", () => {
    for (const share of [0.0153, 0.075, 0.0798, 0.0799, 0.08, 0.4996, 0.5]) {
      const signals = SIG({
        primaryType: "notification",
        imgShare: share,
        gate: share < 0.08 ? ["imagery"] : [],
      });
      const e = ev({ ...HELD, primaryType: "notification", signals });
      const shares = [
        /^(Under 1|\d+)% of the email is pictures/i.exec(row(e, "imagery").value ?? "")?.[1],
        /^Pictures cover (under 1|\d+)%/.exec(row(e, "image_only").value ?? "")?.[1],
        /pictures cover (?:only )?(under 1|\d+)%/.exec(e.sentence)?.[1],
      ].filter((x): x is string => x !== undefined);
      expect(new Set(shares.map((x) => x.toLowerCase())).size, String(share)).toBe(1);
      const shown = shares[0]!.toLowerCase();
      // Never on the other side of Good's 8% or the Bad rule's half.
      if (shown !== "under 1") {
        expect(Number(shown) >= 8, String(share)).toBe(share >= 0.08);
        expect(Number(shown) >= 50, String(share)).toBe(share >= 0.5);
      }
      if (share < 0.08) {
        // The card's own line for the same bar (lib/gallery.ts gateLines).
        const card = galleryReason(
          "ok",
          {
            needsImprovement: [
              { key: "gate:excellence", title: "Plain design", points: 3, ai: false },
            ],
            good: [],
          },
          { signals, primaryType: "notification", score: 84, checks: [] },
        );
        const line = [card.reason?.text ?? "", ...card.problems].find((t) =>
          /^Few pictures/.test(t),
        );
        expect(line, String(share)).toContain(`(${shown}%;`);
      }
    }
  });

  it("a phone layout that shrinks but stays readable says why it passes", () => {
    const readable = ev({
      ...HELD,
      primaryType: "notification",
      signals: SIG({ primaryType: "notification", layoutK: 0.558, phoneTextPx: 17.86 }),
    });
    expect(row(readable, "mobile")).toMatchObject({
      label: "Fits a phone screen",
      state: "pass",
      value: "Shrinks to 56% to fit, but text is still about 17.9 px",
    });
    const little = ev({ ...HELD, signals: SIG({ layoutK: 0.85, phoneTextPx: 12 }) });
    expect(row(little, "mobile")).toMatchObject({
      state: "pass",
      value: "Shrinks only a little (to 85%), so text is about 12 px",
    });
  });

  it("over Gmail's limit without hiding anything that matters passes the Gmail row", () => {
    const e = ev({
      signals: SIG({ htmlKB: 103.4 }),
      checks: {
        X1: { status: "partial", value: { clipped: true, bytes: 103_400, afterShare: 0.09 } },
      },
    });
    expect(row(e, "clipped")).toMatchObject({
      label: "Gmail doesn't cut off key parts",
      state: "pass",
      value: "103 KB: Gmail cuts it off, but only the last 9% of the text is hidden",
    });
  });
});
