/**
 * Pixel metrics with sharp (DESIGN-SCORE §2.1 paint test and pixel-method contrast; §5.6 L2, L3,
 * L5; §5.2 M6 transparent images; §6 AI tiles). sharp runs with `limitInputPixels: 25e6` and
 * `failOn: "error"`; AVIF/HEIF/SVG inputs are never decoded (DESIGN.md §6.2).
 */
import sharp from "sharp";
import {
  type Rgba,
  colorDeltaE2000,
  contrastFromLum,
  deltaE76,
  flatten,
  linearize,
  luminance,
  rgbToLab,
  type Lab,
} from "@edf/design/render-kit";
import type { Rect } from "./snapshot";

const SHARP_INPUT = { limitInputPixels: 25_000_000, failOn: "error" as const };

/** Raw RGB pixels (3 channels, row-major). */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function decodeScreenshot(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png, SHARP_INPUT)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const LIN = new Float64Array(256).map((_, i) => linearize(i));

function lumAt(img: RawImage, i: number): number {
  const d = img.data;
  return 0.2126 * LIN[d[i]!]! + 0.7152 * LIN[d[i + 1]!]! + 0.0722 * LIN[d[i + 2]!]!;
}

/** Clamp a CSS-px rect to the image, in integer pixels; null when empty. */
export function clampRect(
  img: RawImage,
  r: Rect,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(img.height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * Paint-test mask: 1 where pass D and pass D0 differ by ΔE76 > 5 (D0 = text made transparent).
 * Identical pixels short-circuit, so only text pixels pay for the Lab conversion.
 */
export function paintMask(d: RawImage, d0: RawImage): Uint8Array {
  const w = Math.min(d.width, d0.width);
  const h = Math.min(d.height, d0.height);
  const mask = new Uint8Array(d.width * d.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * d.width + x) * 3;
      const j = (y * d0.width + x) * 3;
      const a = d.data;
      const b = d0.data;
      if (a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2]) continue;
      const la = rgbToLab(a[i]!, a[i + 1]!, a[i + 2]!);
      const lb = rgbToLab(b[j]!, b[j + 1]!, b[j + 2]!);
      if (deltaE76(la, lb) > 5) mask[y * d.width + x] = 1;
    }
  }
  return mask;
}

/** Share of pixels in `r` that changed between D and D0, or null when `r` is off-screen. */
export function changedFraction(mask: Uint8Array, img: RawImage, r: Rect): number | null {
  const c = clampRect(img, r);
  if (!c) return null;
  let changed = 0;
  let total = 0;
  for (let y = c.y0; y < c.y1; y++) {
    const row = y * img.width;
    for (let x = c.x0; x < c.x1; x++) {
      total++;
      changed += mask[row + x]!;
    }
  }
  return total > 0 ? changed / total : null;
}

export interface PixelContrast {
  p10: number;
  p90: number;
  /** Median background pixel (for M6 and the group key). */
  bg: Rgba;
}

/**
 * Pixel-method contrast (DESIGN-SCORE §2.1): per-pixel WCAG contrast between the run colour
 * (composited over each pixel) and the D0 pixels in the run's box. At most ~600 samples.
 */
export function pixelContrast(d0: RawImage, r: Rect, fg: Rgba): PixelContrast | null {
  const c = clampRect(d0, r);
  if (!c) return null;
  const area = (c.x1 - c.x0) * (c.y1 - c.y0);
  const stride = Math.max(1, Math.floor(Math.sqrt(area / 600)));
  const ratios: number[] = [];
  const lums: Array<[number, number]> = [];
  for (let y = c.y0; y < c.y1; y += stride) {
    for (let x = c.x0; x < c.x1; x += stride) {
      const i = (y * d0.width + x) * 3;
      const px: Rgba = { r: d0.data[i]!, g: d0.data[i + 1]!, b: d0.data[i + 2]!, a: 1 };
      const bgLum = lumAt(d0, i);
      const front = fg.a < 1 ? flatten(fg, px) : fg;
      ratios.push(contrastFromLum(luminance(front), bgLum));
      lums.push([bgLum, i]);
    }
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  lums.sort((a, b) => a[0] - b[0]);
  const q = (arr: number[], p: number) =>
    arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))]!;
  const mid = lums[Math.floor(lums.length / 2)]![1];
  return {
    p10: q(ratios, 0.1),
    p90: q(ratios, 0.9),
    bg: { r: d0.data[mid]!, g: d0.data[mid + 1]!, b: d0.data[mid + 2]!, a: 1 },
  };
}

function inAny(x: number, y: number, rects: readonly Rect[]): boolean {
  for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  return false;
}

