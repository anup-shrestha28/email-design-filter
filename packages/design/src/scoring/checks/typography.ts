/**
 * Readability & Typography — 15 points (DESIGN-SCORE §5.3).
 */
import { metricGroup } from "../../fonts/catalog";
import { SYSTEM_UI } from "../../fonts/normalize";
import { band, ramp } from "../../util/math";
import { fleschReadingEase } from "../../util/text";
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

/** T1 Effective mobile body size — `ramp(median body px at 375 × k, 12, 16)`. */
export const checkT1: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const px = r.text.body.mobile;
  if (px === null) return notApplicable({ reason: "no_text" });
  const eff = px * r.layout.k;
  return scored(ramp(eff, 12, 16), {
    px: r3(eff),
    cssPx: r3(px),
    k: r3(r.layout.k),
    fallback: r.text.body.fallback,
  });
};

/** T2 Desktop body size — `ramp(median body px, 11, 14)`. */
export const checkT2: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const px = r.text.body.desktop;
  if (px === null) return notApplicable({ reason: "no_text" });
  return scored(ramp(px, 11, 14), { px: r3(px) });
};

function paragraphGate(lines: number): boolean {
  return lines >= 3;
}

/** T3 Line height — measured line pitch ÷ font size → `ramp(r, 1.1, 1.4)`; N/A under 3 lines. */
export const checkT3: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  if (!paragraphGate(r.text.paragraphLines) || r.text.lineRatio === null)
    return notApplicable({ reason: "too_little_paragraph_text" });
  return scored(ramp(r.text.lineRatio, 1.1, 1.4), { ratio: r3(r.text.lineRatio) });
};

/** T4 Line length — Latin `band(x, 25, 45, 80, 110)`, Han/Kana `band(x, 10, 18, 40, 55)`. */
export const checkT4: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const x = r.text.charsPerLine;
  if (!paragraphGate(r.text.paragraphLines) || x === null)
    return notApplicable({ reason: "too_little_paragraph_text" });
  const cjk = r.text.script === "cjk";
  const s = cjk ? band(x, 10, 18, 40, 55) : band(x, 25, 45, 80, 110);
  return scored(s, { charsPerLine: r3(x), cjk });
};

/** T5 Alignment — share of body chars neither justified nor in centred paragraphs > 3 lines. */
export const checkT5: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const a = r.text.alignment;
  if (!paragraphGate(r.text.paragraphLines) || a.chars === 0)
    return notApplicable({ reason: "too_little_paragraph_text" });
  return scored(1 - a.badChars / a.chars, { badShare: r3(a.badChars / a.chars) });
};

const GENERIC_GROUP: Record<string, string> = {
  "sans-serif": "Arial",
  "ui-sans-serif": "Arial",
  serif: "Times New Roman",
  "ui-serif": "Times New Roman",
  monospace: "Courier New",
  "ui-monospace": "Courier New",
};

/**
 * T6 Typographic system — mean of a families score (used primary families from the font
 * profile, merged by the metric alias table; System UI is one family) and a sizes score
 * (distinct 0.5px sizes covering ≥ 1% of characters).
 */
export const checkT6: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const profile = input.fontProfile;
  if (!profile.measured) return notEvaluated("fonts_not_measured");
  const groups = new Set<string>();
  for (const f of profile.families) {
    const name = f.name === SYSTEM_UI ? SYSTEM_UI : (GENERIC_GROUP[f.name] ?? f.name);
    groups.add(metricGroup(name).toLowerCase());
  }
  const n = groups.size;
  const famScore = n <= 2 ? 1 : n === 3 ? 0.8 : n === 4 ? 0.4 : 0;
  const totalChars = r.text.sizes.reduce((s, [, c]) => s + c, 0);
  const sizes = r.text.sizes.filter(([, c]) => totalChars > 0 && c >= 0.01 * totalChars).length;
  const sizeScore = sizes <= 6 ? 1 : sizes <= 8 ? 0.6 : sizes === 9 ? 0.4 : 0.2;
  if (n === 0 && totalChars === 0) return notApplicable({ reason: "no_text" });
  return scored((famScore + sizeScore) / 2, { families: n, sizes });
};

/**
 * T7 Uppercase overuse — `ramp(caps share, 0.30, 0.05)`, headings and buttons excluded; N/A
 * for caseless scripts. Rendered definition for an own render, else the static heuristic.
 */
export const checkT7: CheckFn = (input) => {
  if (input.ownRender && input.render) {
    const c = input.render.text.caps;
    if (c === null) return notApplicable({ reason: "caseless_script" });
    if (c.chars === 0) return notApplicable({ reason: "no_body_text" });
    return scored(ramp(c.caps / c.chars, 0.3, 0.05), {
      capsShare: r3(c.caps / c.chars),
      source: "render",
    });
  }
  if (!input.static.script.cased) return notApplicable({ reason: "caseless_script" });
  const c = input.static.caps;
  if (c.chars === 0) return notApplicable({ reason: "no_body_text" });
  return scored(ramp(c.caps / c.chars, 0.3, 0.05), {
    capsShare: r3(c.caps / c.chars),
    source: "static",
  });
};

/** T8 Prose readability — Flesch Reading Ease → `ramp(FRE, 30, 60)`; English only, ≥ 100 words. */
export const checkT8: CheckFn = (input) => {
  const lang = (input.ctx.language ?? "").toLowerCase();
  const prose = input.static.prose;
  if (!lang.startsWith("en") || !prose || prose.words < 100)
    return notApplicable({ reason: "not_english_prose" });
  const fre = fleschReadingEase(prose);
  if (fre === null) return notApplicable({ reason: "not_english_prose" });
  return scored(ramp(fre, 30, 60), { fre: r3(fre), words: prose.words });
};

export const TYPOGRAPHY_CHECKS: CheckTable = {
  T1: checkT1,
  T2: checkT2,
  T3: checkT3,
  T4: checkT4,
  T5: checkT5,
  T6: checkT6,
  T7: checkT7,
  T8: checkT8,
};
