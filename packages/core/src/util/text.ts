/**
 * Small, allocation-light text helpers shared by ingest modules. Every function is linear in its
 * input and safe on hostile strings (no backtracking-prone regexes).
 */

/** Zero-width / invisible filler characters used in preheader padding and obfuscation. */
const INVISIBLE_RE =
  /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFEFF\uFFA0]|\u034F|\u17B4|\u17B5|\p{Variation_Selector}/gu;

/** All whitespace, including NBSP and the Unicode space separators. */
const WS_RE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/** C0/C1 control characters except TAB, LF, CR. */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Removes zero-width and invisible filler characters. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, "");
}

/** Removes control characters (keeps TAB/LF/CR). */
export function stripControl(s: string): string {
  return s.replace(CONTROL_RE, "");
}

/** Collapses every whitespace run (incl. NBSP) to one space and trims. */
export function collapseWhitespace(s: string): string {
  return s.replace(WS_RE, " ").trim();
}

/**
 * Collapses whitespace but keeps single line breaks as block separators: runs containing a
 * newline become "\n", other runs become " ".
 */
export function collapseKeepingLines(s: string): string {
  return s
    .replace(WS_RE, (run) => (run.includes("\n") ? "\n" : " "))
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/** NFKC + lower-case: the canonical form every keyword regex runs against. */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/** Cuts `s` to at most `max` UTF-16 units without splitting a surrogate pair. */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * Truncates at a word boundary when one exists in the last 40 characters of the window, else
 * hard-cuts (CJK text has no spaces). Never splits a surrogate pair.
 */
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = safeSlice(s, max);
  const lastSpace = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (lastSpace >= max - 40 && lastSpace > 0) return cut.slice(0, lastSpace).trimEnd();
  return cut;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Escapes a literal string for use inside a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a case-insensitive Unicode regex from phrase sources (each already a safe, bounded
 * regex fragment). With `boundary`, matches must not be glued to letters/digits on either side,
 * which works for accented Latin text where `\b` does not.
 */
export function phraseRegex(
  sources: readonly string[],
  opts: { boundary?: boolean; global?: boolean } = {},
): RegExp {
  const alt = sources.join("|");
  // Boundaries only apply at word characters: a phrase ending in "#" may be followed by a letter.
  const lead = "(?:(?<![\\p{L}\\p{N}])|(?![\\p{L}\\p{N}]))";
  const trail = "(?:(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}]))";
  const body = opts.boundary === false ? `(?:${alt})` : `${lead}(?:${alt})${trail}`;
  return new RegExp(body, opts.global ? "giu" : "iu");
}

/** True when any regex in the list matches. */
export function anyMatch(res: readonly RegExp[], s: string): boolean {
  for (const re of res) {
    re.lastIndex = 0;
    if (re.test(s)) return true;
  }
  return false;
}