/** L2: share of 8×8 blocks (outside images) whose relative-luminance SD < 0.02. */
export function whitespaceShare(
  img: RawImage,
  crop: Rect,
  exclude: readonly Rect[],
): number | null {
  const c = clampRect(img, crop);
  if (!c) return null;
  let flat = 0;
  let blocks = 0;
  for (let by = c.y0; by + 8 <= c.y1; by += 8) {
    for (let bx = c.x0; bx + 8 <= c.x1; bx += 8) {
      if (inAny(bx + 4, by + 4, exclude)) continue;
      let s = 0;
      let s2 = 0;
      for (let y = by; y < by + 8; y++) {
        for (let x = bx; x < bx + 8; x++) {
          const l = lumAt(img, (y * img.width + x) * 3);
          s += l;
          s2 += l * l;
        }
      }
      const mean = s / 64;
      const sd = Math.sqrt(Math.max(0, s2 / 64 - mean * mean));
      blocks++;
      if (sd < 0.02) flat++;
    }
  }
  return blocks > 0 ? flat / blocks : null;
}

/** L3 component: share of pixels whose luminance gradient (|dx| + |dy|) exceeds 0.1. */
export function edgeDensity(img: RawImage, crop: Rect): number | null {
  const c = clampRect(img, crop);
  if (!c || c.x1 - c.x0 < 3 || c.y1 - c.y0 < 3) return null;
  let edges = 0;
  let total = 0;
  for (let y = c.y0; y < c.y1 - 1; y++) {
    for (let x = c.x0; x < c.x1 - 1; x++) {
      const i = (y * img.width + x) * 3;
      const l = lumAt(img, i);
      const dx = Math.abs(lumAt(img, i + 3) - l);
      const dy = Math.abs(lumAt(img, i + img.width * 3) - l);
      total++;
      if (dx + dy > 0.1) edges++;
    }
  }
  return total > 0 ? edges / total : null;
}

/** L3 component: PNG bytes per pixel of the crop (sharp `compressionLevel: 9, palette: false`). */
export async function pngBytesPerPixel(img: RawImage, crop: Rect): Promise<number | null> {
  const c = clampRect(img, crop);
  if (!c) return null;
  const w = c.x1 - c.x0;
  const h = c.y1 - c.y0;
  const png = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
    ...SHARP_INPUT,
  })
    .extract({ left: c.x0, top: c.y0, width: w, height: h })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  return png.length / (w * h);
}

