/**
 * Versioned weights, groups and frozen calibration parameters (DESIGN-SCORE §5, §10;
 * FREE-TIER.md §5.4).
 *
 * The check weights are the v1 design choices of DESIGN-SCORE §5 (86 deterministic + 14 AI).
 * The L2/L3 corpus parameters must come from the team corpus (§5.6, §8); no corpus exists yet,
 * so they are **priors**: deliberately wide, so that only clear outliers lose points until
 * calibration replaces them (bump WEIGHTS_VERSION when it does).
 */
import type { EmailType } from "@edf/core/types";
import type { CheckId, PillarId } from "../types";

export const WEIGHTS_VERSION = "w-2026.1";
/**
 * Thresholds. t-2026.2 (verdict policy, DECISIONS.md "Verdict policy"): CAP_MOBILE_BROKEN only
 * for genuinely broken phone layouts (k < 0.5, effective body text < 8px, or a primary button
 * shrunk below 16px); CAP_CONTRAST judged on main content (body + headline, no footer or fine
 * print); CAP_BROKEN_IMAGES / I3 count only definitive failures (404/410, non-image) and the cap
 * needs ≥ 2 broken images. t-2026.3 (2026-10-01 verdict audit): the Excellent gate's bars (headline
 * ≥ 1.5×, button salience ≥ 0.9 and most prominent, imagery ≥ 8% for system mail — excellence.ts),
 * CAP_BROKEN_IMAGES also needs the broken images to cover ≥ 20% of the image area, an SVG is a
 * small I3 deduction, fine print weighs at most 25% of A1, and M4 sizes the visible button.
 */
export const THRESHOLDS_VERSION = "t-2026.3";
export const PRIORS_VERSION = "priors-2026.1";
/**
 * Confidence rules (inheritance weights, exclusions). conf-2026.2: C4 is excluded from a
 * template-sourced score's confidence (FREE-TIER.md §5.4; packages/design/DECISIONS.md #1).
 * conf-2026.3: `provisional` ignores the classifier type-confidence drop (the band still shows
 * it) and a binding cap is never provisional through the AI-pending window (DECISIONS.md #24).
 */
export const CONFIDENCE_VERSION = "conf-2026.3";

/**
 * Coverage group (FREE-TIER.md §5.4): what a check needs, which sets its confidence weight when
 * inherited from a template sample (stable 0.75, content 0.5).
 */
export type CheckGroup = "static" | "stable" | "content" | "ocr" | "ai";

export interface CheckDef {
  pillar: PillarId;
  w: number;
  tier: "A" | "B" | "C" | "AI";
  group: CheckGroup;
}

