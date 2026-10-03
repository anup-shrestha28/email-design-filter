/**
 * Image type and dimensions from magic bytes and headers only (FREE-TIER.md §9.2: the server
 * never decodes an image). PNG (IHDR), JPEG (bounded SOFn scan), GIF (logical screen, enlarged by
 * the first frame as browsers do), WebP (VP8 / VP8L / VP8X). Everything else — SVG, AVIF, HEIF,
 * BMP, ICO, TIFF, JPEG XL — returns null. All reads are bounds-checked.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface SniffResult {
  format: ImageFormat;
  width: number;
  height: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_JPEG_SEGMENTS = 2048;
const MAX_GIF_BLOCKS = 4096;
const MAX_DIMENSION = 1 << 30;

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, at: number, len: number): string {
  if (b.length < at + len) return "";
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[at + i] as number);
  return s;
}

const u16be = (b: Uint8Array, i: number): number => ((b[i] as number) << 8) | (b[i + 1] as number);
const u16le = (b: Uint8Array, i: number): number => (b[i] as number) | ((b[i + 1] as number) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] as number) << 16);
const u32be = (b: Uint8Array, i: number): number =>
  (((b[i] as number) << 24) >>> 0) +
  (((b[i + 1] as number) << 16) | ((b[i + 2] as number) << 8) | (b[i + 3] as number));

function ok(format: ImageFormat, width: number, height: number): SniffResult | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { format, width, height };
}

function png(b: Uint8Array): SniffResult | null {
  // signature, then the first chunk must be IHDR with length 13
  if (b.length < 33 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return null;
  return ok("png", u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): SniffResult | null {
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  const flags = b[10] as number;
  let p = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  // Walk extension blocks to the first image descriptor (bounded).
  for (let blocks = 0; blocks < MAX_GIF_BLOCKS && p < b.length; blocks++) {
    const intro = b[p] as number;
    if (intro === 0x2c) {
      if (p + 9 >= b.length) return null;
      const left = u16le(b, p + 1);
      const top = u16le(b, p + 3);
      const fw = u16le(b, p + 5);
      const fh = u16le(b, p + 7);
      width = Math.max(width, left + fw);
      height = Math.max(height, top + fh);
      return ok("gif", width, height);
    }
    if (intro !== 0x21 || p + 2 >= b.length) return null; // trailer before any frame, or junk
    p += 2; // introducer + label
    for (;;) {
      if (p >= b.length) return null;
      const size = b[p] as number;
      p += 1 + size;
      if (size === 0) break;
    }
  }
  return null;
}

function jpeg(b: Uint8Array): SniffResult | null {
  let p = 2;
  for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
    // Skip to the next marker (0xFF, possibly padded with more 0xFF fill bytes).
    if (p >= b.length || b[p] !== 0xff) return null;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) return null;
    const marker = b[p] as number;
    p++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    if (p + 2 > b.length) return null;
    const len = u16be(b, p);
    if (len < 2 || p + len > b.length) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return null;
      const height = u16be(b, p + 3);
      const width = u16be(b, p + 5);
      return ok("jpeg", width, height);
    }
    p += len;
  }
  return null;
}

function webp(b: Uint8Array): SniffResult | null {
  if (b.length < 25 || ascii(b, 8, 4) !== "WEBP") return null;
  const riffSize = u16le(b, 4) + u16le(b, 6) * 65536;
  if (riffSize < 17) return null; // "WEBP" + chunk header + the shortest (VP8L) bitstream header
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // frame tag (3 bytes) then start code 9D 01 2A, then 14-bit width/height
    if (b.length < 30 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return ok("webp", u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits =
      (b[21] as number) |
      ((b[22] as number) << 8) |
      ((b[23] as number) << 16) |
      (((b[24] as number) << 24) >>> 0);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return ok("webp", width, height);
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    return ok("webp", u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

/** Magic bytes + header dimensions only; never decodes pixels. null if not an allowed format. */
export function sniffImage(bytes: Uint8Array): SniffResult | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  try {
    if (startsWith(bytes, PNG_SIG)) return png(bytes);
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpeg(bytes);
    const head = ascii(bytes, 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return gif(bytes);
    if (ascii(bytes, 0, 4) === "RIFF") return webp(bytes);
    return null;
  } catch {
    return null;
  }
}
