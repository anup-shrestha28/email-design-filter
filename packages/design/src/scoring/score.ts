/**
 * `scoreEmail(features, ctx)` — the pure scoring function (DESIGN-SCORE §3–§7; FREE-TIER.md §5.4
 * coverage levels). Deterministic: no clock, no randomness, no I/O (time comes from `ctx.now`).
 */
import { fontProfile } from "../fonts/profile";
import {
  CHECK_IDS,
  type CapId,
  type CheckId,
  type CheckResult,
  type CheckSource,
  type ConfidenceBand,
  type Coverage,
  type DesignBand,
  type DesignFeatures,
  type DesignIssue,
  type ScoreContext,
  type ScoreResult,
} from "../types";
import { SCORING_VERSION } from "../version";
import { aggregate, displayRaw, type PendingCheck } from "./aggregate";
import { inapplicableReason } from "./applicability";
import { CAP_ISSUE, evaluateCaps, type CapHit } from "./caps";
import { staticChips } from "./chips";
import { ACCESSIBILITY_CHECKS } from "./checks/accessibility";
import { AI_CHECKS } from "./checks/ai";
import { CONTENT_CHECKS } from "./checks/content";
import { HIERARCHY_CHECKS, ctaPlacement } from "./checks/hierarchy";
import {
  IMAGES_CHECKS,
  imageShareIfLoaded,
  imagesOff,
  imagesUnknownShare,
  largeImageMissing,
  textInImages,
} from "./checks/images";
import { LAYOUT_CHECKS } from "./checks/layout";
import { MOBILE_CHECKS } from "./checks/mobile";
import { FOOTER_CHECKS, TECHNICAL_CHECKS } from "./checks/technical";
import { TYPOGRAPHY_CHECKS } from "./checks/typography";
import { explain } from "./explain";
import {
  EXCELLENCE_CEILING,
  HERO_PICTURE_AREA_MIN,
  IMAGES_UNKNOWN_SHARE_MAX,
  competingButtons,
  excellenceGate,
  heroFacts,
  type ExcellenceGate,
  type GateFacts,
} from "./excellence";
import { type CheckFn, type CheckInput, type CheckOutcome, r3 } from "./kit";
import { scoreSignals } from "./summary";
import {
  BAND_EXCELLENT,
  BAND_GOOD,
  BAND_NEEDS_WORK,
  CHECKS,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  INHERITANCE_WEIGHT,
  PROVISIONAL_WINDOW,
  TYPE_CONFIDENCE_MIN,
} from "./weights";

/** Every check's pure function (DESIGN-SCORE §10). */
export const CHECK_FUNCTIONS: Readonly<Record<CheckId, CheckFn>> = {
  ...ACCESSIBILITY_CHECKS,
  ...MOBILE_CHECKS,
  ...TYPOGRAPHY_CHECKS,
  ...HIERARCHY_CHECKS,
  ...IMAGES_CHECKS,
  ...LAYOUT_CHECKS,
  ...CONTENT_CHECKS,
  ...TECHNICAL_CHECKS,
  ...FOOTER_CHECKS,
  ...AI_CHECKS,
} as Record<CheckId, CheckFn>;

export function bandOf(score: number): DesignBand {
  if (score >= BAND_EXCELLENT) return "excellent";
  if (score >= BAND_GOOD) return "good";
  if (score >= BAND_NEEDS_WORK) return "needs_work";
  return "poor";
}

/**
 * Confidence band; a classifier `type_confidence` < 0.6 drops one level (DESIGN-SCORE §3). The
 * drop is shown to readers but does not make a score provisional (see `isProvisional`).
 */
export function confidenceBandOf(
  confidence: number,
  typeConfidence: number | null,
): ConfidenceBand {
  const band: ConfidenceBand =
    confidence >= CONFIDENCE_HIGH ? "high" : confidence >= CONFIDENCE_MEDIUM ? "medium" : "low";
  if (typeConfidence !== null && typeConfidence < TYPE_CONFIDENCE_MIN)
    return band === "high" ? "medium" : "low";
  return band;
}