export const CHECKS: Readonly<Record<CheckId, CheckDef>> = {
  A1: { pillar: "accessibility", w: 5, tier: "A", group: "content" },
  A2: { pillar: "accessibility", w: 3.5, tier: "A", group: "static" },
  A3: { pillar: "accessibility", w: 2.5, tier: "A", group: "static" },
  A4: { pillar: "accessibility", w: 1, tier: "A", group: "static" },
  A5: { pillar: "accessibility", w: 1, tier: "A", group: "static" },
  A6: { pillar: "accessibility", w: 1, tier: "A", group: "stable" },
  A7: { pillar: "accessibility", w: 2, tier: "A", group: "stable" },
  A8: { pillar: "accessibility", w: 1, tier: "A", group: "stable" },
  A9: { pillar: "accessibility", w: 0.25, tier: "A", group: "static" },
  A10: { pillar: "accessibility", w: 0.25, tier: "A", group: "static" },
  A11: { pillar: "accessibility", w: 0.5, tier: "B", group: "static" },
  A12: { pillar: "accessibility", w: 0.5, tier: "A", group: "stable" },
  A13: { pillar: "accessibility", w: 1.5, tier: "A", group: "ocr" },
  M1: { pillar: "mobile", w: 2.5, tier: "A", group: "stable" },
  M2: { pillar: "mobile", w: 1.5, tier: "B", group: "stable" },
  M3: { pillar: "mobile", w: 2.5, tier: "C", group: "stable" },
  M4: { pillar: "mobile", w: 2, tier: "B", group: "stable" },
  M5: { pillar: "mobile", w: 2.5, tier: "C", group: "stable" },
  M6: { pillar: "mobile", w: 2, tier: "C", group: "stable" },
  M7: { pillar: "mobile", w: 2, tier: "C", group: "stable" },
  T1: { pillar: "typography", w: 4, tier: "B", group: "stable" },
  T2: { pillar: "typography", w: 2, tier: "B", group: "stable" },
  T3: { pillar: "typography", w: 2, tier: "B", group: "stable" },
  T4: { pillar: "typography", w: 2, tier: "B", group: "stable" },
  T5: { pillar: "typography", w: 1.5, tier: "B", group: "stable" },
  T6: { pillar: "typography", w: 1.5, tier: "C", group: "stable" },
  T7: { pillar: "typography", w: 1, tier: "C", group: "static" },
  T8: { pillar: "typography", w: 1, tier: "C", group: "static" },
  H1: { pillar: "hierarchy", w: 1, tier: "B", group: "static" },
  H2: { pillar: "hierarchy", w: 2, tier: "B", group: "content" },
  H3: { pillar: "hierarchy", w: 2.5, tier: "A", group: "stable" },
  H4: { pillar: "hierarchy", w: 1, tier: "C", group: "static" },
  H5: { pillar: "hierarchy", w: 1, tier: "C", group: "content" },
  H6: { pillar: "hierarchy", w: 1.5, tier: "C", group: "stable" },
  H7: { pillar: "hierarchy", w: 6, tier: "AI", group: "ai" },
  I1: { pillar: "images", w: 3, tier: "B", group: "content" },
  I2: { pillar: "images", w: 2, tier: "B", group: "content" },
  I3: { pillar: "images", w: 2, tier: "A", group: "content" },
  I4: { pillar: "images", w: 1, tier: "B", group: "content" },
  I5: { pillar: "images", w: 0.5, tier: "C", group: "content" },
  I6: { pillar: "images", w: 1.5, tier: "AI", group: "ai" },
  L1: { pillar: "layout", w: 1, tier: "B", group: "stable" },
  L2: { pillar: "layout", w: 1, tier: "C", group: "content" },
  L3: { pillar: "layout", w: 1, tier: "C", group: "content" },
  L4: { pillar: "layout", w: 1, tier: "C", group: "stable" },
  L5: { pillar: "layout", w: 1, tier: "C", group: "stable" },
  L6: { pillar: "layout", w: 0.5, tier: "C", group: "stable" },
  L7: { pillar: "layout", w: 0.5, tier: "C", group: "stable" },
  L8: { pillar: "layout", w: 4, tier: "AI", group: "ai" },
  C1: { pillar: "content", w: 0.75, tier: "B", group: "static" },
  C2: { pillar: "content", w: 0.75, tier: "B", group: "static" },
  C3: { pillar: "content", w: 0.5, tier: "C", group: "content" },
  C4: { pillar: "content", w: 2.5, tier: "AI", group: "ai" },
  C5: { pillar: "content", w: 0.5, tier: "C", group: "content" },
  X1: { pillar: "technical", w: 2, tier: "B", group: "static" },
  X2: { pillar: "technical", w: 1.5, tier: "A", group: "static" },
  X3: { pillar: "technical", w: 1, tier: "A", group: "static" },
  X4: { pillar: "technical", w: 0.5, tier: "B", group: "static" },
  U1: { pillar: "footer", w: 2, tier: "A", group: "static" },
  U2: { pillar: "footer", w: 2, tier: "A", group: "stable" },
  U3: { pillar: "footer", w: 0.5, tier: "C", group: "static" },
  U4: { pillar: "footer", w: 0.5, tier: "C", group: "static" },
};

export const PILLAR_META: Readonly<Record<PillarId, { label: string; nominal: number }>> = {
  accessibility: { label: "Accessibility", nominal: 20 },
  mobile: { label: "Mobile & Responsiveness", nominal: 15 },
  typography: { label: "Readability & Typography", nominal: 15 },
  hierarchy: { label: "Visual Hierarchy & CTA", nominal: 15 },
  images: { label: "Images & Media", nominal: 10 },
  layout: { label: "Layout, Color & Consistency", nominal: 10 },
  content: { label: "Content & Structure", nominal: 5 },
  technical: { label: "Technical Health", nominal: 5 },
  footer: { label: "Footer & Unsubscribe UX", nominal: 5 },
};

/** Maximum AI share of the score (DESIGN-SCORE §3). */
export const AI_MAX_POINTS = 14;

/** Confidence weight of inherited evidence (FREE-TIER.md §5.4). */
export const INHERITANCE_WEIGHT = { stable: 0.75, content: 0.5, aiReused: 0.5 } as const;

/** Confidence bands (DESIGN-SCORE §3). */
export const CONFIDENCE_HIGH = 0.85;
export const CONFIDENCE_MEDIUM = 0.7;
/** type_confidence below this drops confidence one level (DESIGN-SCORE §3). */
export const TYPE_CONFIDENCE_MIN = 0.6;

