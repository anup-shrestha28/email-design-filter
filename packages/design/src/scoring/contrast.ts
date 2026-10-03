/**
 * Contrast verdicts over colour-pair groups (DESIGN-SCORE §2.1 "Effective background",
 * §5.1 A1, §4 CAP_CONTRAST, §5.2 M6).
 */
import { INVISIBLE_CONTRAST } from "../constants";
import type { ContrastGroup, TextRole } from "../features/render";
import { type Lab, colorToLab, contrastRatio, fromHex, labToRgb } from "../util/color";

export type Verdict = "pass" | "fail" | "undecided";

/**
 * Per-group verdict at WCAG AA (4.5:1, large text 3:1; ratios never rounded).
 * - Rendered runs: colour method compares the ratio; the pixel method passes when the p10
 *   meets the threshold and is undecidable only when p10 < threshold < p90.
 * - Runs that failed a visibility rule are excluded, except sub-1.3:1 runs of ≥ 20 characters,
 *   which count as failing (monotonic rule: hiding text by lowering contrast never helps).
 * Returns null when the group is excluded.
 */
export function verdict(g: ContrastGroup): Verdict | null {
  if (!g.rendered) return g.ratio < INVISIBLE_CONTRAST && !g.short ? "fail" : null;
  const thr = g.large ? 3 : 4.5;
  if (g.ratio >= thr) return "pass";
  if (g.method === "pixel" && g.p90 !== null && g.p90 > thr) return "undecided";
  return "fail";
}

export interface ContrastTally {
  pass: number;
  fail: number;
  undecided: number;
  /** The failing group with the most characters (for explanations). */
  worst: ContrastGroup | null;
}

export function tally(groups: readonly ContrastGroup[], roles: readonly TextRole[]): ContrastTally {
  const t: ContrastTally = { pass: 0, fail: 0, undecided: 0, worst: null };
  for (const g of groups) {
    if (!roles.includes(g.role)) continue;
    const v = verdict(g);
    if (v === null) continue;
    t[v] += g.chars;
    if (v === "fail" && (!t.worst || g.chars > t.worst.chars)) t.worst = g;
  }
  return t;
}

// ───────────────────────── dark-mode simulation (M6) ─────────────────────────

export type DarkModel = "partial" | "full";

function invertL(lab: Lab): Lab {
  return { L: 100 - lab.L, a: lab.a, b: lab.b };
}

/**
 * Simulated colours under a dark-mode model (DESIGN-SCORE §5.2 M6):
 * - partial: backgrounds with L* > 60 are flipped to 100 − L*; dark text (L* < 50) on a
 *   flipped background is lightened to 100 − L* (Outlook.com and apps);
 * - full: every colour L* → 100 − L*, hue kept (Outlook Windows, Gmail iOS).
 */
export function simulate(fgLab: Lab, bgLab: Lab, model: DarkModel): { fg: Lab; bg: Lab } {
  if (model === "full") return { fg: invertL(fgLab), bg: invertL(bgLab) };
  if (bgLab.L > 60) {
    return { fg: fgLab.L < 50 ? invertL(fgLab) : fgLab, bg: invertL(bgLab) };
  }
  return { fg: fgLab, bg: bgLab };
}

/** AA pass share of body and heading text under a dark-mode model; null without text. */
export function darkModeTextShare(
  groups: readonly ContrastGroup[],
  model: DarkModel,
): number | null {
  let pass = 0;
  let total = 0;
  for (const g of groups) {
    if (!g.rendered || (g.role !== "body" && g.role !== "heading")) continue;
    const fg = fromHex(g.fg);
    const bg = fromHex(g.bg);
    if (!fg || !bg) continue;
    const alpha = fg.a;
    const sim = simulate(colorToLab({ ...fg, a: 1 }), colorToLab(bg), model);
    const simFg = { ...labToRgb(sim.fg), a: alpha };
    const ratio = contrastRatio(simFg, labToRgb(sim.bg));
    total += g.chars;
    if (ratio >= (g.large ? 3 : 4.5)) pass += g.chars;
  }
  return total > 0 ? pass / total : null;
}
