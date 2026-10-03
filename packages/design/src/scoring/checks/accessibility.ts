/**
 * Accessibility — 20 points (DESIGN-SCORE §5.1).
 */
import { ramp, share } from "../../util/math";
import { mainContentGroups } from "../caps";
import { tally } from "../contrast";
import {
  type CheckFn,
  type CheckTable,
  isOutcome,
  needsReview,
  notApplicable,
  notEvaluated,
  r3,
  requireRender,
  scored,
} from "../kit";

/** A1: fine print (footer-like legal, disclaimer or metadata lines) weighs at most this share. */
export const FINE_PRINT_WEIGHT_MAX = 0.25;

const credit = (passShare: number) => ramp(passShare, 0.7, 0.98);

/**
 * A1 Text contrast — WCAG 2.2 SC 1.4.3: `ramp(pass_share, 0.70, 0.98)` over body + heading chars.
 * Fine print (`fine` groups: < 13px and ≤ 0.9 × the body's p75 size) is judged apart and weighs
 * its character share, at most 25% (methodology 2026.5, like CAP_CONTRAST leaving it out): a
 * faint footer disclaimer or grey metadata line costs at most a quarter of the check, never the
 * whole email's contrast credit — also when it is the only decided text (needs review when the
 * main text is there but undecided).
 */
export const checkA1: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const groups = r.contrast.groups;
  const t = tally(groups, ["body", "heading"]);
  const total = t.pass + t.fail + t.undecided;
  if (total === 0) return notApplicable({ reason: "no_text" });
  const main = tally(mainContentGroups(groups), ["body", "heading"]);
  const fine = tally(
    groups.filter((g) => g.fine === true),
    ["body", "heading"],
  );
  // The worst failing run of the main text names the problem; fine print only when it's all.
  const w = main.worst ?? t.worst;
  const worst = w
    ? {
        fg: w.fg,
        bg: w.bg,
        ratio: r3(w.ratio),
        chars: w.chars,
        role: w.role,
        rendered: w.rendered,
        fine: w.fine === true,
      }
    : null;
  if (t.undecided > 0.5 * total)
    return needsReview({ undecidedShare: r3(t.undecided / total), worst });
  const decided = t.pass + t.fail;
  const passShare = decided > 0 ? t.pass / decided : 1;
  const mainDecided = main.pass + main.fail;
  const fineDecided = fine.pass + fine.fail;
  // Main text that can't be decided (copy over a picture) leaves A1 to review, never to the fine
  // print alone.
  if (mainDecided === 0 && main.undecided > 0 && fineDecided > 0)
    return needsReview({ undecidedShare: r3(t.undecided / total), worst });
  let s = credit(passShare);
  let fineWeight: number | null = null;
  if (fineDecided > 0 && mainDecided > 0) {
    fineWeight = Math.min(FINE_PRINT_WEIGHT_MAX, fineDecided / (mainDecided + fineDecided));
    s =
      (1 - fineWeight) * credit(main.pass / mainDecided) +
      fineWeight * credit(fine.pass / fineDecided);
  } else if (fineDecided > 0) {
    // Only fine print to judge: it still costs at most its 25%.
    fineWeight = FINE_PRINT_WEIGHT_MAX;
    s = 1 - FINE_PRINT_WEIGHT_MAX + FINE_PRINT_WEIGHT_MAX * credit(fine.pass / fineDecided);
  }
  return scored(s, {
    passShare: r3(passShare),
    failShare: r3(1 - passShare),
    failChars: t.fail,
    undecidedShare: r3(t.undecided / total),
    mainFailShare: mainDecided > 0 ? r3(main.fail / mainDecided) : null,
    fineFailChars: fine.fail,
    fineWeight: fineWeight === null ? null : r3(fineWeight),
    worst,
  });
};

/**
 * A2 Text alternatives — WCAG 1.1.1: `0.5a + 0.5b`, (a) share with an alt attribute,
 * (b) share of informative images with meaningful alt. (b) uses rendered sizes only for an own
 * render (FREE-TIER.md §5.4 static heuristic otherwise).
 */
export const checkA2: CheckFn = (input) => {
  const st = input.static.images;
  if (st.content === 0) return notApplicable({ reason: "no_images" });
  const a = st.withAlt / st.content;
  const alt = input.ownRender && input.render ? input.render.images.alt : null;
  const informative = alt ? alt.informative : st.informative;
  const meaningful = alt ? alt.informativeMeaningful : st.informativeMeaningful;
  const b = share(informative, meaningful);
  const s = b === null ? a : 0.5 * a + 0.5 * b;
  return scored(s, {
    images: st.content,
    withAlt: st.withAlt,
    missingAlt: st.content - st.withAlt,
    informative,
    meaningful,
    altShare: r3(a),
    meaningfulShare: b === null ? null : r3(b),
  });
};

/** A3 Link purpose — WCAG 2.4.4 / 4.1.2: `named share × (1 − 0.5 × generic share)`. */
export const checkA3: CheckFn = (input) => {
  const l = input.static.links;
  if (l.total === 0) return notApplicable({ reason: "no_links" });
  const named = l.named / l.total;
  const generic = l.generic / l.total;
  return scored(named * (1 - 0.5 * generic), {
    links: l.total,
    unnamed: l.total - l.named,
    generic: l.generic,
  });
};