/** Most common colour of a crop (5-bit quantised). */
export function dominantBackground(img: RawImage, crop: Rect): Rgba {
  const c = clampRect(img, crop);
  if (!c) return { r: 255, g: 255, b: 255, a: 1 };
  const counts = new Map<number, number>();
  const step = Math.max(1, Math.floor(Math.sqrt(((c.x1 - c.x0) * (c.y1 - c.y0)) / 40_000)));
  for (let y = c.y0; y < c.y1; y += step) {
    for (let x = c.x0; x < c.x1; x += step) {
      const i = (y * img.width + x) * 3;
      const key =
        ((img.data[i]! >> 3) << 10) | ((img.data[i + 1]! >> 3) << 5) | (img.data[i + 2]! >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  return {
    r: ((best >> 10) & 31) * 8 + 4,
    g: ((best >> 5) & 31) * 8 + 4,
    b: (best & 31) * 8 + 4,
    a: 1,
  };
}

/**
 * L3 component: X–Y cut leaf count. Foreground = ΔE76 > 8 from the container background;
 * alternate horizontal/vertical cuts at gaps ≥ 12px; minimum leaf 32×32; maximum depth 16.
 */
export function xyCutLeaves(img: RawImage, crop: Rect, background: Rgba): number | null {
  const c = clampRect(img, crop);
  if (!c) return null;
  const W = c.x1 - c.x0;
  const H = c.y1 - c.y0;
  const bgLab: Lab = rgbToLab(background.r, background.g, background.b);
  const fg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((y + c.y0) * img.width + (x + c.x0)) * 3;
      const d = img.data;
      if (
        Math.abs(d[i]! - background.r) +
          Math.abs(d[i + 1]! - background.g) +
          Math.abs(d[i + 2]! - background.b) <
        6
      )
        continue;
      if (deltaE76(rgbToLab(d[i]!, d[i + 1]!, d[i + 2]!), bgLab) > 8) fg[y * W + x] = 1;
    }
  }
  // Prefix sums per row (over x) and per column (over y) for O(w + h) profiles.
  const rowPre = new Uint32Array(H * (W + 1));
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = 0; x < W; x++) {
      acc += fg[y * W + x]!;
      rowPre[y * (W + 1) + x + 1] = acc;
    }
  }
  const colPre = new Uint32Array(W * (H + 1));
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = 0; y < H; y++) {
      acc += fg[y * W + x]!;
      colPre[x * (H + 1) + y + 1] = acc;
    }
  }
  const rowCount = (y: number, x0: number, x1: number) =>
    rowPre[y * (W + 1) + x1]! - rowPre[y * (W + 1) + x0]!;
  const colCount = (x: number, y0: number, y1: number) =>
    colPre[x * (H + 1) + y1]! - colPre[x * (H + 1) + y0]!;
  let leaves = 0;
  let budget = 20_000;
  const split = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    depth: number,
    horizontal: boolean,
  ): void => {
    if (budget-- <= 0) return;
    // Trim empty margins.
    while (y0 < y1 && rowCount(y0, x0, x1) === 0) y0++;
    while (y1 > y0 && rowCount(y1 - 1, x0, x1) === 0) y1--;
    while (x0 < x1 && colCount(x0, y0, y1) === 0) x0++;
    while (x1 > x0 && colCount(x1 - 1, y0, y1) === 0) x1--;
    if (x1 <= x0 || y1 <= y0) return;
    const leafSize = x1 - x0 < 64 && y1 - y0 < 64;
    if (depth >= 16 || leafSize) {
      leaves++;
      return;
    }
    for (const dir of horizontal ? [true, false] : [false, true]) {
      const segs: Array<[number, number]> = [];
      let start = dir ? y0 : x0;
      let gap = 0;
      const end = dir ? y1 : x1;
      for (let p = start; p < end; p++) {
        const empty = dir ? rowCount(p, x0, x1) === 0 : colCount(p, y0, y1) === 0;
        if (empty) gap++;
        else {
          if (gap >= 12 && p - gap > start) {
            segs.push([start, p - gap]);
            start = p;
          } else if (gap >= 12) {
            start = p;
          }
          gap = 0;
        }
      }
      segs.push([start, end - gap]);
      // Minimum leaf 32px in the cut dimension: slivers (e.g. one text line) merge into the
      // following segment (or the previous one at the end) instead of becoming leaves.
      const valid = mergeSlivers(
        segs.filter(([a, b]) => b > a),
        32,
      );
      if (valid.length > 1) {
        for (const [a, b] of valid) {
          if (dir) split(x0, a, x1, b, depth + 1, !dir);
          else split(a, y0, b, y1, depth + 1, !dir);
        }
        return;
      }
    }
    leaves++;
  };
  split(0, 0, W, H, 0, true);
  return leaves;
}

/** Merge segments shorter than `min` into their neighbour (next, or previous for the last). */
export function mergeSlivers(segs: Array<[number, number]>, min: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let pending: [number, number] | null = null;
  for (const seg of segs) {
    const cur: [number, number] = pending ? [pending[0], seg[1]] : [seg[0], seg[1]];
    if (cur[1] - cur[0] < min) {
      pending = cur;
      continue;
    }
    out.push(cur);
    pending = null;
  }
  if (pending) {
    const last = out.pop();
    out.push(last ? [last[0], pending[1]] : pending);
  }
  return out;
}

/** L5: non-image colours covering ≥ 1% of the area, merged at ΔE2000 < 5. */
export function dominantColourCount(
  img: RawImage,
  crop: Rect,
  exclude: readonly Rect[],
): number | null {
  const c = clampRect(img, crop);
  if (!c) return null;
  const counts = new Map<number, number>();
  let total = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((c.x1 - c.x0) * (c.y1 - c.y0)) / 60_000)));
  for (let y = c.y0; y < c.y1; y += step) {
    for (let x = c.x0; x < c.x1; x += step) {
      if (inAny(x, y, exclude)) continue;
      const i = (y * img.width + x) * 3;
      const key =
        ((img.data[i]! >> 3) << 10) | ((img.data[i + 1]! >> 3) << 5) | (img.data[i + 2]! >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return null;
  const bins = [...counts.entries()]
    .filter(([, n]) => n >= 0.002 * total)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([k, n]) => ({
      color: { r: ((k >> 10) & 31) * 8 + 4, g: ((k >> 5) & 31) * 8 + 4, b: (k & 31) * 8 + 4, a: 1 },
      n,
    }));
  const clusters: Array<{ color: Rgba; n: number }> = [];
  for (const b of bins) {
    const hit = clusters.find((cl) => colorDeltaE2000(cl.color, b.color) < 5);
    if (hit) hit.n += b.n;
    else clusters.push({ ...b });
  }
  return clusters.filter((cl) => cl.n >= 0.01 * total).length;
}

/** Hasler & Süsstrunk colourfulness (signed opponent channels, 0–255 scale). Information only. */
export function colourfulness(img: RawImage, crop: Rect): number | null {
  const c = clampRect(img, crop);
  if (!c) return null;
  let n = 0;
  let mrg = 0;
  let myb = 0;
  let srg = 0;
  let syb = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((c.x1 - c.x0) * (c.y1 - c.y0)) / 60_000)));
  for (let y = c.y0; y < c.y1; y += step) {
    for (let x = c.x0; x < c.x1; x += step) {
      const i = (y * img.width + x) * 3;
      const R = img.data[i]!;
      const G = img.data[i + 1]!;
      const B = img.data[i + 2]!;
      const rg = R - G;
      const yb = 0.5 * (R + G) - B;
      n++;
      mrg += rg;
      myb += yb;
      srg += rg * rg;
      syb += yb * yb;
    }
  }
  if (n === 0) return null;
  mrg /= n;
  myb /= n;
  const vrg = Math.max(0, srg / n - mrg * mrg);
  const vyb = Math.max(0, syb / n - myb * myb);
  return Math.sqrt(vrg + vyb) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);
}

