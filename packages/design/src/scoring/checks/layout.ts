/**
 * Layout, Color & Consistency — 6 deterministic points + L8 (AI, 4) (DESIGN-SCORE §5.6).
 * L2/L3 use per-type-group corpus parameters (priors until calibrated; see weights.ts).
 */
import type { ContrastGroup } from "../../features/render";
import { colorToLab, deltaE2000, fromHex, type Lab } from "../../util/color";
import { band, meanOf, ramp } from "../../util/math";
import { L2_PRIORS, L3_PRIORS, typeGroupOf } from "../weights";
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

/** L1 Container width — `band(w, 320, 440, 700, 800)` on desktop. */
export const checkL1: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const c = r.layout.mainContainer;
  if (!c) return notApplicable({ reason: "no_main_container" });
  return scored(band(c.w, 320, 440, 700, 800), { width: Math.round(c.w) });
};

/** L2 Whitespace balance — band over the type group's p2/p10/p90/p98 (priors). */
export const checkL2: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const v = r.pixels.whitespace;
  if (v === null) return notEvaluated("no_pixels");
  const group = typeGroupOf(input.ctx.primaryType);
  const [p2, p10, p90, p98] = L2_PRIORS[group];
  return scored(band(v, p2, p10, p90, p98), { whitespace: r3(v), group });
};

/** L3 Visual clutter — mean z-score of edge density, PNG bytes/pixel and X–Y leaves; `ramp(z, p99, p90)`. */
export const checkL3: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const { edgeDensity, pngBytesPerPixel, xyLeaves } = r.pixels;
  if (edgeDensity === null || pngBytesPerPixel === null || xyLeaves === null)
    return notEvaluated("no_pixels");
  const group = typeGroupOf(input.ctx.primaryType);
  const p = L3_PRIORS[group];
  const z =
    ((edgeDensity - p.edge[0]) / p.edge[1] +
      (pngBytesPerPixel - p.png[0]) / p.png[1] +
      (xyLeaves - p.leaves[0]) / p.leaves[1]) /
    3;
  return scored(ramp(z, p.p99, p.p90), { z: r3(z), group });
};

/** L4 Alignment grid — distinct alignment anchors on desktop → `ramp(n, 14, 6)`. */
export const checkL4: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const n = r.text.alignmentAnchors;
  if (n === 0) return notApplicable({ reason: "no_text_blocks" });
  return scored(ramp(n, 14, 6), { anchors: n });
};

/**
 * Text colours covering ≥ 1% of rendered characters after merging at ΔE2000 < 3
 * (greedy, most-used colour first).
 */
export function countTextColours(groups: readonly ContrastGroup[]): number {
  const byColour = new Map<string, number>();
  let total = 0;
  for (const g of groups) {
    if (!g.rendered) continue;
    byColour.set(g.fg.slice(0, 7), (byColour.get(g.fg.slice(0, 7)) ?? 0) + g.chars);
    total += g.chars;
  }
  if (total === 0) return 0;
  const clusters: Array<{ lab: Lab; chars: number }> = [];
  for (const [hex, chars] of [...byColour.entries()].sort((a, b) => b[1] - a[1])) {
    const c = fromHex(hex);
    if (!c) continue;
    const lab = colorToLab(c);
    const hit = clusters.find((k) => deltaE2000(k.lab, lab) < 3);
    if (hit) hit.chars += chars;
    else clusters.push({ lab, chars });
  }
  return clusters.filter((k) => k.chars >= 0.01 * total).length;
}

/** L5 Colour discipline — mean of `ramp(n_dominant, 9, 5)` and `ramp(n_text_colours, 7, 4)`. */
export const checkL5: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const dominant = r.pixels.dominantColours;
  const text = countTextColours(r.contrast.groups);
  const parts = [
    dominant === null ? null : ramp(dominant, 9, 5),
    text === 0 ? null : ramp(text, 7, 4),
  ];
  const s = meanOf(parts);
  if (s === null) return notApplicable({ reason: "nothing_to_measure" });
  return scored(s, { dominantColours: dominant, textColours: text });
};

/**
 * L6 Component consistency — mean of button styles (≤ 2 → 1, 3 → 0.6, ≥ 4 → 0.3) and
 * `ramp(n_vertical_gap_clusters, 10, 5)`.
 */
export const checkL6: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const styles = r.cta.buttonStyles;
  const gaps = r.components.gapClusters;
  const buttonScore = styles === 0 ? null : styles <= 2 ? 1 : styles === 3 ? 0.6 : 0.3;
  const gapScore = gaps === 0 ? null : ramp(gaps, 10, 5);
  const s = meanOf([buttonScore, gapScore]);
  if (s === null) return notApplicable({ reason: "nothing_to_measure" });
  return scored(s, { buttonStyles: styles, gapClusters: gaps });
};

/** L7 In-email brand coherence — mean of a logo in the top 200px at 375 and `ramp(n_accent_hues, 4, 2)`. */
export const checkL7: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const hues = r.components.accentHues;
  return scored((r.images.logoTop ? 1 : 0) / 2 + ramp(hues, 4, 2) / 2, {
    logoTop: r.images.logoTop,
    accentHues: hues,
  });
};

export const LAYOUT_CHECKS: CheckTable = {
  L1: checkL1,
  L2: checkL2,
  L3: checkL3,
  L4: checkL4,
  L5: checkL5,
  L6: checkL6,
  L7: checkL7,
};
