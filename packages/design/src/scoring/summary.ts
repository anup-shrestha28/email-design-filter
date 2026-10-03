/**
 * Feature compaction and template inheritance (FREE-TIER.md §5.4):
 * - `summarizeScore`: the compact score summary kept after full features expire;
 * - `buildDesignFeatures`: assemble `email_analysis.features` from ingest + render;
 * - `inheritFromTemplate`: template-level features `{...sample render, ...own static}`;
 * - `templateMatch`: the "closely matches" test for template-level scoring.
 */
import { fontSummary } from "../fonts/profile";
import type { FontFeatures } from "../features/fonts";
import type { RenderFeatures } from "../features/render";
import type { StaticDesignFeatures } from "../features/static";
import type {
  AiReview,
  DesignFeatures,
  FontProfile,
  ScoreResult,
  ScoreSummary,
  SummaryLayout,
  SummarySignals,
} from "../types";
import { truncate } from "../util/text";
import { FEATURES_VERSION } from "../version";
import { declaredImages, imagesOff, imagesUnknownShare } from "./checks/images";
import { renderUnsubscribe, staticUnsubscribe, unsubscribeUnion } from "./checks/technical";
import type { ExcellenceGate } from "./excellence";
import { r3, type CheckInput } from "./kit";

const TITLE_MAX = 80;

/**
 * Titles are written to fit in 80 characters; a longer one (a long CTA label or AI evidence) is
 * cut at a word boundary and ends with "…", never mid-word.
 */
function briefTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (Array.from(t).length <= TITLE_MAX) return t;
  const room = truncate(t, TITLE_MAX - 1);
  const space = room.lastIndexOf(" ");
  const cut = space >= TITLE_MAX * 0.5 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,;:.\-–—(“"]+$/u, "")}…`;
}

/** Render features without the used-font facts (those live in `DesignFeatures.fonts.used`). */
function withoutFonts(r: RenderFeatures): RenderFeatures {
  const copy: RenderFeatures = { ...r };
  delete copy.fonts;
  return copy;
}

/**
 * Compact summary (FREE-TIER.md §5.4 "Feature compaction"): score, band, caps, confidence,
 * pillar points, the top 5 needs-improvement and top 5 good bullets (so the gallery can still
 * fold symptoms into root causes and pick the most distinctive strengths after compaction empties
 * `checks`), the font summary, the gallery's severe-problem signals and, with a render, the
 * layout facts that size the gallery's full-length previews.
 */
export function summarizeScore(
  result: ScoreResult,
  profile: FontProfile | null,
  render?: RenderFeatures | null,
): ScoreSummary {
  const brief = (items: ScoreResult["needsImprovement"], n: number) =>
    items.slice(0, n).map((i) => ({
      key: i.key,
      title: briefTitle(i.title),
      points: i.points,
      ai: i.ai,
    }));
  return {
    scoringVersion: result.scoringVersion,
    coverage: result.coverage,
    score: result.score,
    raw: result.raw,
    band: result.band,
    caps: result.caps,
    confidence: Math.round(result.confidence * 100) / 100,
    pillars: result.pillars.map((p) => ({ id: p.id, points: p.points, max: p.max })),
    needsImprovement: brief(result.needsImprovement, 5),
    good: brief(result.good, 5),
    fonts: profile ? fontSummary(profile) : null,
    signals: result.signals ?? summarySignals(result.checks),
    ...(render ? { layout: summaryLayout(render) } : {}),
  };
}

/**
 * The layout facts the gallery sizes and crops its previews with (ScoreSummary.layout), from a
 * render. `content` keeps the render's three states: an extent, null (nothing visible found), or
 * absent (rendered before the measurement existed). Mirrored in SQL by public.summary_layout
 * (migration 0017).
 */
