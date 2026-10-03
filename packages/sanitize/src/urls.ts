/**
 * URL classification for sanitizer rewrites (DESIGN.md §11.5 afterSanitizeAttributes rules).
 * Parsing uses the WHATWG URL parser (what browsers use), so tab/newline/control tricks such as
 * "java\tscript:" or "  javascript:" normalize to the scheme a browser would see.
 */

/** data:image payloads allowed straight from email content (DESIGN.md §11.5). */
export const DATA_IMAGE_MAX_BYTES = 256 * 1024;

/**
 * Linear on hostile input (values reach 32 MB in the analysis profile). No two adjacent
 * quantifiers match the same characters: `[…\s]*={0,2}\s*` made V8 try every split of a
 * whitespace run, which is quadratic on a long run followed by a non-base64 character. The
 * parameters are one flat class instead of `(?:;[…]*)*`, whose per-iteration backtrack state
 * overflowed the stack (RangeError) on a few million `;`. Same language as the nested forms.
 */
const DATA_IMAGE_RE =
  /^data:image\/(png|gif|jpeg|webp)(?:;[;a-z0-9=._+-]*)?;base64,([A-Za-z0-9+/\s]*(?:={1,2}\s*)?)$/i;
/** The same check DOMPurify's SAFE_FOR_XML applies to attribute values. */
const MARKUP_IN_ATTR_RE =
  /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i;

export function looksLikeMarkupBreakout(v: string): boolean {
  return MARKUP_IN_ATTR_RE.test(v);
}

/** Magic bytes of the four allowed raster formats (browsers sniff, so the declared type is not enough). */
function rasterMagicOk(head: Buffer): boolean {
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return true;
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  const a = head.subarray(0, 6).toString("latin1");
  if (a === "GIF87a" || a === "GIF89a") return true;
  return (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

/**
 * A `data:image/(png|gif|jpeg|webp);base64,…` URI of at most `maxBytes` characters whose decoded
 * bytes really start with one of those formats. Returns the canonical form (whitespace removed,
 * lower-case type) or null.
 */
export function validDataImage(value: string, maxBytes: number): string | null {
  const v = value.trim();
  if (v.length > maxBytes) return null;
  const m = DATA_IMAGE_RE.exec(v);
  if (m === null) return null;
  const type = (m[1] as string).toLowerCase();
  const payload = (m[2] as string).replace(/\s+/g, "");
  if (payload.length < 16) return null;
  const head = Buffer.from(payload.slice(0, 24), "base64");
  if (!rasterMagicOk(head)) return null;
  return `data:image/${type};base64,${payload}`;
}

/** Absolute URL with one of the given schemes (normalized href), else null. */
export function absoluteUrl(value: string, schemes: readonly string[]): URL | null {
  let u: URL;
  try {
    u = new URL(value); // no base: relative URLs throw, which is what we want
  } catch {
    return null;
  }
  return schemes.includes(u.protocol) ? u : null;
}

/** `cid:` Content-ID → lower-cased id without angle brackets, or null. */
export function contentIdOf(value: string): string | null {
  const v = value.trim();
  if (!/^cid:/i.test(v)) return null;
  let id: string;
  try {
    id = decodeURIComponent(v.slice(4));
  } catch {
    return null;
  }
  id = id
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .toLowerCase();
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  if (id.length === 0 || id.length > 256 || /[\s<>"'\\\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

/** Longest rewriter output accepted (the normalized href, which is ASCII: chars = bytes). */
export const REWRITTEN_URL_MAX_CHARS = 8192;

/** Output of an edf-app rewriter must be an absolute http(s) URL (a proxy or /out URL). */
export function safeRewrittenUrl(
  v: unknown,
  maxChars: number = REWRITTEN_URL_MAX_CHARS,
): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > maxChars) return null;
  const u = absoluteUrl(v, ["https:", "http:"]);
  return u === null || u.href.length > maxChars ? null : u.href;
}
