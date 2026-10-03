/**
 * Image fetch for the proxy and render pre-fetch (FREE-TIER.md §8.4, §9.2; DESIGN.md §6.3).
 */
import { safeFetch, type SafeFetchError } from "./safe-fetch";
import { sniffImage, type ImageFormat } from "./sniff";

export type ImageFetchResult =
  | {
      ok: true;
      format: ImageFormat;
      width: number;
      height: number;
      contentType: string;
      body: Buffer;
    }
  | {
      ok: false;
      reason: SafeFetchError | "not_image" | "too_many_pixels";
      status?: number;
      /**
       * ADDED (render pre-fetch): a `not_image` body that is an SVG (served as image/svg+xml, or
       * starting with `<svg`). Gmail doesn't show SVG either, so the analysis reports it as such
       * rather than as a broken image.
       */
      svg?: boolean;
    };

/** Reject images above 25 megapixels (header dimensions). */
export const MAX_IMAGE_PIXELS = 25_000_000;

/** The Content-Type we serve is derived from the sniffed format, never from the upstream header. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Generic or missing Content-Types that real email images arrive with besides `image/*`: files on
 * S3 without a type (`binary/octet-stream`, S3's default), `application/octet-stream`, no header
 * at all, and odd CDN defaults (e.g. `audio/unknown` for a WebP, seen on a job site's banner).
 * Browsers display these (they sniff image bytes), so refusing them left grey boxes. Safe because
 * the header is only a pre-filter: the body must still sniff as PNG/JPEG/GIF/WebP, the served type
 * comes from those magic bytes, and HTML, SVG, JSON, XML, text etc. stay refused outright.
 */
export const TOLERATED_IMAGE_CONTENT_TYPES: readonly string[] = [
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/unknown",
  "unknown/unknown",
  "audio/unknown",
];

/** An SVG document: the served type, or an `<svg` root within the first 1 KB (after a prolog). */
function isSvg(contentType: string, body: Buffer): boolean {
  if (/^image\/svg\+xml\b/i.test(contentType.trim())) return true;
  const head = body.subarray(0, 1024).toString("latin1");
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s/>]/i.test(head);
}

/** safeFetch + sniffImage + ≤ 25 megapixels. SVG/AVIF/HEIF are rejected. */
export async function fetchImage(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number },
): Promise<ImageFetchResult> {
  const r = await safeFetch(url, {
    maxBytes: opts.maxBytes,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    accept: ["image/"],
    tolerate: TOLERATED_IMAGE_CONTENT_TYPES,
    maxRedirects: 3,
  });
  if (!r.ok)
    return r.status === undefined
      ? { ok: false, reason: r.error }
      : { ok: false, reason: r.error, status: r.status };
  const sniffed = sniffImage(r.body);
  if (sniffed === null)
    return isSvg(r.contentType, r.body)
      ? { ok: false, reason: "not_image", status: r.status, svg: true }
      : { ok: false, reason: "not_image", status: r.status };
  if (sniffed.width * sniffed.height > MAX_IMAGE_PIXELS)
    return { ok: false, reason: "too_many_pixels", status: r.status };
  return {
    ok: true,
    format: sniffed.format,
    width: sniffed.width,
    height: sniffed.height,
    contentType: IMAGE_CONTENT_TYPES[sniffed.format],
    body: r.body,
  };
}
