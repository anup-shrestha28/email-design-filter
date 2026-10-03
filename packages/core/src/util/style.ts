/**
 * Inline `style=""` parsing and the hidden-content rules shared by ingest (visible text,
 * preheader) and the image policy (hidden pixels). Bounded: styles are cut at 4 KB.
 */

const MAX_STYLE = 4096;

/** Parses an inline style into lower-case property → value (with `!important` stripped). */
export function parseInlineStyle(style: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!style) return map;
  const s = style.length > MAX_STYLE ? style.slice(0, MAX_STYLE) : style;
  for (const decl of s.split(";")) {
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (!/^-?[a-z][a-z0-9-]{0,40}$/.test(prop)) continue;
    const value = decl
      .slice(colon + 1)
      .replace(/!\s*important/gi, "")
      .trim()
      .toLowerCase();
    // Later declarations win, as in CSS.
    map.set(prop, value);
  }
  return map;
}

/** Numeric CSS length in px (px, pt, em/rem at 16px, bare numbers), or null (%, auto, calc…). */
export function cssLengthPx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(-?\d{1,6}(?:\.\d{1,4})?)\s*(px|pt|em|rem)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "pt":
      return n * (4 / 3);
    case "em":
    case "rem":
      return n * 16;
    default:
      return n;
  }
}

function isZeroLength(value: string | undefined): boolean {
  const px = cssLengthPx(value);
  return px !== null && px <= 0;
}

function overflowHidden(style: Map<string, string>): boolean {
  const o = style.get("overflow") ?? "";
  const oy = style.get("overflow-y") ?? "";
  const ox = style.get("overflow-x") ?? "";
  return (
    o.startsWith("hidden") ||
    oy.startsWith("hidden") ||
    ox.startsWith("hidden") ||
    o.startsWith("clip")
  );
}

/**
 * True when an inline style hides the element's content from a Gmail reader:
 * display:none, visibility:hidden, opacity≈0, font-size < 2px, zero height/width with overflow
 * hidden (the classic preheader trick), off-screen positioning, clip rect(0…), transparent text.
 * `mso-hide:all` alone only hides from Outlook, so it doesn't count.
 */
export function isHiddenStyle(style: Map<string, string>): boolean {
  if (style.size === 0) return false;
  const display = style.get("display");
  if (display !== undefined && display.startsWith("none")) return true;
  const visibility = style.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return true;
  const opacity = style.get("opacity");
  if (opacity !== undefined) {
    const o = Number.parseFloat(opacity);
    if (!Number.isNaN(o) && o <= 0.01) return true;
  }
  const fontSize = style.get("font-size");
  if (fontSize !== undefined) {
    const px = cssLengthPx(fontSize);
    if (px !== null && px < 2) return true;
    const pct = /^(\d{1,3}(?:\.\d+)?)%$/.exec(fontSize.trim());
    if (pct && Number(pct[1]) < 12) return true;
  }
  if (overflowHidden(style)) {
    if (isZeroLength(style.get("max-height")) || isZeroLength(style.get("height"))) return true;
    if (isZeroLength(style.get("max-width")) || isZeroLength(style.get("width"))) return true;
  }
  const position = style.get("position");
  if (position === "absolute" || position === "fixed") {
    const left = cssLengthPx(style.get("left"));
    const top = cssLengthPx(style.get("top"));
    if ((left !== null && left <= -500) || (top !== null && top <= -500)) return true;
    const clip = style.get("clip") ?? "";
    if (/^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(clip))
      return true;
  }
  const color = style.get("color");
  if (color === "transparent") return true;
  return false;
}

/** True when a style declares a (non-transparent) background colour or image. */
export function hasBackground(style: Map<string, string>): boolean {
  const bg = style.get("background-color") ?? style.get("background");
  if (!bg) return false;
  return !/^(?:transparent|none|initial|inherit|unset|rgba\([^)]*,\s*0\))$/.test(bg);
}

/** True when a style declares a visible border of at least 1px. */
export function hasVisibleBorder(style: Map<string, string>): boolean {
  const border = style.get("border") ?? style.get("border-width") ?? "";
  if (!border || /\bnone\b|^0(?:px)?\b/.test(border)) return false;
  return /\d/.test(border) || /\b(?:solid|dashed|dotted|double)\b/.test(border);
}