const DATA_URI = /^data:image\/(png|gif|webp);base64,([a-z0-9+/=\s]+)$/i;

/**
 * M6 transparent images: share of opaque pixels (α ≥ 128) keeping ≥ 3:1 against the simulated
 * background under partial and full inversion. Null when the image isn't transparent.
 */
export async function darkModeImage(
  dataUri: string,
  bg: Rgba,
): Promise<{ partial: number; full: number } | null> {
  const m = DATA_URI.exec(dataUri);
  if (!m) return null;
  const buf = Buffer.from(m[2]!, "base64");
  if (buf.length > 5_000_000) return null;
  const { data, info } = await sharp(buf, { ...SHARP_INPUT, animated: false })
    .resize(64, 64, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  let transparent = 0;
  for (let i = 0; i < px; i++) if (data[i * 4 + 3]! < 250) transparent++;
  if (transparent < 0.05 * px) return null;
  const bgLab = rgbToLab(Math.round(bg.r), Math.round(bg.g), Math.round(bg.b));
  const simBg = (model: "partial" | "full"): number => {
    const L = model === "full" || bgLab.L > 60 ? 100 - bgLab.L : bgLab.L;
    // Luminance of the simulated background (Lab L* → relative luminance).
    const fy = (L + 16) / 116;
    return fy ** 3 > 216 / 24389 ? fy ** 3 : (116 * fy - 16) / (24389 / 27);
  };
  const result = { partial: 0, full: 0 };
  for (const model of ["partial", "full"] as const) {
    const lb = simBg(model);
    let opaque = 0;
    let ok = 0;
    for (let i = 0; i < px; i++) {
      if (data[i * 4 + 3]! < 128) continue;
      opaque++;
      const l =
        0.2126 * LIN[data[i * 4]!]! +
        0.7152 * LIN[data[i * 4 + 1]!]! +
        0.0722 * LIN[data[i * 4 + 2]!]!;
      if (contrastFromLum(l, lb) >= 3) ok++;
    }
    result[model] = opaque > 0 ? ok / opaque : 1;
  }
  return result;
}

/** Natural size of an inlined image from its header (no full decode). */
export async function imageSize(
  dataUri: string,
): Promise<{ width: number; height: number } | null> {
  const m =
    DATA_URI.exec(dataUri) ?? /^data:image\/(jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(dataUri);
  if (!m) return null;
  try {
    const meta = await sharp(Buffer.from(m[2]!, "base64"), SHARP_INPUT).metadata();
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}

/**
 * AI tiles (FREE-TIER.md §6.2): up to three 800×1000 desktop crops (top, middle, bottom)
 * downscaled to 600×750, and the mobile first viewport (375×667), as WebP.
 */
export async function makeTiles(
  desktopPng: Buffer,
  desktop: RawImage,
  mobilePng: Buffer | null,
): Promise<{ desktop: Uint8Array[]; mobile: Uint8Array | null }> {
  const H = desktop.height;
  const tileH = Math.min(1000, H);
  const tops =
    H <= 1000 ? [0] : H <= 2000 ? [0, H - tileH] : [0, Math.round((H - tileH) / 2), H - tileH];
  const out: Uint8Array[] = [];
  for (const top of tops) {
    const buf = await sharp(desktopPng, SHARP_INPUT)
      .extract({ left: 0, top, width: Math.min(800, desktop.width), height: tileH })
      .resize(600, 750, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
      .webp({ quality: 80 })
      .toBuffer();
    out.push(new Uint8Array(buf));
  }
  const mobile = mobilePng
    ? new Uint8Array(
        await sharp(mobilePng, SHARP_INPUT)
          .resize(375, 667, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
          .webp({ quality: 80 })
          .toBuffer(),
      )
    : null;
  return { desktop: out, mobile };
}
