/**
 * Public contract of the design engine (DESIGN-SCORE.md v1.1 + FREE-TIER.md §5, DESIGN.md §8.1).
 *
 * The web app, the pipeline and the database only depend on the types in this file.
 * The shapes of the raw measurements (`StaticDesignFeatures`, `RenderFeatures`,
 * `FontFeatures`) are owned by `./features/*` and are opaque JSON to everything else.
 *
 * Invariants (tested):
 *  - Σ pillar points = raw; Σ pillar max = 100 (DESIGN-SCORE §3).
 *  - AI contributes at most 14 points.
 *  - A capped email never lands in a "Good design" band (every cap ≤ 69).
 *  - `score(features, ctx)` is a pure function of its inputs and SCORING_VERSION.
 */
import type { EmailType } from "@edf/core/types";
import type { StaticDesignFeatures } from "./features/static";
import type { ImageLoadReason, RenderFeatures } from "./features/render";
import type { FontFeatures } from "./features/fonts";

export type { StaticDesignFeatures, RenderFeatures, FontFeatures };

// ───────────────────────── identifiers ─────────────────────────

export const PILLARS = [
  "accessibility",
  "mobile",
  "typography",
  "hierarchy",
  "images",
  "layout",
  "content",
  "technical",
  "footer",
] as const;
export type PillarId = (typeof PILLARS)[number];

export const CHECK_IDS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
  "A11",
  "A12",
  "A13",
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "M7",
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "T7",
  "T8",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "H7",
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "X1",
  "X2",
  "X3",
  "X4",
  "U1",
  "U2",
  "U3",
  "U4",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const AI_CHECK_IDS = ["H7", "L8", "C4", "I6"] as const satisfies readonly CheckId[];
export type AiCheckId = (typeof AI_CHECK_IDS)[number];

export const CAP_IDS = [
  "CAP_IMAGE_ONLY",
  "CAP_CONTRAST",
  "CAP_BROKEN_IMAGES",
  "CAP_MOBILE_BROKEN",
  "CAP_CLIPPED",
  "CAP_MERGE_TAG",
] as const;
export type CapId = (typeof CAP_IDS)[number];

/**
 * The order caps are named in, most visible first (what every reader sees before what only some
 * clients show). The engine's explanations and the gallery's reason line both use it, so the card
 * and the full analysis always lead with the same problem.
 */
export const CAP_DISPLAY_ORDER: readonly CapId[] = [
  "CAP_IMAGE_ONLY",
  "CAP_CONTRAST",
  "CAP_MERGE_TAG",
  "CAP_MOBILE_BROKEN",
  "CAP_CLIPPED",
  "CAP_BROKEN_IMAGES",
];

/** Issue chips stored in `email.design_issues` (DB CHECK), mapped 1:1 to caps (DESIGN.md §9.1). */
export const DESIGN_ISSUES = [
  "image_only",
  "contrast",
  "mobile",
  "clipped",
  "broken_images",
] as const;
export type DesignIssue = (typeof DESIGN_ISSUES)[number];

export const DESIGN_BANDS = ["excellent", "good", "needs_work", "poor"] as const;
export type DesignBand = (typeof DESIGN_BANDS)[number];

export type ConfidenceBand = "high" | "medium" | "low";

/** Coverage level (FREE-TIER.md §5.4). Mirrors `email.design_source` minus 'none'. */
export type Coverage = "render" | "template" | "static";

export type CheckStatus =
  "pass" | "partial" | "fail" | "not_applicable" | "not_evaluated" | "needs_review";

/** Where a check's input came from. `template` = inherited from the template's rendered sample. */
export type CheckSource = "static" | "render" | "template" | "ai" | "ai_template";

// ───────────────────────── inputs ─────────────────────────