/** Band cut-offs (DESIGN-SCORE §3.1, v1 priors). */
export const BAND_EXCELLENT = 85;
export const BAND_GOOD = 70;
export const BAND_NEEDS_WORK = 50;
/** Provisional window around band edges while the AI review is pending. */
export const PROVISIONAL_WINDOW = 3;

// ───────────────────────── caps (DESIGN-SCORE §4, t-2026.2) ─────────────────────────

/**
 * CAP_MOBILE_BROKEN fires only when the email is genuinely broken on a phone, not merely
 * non-responsive (a readable fixed 600px email loses points through M1/M2/M3/M7/T1 instead):
 *  - `k < MOBILE_OVERFLOW_K`: the layout is more than twice the phone width (≥ 750px), so it
 *    either scrolls sideways or shrinks to under half size;
 *  - effective body text (median body px at 375 × k) `< MOBILE_UNREADABLE_PX`: 12px copy in a
 *    600px layout (7.5px) or 14px copy in a 700px layout (7.5px); 14–16px copy in a 600–640px
 *    layout (8.2–10px) stays readable;
 *  - the layout shrinks (k < 1) the primary button below `MOBILE_UNTAPPABLE_PX` on its larger
 *    measured box (M4's zero-credit point).
 */
export const MOBILE_OVERFLOW_K = 0.5;
export const MOBILE_UNREADABLE_PX = 8;
export const MOBILE_UNTAPPABLE_PX = 16;
/** CAP_CONTRAST: share of main-content characters (body + headline) failing AA. */
export const CONTRAST_CAP_SHARE = 0.4;
/** CAP_BROKEN_IMAGES: > 50% of evaluated content images definitively broken, and at least 2… */
export const BROKEN_IMAGES_CAP_SHARE = 0.5;
export const BROKEN_IMAGES_CAP_MIN = 2;
/**
 * …covering at least this share of the content-image area (t-2026.3; `loads[].area`, renders from
 * render-2026.4): a broken 1% logo is an I3 deduction, never "most images are broken".
 */
export const BROKEN_IMAGES_CAP_AREA = 0.2;

/** Corpus median AI level used by the injection safeguard (prior: the rubric midpoint). */
export const AI_CORPUS_MEDIAN_LEVEL_PRIOR = 3;

// ───────────────────────── corpus priors for L2 / L3 ─────────────────────────

export type TypeGroup = "promotional" | "newsletter" | "transactional" | "notification";

/** Type group for corpus percentiles (DESIGN-SCORE §5.6). */
export function typeGroupOf(t: EmailType): TypeGroup {
  switch (t) {
    case "newsletter":
    case "community":
      return "newsletter";
    case "transactional":
    case "account_security":
    case "account_notice":
      return "transactional";
    case "notification":
    case "social":
      return "notification";
    default:
      return "promotional";
  }
}

/**
 * L2 whitespace share percentiles (p2, p10, p90, p98) — PRIORS, not corpus values. The band
 * is flat (credit 1) between p10 and p90, so only unusually cramped or unusually empty
 * layouts lose points.
 */
export const L2_PRIORS: Readonly<Record<TypeGroup, readonly [number, number, number, number]>> = {
  promotional: [0.3, 0.45, 0.94, 0.985],
  newsletter: [0.35, 0.5, 0.95, 0.99],
  transactional: [0.4, 0.55, 0.97, 0.995],
  notification: [0.4, 0.55, 0.97, 0.995],
};

/**
 * L3 clutter z-score parameters — PRIORS. Each metric's mean and SD; the clutter index is the
 * mean z-score, and credit is `ramp(z, p99, p90)`. With p90 = 1.28 and p99 = 2.33 (the
 * standard-normal quantiles) only the top decile loses points, as §5.6 intends.
 */
export const L3_PRIORS: Readonly<
  Record<
    TypeGroup,
    {
      edge: [number, number];
      png: [number, number];
      leaves: [number, number];
      p90: number;
      p99: number;
    }
  >
> = {
  promotional: { edge: [0.09, 0.05], png: [0.9, 0.6], leaves: [30, 18], p90: 1.28, p99: 2.33 },
  newsletter: { edge: [0.1, 0.05], png: [0.8, 0.5], leaves: [40, 22], p90: 1.28, p99: 2.33 },
  transactional: { edge: [0.07, 0.04], png: [0.5, 0.35], leaves: [22, 14], p90: 1.28, p99: 2.33 },
  notification: { edge: [0.06, 0.04], png: [0.45, 0.3], leaves: [16, 10], p90: 1.28, p99: 2.33 },
};

