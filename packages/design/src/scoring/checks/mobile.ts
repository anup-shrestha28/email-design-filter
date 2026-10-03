/**
 * Mobile & Responsiveness — 15 points (DESIGN-SCORE §5.2). `k` is the mobile fit factor.
 */
import { meanOf, ramp } from "../../util/math";
import { darkModeTextShare } from "../contrast";
import {
  type CheckFn,
  type CheckTable,
  isOutcome,
  notApplicable,
  notEvaluated,
  r3,
  requireRender,
  scored,
} from "../kit";

/** M1 Fits the phone — `ramp(k, 0.70, 1.0)`. */
export const checkM1: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const { k, mobileContentWidth } = r.layout;
  return scored(ramp(k, 0.7, 1), { k: r3(k), contentWidth: Math.round(mobileContentWidth) });
};

/** M2 Fluid without media queries — `ramp(k_nomq, 0.75, 1.0)` from pass M-nomq. */
export const checkM2: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const kn = r.layout.kNomq;
  if (kn === null) return notEvaluated("pass_skipped");
  return scored(ramp(kn, 0.75, 1), { kNomq: r3(kn), contentWidth: r.layout.nomqContentWidth });
};

/** M3: prose narrower than this (width × k) is squeezed (render-2026.4 `proseWidths`). */
const NARROW_PROSE_PX = 200;

/**
 * M3 Readable column width — share of body chars not squeezed into a narrow column. With
 * `proseWidths` (render-2026.4) only paragraph text in blocks whose width × k < 200px is
 * squeezed (card grids, logo rows and labels never are); older renders: every body block whose
 * width × k < 250px.
 */
export const checkM3: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const k = r.layout.k;
  let total = 0;
  let wide = 0;
  for (const [w, chars] of r.text.blockWidths) {
    total += chars;
    if (w * k >= 250) wide += chars;
  }
  if (total === 0) return notApplicable({ reason: "no_body_text" });
  const prose = r.text.proseWidths;
  if (prose) {
    let narrow = 0;
    for (const [w, chars] of prose) if (w * k < NARROW_PROSE_PX) narrow += chars;
    wide = Math.max(0, total - narrow);
  }
  return scored(wide / total, { wideShare: r3(wide / total) });
};

/**
 * M4 Primary-CTA touch size — `ramp(min(h, w) × k, 16, 44)` of the button a reader sees (the
 * larger of its painted box `visual` and the link box; methodology 2026.5 — a padded cell button
 * read "20px tall" from its inner link at 46px). When only its text is tappable (`textOnlyTap`,
 * render-2026.4) the credit is the mean of the visible and the tappable size's. N/A without a
 * primary CTA. `shrinkOnly`: the button is full size on its own (≥ ~41px unscaled) and only the
 * fixed-width shrink (k < 1) makes it small — a symptom of the fixed-width layout, reported inside
 * that one root-cause item (DECISIONS.md #26).
 */
export const checkM4: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const cta = r.cta.primary;
  if (!cta) return notApplicable({ reason: "no_primary_cta" });
  const k = r.layout.k;
  const targetCss = Math.min(cta.target.w, cta.target.h);
  const visualCss = Math.max(targetCss, Math.min(cta.visual.w, cta.visual.h));
  const minSide = visualCss * k;
  const seen = ramp(minSide, 16, 44);
  const textOnlyTap = cta.textOnlyTap === true;
  const s = textOnlyTap ? (seen + ramp(targetCss * k, 16, 44)) / 2 : seen;
  const shrinkOnly = k < 0.99 && seen < 0.9 && ramp(visualCss, 16, 44) >= 0.9;
  return scored(s, {
    minSidePx: r3(minSide),
    cssPx: r3(visualCss),
    visualPx: r3(visualCss * k),
    targetPx: r3(targetCss * k),
    textOnlyTap,
    label: cta.label,
    shrinkOnly,
  });
};

/**
 * M5 Images adapt — mean of (i) within the viewport at 375, (ii) aspect kept (< 5%),
 * (iii) sharp (natural ≥ 1.5 × rendered width, for images ≥ 300px wide).
 */
export const checkM5: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const items = r.images.adapt;
  if (items.length === 0) return notApplicable({ reason: "no_large_images" });
  const within = items.filter((i) => i.withinViewport).length / items.length;
  const known = items.filter((i) => i.aspectDev !== null);
  const aspect =
    known.length > 0 ? known.filter((i) => (i.aspectDev ?? 0) < 0.05).length / known.length : null;
  const big = items.filter((i) => i.renderedWidth >= 300 && i.sharpRatio !== null);
  const sharp =
    big.length > 0 ? big.filter((i) => (i.sharpRatio ?? 0) >= 1.5).length / big.length : null;
  const s = meanOf([within, aspect, sharp]) ?? within;
  return scored(s, {
    images: items.length,
    overflowing: items.length - items.filter((i) => i.withinViewport).length,
    distorted: known.length - known.filter((i) => (i.aspectDev ?? 0) < 0.05).length,
    blurry: big.length - big.filter((i) => (i.sharpRatio ?? 0) >= 1.5).length,
  });
};

/**
 * M6 Dark-mode resilience — mean over partial and full inversion of (AA text pass share,
 * share of transparent images whose opaque pixels mostly stay ≥ 3:1).
 */
export const checkM6: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const models = ["partial", "full"] as const;
  const perModel: number[] = [];
  const detail: Record<string, number | null> = {};
  for (const m of models) {
    const text = darkModeTextShare(r.contrast.groups, m);
    const imgs = r.images.darkMode;
    const img = imgs.length > 0 ? imgs.filter((i) => i[m] >= 0.5).length / imgs.length : null;
    detail[`${m}Text`] = text === null ? null : r3(text);
    detail[`${m}Images`] = img === null ? null : r3(img);
    const v = meanOf([text, img]);
    if (v !== null) perModel.push(v);
  }
  if (perModel.length === 0) return notApplicable({ reason: "nothing_to_simulate" });
  return scored(perModel.reduce((a, b) => a + b, 0) / perModel.length, detail);
};

/** M7 Side gutters — share of body chars whose lines sit ≥ 12px (× k) from both edges at 375. */
export const checkM7: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const k = r.layout.k;
  let total = 0;
  let ok = 0;
  for (const [d, chars] of r.text.gutters) {
    total += chars;
    if (d * k >= 12) ok += chars;
  }
  if (total === 0) return notApplicable({ reason: "no_body_text" });
  return scored(ok / total, { okShare: r3(ok / total) });
};

export const MOBILE_CHECKS: CheckTable = {
  M1: checkM1,
  M2: checkM2,
  M3: checkM3,
  M4: checkM4,
  M5: checkM5,
  M6: checkM6,
  M7: checkM7,
};
