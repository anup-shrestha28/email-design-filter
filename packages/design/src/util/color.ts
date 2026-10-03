/**
 * Colour maths for the design checks: CSS colour parsing, WCAG 2.2 relative luminance and
 * contrast (DESIGN-SCORE §2.1 "Large text", "Contrast ratios are never rounded"), alpha
 * compositing, CIE Lab (D65) and CIEDE2000.
 *
 * Pixel-level loops (paint test, X–Y cut) use `deltaE76` on precomputed Lab values for speed;
 * colour-level comparisons (CTA salience, palette merging) use `deltaE2000`.
 */
import { converter, parse } from "culori";

/** sRGB colour, channels 0..255 (may be fractional after compositing), alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

const toRgb = converter("rgb");
const RGB_FN = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;
const HEX = /^#([0-9a-f]{3,8})$/i;

/**
 * Parse a CSS colour as serialised by Chromium computed styles (`rgb()`, `rgba()`, and
 * non-legacy spaces such as `oklch()`/`color(display-p3 …)`), or a hex/named colour from
 * static HTML. Returns null when unparseable. Out-of-gamut colours are clamped to sRGB.
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim();
  if (s === "") return null;
  if (s === "transparent") return { ...TRANSPARENT };
  const m = RGB_FN.exec(s);
  if (m) {
    const alphaRaw = m[4];
    let a = 1;
    if (alphaRaw !== undefined)
      a = alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
    return clampRgba({ r: parseFloat(m[1]!), g: parseFloat(m[2]!), b: parseFloat(m[3]!), a });
  }
  const h = HEX.exec(s);
  if (h) return parseHex(h[1]!);
  if (s.length > 200) return null;
  try {
    const parsed = parse(s);
    if (!parsed) return null;
    const rgb = toRgb(parsed);
    if (!rgb) return null;
    return clampRgba({ r: rgb.r * 255, g: rgb.g * 255, b: rgb.b * 255, a: rgb.alpha ?? 1 });
  } catch {
    return null;
  }
}

function parseHex(hex: string): Rgba | null {
  const expand =
    hex.length <= 4
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (expand.length !== 6 && expand.length !== 8) return null;
  const n = (i: number) => parseInt(expand.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: expand.length === 8 ? n(6) / 255 : 1 };
}

function clampRgba(c: Rgba): Rgba {
  const ch = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0);
  return {
    r: ch(c.r),
    g: ch(c.g),
    b: ch(c.b),
    a: Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1,
  };
}

/** Source-over compositing of `top` onto `bottom` (sRGB space, as browsers composite). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a <= 0) return { ...TRANSPARENT };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** Composite onto an opaque backdrop (default white canvas, DESIGN-SCORE §2.1). */
export function flatten(c: Rgba, backdrop: Rgba = WHITE): Rgba {
  const out = composite(c, { ...backdrop, a: 1 });
  return { r: out.r, g: out.g, b: out.b, a: 1 };
}

/** WCAG 2.2 channel linearisation (0.04045 threshold). `v` is 0..255. */
export function linearize(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  return 0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b);
}

/** Contrast ratio from two luminances (never rounded). */
export function contrastFromLum(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG contrast ratio of `fg` (possibly translucent) over an opaque `bg`. The foreground is
 * composited onto the background first, exactly as it is painted.
 */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const back = bg.a < 1 ? flatten(bg) : bg;
  const front = fg.a < 1 ? flatten(fg, back) : fg;
  return contrastFromLum(luminance(front), luminance(back));
}

/** WCAG large text: ≥ 24px, or ≥ 18.66px at weight ≥ 700 (DESIGN-SCORE §2.1). */
export function isLargeText(px: number, weight: number): boolean {
  return px >= 24 || (px >= 18.66 && weight >= 700);
}

// ───────────────────────── CIE Lab (D65) ─────────────────────────

export interface Lab {
  L: number;
  a: number;
  b: number;
}

const LIN_LUT: Float64Array = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = linearize(i);
  return t;
})();

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

/** sRGB (0..255, opaque) → CIE Lab D65. Integer channels use a lookup table. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = Number.isInteger(r) && r >= 0 && r < 256 ? LIN_LUT[r]! : linearize(r);
  const lg = Number.isInteger(g) && g >= 0 && g < 256 ? LIN_LUT[g]! : linearize(g);
  const lb = Number.isInteger(b) && b >= 0 && b < 256 ? LIN_LUT[b]! : linearize(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function colorToLab(c: Rgba): Lab {
  const f = c.a < 1 ? flatten(c) : c;
  return rgbToLab(f.r, f.g, f.b);
}

/** Lab → sRGB (clamped), used by the dark-mode simulation (M6). */
export function labToRgb(lab: Lab): Rgba {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };
  return { r: enc(lr), g: enc(lg), b: enc(lb), a: 1 };
}

export function deltaE76(p: Lab, q: Lab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005 reference implementation). */
export function deltaE2000(p: Lab, q: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(p.a, p.b);
  const C2 = Math.hypot(q.a, q.b);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1 = (1 + G) * p.a;
  const a2 = (1 + G) * q.a;
  const C1p = Math.hypot(a1, p.b);
  const C2p = Math.hypot(a2, q.b);
  const h = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const d = Math.atan2(b, a) / rad;
    return d < 0 ? d + 360 : d;
  };
  const h1 = h(p.b, a1);
  const h2 = h(q.b, a2);
  const dL = q.L - p.L;
  const dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lm = (p.L + q.L) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1 - h2) > 180) hm = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
    else hm = (h1 + h2) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

export function colorDeltaE2000(x: Rgba, y: Rgba): number {
  return deltaE2000(colorToLab(x), colorToLab(y));
}

/** Hue angle (degrees) and chroma in Lab, for accent-hue counting (L7). */
export function hueChroma(c: Rgba): { hue: number; chroma: number } {
  const lab = colorToLab(c);
  const chroma = Math.hypot(lab.a, lab.b);
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { hue, chroma };
}

/** `#rrggbb` or `#rrggbbaa` (alpha only when < 1), channels rounded. */
export function toHex(c: Rgba): string {
  const h = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return c.a >= 0.999 ? base : `${base}${h(c.a * 255)}`;
}

/** Parse the compact `#rrggbb[aa]` form produced by `toHex`. */
export function fromHex(s: string): Rgba | null {
  const h = HEX.exec(s);
  return h ? parseHex(h[1]!) : null;
}

/**
 * A plain colour name for explanations ("light grey", "white", "pale blue"), from CIELAB
 * lightness and LCh hue. Deliberately coarse: it only has to let a reader recognise the colour
 * on screen. Null for an unparsable value.
 */
export function describeColour(hex: string): string | null {
  const c = fromHex(hex);
  if (!c) return null;
  const lab = colorToLab(flatten(c));
  const chroma = Math.hypot(lab.a, lab.b);
  if (chroma < 18) {
    if (lab.L >= 96) return "white";
    if (lab.L >= 80) return "very light grey";
    if (lab.L >= 62) return "light grey";
    if (lab.L >= 40) return "grey";
    if (lab.L >= 10) return "dark grey";
    return "black";
  }
  const h = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
  const hue =
    h < 20 || h >= 340
      ? "pink"
      : h < 50
        ? "red"
        : h < 75
          ? "orange"
          : h < 105
            ? "yellow"
            : h < 170
              ? "green"
              : h < 230
                ? "teal"
                : h < 308
                  ? "blue"
                  : "purple";
  if (lab.L >= 80) return `pale ${hue}`;
  if (lab.L >= 62) return `light ${hue}`;
  if (lab.L < 30) return `dark ${hue}`;
  return hue;
}
