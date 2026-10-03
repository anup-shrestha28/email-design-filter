/**
 * Image heuristics shared by static extraction and the renderer: tracking pixels, spacers,
 * informative images and meaningful alt text (DESIGN-SCORE §2.1, §5.1 A2).
 */
import { FILENAME_ALT, GENERIC_ALT } from "./patterns";
import { collapseWhitespace, words } from "./text";

/** Path patterns typical of open-tracking pixels (hosts shared with content need size too). */
const TRACKER_PATH =
  /(?:^|[/_.-])(?:open|opens|pixel|track(?:ing)?|beacon|wf\/open|e\/o|o\.gif|t\.gif|spacer\.gif|blank\.gif|1x1)(?:[/_.?-]|$)/i;

/** Hosts that only ever serve tracking pixels (curated; shared hosts use path + size). */
const TRACKER_HOST =
  /(?:^|\.)(?:mailtrack\.io|mailtrack\.email|pixel\.mailchimp\.com|trk\.klaviyomail\.com|opens\.klaviyo\.com|open\.convertkit-mail\.com|open\.convertkit-mail2\.com|pixel\.watch|getnotify\.com|bananatag\.com|yesware\.com|mixmax\.com|sidekickopen\d*\.com)$/i;

export interface PixelInput {
  src: string | null;
  width: number | null;
  height: number | null;
  hidden: boolean;
}

/**
 * Tracking pixel (DESIGN-SCORE §2.1 "Content images"): `w×h ≤ 25 px²`, a dimension ≤ 1px,
 * hidden, or a tracker-exclusive host / pixel path with a tiny or unknown size.
 */
export function isTrackingPixel(img: PixelInput): boolean {
  if (img.hidden) return true;
  const { width: w, height: h } = img;
  if (w !== null && h !== null && w * h <= 25) return true;
  if ((w !== null && w <= 1) || (h !== null && h <= 1)) return true;
  const src = img.src ?? "";
  const hostMatch = /^(?:https?:)?\/\/([^/?#]+)(\/[^?#]*)?/i.exec(src);
  if (hostMatch) {
    const host = hostMatch[1]!.toLowerCase();
    const path = hostMatch[2] ?? "/";
    if (TRACKER_HOST.test(host)) return true;
    const small = (w === null || w <= 3) && (h === null || h <= 3);
    if (small && TRACKER_PATH.test(path)) return true;
  }
  return false;
}

/** Spacer or divider: aspect ratio beyond 20:1 (DESIGN-SCORE §2.1 "Informative image"). */
export function isSpacerOrDivider(w: number | null, h: number | null): boolean {
  if (w === null || h === null || w <= 0 || h <= 0) return false;
  return w / h > 20 || h / w > 20;
}

/**
 * Informative image: a content `<img>` that is linked, or ≥ 100×50px, and isn't a spacer or
 * divider. With unknown size (static), an image with explicit `alt=""` that isn't linked is
 * given the benefit of the doubt (decorative); otherwise it counts as informative.
 */
export function isInformativeImage(input: {
  linked: boolean;
  width: number | null;
  height: number | null;
  alt: string | null;
}): boolean {
  const { linked, width: w, height: h } = input;
  if (isSpacerOrDivider(w, h)) return false;
  if (linked) return true;
  if (w !== null && h !== null) return w >= 100 && h >= 50;
  return input.alt !== "";
}

/** Normalized alt text for comparisons. */
export function normalizeAlt(alt: string): string {
  return collapseWhitespace(alt).toLowerCase();
}

/**
 * Meaningful alt (A2(b)): non-empty, not a filename/URL/generic word, ≤ 150 chars,
 * type/token ratio ≥ 0.5, and not repeated across ≥ 3 images (`repeats` = how many
 * informative images share this normalized alt).
 */
export function isMeaningfulAlt(alt: string | null, repeats: number): boolean {
  if (alt === null) return false;
  const a = collapseWhitespace(alt);
  if (a.length === 0 || a.length > 150) return false;
  if (FILENAME_ALT.test(a)) return false;
  const norm = a.toLowerCase();
  if (GENERIC_ALT.has(norm)) return false;
  if (!/[\p{L}\p{N}]/u.test(a)) return false;
  const ws = words(norm).map((w) => w.toLowerCase());
  if (ws.length >= 3) {
    const unique = new Set(ws).size;
    if (unique / ws.length < 0.5) return false;
  }
  return repeats < 3;
}

/** Counts of informative images and those with meaningful alt (A2(b)). */
export function altStats(images: ReadonlyArray<{ alt: string | null; informative: boolean }>): {
  informative: number;
  meaningful: number;
} {
  const repeats = new Map<string, number>();
  for (const img of images) {
    if (!img.informative || img.alt === null) continue;
    const key = normalizeAlt(img.alt);
    if (key) repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  let informative = 0;
  let meaningful = 0;
  for (const img of images) {
    if (!img.informative) continue;
    informative++;
    const rep = img.alt === null ? 0 : (repeats.get(normalizeAlt(img.alt)) ?? 0);
    if (isMeaningfulAlt(img.alt, rep)) meaningful++;
  }
  return { informative, meaningful };
}
