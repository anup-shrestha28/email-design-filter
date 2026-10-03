/**
 * Visual Hierarchy & CTA — 9 deterministic points + H7 (AI, 6) (DESIGN-SCORE §5.4).
 * Type applicability (H1–H2 / H3–H5 matrix) is applied by `applicability.ts` first.
 */
import { VIEWPORT_V } from "../../constants";
import type { RenderFeatures } from "../../features/render";
import { ACTION_VERBS, GENERIC_LABELS } from "../../util/patterns";
import { meanOf, ramp } from "../../util/math";
import { normalizeLabel, words } from "../../util/text";
import {
  type CheckFn,
  type CheckInput,
  type CheckTable,
  isOutcome,
  notApplicable,
  r3,
  requireRender,
  scored,
} from "../kit";

/** A button-like CTA exists (H1's source: rendered for an own render, else the static heuristic). */
export function hasButtonCta(input: CheckInput): boolean {
  if (input.ownRender && input.render) return input.render.cta.buttonLike > 0;
  // A failed static pass counted no buttons: the template's render decides, else assume one so
  // the H checks report "not evaluated" rather than "not applicable".
  if (input.static.unavailable === true)
    return input.render ? input.render.cta.buttonLike > 0 : true;
  return input.static.cta.buttonLike > 0;
}

/** H1 Primary CTA present — a button-like CTA exists. */
export const checkH1: CheckFn = (input) => {
  const present = hasButtonCta(input);
  return scored(present ? 1 : 0, { present, source: input.ownRender ? "render" : "static" });
};

/**
 * H2's placement credit `max(0.1, ramp(y_b × k, 3V, V))` and the bottom edge it is read from, for
 * the main button (null without one). The Excellent gate's "first phone screen" (G2) reads the
 * same number for every email type — H2 itself is only scored for action types — so a template's
 * verdict follows what a reader sees at its top (DESIGN-SCORE §3.1).
 */
export function ctaPlacement(r: RenderFeatures): { credit: number; bottomPx: number } | null {
  const cta = r.cta.primary;
  if (!cta) return null;
  const yb = (cta.visual.y + cta.visual.h) * r.layout.k;
  return { credit: Math.max(0.1, ramp(yb, 3 * VIEWPORT_V, VIEWPORT_V)), bottomPx: yb };
}

/** H2 CTA placement — `max(0.1, ramp(y_b × k, 3V, V))`, y_b = the primary CTA's bottom edge at 375. */
export const checkH2: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const cta = r.cta.primary;
  const place = ctaPlacement(r);
  if (!cta || !place) return scored(0, { present: false });
  const yb = place.bottomPx;
  return scored(place.credit, {
    present: true,
    bottomPx: Math.round(yb),
    screens: r3(yb / VIEWPORT_V),
    label: cta.label,
  });
};

/**
 * H3 CTA prominence — mean of label contrast (`ramp(ratio, 3, 4.5)`, large `ramp(ratio, 2, 3)`),
 * salience (`max(ramp(lum ratio, 1.5, 3), ramp(ΔE2000, 15, 30))`) and rank (most prominent
 * link overall → 1, else 0.5). Image buttons have no measurable label contrast.
 */
export const checkH3: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const cta = r.cta.primary;
  if (!cta) return scored(0, { present: false });
  const label =
    cta.labelContrast === null
      ? null
      : cta.labelLarge
        ? ramp(cta.labelContrast, 2, 3)
        : ramp(cta.labelContrast, 3, 4.5);
  const salience = Math.max(
    cta.fillLumRatio === null ? 0 : ramp(cta.fillLumRatio, 1.5, 3),
    cta.fillDeltaE === null ? 0 : ramp(cta.fillDeltaE, 15, 30),
  );
  const rank = cta.mostProminent ? 1 : 0.5;
  return scored(meanOf([label, salience, rank]) ?? 0, {
    present: true,
    labelContrast: cta.labelContrast === null ? null : r3(cta.labelContrast),
    labelLarge: cta.labelLarge,
    salience: r3(salience),
    mostProminent: cta.mostProminent,
    label: cta.label,
  });
};

/**
 * H4 CTA label clarity — 1–5 words starting with an action verb → 1; generic labels → 0.4.
 * Non-generic labels without a leading verb are a tie the AI would decide; deterministically
 * they get 0.7, as do 6–7 word labels (longer labels 0.5).
 */
export function labelClarity(label: string, lang: string | null): number {
  const norm = normalizeLabel(label);
  if (!norm) return 0;
  if (GENERIC_LABELS.has(norm)) return 0.4;
  const ws = words(norm, lang);
  const n = ws.length;
  if (n === 0) return 0;
  if (n > 7) return 0.5;
  if (n > 5) return 0.7;
  const first = (ws[0] ?? "").toLowerCase();
  return ACTION_VERBS.has(first) ? 1 : 0.7;
}

export const checkH4: CheckFn = (input) => {
  const label =
    input.ownRender && input.render
      ? (input.render.cta.primary?.label ?? null)
      : input.static.cta.primaryLabel;
  if (!label) return notApplicable({ reason: "no_primary_cta" });
  return scored(labelClarity(label, input.ctx.language), { label });
};

/** H5 CTA focus — distinct actions in the first two mobile viewports: ≤2 → 1, 3 → 0.7, 4 → 0.4, ≥5 → 0.2. */
export const checkH5: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  if (r.cta.buttonLike === 0) return notApplicable({ reason: "no_button_cta" });
  const n = r.cta.firstTwoViewportsDistinct;
  const s = n <= 2 ? 1 : n === 3 ? 0.7 : n === 4 ? 0.4 : 0.2;
  return scored(s, { distinct: n });
};

/**
 * H6 Type-scale contrast — largest first-viewport size ÷ median_all → `ramp(ratio, 1.1, 1.6)`.
 * `headline: false` (methodology 2026.5) when the email has no heading at all (no heading-role
 * text, no visual heading): the explanation then says "No headline", not "barely larger", and the
 * Excellent gate's G1 fails whatever the ratio (the largest text is then a button or a label).
 * `pictures`: the email has content images, so a headline may be set in one — the explanation
 * then says "No headline in live text" (a hero picture or a banner that didn't load).
 */
export const checkH6: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const max = r.text.firstViewportMaxPx;
  const med = r.text.medianAll.mobile;
  if (max === null || med === null || med <= 0) return notApplicable({ reason: "no_text" });
  const ratio = max / med;
  const headline = r.text.chars.heading > 0 || r.text.headings.visual > 0;
  return scored(ramp(ratio, 1.1, 1.6), {
    ratio: r3(ratio),
    largestPx: r3(max),
    medianPx: r3(med),
    headline,
    pictures: (r.images.declared ?? r.images.content) > 0,
  });
};

export const HIERARCHY_CHECKS: CheckTable = {
  H1: checkH1,
  H2: checkH2,
  H3: checkH3,
  H4: checkH4,
  H5: checkH5,
  H6: checkH6,
};
