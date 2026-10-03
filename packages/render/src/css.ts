/**
 * Minimal CSS text utilities for pass M-nomq (no parser dependency in the VM bundle): remove
 * every `@media` block, respecting strings, comments and nested braces. Bounded and linear.
 */

/** Remove all `@media …{…}` blocks from a stylesheet (DESIGN-SCORE §2 pass M-nomq). */
export function stripMediaRules(css: string): string {
  const s = css.length > 2_000_000 ? css.slice(0, 2_000_000) : css;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? s.length : end + 2;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "@" && s.slice(i, i + 6).toLowerCase() === "@media") {
      const open = findBlockStart(s, i + 6);
      if (open < 0) break; // malformed tail: drop it
      const close = matchBrace(s, open);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findBlockStart(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "{") return i;
    if (c === ";") return -1;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      i = j;
    }
  }
  return -1;
}

function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
