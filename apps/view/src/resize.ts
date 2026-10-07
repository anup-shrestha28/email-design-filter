/**
 * Shrinks a proxied email image to the size it is shown at, before it is served (2026-10-07).
 *
 * Senders put retina originals in their emails: 2,400 px wide PNGs of 2–5 MB for a picture shown
 * 600 px wide, animated GIFs of 4 MB. A gallery page of 30 cards fetched 361 images and 72.5 MB
 * (measured on a friend's first page), so on a home connection the pictures took over a minute and
 * many showed as broken. Shown at most this wide, as WebP, the same page is 7.2 MB, with 6 CPU-s
 * spent on the resizing (sharp, one thread): what a card shows needs at most app.ts CARD_MAX_WIDTH
 * (a card is ≤ ~560 device px wide at 2×), the opened design FULL_MAX_WIDTH (2× its 600–800 px).
 * Only api/img.js imports this module (img.ts), so the view function never loads sharp.
 *
 * Never larger, never worse than the original: an image already narrow enough and small is served
 * as it is; a result that comes out bigger is dropped for the original; anything sharp can't read
 * (or an animation too big to re-encode cheaply) is served as it is.
 */
import sharp from "sharp";

/** Below this many bytes an image no wider than the cap is served as it is (re-encoding saves little). */
export const RECODE_MIN_BYTES = 100 * 1024;
/**
 * An animation re-encodes every frame: past this many pixels in all (frames × width × height) it is
 * served as it is, so one huge animation can't take seconds of CPU. The 3.9 MB, 4-frame,
 * 1,433 × 7,680 hero measured above is 44 M.
 */
export const MAX_ANIMATED_PIXELS = 80_000_000;
/** WebP quality: text in banners stays crisp at card size. */
const WEBP_QUALITY = 82;

sharp.concurrency(1);
sharp.cache(false);

export interface ShrinkInput {
  body: Buffer;
  /** Sniffed format and first-frame size (from @edf/fetch). */
  format: "png" | "jpeg" | "gif" | "webp";
  width: number;
  height: number;
}

export interface ShrinkResult {
  body: Buffer;
  contentType: string;
}

export type ShrinkImage = (input: ShrinkInput, maxWidth: number) => Promise<ShrinkResult | null>;

/** The smaller WebP of `input` at most `maxWidth` wide, or null to serve the original. */
export const shrinkImage: ShrinkImage = async (input, maxWidth) => {
  const wide = input.width > maxWidth;
  if (!wide && input.body.length < RECODE_MIN_BYTES) return null;
  try {
    const animatable = input.format === "gif" || input.format === "webp";
    let pages = 1;
    if (animatable) {
      pages = (await sharp(input.body, { animated: true }).metadata()).pages ?? 1;
      if (pages > 1 && pages * input.width * input.height > MAX_ANIMATED_PIXELS) return null;
    }
    const animated = pages > 1;
    let p = sharp(input.body, { animated, limitInputPixels: MAX_ANIMATED_PIXELS });
    // A JPEG's EXIF orientation is dropped with its metadata: apply it to the pixels first.
    if (input.format === "jpeg") p = p.rotate();
    const out = await p
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY, effort: animated ? 1 : 2 })
      .toBuffer();
    return out.length < input.body.length ? { body: out, contentType: "image/webp" } : null;
  } catch {
    return null;
  }
};