export function summaryLayout(render: RenderFeatures): SummaryLayout {
  const l = render.layout;
  const box = l.mainContainer;
  const content = l.content;
  return {
    desktopHeight: l.desktopHeight,
    mobileHeight: l.mobileHeight,
    mobileContentWidth: l.mobileContentWidth,
    mainContainer: box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null,
    ...(content === undefined
      ? {}
      : {
          content: content
            ? { left: content.left, right: content.right, bottom: content.bottom }
            : null,
        }),
    desktopContentWidth: l.desktopContentWidth,
  };
}

const UNSUBSCRIBE_PLACES: ReadonlySet<string> = new Set(["before_clip", "after_clip", "none"]);

/**
 * The raw facts behind the gallery's severe-problem rules (ScoreSummary.signals), from the checks:
 * I1 image share and live-text characters, T1 phone text size and layout scale, U1 unsubscribe
 * placement (only when U1 applies, so transactional / account mail never reports "none"). Mirrored
 * in SQL by public.summary_signals(checks) (migration 0015) for rows saved without signals;
 * `scoreSignals` adds the rest.
 */
export function summarySignals(checks: ScoreResult["checks"]): SummarySignals {
  const valueOf = (id: string, applicableOnly = true): Record<string, unknown> => {
    const c = checks.find((x) => x.id === id);
    if (!c || c.status === "not_evaluated") return {};
    if (applicableOnly && c.status === "not_applicable") return {};
    return typeof c.value === "object" && c.value !== null
      ? (c.value as Record<string, unknown>)
      : {};
  };
  const num = (v: Record<string, unknown>, key: string): number | null => {
    const x = v[key];
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  };
  // I1 reports the image share even when it doesn't apply (share < 0.25).
  const i1 = valueOf("I1", false);
  const t1 = valueOf("T1");
  const u = valueOf("U1").unsubscribe;
  return {
    imgShare: num(i1, "imgShare"),
    legibleChars: num(i1, "legibleChars"),
    phoneTextPx: num(t1, "px"),
    layoutK: num(t1, "k"),
    unsubscribe:
      typeof u === "string" && UNSUBSCRIBE_PLACES.has(u)
        ? (u as SummarySignals["unsubscribe"])
        : null,
  };
}

/**
 * Every saved signal (ScoreSummary.signals, DESIGN-SCORE §3.1 "Saved signals"): the five
 * check-derived facts (`summarySignals`) plus, from methodology 2026.5, the Excellent gate's bars
 * and measurements, both passes' unsubscribe answers and their union for every email, the image
 * counts behind the image-only rule (with whether images were off for the email, when the drawn
 * count isn't measured), the live text, the HTML size and the type. Raw facts only: the gallery
 * owns the thresholds of its verdict policy.
 */
export function scoreSignals(
  checks: ScoreResult["checks"],
  input: CheckInput,
  gate: ExcellenceGate | null,
): SummarySignals {
  const r = input.render;
  const st = input.static;
  const unknown = r ? imagesUnknownShare(r, input.ctx) : null;
  const off = r ? imagesOff(r) : null;
  return {
    ...summarySignals(checks),
    primaryType: input.ctx.primaryType,
    headlineRatio: gate?.headlineRatio ?? null,
    hasHeadline: gate?.hasHeadline ?? null,
    ctaSalience: gate?.ctaSalience ?? null,
    ctaMostProminent: gate?.ctaMostProminent ?? null,
    ctaFirstScreen: gate?.ctaFirstScreen ?? null,
    ctaLabelContrast: gate?.ctaLabelContrast ?? null,
    ctaCompeting: gate?.ctaCompeting ?? null,
    gate: gate && gate.rule === "bars" ? [...gate.misses] : null,
    heroPicture: gate?.heroPicture ?? null,
    heroBand: gate?.heroBand ?? null,
    // Renders before render-2026.4 have no declared / drawn counts: the static pass's
    // content images and the render's (an image too large to draw wasn't one of them). With
    // images off for the email nothing is drawn by our policy: not measured (null).
    htmlContentImages: declaredImages(r, st),
    drawnContentImages: r && !off ? (r.images.drawn ?? r.images.content) : null,
    imagesOff: off,
    imagesUnknownShare: unknown === null ? null : r3(unknown),
    staticUnsubscribe: staticUnsubscribe(input),
    renderUnsubscribe: renderUnsubscribe(input),
    unsubscribeUnion: unsubscribeUnion(input),
    liveTextChars: r ? r.text.chars.legible : null,
    htmlKB: Math.round(st.htmlBytes / 100) / 10,
  };
}

