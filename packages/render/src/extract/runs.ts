/**
 * Text runs (DESIGN-SCORE §2.1 "Text run"): one DOMSnapshot text box each, with its effective
 * colour (alpha × cumulative opacity), geometric visibility (non-zero box, visibility:visible,
 * inside the document and ≥ 50% inside every ancestor clip rect) and, on desktop, the paint
 * test (≥ 2% of the box's pixels change by ΔE > 5 between passes D and D0).
 */
import { type Rgba, charProfile, parseColor } from "@edf/design/render-kit";
import { type RawImage, changedFraction } from "../pixels";
import { type Rect, type Snap, px } from "../snapshot";

export interface Run {
  box: number;
  node: number;
  /** Parent element of the text node. */
  el: number;
  rect: Rect;
  text: string;
  /** Counted characters (CJK ×2, whitespace/emoji skipped). */
  chars: number;
  cjk: number;
  pua: number;
  px: number;
  weight: number;
  family: string;
  /** Effective text colour; alpha already includes cumulative opacity. */
  color: Rgba;
  /** Geometric visibility rules of §2.1 (paint test excluded). */
  geom: boolean;
  /** Paint test (desktop): true/false, or null when not tested (off-screen, or not desktop). */
  paint: boolean | null;
}

const PAINT_MIN = 0.02;

function visibleFraction(rect: Rect, clip: [number, number, number, number] | null): number {
  if (!clip) return 1;
  const w = Math.min(rect.x + rect.w, clip[2]) - Math.max(rect.x, clip[0]);
  const h = Math.min(rect.y + rect.h, clip[3]) - Math.max(rect.y, clip[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (rect.w * rect.h);
}

const MAX_RUNS = 60_000;

/**
 * Build the runs of a pass; the paint test runs when D/D0 pixels and the mask are given.
 * Text boxes that count no characters are skipped. When `symbols` is given, the skipped boxes
 * that still show something (emoji, ©, ™, arrows, check marks — pictographs `charProfile` doesn't
 * count) are built the same way, with `chars` 0, and pushed there instead: they are visible
 * content (the content extent) but not text for the character-weighted metrics.
 */
export function buildRuns(
  s: Snap,
  paint: { img: RawImage; mask: Uint8Array } | null,
  symbols?: Run[],
): Run[] {
  const runs: Run[] = [];
  const docW = Math.max(s.contentWidth, 1);
  const docH = Math.max(s.contentHeight, 1);
  for (let bi = 0; bi < s.boxes.length && runs.length < MAX_RUNS; bi++) {
    const b = s.boxes[bi]!;
    const text = s.boxText(b);
    const prof = charProfile(text);
    let out = runs;
    if (prof.counted === 0) {
      if (!symbols || symbols.length >= MAX_RUNS || !hasVisibleText(text)) continue;
      out = symbols;
    }
    const el = s.parent[b.node] ?? -1;
    const fill = parseColor(s.nodeStyle(b.node, "-webkit-text-fill-color"));
    const base = fill ?? parseColor(s.nodeStyle(b.node, "color")) ?? { r: 0, g: 0, b: 0, a: 1 };
    const opacity = el >= 0 ? s.cumOpacity[el]! : 1;
    const color: Rgba = { ...base, a: base.a * opacity };
    const r = b.rect;
    const inDoc = r.x + r.w > 0 && r.y + r.h > 0 && r.x < docW && r.y < docH;
    const clip = el >= 0 ? s.clip[el]! : null;
    const geom =
      r.w > 0 &&
      r.h > 0 &&
      s.nodeStyle(b.node, "visibility") === "visible" &&
      inDoc &&
      visibleFraction(r, clip) >= 0.5 &&
      color.a > 0.01;
    let paintOk: boolean | null = null;
    if (paint && geom) {
      const f = changedFraction(paint.mask, paint.img, r);
      paintOk = f === null ? null : f >= PAINT_MIN;
    }
    const weightRaw = s.nodeStyle(b.node, "font-weight");
    const weight = weightRaw === "bold" ? 700 : weightRaw === "normal" ? 400 : px(weightRaw) || 400;
    out.push({
      box: bi,
      node: b.node,
      el,
      rect: r,
      text,
      chars: prof.counted,
      cjk: prof.cjk,
      pua: prof.pua,
      px: px(s.nodeStyle(b.node, "font-size")),
      weight,
      family: s.nodeStyle(b.node, "font-family"),
      color,
      geom,
      paint: paintOk,
    });
  }
  return runs;
}

/** §2.1 "rendered": geometric visibility and (where tested) the paint test. */
export function isRendered(run: Run): boolean {
  return run.geom && run.paint !== false;
}

/**
 * Characters that paint nothing: whitespace, NBSP, soft hyphen, CGJ (U+034F), zero-width and
 * bidi controls, word joiner and invisible operators, BOM, variation selectors, and the blank
 * "letters" preheader padding uses (Hangul fillers U+115F/U+1160/U+3164/U+FFA0, the braille blank
 * U+2800, Khmer inherent vowels U+17B4/U+17B5, the Arabic letter mark, the Mongolian vowel
 * separator). Wider than `charProfile`'s set, which counts the Hangul fillers as CJK.
 */
const BLANK =
  // eslint-disable-next-line no-misleading-character-class -- deliberately matches lone CGJ/variation selectors
  /[\s\u{00A0}\u{00AD}\u{034F}\u{061C}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180E}\u{200B}-\u{200F}\u{2028}-\u{202F}\u{205F}-\u{206F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FEFF}\u{FFA0}]/gu;

/** The text has at least one character a reader can see. */
export function hasVisibleText(text: string): boolean {
  return text.replace(BLANK, "").length > 0;
}