/** Non-measurement facts the scorer needs (applicability, C1/C2, U1, confidence). */
export interface ScoreContext {
  primaryType: EmailType;
  isSubscription: boolean;
  /** Classifier confidence; < 0.6 drops confidence one level (DESIGN-SCORE §3). */
  typeConfidence: number | null;
  subject: string | null;
  /** Gmail snippet (C2). */
  snippet: string | null;
  /** Email received time; I3 link-rot rule (emails older than 30 days). */
  receivedAt: Date;
  /** "Now" for time-dependent rules; injected so scoring stays pure. */
  now: Date;
  /** https List-Unsubscribe URIs (U1 host/path match, footer marker). */
  listUnsubscribeHttps: string[];
  /** Sender registrable domain (logo detection token). */
  senderDomain: string | null;
  /** Detected language (ISO 639-1), e.g. for T8 (English only) and lexicons. */
  language: string | null;
  /**
   * ADDED (optional): number of visible-link domains that returned NXDOMAIN (X3 defect class 4,
   * DNS-only). Undefined/null = not checked, the class is not counted.
   */
  linkDnsFailures?: number | null;
}

/** Per-criterion AI result (DESIGN-SCORE §6 output). */
export interface AiCriterion {
  /** 1..5, or null (N/A: e.g. I6 without content images). */
  level: number | null;
  /** ≤ 200 chars, already stripped of URLs, e-mail addresses and digit runs ≥ 4. Untrusted text. */
  evidence: string;
  region: "top" | "middle" | "bottom" | "mobile_top";
}

export interface AiReview {
  criteria: Partial<Record<AiCheckId, AiCriterion>>;
  flags: { suspected_prompt_injection: boolean; render_problem: boolean };
  /** Our own pre-scan hit an injection pattern in subject/visible text. */
  injectionPatternHit: boolean;
  model: string;
  reviewedAt: string; // ISO
  /** Where the review came from: this email, or the template's sample (counts 0.5 in confidence). */
  source: "email" | "template";
  /** The model refused (stop_reason "refusal") → AI checks not_evaluated. */
  refused: boolean;
}

/**
 * What `email_analysis.features` stores. Template-level features are
 * `{...sample.render, ...own static}` with `renderSource: "template"` (FREE-TIER.md §5.4).
 */
export interface DesignFeatures {
  /** Features schema version (bumped when the shape changes). */
  v: number;
  static: StaticDesignFeatures;
  /** Own render, the template sample's render, or null. */
  render: RenderFeatures | null;
  renderSource: "none" | "render" | "template";
  /** Set when renderSource = "template": the sample it was inherited from. */
  renderRef: { emailId: string; renderedAt: string } | null;
  /** Raw font facts (≤ 4 KB): fonts_static + used stacks from the render (DESIGN.md §8.1). */
  fonts: FontFeatures;
  ai: AiReview | null;
}

// ───────────────────────── outputs ─────────────────────────

export interface CheckResult {
  id: CheckId;
  pillar: PillarId;
  status: CheckStatus;
  /** Credit 0..1, or null when not scored (N/A, not evaluated, needs review). */
  s: number | null;
  /** The measured value, JSON-serialisable (number, string, object with the key numbers). */
  value: unknown;
  /** Nominal weight w_c. */
  w: number;
  /** Effective weight e_c after renormalization (0 when not scored). */
  e: number;
  /** e_c × s_c */
  points: number;
  /** e_c × (1 − s_c) */
  pointsLost: number;
  source: CheckSource;
}

export interface PillarScore {
  id: PillarId;
  label: string;
  /** Σ points(c ∈ p) */
  points: number;
  /** Σ e_c(c ∈ p); pillar maxima add up to 100. */
  max: number;
  /** Nominal pillar weight W (DESIGN-SCORE §5). */
  nominal: number;
}