/**
 * Assemble `DesignFeatures` for an email with its own render (or none yet). The render's used
 * font stacks move to `fonts.used` (DESIGN.md §8.1 "Storage").
 */
export function buildDesignFeatures(input: {
  static: StaticDesignFeatures;
  fonts: FontFeatures;
  render: RenderFeatures | null;
  ai?: AiReview | null;
}): DesignFeatures {
  const render = input.render ? withoutFonts(input.render) : null;
  return {
    v: FEATURES_VERSION,
    static: input.static,
    render,
    renderSource: render ? "render" : "none",
    renderRef: null,
    fonts: { v: 1, static: input.fonts.static, used: input.render?.fonts ?? input.fonts.used },
    ai: input.ai ?? null,
  };
}

/**
 * Template-level features (FREE-TIER.md §5.4): the sample's render and used fonts, this email's
 * own static features and declared fonts, and the sample's AI review marked `source: "template"`
 * (counts 0.5 in confidence; C4 is never reused). Returns static-only features when the sample
 * has no render.
 */
export function inheritFromTemplate(
  sample: DesignFeatures,
  own: { static: StaticDesignFeatures; fonts: FontFeatures },
  ref: { emailId: string; renderedAt: string },
): DesignFeatures {
  if (!sample.render) {
    return {
      v: FEATURES_VERSION,
      static: own.static,
      render: null,
      renderSource: "none",
      renderRef: null,
      fonts: own.fonts,
      ai: null,
    };
  }
  return {
    v: FEATURES_VERSION,
    static: own.static,
    render: withoutFonts(sample.render),
    renderSource: "template",
    renderRef: { emailId: ref.emailId, renderedAt: ref.renderedAt },
    fonts: { v: 1, static: own.fonts.static, used: sample.fonts.used },
    ai: sample.ai ? { ...sample.ai, source: "template" } : null,
  };
}

export interface TemplateMatchDetails {
  match: boolean;
  sameCtaLabels: boolean;
  imageCountWithin: boolean;
  htmlSizeWithin: boolean;
}

function within(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance * Math.max(a, b);
}

/**
 * "Closely matches" (FREE-TIER.md §5.4), given the simhash distance ≤ 3 already holds (SQL):
 * the same set of CTA labels, image count within ±20% and HTML size within ±25%. Symmetric —
 * tolerances are relative to the larger of the two values.
 */
export function templateMatchDetails(a: DesignFeatures, b: DesignFeatures): TemplateMatchDetails {
  const la = new Set(a.static.cta.labels);
  const lb = new Set(b.static.cta.labels);
  const sameCtaLabels = la.size === lb.size && [...la].every((l) => lb.has(l));
  const imageCountWithin = within(a.static.images.content, b.static.images.content, 0.2);
  const htmlSizeWithin = within(a.static.htmlBytes, b.static.htmlBytes, 0.25);
  // A failed static pass has placeholder labels and counts: nothing to compare, so no match.
  const evaluated = a.static.unavailable !== true && b.static.unavailable !== true;
  return {
    match: evaluated && sameCtaLabels && imageCountWithin && htmlSizeWithin,
    sameCtaLabels,
    imageCountWithin,
    htmlSizeWithin,
  };
}

export function templateMatch(a: DesignFeatures, b: DesignFeatures): boolean {
  return templateMatchDetails(a, b).match;
}
