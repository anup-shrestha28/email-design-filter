/**
 * Hostile-input nesting limiter shared by every parse5 user (core content extraction, design static
 * extraction, the renderer's byte-offset stamping). Dependency-free (no cheerio), so the render
 * kit can import it via `@edf/core/nesting`.
 */
import { forEachTag } from "./tags";
import type { TagToken } from "./tags";

/** Maximum element nesting handed to parse5 (real email rarely exceeds ~100). */
export const MAX_HTML_DEPTH = 400;
/**
 * Maximum formatting elements open at once. parse5 re-opens every unclosed formatting element in
 * each new block (the "reconstruct the active formatting elements" step; distinct attributes defeat
 * its Noah's-ark limit of 3), so 420 open <b id=N> × 30,000 paragraphs is 12.6M elements and an
 * out-of-memory crash. Real email keeps a handful open; extra ones only carry styling.
 */
export const MAX_OPEN_FORMATTING = 16;
const FORMATTING_TAGS = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "keygen",
  "command",
]);
/** Elements the HTML parser closes implicitly; they can't nest unboundedly, so they aren't counted. */
const AUTO_CLOSED = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "option",
  "optgroup",
  "tbody",
  "thead",
  "tfoot",
  "colgroup",
  "caption",
  // rp/rt/rb/rtc close implicitly only inside <ruby>; outside it they nest without bound (20k
  // stray <rt>s ≈ 20 s in parse5), so they are counted like any other element.
  "html",
  "head",
  "body",
]);
/**
 * Hostile-input guard: parse5 is quadratic in nesting depth (20k nested <div>s ≈ 5 s CPU).
 * A linear tag scan drops opening tags (and their matching closing tags) beyond `maxDepth`,
 * which flattens only pathological documents; normal email is returned untouched.
 */
export function limitNesting(html: string, maxDepth = MAX_HTML_DEPTH): string {
  const counted = (t: TagToken): boolean =>
    !VOID_TAGS.has(t.name) && !AUTO_CLOSED.has(t.name) && !t.selfClosing && t.rawText === undefined;
  // Pass 1: measure. Most documents stop here.
  let depth = 0;
  let maxSeen = 0;
  let fmt = 0;
  let tooMuchFormatting = false;
  forEachTag(html, (t) => {
    if (t.rawText !== undefined || !counted(t)) return;
    if (FORMATTING_TAGS.has(t.name)) {
      if (t.closing) fmt = Math.max(0, fmt - 1);
      else if (++fmt > MAX_OPEN_FORMATTING) tooMuchFormatting = true;
    }
    if (t.closing) {
      if (depth > 0) depth--;
    } else if (++depth > maxSeen) {
      maxSeen = depth;
    }
    if (maxSeen >= maxDepth || tooMuchFormatting) return false;
  });
  if (maxSeen < maxDepth && !tooMuchFormatting) return html;
  // Pass 2: rebuild without the excess tags.
  const parts: string[] = [];
  let last = 0;
  let skipped = 0;
  let skippedFmt = 0;
  depth = 0;
  fmt = 0;
  forEachTag(html, (t) => {
    if (t.rawText !== undefined || !counted(t)) return;
    let drop = false;
    if (FORMATTING_TAGS.has(t.name)) {
      if (!t.closing) {
        if (fmt >= MAX_OPEN_FORMATTING) {
          skippedFmt++;
          drop = true;
        } else fmt++;
      } else if (skippedFmt > 0) {
        skippedFmt--;
        drop = true;
      } else if (fmt > 0) fmt--;
      if (drop) {
        parts.push(html.slice(last, t.start));
        last = t.end;
        return;
      }
    }
    if (!t.closing) {
      if (depth >= maxDepth) {
        skipped++;
        drop = true;
      } else {
        depth++;
      }
    } else if (skipped > 0) {
      skipped--;
      drop = true;
    } else if (depth > 0) {
      depth--;
    }
    if (drop) {
      parts.push(html.slice(last, t.start));
      last = t.end;
    }
  });
  parts.push(html.slice(last));
  return parts.join("");
}