/**
 * Provisional (DESIGN-SCORE §3.1; DECISIONS.md #24, conf-2026.3) — "we can't be sure yet":
 *  - the design evidence is thin: numeric confidence < 0.70 (e.g. a template render without an
 *    AI review, 0.64). The classifier's type-confidence drop is NOT used here: it lowers the
 *    displayed confidence band, but it says nothing about the design's quality, so it must not
 *    keep a clearly excellent email out of "Good design";
 *  - or the AI review is pending and the score sits within ±3 of a band edge (50 / 70) — except
 *    when a cap binds: the AI can move the raw score but never lift a capped score over its cap,
 *    and a capped email is a "Bad design" whatever the review says.
 */
export function isProvisional(x: {
  confidence: number;
  aiPending: boolean;
  nearEdge: boolean;
  capped: boolean;
}): boolean {
  if (confidenceBandOf(x.confidence, null) === "low") return true;
  return x.aiPending && x.nearEdge && !x.capped;
}

function coverageOf(f: DesignFeatures): Coverage {
  if (f.renderSource === "render" && f.render) return "render";
  if (f.renderSource === "template" && f.render) return "template";
  return "static";
}

function sourceOf(id: CheckId, coverage: Coverage, input: CheckInput): CheckSource {
  const group = CHECKS[id].group;
  if (group === "ai") return input.ai?.source === "template" ? "ai_template" : "ai";
  if (group === "static") return "static";
  return coverage === "template" ? "template" : "render";
}

/**
 * FREE-TIER.md §5.4 inheritance weights for confidence.
 *
 * A template-sourced score (template render + the template's AI review) leaves C4 out of the
 * confidence entirely (`null`): C4 judges an email's own copy and is never inherited
 * (DESIGN-SCORE §6), so it is structurally unavailable there, not a gap. This reproduces
 * FREE-TIER.md §5.4's "about 0.71 (Medium)": FREE-TIER.md §5.4 takes precedence over
 * DESIGN-SCORE §6 for confidence only (DECISIONS.md #1); the C4 score is still never inherited.
 * Everywhere else a missing C4 still counts as a gap: an own render with a reused review, or AI
 * pending/skipped. A refused template review still drops only C4; its other AI checks are gaps.
 */
function confidenceFactor(c: PendingCheck, coverage: Coverage): number | null {
  if (c.id === "C4" && coverage === "template" && c.source === "ai_template") return null;
  if (c.source === "ai_template") return INHERITANCE_WEIGHT.aiReused;
  if (coverage !== "template") return 1;
  const group = CHECKS[c.id].group;
  if (group === "stable") return INHERITANCE_WEIGHT.stable;
  if (group === "content") return INHERITANCE_WEIGHT.content;
  return 1;
}

/**
 * Checks read from the static HTML pass. When that pass failed (`static.unavailable`), its zero
 * counts are placeholders, not findings ("no links", "no unsubscribe", "no button"), so these are
 * not evaluated; the second set reads the render instead when the email has its own. C1/C2 read the
 * subject and snippet, which the pass does not produce. U1 (methodology 2026.5) decides itself:
 * the render's answer still counts when the static pass failed (`unsubscribeUnion`).
 */
const STATIC_HTML_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>([
  "A2",
  "A3",
  "A4",
  "A9",
  "A10",
  "A11",
  "T8",
  "X2",
  "X3",
  "X4",
  "U3",
  "U4",
]);
const STATIC_UNLESS_OWN_RENDER: ReadonlySet<CheckId> = new Set<CheckId>([
  "A5",
  "T7",
  "H1",
  "H4",
  "X1",
]);

function runCheck(id: CheckId, input: CheckInput): CheckOutcome {
  const reason = inapplicableReason(id, input);
  if (reason !== null) return { status: "not_applicable", s: null, value: { reason } };
  if (
    input.static.unavailable === true &&
    (STATIC_HTML_CHECKS.has(id) || (STATIC_UNLESS_OWN_RENDER.has(id) && !input.ownRender))
  )
    return { status: "not_evaluated", s: null, value: { reason: "static_unavailable" } };
  try {
    return CHECK_FUNCTIONS[id](input);
  } catch {
    // Malformed stored features must not break scoring; the gap shows in confidence.
    return { status: "not_evaluated", s: null, value: { reason: "error" } };
  }
}