/** A DOM box for issue overlays (approximate in the user's browser, FREE-TIER.md §5.6). */
export interface Region {
  pass: "desktop" | "mobile";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExplanationItem {
  /** Stable id for React keys and dedupe, e.g. "cap:CAP_CONTRAST" or "group:fixed-width". */
  key: string;
  kind: "cap" | "check" | "group" | "ai";
  checkIds: CheckId[];
  /** One-line headline with measured values filled in. */
  title: string;
  /** Measured value, human-readable ("9.3px", "2.8:1"). */
  measured?: string;
  /** Target, human-readable ("≥ 16px", "≥ 4.5:1"). */
  target?: string;
  /** How to fix it. */
  fix?: string;
  /** Standard or guideline behind the check ("WCAG 2.2 SC 1.4.3", "design guideline"). */
  source?: string;
  /** Points lost (needs improvement) or earned (good). */
  points: number;
  /** True for AI-derived bullets ("AI review" tag). */
  ai: boolean;
  /** Up to 3 overlay boxes. */
  regions?: Region[];
}

/** Chips shown for static-only coverage, where no number is shown (FREE-TIER.md §5.4). */
export interface StaticChip {
  code:
    | "clipped"
    | "near_clip"
    | "merge_tag_subject"
    | "merge_tag"
    | "no_unsubscribe"
    | "no_alt_text"
    | "no_lang"
    | "style_budget"
    | "broken_links";
  label: string;
  severity: "high" | "medium" | "low";
}

export interface ScoreResult {
  scoringVersion: string;
  coverage: Coverage;
  /** Rounded, capped score. null for static-only coverage ("Design not analysed yet"). */
  score: number | null;
  /** Uncapped raw score (0..100, 1 decimal), null for static-only. */
  raw: number | null;
  band: DesignBand | null;
  caps: CapId[];
  capped: boolean;
  /** Issue chips derived from active caps. */
  issues: DesignIssue[];
  /** Σ w(evaluated) / Σ w(applicable), with FREE-TIER.md §5.4 inheritance weights. */
  confidence: number;
  confidenceBand: ConfidenceBand;
  /** Excluded from the Good/Bad chips (DESIGN-SCORE §3.1). */
  provisional: boolean;
  /** Deterministic score only, AI review not yet available. */
  aiPending: boolean;
  checks: CheckResult[];
  pillars: PillarScore[];
  /** Up to 5, caps first, deduplicated by root cause (DESIGN-SCORE §7). */
  needsImprovement: ExplanationItem[];
  /** Up to 5 user-visible passing checks with w ≥ 1, plus AI levels ≥ 4. */
  good: ExplanationItem[];
  /** Static-only coverage chips (also computed for other coverages, for list badges). */
  staticChips: StaticChip[];
  /** Information-only facts (never scored): image/text ratio, link count, reading time, AMP… */
  info: Record<string, string | number | boolean | null>;
  /**
   * ADDED (methodology 2026.5, optional for hand-built results): the measured facts saved as
   * `ScoreSummary.signals` (summary.ts `scoreSignals`); always set by `scoreEmail`.
   */
  signals?: SummarySignals;
}

/**
 * Compact summary kept after feature compaction (~0.5 KB, FREE-TIER.md §5.4), including a
 * font summary (≤ 0.3 KB) so the Fonts card keeps working ("saved summary").
 */
export interface ScoreSummary {
  scoringVersion: string;
  coverage: Coverage;
  score: number | null;
  raw: number | null;
  band: DesignBand | null;
  caps: CapId[];
  confidence: number;
  pillars: Array<Pick<PillarScore, "id" | "points" | "max">>;
  needsImprovement: Array<Pick<ExplanationItem, "key" | "title" | "points" | "ai">>;
  good: Array<Pick<ExplanationItem, "key" | "title" | "points" | "ai">>;
  fonts: FontSummary | null;
  /**
   * The measured facts behind the gallery's severe-problem rules (apps/web lib/gallery.ts VERDICT
   * POLICY), kept here because compaction empties `checks`. Absent on summaries saved before it
   * existed (and backfilled from `checks` by migration 0015 while they were still stored).
   */
  signals?: SummarySignals;
  /**
   * The rendered email's size (a subset of `features.render.layout`), kept here because compaction
   * empties `features`: the gallery shows every email at its full length, and its viewer iframe is
   * script-free, so it can't measure the email itself. Absent without a render, and on summaries
   * saved before it existed (backfilled from `features` by migration 0016 while they were stored).
   */
  layout?: SummaryLayout;
}

/** Where the email sits and how tall it is (render px; see RenderFeatures["layout"]). */
export interface SummaryLayout {
  /** Document height at the 800 px desktop viewport (never less than the 1000 px viewport). */
  desktopHeight: number;
  /** Document height at the 375 px phone viewport. */
  mobileHeight: number;
  /** Content width at the phone viewport (wider than 375 = a fixed layout the phone shrinks). */
  mobileContentWidth: number;
  /** The main container on desktop (L1), or null. */
  mainContainer: { x: number; y: number; w: number; h: number } | null;
  /**
   * The extent of everything a reader can see on desktop (RenderFeatures["layout"]["content"]):
   * null when the render found nothing visible; absent when the render predates the measurement
   * (and on summaries saved before it existed, until migration 0017 backfilled them).
   */
  content?: { left: number; right: number; bottom: number } | null;
  /**
   * Document width at the 800 px desktop viewport (> 800 = a fixed layout wider than the canvas).
   * Absent on summaries saved before it existed (backfilled by migration 0017 while stored).
   */
  desktopContentWidth: number;
}

/** A failed Excellent-gate bar (scoring/excellence.ts `ExcellenceMiss`). */
export type GateBar =
  | "headline"
  | "button"
  | "imagery"
  | "imagery_unknown"
  | "hero"
  | "plain"
  | "phone_narrow"
  | "phone_edge";

/** One pass's unsubscribe answer: found (before the clip offset or place unknown), only after it, none. */
export type UnsubscribeFind = "found" | "after_clip" | "none";

/**
 * Raw measurements from the checks (never thresholds: the gallery owns its policy). null = not
 * measured (no render, or the check didn't apply). The first five keys are also extracted from
 * `checks` in SQL (`summary_signals`, migration 0015); the rest (methodology 2026.5) only exist in
 * summaries saved by the engine since — absent on older ones (DESIGN-SCORE §3.1 "Saved signals").
 */
export interface SummarySignals {
  /** I1: share of the content area covered by images, 0..1. */
  imgShare: number | null;
  /** I1: characters of real, legible live text (only measured when imgShare ≥ 0.25). */
  legibleChars: number | null;
  /** T1: median body text size a reader sees on a 375 px phone (CSS px × layout scale k). */
  phoneTextPx: number | null;
  /** T1 / M1: how much the layout is scaled down to fit a phone (1 = fits, 0.66 = shrinks to 66%). */
  layoutK: number | null;
  /**
   * U1: where the unsubscribe link is — only when the footer rules apply (subscription mail that
   * isn't transactional / account mail); null when exempt or not measured. From methodology
   * 2026.5 it is the union of the static pass and the render (`unsubscribeUnion`).
   */
  unsubscribe: "before_clip" | "after_clip" | "none" | null;
  /** The email type the score was computed for (`email.primary_type`). */
  primaryType?: string;
  /** H6: largest first-screen text ÷ body text (the Excellent gate's G1 needs ≥ 1.5). */
  headlineRatio?: number | null;
  /**
   * H6: the email has heading text at all (G1 needs true); false = no headline (the largest text
   * is a button or a label), null when H6 didn't run.
   */
  hasHeadline?: boolean | null;
  /** H3: the main button's fill salience 0..1 (G2 needs ≥ 0.9); null without a main button. */
  ctaSalience?: number | null;
  /**
   * H3: the main button is the most prominent link (G2 needs this or `ctaFirstScreen`); null
   * without one.
   */
  ctaMostProminent?: boolean | null;
  /**
   * The main button sits in the first phone screen (H2's placement credit ≥ 0.9), measured for
   * every type from methodology 2026.6 (before: only where H2 is scored); null without one.
   */
  ctaFirstScreen?: boolean | null;
  /** H3: the main button's label contrast ratio; null for an image button or without one. */
  ctaLabelContrast?: number | null;
  /**
   * G2 (methodology 2026.6): ≥ 3 look-alike buttons (one style) for ≥ 3 different actions in the
   * first two phone screens — none is the main button; null without a main button.
   */
  ctaCompeting?: boolean | null;
  /**
   * The Excellent gate's failed bars, evaluated for every rendered email whether it binds or not
   * ([] = all passed, or an AI rating ≥ 4 stood in for G1–G4); null when not evaluated (no render,
   * or the bars' facts were missing and the v1.3 rule decided).
   */
  gate?: GateBar[] | null;
  /**
   * G4 (methodology 2026.6): a hero picture was drawn — a content image ≥ 300 px wide and an
   * image of ≥ 40,000 px² on desktop; null when not evaluated.
   */
  heroPicture?: boolean | null;
  /**
   * G4: a large heading sits on a painted band, panel or dark theme (background ≥ 1.15:1 against
   * white); null when not evaluated.
   */
  heroBand?: boolean | null;
  /**
   * Distinct content images declared in the HTML (render `images.declared`; renders before
   * render-2026.4: the static pass's content-image count); null when unknown.
   */
  htmlContentImages?: number | null;
  /**
   * Content images drawn from a decoded picture (render `images.drawn`; renders before
   * render-2026.4: the render's content-image count); null without a render or with images off
   * for the email (`imagesOff`: nothing drawn by our policy, which says nothing about the design).
   */
  drawnContentImages?: number | null;
  /**
   * Images weren't requested for this email (render `loads[].reason = "images_off"`: account /
   * transactional / suspicious mail, privacy mode): no image-only verdict and no imagery bar;
   * null without a render.
   */
  imagesOff?: boolean | null;
  /**
   * Share of the content images not drawn for reasons that say nothing about the design (by
   * image area when the render recorded it, else by count); G3 can't pass above 0.5. null without
   * load entries or with images off.
   */
  imagesUnknownShare?: number | null;
  /** The static HTML pass's unsubscribe answer; null when that pass failed. */
  staticUnsubscribe?: UnsubscribeFind | null;
  /**
   * The email's own render's unsubscribe answer; null without one (a template sample's footer is
   * another email's; it answers only when this email's static pass failed).
   */
  renderUnsubscribe?: UnsubscribeFind | null;
  /**
   * The unsubscribe union (static ∪ render) for EVERY email, whether U1 applies or not; null when
   * neither pass could tell. `unsubscribe` is this when U1 applies.
   */
  unsubscribeUnion?: "before_clip" | "after_clip" | "none" | null;
  /** Characters of real, legible live text outside the footer (render `text.chars.legible`). */
  liveTextChars?: number | null;
  /** Size of the HTML in KB (1,000 bytes, one decimal); Gmail clips past 102 KB. */
  htmlKB?: number;
}

// ───────────────────────── font profile (DESIGN.md §8.1) ─────────────────────────

export type FontRole = "heading" | "body" | "button" | "navigation" | "footer";
export type FontClass = "web" | "likely_web" | "system" | "not_loaded";

export type EmailClientId =
  | "gmail_web"
  | "gmail_android"
  | "gmail_ios"
  | "outlook_classic"
  | "outlook_new"
  | "apple_mail"
  | "samsung";

export interface FontFamilyProfile {
  /** Display-canonical name (catalog spelling if known, else the designer's). */
  name: string;
  /** Share of counted characters 0..1 (null when not measured, i.e. static coverage). */
  share: number | null;
  /** Roles covering ≥ 20% of this family's characters, at most 2 (measured only). */
  roles: FontRole[];
  class: FontClass;
  /** "Google Fonts", "Adobe Fonts", "Bunny Fonts", "Fonts.com", a registrable domain, or null. */
  provider: string | null;
  /** Used weights (≥ 5% of the family's characters); synthesized = not in the declared weights. */
  weights: Array<{ weight: number; synthesized: boolean }>;
  /** Variable-axis note from the declaration, e.g. "variable 100–900". */
  weightNote: string | null;
}

export interface ClientFontResult {
  client: EmailClientId;
  /** "Gmail (web)", "Outlook for Windows (classic)", … */
  label: string;
  /** What readers likely see for the email's main text, e.g. "Arial", "Times New Roman". */
  likely: string;
  /** Families that fall back in this client (web font not shown). */
  fallbackFrom: string[];
  /** A problem worth a ⚠ line (e.g. the classic-Outlook Times New Roman bug). */
  warning: boolean;
  /** Human sentence for the card. */
  note: string;
}

export interface FontProfile {
  /** Where the facts come from (maps to `email.font_source`, plus "summary" after compaction). */
  source: "render" | "template" | "static" | "summary";
  /** False for static coverage: "Fonts declared in the email code (not measured)". */
  measured: boolean;
  /** Used primary families (measured) or declared primary families (static), by share desc. */
  families: FontFamilyProfile[];
  /** Share of text with no font set ("No font set (each app's default)"), measured only. */
  noFontSetShare: number | null;
  /** Backup families found in the stacks (e.g. "Arial"). */
  fallbacks: string[];
  /** Declared (web) families not used by any rendered text. */
  declaredUnused: string[];
  clients: ClientFontResult[];
  /** ⚠ lines, most important first. */
  warnings: string[];
  /** "At least N images contain text" (null when unknown: OCR off). */
  imageTextCount: number | null;
  /** → email.font_families (≤ 12, display-canonical, no generics, no "No font set"). */
  fontFamilies: string[];
  /** → email.uses_web_fonts */
  usesWebFonts: boolean;
}

/** Compact font summary for ScoreSummary (≤ 0.3 KB). */
export interface FontSummary {
  families: Array<{ name: string; share: number | null; role: FontRole | null; class: FontClass }>;
  gmailWeb: string | null;
  outlookClassic: string | null;
  outlookClassicWarning: boolean;
}

// ───────────────────────── renderer contract ─────────────────────────

/** One email handed to the renderer (local Chromium or the Sandbox VM). */
export interface RenderJob {
  /** Opaque id echoed back (the email id). */
  id: string;
  /** Raw decoded text/html part. Sanitized with the analysis profile INSIDE the renderer. */
  html: string;
  /**
   * Pre-fetched, policy-allowed images keyed by their original absolute URL, as data: URIs
   * (≤ 60 images, ≤ 15 MB per email). Anything not in this map renders as a placeholder.
   */
  images: Record<string, string>;
  /** Inline cid: images keyed by lower-cased Content-ID, as data: URIs. */
  cid: Record<string, string>;
  /**
   * Image fetch outcomes for I3/I5 (status per URL; "blocked" = policy/tracker/SSRF refusal;
   * "too_large" = over our per-image byte or pixel limit). A numeric status is the sender
   * server's HTTP answer; record 200 only for a response whose body was an image or a
   * non-image (wrong content type / undecodable), never for our own size limits.
   * `reason` (ADDED, render-structure, optional): why it wasn't fetched or can't be shown
   * (`ImageLoadReason`: "too_many_pixels", "tracker", "per_recipient", "expired", "svg", …); the
   * renderer copies known reasons onto `images.loads`.
   */
  imageLog: Record<
    string,
    {
      status: number | "blocked" | "timeout" | "error" | "too_large";
      bytes: number;
      reason?: ImageLoadReason;
    }
  >;
  /** false → images-off analysis only (privacy mode, suspicious/sensitive types). */
  imagesAllowed: boolean;
  /** Produce downscaled AI tiles (3 desktop 600×750 + mobile 375×667, WebP/PNG bytes). */
  wantAiTiles: boolean;
  /** Lite profile (D + D0 + M) when renders measure > 12 CPU-s (FREE-TIER.md §5.2). */
  lite: boolean;
  /**
   * ADDED (optional): non-HTML facts the renderer needs to find the footer region and the logo
   * (DESIGN-SCORE §2.1: List-Unsubscribe host/path footer markers, sender-domain logo token,
   * word segmentation language). Omitted → markers by link text only.
   */
  context?: RenderJobContext;
}

/** ADDED: optional renderer context (see `RenderJob.context`). */
export interface RenderJobContext {
  listUnsubscribeHttps: string[];
  senderDomain: string | null;
  language: string | null;
}

export interface RenderOutcome {
  id: string;
  ok: boolean;
  /** Fixed status code on failure ("timeout", "too_large", "crash", …). Never email content. */
  error: string | null;
  features: RenderFeatures | null;
  /** In-memory AI tiles; never persisted, never decoded by edf-app. */
  aiTiles: { desktop: Uint8Array[]; mobile: Uint8Array | null } | null;
  renderMs: number;
  chromiumVersion: string | null;
}
