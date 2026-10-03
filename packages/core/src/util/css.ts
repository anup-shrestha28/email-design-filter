/**
 * Minimal, linear-time CSS helpers for hostile email CSS (css-tree is not an ingest dependency
 * of this package): comment stripping, brace matching, and `url(...)` extraction.
 */

/** Removes /* … *\/ comments (an unterminated comment drops the rest). Linear. */
export function stripCssComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf("/*", i);
    if (start < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, start);
    const end = css.indexOf("*/", start + 2);
    if (end < 0) break;
    i = end + 2;
  }
  return out;
}

/** Index of the "}" matching the "{" at `open` (or s.length). Linear. */
export function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

/**
 * Removes `@import …;` statements and `@font-face { … }` blocks, whose url()s are stylesheets
 * and fonts rather than images.
 */
export function stripNonImageAtRules(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@", i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const head = css.slice(at, at + 16).toLowerCase();
    if (head.startsWith("@import")) {
      const semi = css.indexOf(";", at);
      i = semi < 0 ? css.length : semi + 1;
    } else if (head.startsWith("@font-face")) {
      const brace = css.indexOf("{", at);
      i = brace < 0 ? css.length : matchingBrace(css, brace) + 1;
    } else {
      out += "@";
      i = at + 1;
    }
  }
  return out;
}

const URL_FN_RE = /url\(\s*(?:"([^"\n]{1,2048})"|'([^'\n]{1,2048})'|([^'"()\s]{1,2048}))\s*\)/gi;

/** All `url(...)` arguments in a CSS string, in order (bounded count). */
export function cssUrls(css: string, max = 200): string[] {
  const out: string[] = [];
  URL_FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_FN_RE.exec(css)) !== null && out.length < max) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (raw) out.push(raw);
  }
  return out;
}