function info(f: DesignFeatures, coverage: Coverage): ScoreResult["info"] {
  const r = coverage === "static" ? null : f.render;
  const out: ScoreResult["info"] = {
    htmlKb: Math.round(f.static.htmlBytes / 100) / 10,
    // A failed static pass (`unavailable`) counted nothing: no figures rather than zeros.
    linkCount: f.static.unavailable === true ? null : f.static.links.total,
    imageCount: f.static.unavailable === true ? null : f.static.images.content,
    words: f.static.unavailable === true ? null : f.static.text.words,
  };
  if (r) {
    out.imageToTextRatio =
      r.info.textArea > 0 ? Math.round((r.info.imageArea / r.info.textArea) * 100) / 100 : null;
    out.readingTimeSec = r.info.readingTimeSec;
    out.colourfulness = r.pixels.colourfulness === null ? null : Math.round(r.pixels.colourfulness);
    out.renderedAtK = Math.round(r.layout.k * 100) / 100;
  }
  return out;
}

function buildInput(
  features: DesignFeatures,
  ctx: ScoreContext,
): { input: CheckInput; coverage: Coverage } {
  const coverage = coverageOf(features);
  const input: CheckInput = {
    static: features.static,
    render: coverage === "static" ? null : features.render,
    renderSource: coverage === "static" ? "none" : features.renderSource,
    fonts: features.fonts,
    fontProfile: fontProfile(features.fonts, { source: coverage }),
    ai: features.ai,
    ctx,
    ownRender: coverage === "render",
  };
  return { input, coverage };
}

/** A check's "pass" credit (kit.ts `scored`): H2's placement passes at this. */
const PASS_CREDIT = 0.9;

/**
 * The render facts the Excellent gate's bars read; null without a render: G2's first phone screen
 * for every type and its look-alike buttons, G3's image share — compared as it is saved (I1 `imgShare`, 3 decimals), so the
 * signal and the bar agree — and G4's hero picture / headline band.
 */
function gateFacts(input: CheckInput): GateFacts | null {
  const r = input.render;
  if (!r) return null;
  const place = ctaPlacement(r);
  return {
    primaryType: input.ctx.primaryType,
    imgShare: r3(r.images.share),
    imagesUnknownShare: imagesUnknownShare(r, input.ctx),
    imgShareIfLoaded: imageShareIfLoaded(r, input.ctx),
    imagesOff: imagesOff(r),
    // G2's first phone screen for every type (H2 is only scored for action types).
    ctaFirstScreen: place === null ? null : place.credit >= PASS_CREDIT,
    ctaCompeting: competingButtons(r),
    ...heroFacts(r),
    heroUnknown: largeImageMissing(r, input.ctx, HERO_PICTURE_AREA_MIN),
  };
}

/** Most content images weren't drawn for unknown reasons: no image strengths (explain.ts). */
function imagesMissing(input: CheckInput): boolean {
  const unknown = input.render ? imagesUnknownShare(input.render, input.ctx) : null;
  return unknown !== null && unknown > IMAGES_UNKNOWN_SHARE_MAX;
}

/**
 * Score an email from its stored features (DESIGN-SCORE §3). Static-only coverage returns no
 * number (`score: null`, `band: null`) plus the static chips (FREE-TIER.md §5.4).
 */