function primarySubtag(lang: string | null): string | null {
  if (!lang) return null;
  const m = /^([a-z]{2,3})\b/i.exec(lang.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** A4 Language declared — WCAG 3.1.1: wrapper 1, `<html>` only 0.5, none 0; ×0.5 on mismatch. */
export const checkA4: CheckFn = (input) => {
  const { html, wrapper } = input.static.lang;
  let s = wrapper ? 1 : html ? 0.5 : 0;
  const declared = primarySubtag(wrapper ?? html);
  const detected = primarySubtag(input.ctx.language);
  const mismatch = s > 0 && declared !== null && detected !== null && declared !== detected;
  if (mismatch) s *= 0.5;
  return scored(s, { html, wrapper, detected: input.ctx.language, mismatch });
};

/**
 * A5 Layout tables presentational — share with role="presentation"/"none". Layout tables are
 * decided by axe-core `isDataTable` for an own render, else by the static heuristic.
 */
export const checkA5: CheckFn = (input) => {
  const axe = input.ownRender && input.render ? input.render.axe : null;
  const layout = axe ? axe.layoutTables : input.static.tables.layout;
  const presentational = axe ? axe.presentationalLayoutTables : input.static.tables.presentational;
  if (layout === 0) return notApplicable({ reason: "no_layout_tables" });
  return scored(presentational / layout, { layoutTables: layout, presentational });
};

/** A6 Heading structure — `0.7 × marked-up share + 0.3 × [exactly one h1]`; N/A without visual headings. */
export const checkA6: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const h = r.text.headings;
  if (h.visual === 0) return notApplicable({ reason: "no_visual_headings" });
  const marked = Math.min(1, h.markedUp / h.visual);
  return scored(0.7 * marked + 0.3 * (h.h1 === 1 ? 1 : 0), {
    visual: h.visual,
    markedUp: h.markedUp,
    h1: h.h1,
  });
};

/** A7 Target size — WCAG 2.2 SC 2.5.8: share of standalone links ≥ 24×24 × k, or the spacing exception. */
export const checkA7: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const targets = r.links.targets;
  if (targets.length === 0) return notApplicable({ reason: "no_standalone_links" });
  const k = r.layout.k;
  let ok = 0;
  let okUnscaled = 0;
  let smallest = Infinity;
  for (const [w, h, spacing] of targets) {
    const minSide = Math.min(w, h) * k;
    smallest = Math.min(smallest, minSide);
    if ((w * k >= 24 && h * k >= 24) || spacing) ok++;
    if ((w >= 24 && h >= 24) || spacing) okUnscaled++;
  }
  const s = ok / targets.length;
  return scored(s, {
    targets: targets.length,
    small: targets.length - ok,
    smallestPx: r3(smallest),
    // Every target passes at its own size: only the fixed-width shrink makes them small
    // (a symptom reported inside the fixed-width item, DECISIONS.md #26).
    shrinkOnly: k < 0.99 && s < 0.9 && okUnscaled / targets.length >= 0.9,
  });
};

/** A8 Links distinguishable — WCAG 1.4.1: share of inline links with a non-colour cue or ≥ 3:1. */
export const checkA8: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const l = r.links;
  if (l.inline === 0) return notApplicable({ reason: "no_inline_links" });
  return scored(l.inlineDistinguishable / l.inline, {
    inline: l.inline,
    indistinct: l.inline - l.inlineDistinguishable,
  });
};

/** A9 Document title — axe `document-title`. */
export const checkA9: CheckFn = (input) =>
  scored(input.static.title ? 1 : 0, { title: input.static.title });

/** A10 ARIA misuse — none of role=button on `<a>`, VML without alt, aria-hidden on body. */
export const checkA10: CheckFn = (input) => {
  const a = input.static.aria;
  const ok = a.roleButtonOnLink === 0 && a.vmlWithoutAlt === 0 && !a.ariaHiddenBody;
  return scored(ok ? 1 : 0, a);
};

/** A11 Text direction — RTL script needs dir="rtl"; LTR needs dir on the wrapper or `<html>`. */
export const checkA11: CheckFn = (input) => {
  const { html, wrapper } = input.static.dir;
  const rtl = input.static.script.kind === "rtl";
  const declared = wrapper ?? html;
  const ok = rtl ? html === "rtl" || wrapper === "rtl" : declared !== null;
  return scored(ok ? 1 : 0, { rtl, html, wrapper });
};

/** A12 Reading order — WCAG 1.3.2: `ramp(τ, 0.80, 0.98)`. */
export const checkA12: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const tau = r.text.readingOrderTau;
  if (tau === null) return notApplicable({ reason: "too_few_blocks" });
  return scored(ramp(tau, 0.8, 0.98), { tau: r3(tau) });
};

/**
 * A13 Images of text — needs OCR, which is off in the free edition (FREE-TIER.md §5.7):
 * always `not_evaluated`.
 */
export const checkA13: CheckFn = () => notEvaluated("ocr_off");

export const ACCESSIBILITY_CHECKS: CheckTable = {
  A1: checkA1,
  A2: checkA2,
  A3: checkA3,
  A4: checkA4,
  A5: checkA5,
  A6: checkA6,
  A7: checkA7,
  A8: checkA8,
  A9: checkA9,
  A10: checkA10,
  A11: checkA11,
  A12: checkA12,
  A13: checkA13,
};