/**
 * X2 client shares for this product's audience (Gmail web and app dominate, DESIGN-SCORE §5.8),
 * not Litmus open share. Design choice, sums to 1.
 */
export const X2_CLIENT_SHARES = {
  gmail_web: 0.38,
  gmail_android: 0.14,
  gmail_ios: 0.12,
  apple_mail: 0.14,
  outlook_classic: 0.06,
  outlook_new: 0.06,
  yahoo: 0.05,
  samsung: 0.05,
} as const;
export type X2Client = keyof typeof X2_CLIENT_SHARES;

/** X2 severities (DESIGN-SCORE §5.8): layout-breaking 1.0, visual 0.5, cosmetic 0.2. */
export const X2_SEVERITY = {
  flex: 1,
  grid: 1,
  position: 1,
  float: 1,
  max_width: 1,
  background_image: 0.5,
  border_radius: 0.5,
  linear_gradient: 0.5,
  web_font: 0.5,
  svg_image: 0.5,
  webp_image: 0.5,
  box_shadow: 0.2,
  video: 0.2,
  picture: 0.2,
} as const;
export type X2Feature = keyof typeof X2_SEVERITY;

/**
 * Client support per feature from caniemail (snapshot 2026-09-16, latest version entry):
 * 1 = unsupported ("n"), 0.5 = partial ("a"), 0 = supported ("y").
 */
export const CANIEMAIL_SNAPSHOT = "2026-09-16";
const Y = 0;
const A = 0.5;
const N = 1;
export const X2_UNSUPPORTED: Readonly<Record<X2Feature, Readonly<Record<X2Client, number>>>> = {
  flex: {
    gmail_web: Y,
    gmail_android: A,
    gmail_ios: A,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: Y,
    samsung: Y,
  },
  grid: {
    gmail_web: Y,
    gmail_android: A,
    gmail_ios: A,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: Y,
    samsung: Y,
  },
  position: {
    gmail_web: N,
    gmail_android: N,
    gmail_ios: N,
    apple_mail: A,
    outlook_classic: N,
    outlook_new: A,
    yahoo: A,
    samsung: A,
  },
  float: {
    gmail_web: Y,
    gmail_android: A,
    gmail_ios: A,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: A,
    samsung: Y,
  },
  max_width: {
    gmail_web: Y,
    gmail_android: Y,
    gmail_ios: Y,
    apple_mail: Y,
    outlook_classic: A,
    outlook_new: Y,
    yahoo: Y,
    samsung: Y,
  },
  background_image: {
    gmail_web: Y,
    gmail_android: Y,
    gmail_ios: Y,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: A,
    samsung: Y,
  },
  border_radius: {
    gmail_web: Y,
    gmail_android: Y,
    gmail_ios: Y,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: A,
    samsung: Y,
  },
  linear_gradient: {
    gmail_web: Y,
    gmail_android: A,
    gmail_ios: Y,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: N,
    yahoo: N,
    samsung: A,
  },
  web_font: {
    gmail_web: N,
    gmail_android: N,
    gmail_ios: N,
    apple_mail: Y,
    outlook_classic: A,
    outlook_new: N,
    yahoo: N,
    samsung: Y,
  },
  box_shadow: {
    gmail_web: N,
    gmail_android: A,
    gmail_ios: A,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: N,
    samsung: Y,
  },
  svg_image: {
    gmail_web: A,
    gmail_android: A,
    gmail_ios: A,
    apple_mail: Y,
    outlook_classic: Y,
    outlook_new: Y,
    yahoo: Y,
    samsung: Y,
  },
  webp_image: {
    gmail_web: A,
    gmail_android: A,
    gmail_ios: A,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: Y,
    yahoo: Y,
    samsung: Y,
  },
  video: {
    gmail_web: N,
    gmail_android: N,
    gmail_ios: N,
    apple_mail: A,
    outlook_classic: N,
    outlook_new: N,
    yahoo: N,
    samsung: A,
  },
  picture: {
    gmail_web: N,
    gmail_android: N,
    gmail_ios: N,
    apple_mail: Y,
    outlook_classic: N,
    outlook_new: N,
    yahoo: N,
    samsung: Y,
  },
};

/** 1 MB for I5 (binary megabytes). */
export const MEGABYTE = 1024 * 1024;
/** 1 KB for X4 (the Gmail limit is 16,384 bytes). */
export const KILOBYTE = 1024;