export function scoreEmail(features: DesignFeatures, ctx: ScoreContext): ScoreResult {
  const { input, coverage } = buildInput(features, ctx);
  const render = input.render;
  const pending: PendingCheck[] = CHECK_IDS.map((id) => {
    const out = runCheck(id, input);
    return {
      id,
      pillar: CHECKS[id].pillar,
      status: out.status,
      s: out.s,
      value: out.value,
      w: CHECKS[id].w,
      source: sourceOf(id, coverage, input),
    };
  });
  const agg = aggregate(pending, (c) => confidenceFactor(c, coverage));
  const confidence = Math.round(agg.confidence * 10_000) / 10_000;
  const confidenceBand = confidenceBandOf(confidence, ctx.typeConfidence);
  const aiPending = features.ai === null;
  const chips = staticChips(features.static, ctx);

  if (coverage === "static" || agg.raw === null) {
    return {
      scoringVersion: SCORING_VERSION,
      coverage: "static",
      score: null,
      raw: null,
      band: null,
      caps: [],
      capped: false,
      issues: [],
      confidence,
      confidenceBand,
      provisional: true,
      aiPending,
      checks: agg.checks,
      pillars: [],
      needsImprovement: [],
      good: [],
      staticChips: chips,
      info: info(features, "static"),
      signals: scoreSignals(agg.checks, input, null),
    };
  }

  const raw = agg.raw;
  const capHits: CapHit[] = evaluateCaps(input);
  const capLimit = capHits.length > 0 ? Math.min(...capHits.map((c) => c.limit)) : Infinity;
  // The Excellent gate (excellence.ts): 85+ needs design substance, else the score is held at 84.
  // It is evaluated for every rendered email (the saved signals show each bar).
  const gate = excellenceGate(agg.checks, gateFacts(input));
  const gateBinds =
    gate.misses.length > 0 && Math.round(Math.min(raw, capLimit)) > EXCELLENCE_CEILING;
  const score = Math.round(Math.min(raw, capLimit, gateBinds ? EXCELLENCE_CEILING : Infinity));
  const capped = capHits.some((c) => c.limit < raw);
  const caps: CapId[] = capHits.map((c) => c.id);
  const issues = [
    ...new Set(caps.map((c) => CAP_ISSUE[c]).filter((i): i is DesignIssue => i !== null)),
  ];
  const nearEdge =
    Math.abs(score - 50) <= PROVISIONAL_WINDOW || Math.abs(score - 70) <= PROVISIONAL_WINDOW;
  const provisional = isProvisional({
    confidence,
    aiPending,
    nearEdge,
    capped,
  });
  const explanations = explain(
    agg.checks,
    capHits,
    raw,
    render,
    gateBinds ? gate : null,
    features.static.instructionText === true,
    features.static.strayButtons ?? 0,
    render !== null && textInImages(render, features.static),
    imagesMissing(input),
  );
  return {
    scoringVersion: SCORING_VERSION,
    coverage,
    score,
    raw: displayRaw(raw),
    band: bandOf(score),
    caps,
    capped,
    issues,
    confidence,
    confidenceBand,
    provisional,
    aiPending,
    checks: agg.checks,
    pillars: agg.pillars,
    needsImprovement: explanations.needsImprovement,
    good: explanations.good,
    staticChips: chips,
    info: info(features, coverage),
    signals: scoreSignals(agg.checks, input, gate),
  };
}

/**
 * Test/diagnostic hook: the result plus the untruncated explanation list with exact points, so
 * the reconciliation Σ needs-improvement = 100 − min(raw, cap) can be verified.
 */
export function scoreEmailDetailed(
  features: DesignFeatures,
  ctx: ScoreContext,
): {
  result: ScoreResult;
  rawExact: number | null;
  capHits: CapHit[];
  /** The Excellent gate's ceiling (84) when it binds, else null. */
  ceiling: number | null;
  all: Array<{ key: string; points: number }>;
} {
  const result = scoreEmail(features, ctx);
  if (result.coverage === "static")
    return { result, rawExact: null, capHits: [], ceiling: null, all: [] };
  const { input } = buildInput(features, ctx);
  const rawExact = result.checks.reduce((s, c: CheckResult) => s + c.points, 0);
  const capHits = evaluateCaps(input);
  const gate: ExcellenceGate = excellenceGate(result.checks, gateFacts(input));
  const capLimit = capHits.length > 0 ? Math.min(...capHits.map((c) => c.limit)) : Infinity;
  const binds =
    gate.misses.length > 0 && Math.round(Math.min(rawExact, capLimit)) > EXCELLENCE_CEILING;
  return {
    result,
    rawExact,
    capHits,
    ceiling: binds ? EXCELLENCE_CEILING : null,
    all: explain(
      result.checks,
      capHits,
      rawExact,
      input.render,
      binds ? gate : null,
      features.static.instructionText === true,
      features.static.strayButtons ?? 0,
      input.render !== null && textInImages(input.render, features.static),
      imagesMissing(input),
    ).all,
  };
}
