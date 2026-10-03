/**
 * Text measurement helpers shared by static extraction, the renderer and the scorer:
 * counted characters (DESIGN.md §8.1 "Counting"; DESIGN-SCORE §2.1 CJK ×2), word counts via
 * `Intl.Segmenter` (DESIGN-SCORE §2.1), display width (C1), scripts (T4, T7, A11) and
 * Flesch Reading Ease (T8).
 */

/** Characters never counted: whitespace, NBSP, soft hyphen, CGJ, zero-width chars, word joiner, BOM, VS16. */
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- deliberately matches lone CGJ/variation selectors
  /[\s\u{00A0}\u{00AD}\u{034F}\u{180E}\u{200B}-\u{200F}\u{2028}-\u{202F}\u{2060}-\u{2064}\u{FE0E}\u{FE0F}\u{FEFF}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * Counted characters of `s`: whitespace, invisible fillers (the preheader padding hack) and
 * emoji are skipped; Han, Kana and Hangul count ×2.
 */
export function countedChars(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (INVISIBLE.test(ch) || PICTO.test(ch)) continue;
    n += CJK.test(ch) ? 2 : 1;
  }
  return n;
}

/** Counted CJK characters (already ×2) and Private-Use-Area characters of `s`. */
export function charProfile(s: string): { counted: number; cjk: number; pua: number } {
  let counted = 0;
  let cjk = 0;
  let pua = 0;
  for (const ch of s) {
    if (INVISIBLE.test(ch) || PICTO.test(ch)) continue;
    if (CJK.test(ch)) {
      counted += 2;
      cjk += 2;
    } else {
      counted += 1;
      if (PUA.test(ch)) pua += 1;
    }
  }
  return { counted, cjk, pua };
}

/** Collapse runs of whitespace (incl. invisible fillers) to single spaces and trim. */
export function collapseWhitespace(s: string): string {
  return s
    // eslint-disable-next-line no-misleading-character-class -- deliberately removes a lone CGJ (U+034F)
    .replace(/[\u{00AD}\u{034F}\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu, "")
    .replace(/[\s\u{00A0}]+/gu, " ")
    .trim();
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(lang: string | null): Intl.Segmenter {
  const key = lang && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(lang) ? lang : "und";
  let s = segmenters.get(key);
  if (!s) {
    try {
      s = new Intl.Segmenter(key === "und" ? undefined : key, { granularity: "word" });
    } catch {
      s = new Intl.Segmenter(undefined, { granularity: "word" });
    }
    segmenters.set(key, s);
  }
  return s;
}

/** Word-like segments (DESIGN-SCORE §2.1 "Word counts use Intl.Segmenter"). */
export function words(text: string, lang: string | null = null): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const seg of segmenter(lang).segment(
    text.length > 200_000 ? text.slice(0, 200_000) : text,
  )) {
    if (seg.isWordLike) out.push(seg.segment);
  }
  return out;
}

export function wordCount(text: string, lang: string | null = null): number {
  return words(text, lang).length;
}

/** Display width: East Asian wide/fullwidth characters and emoji count 2 (DESIGN-SCORE §2.1). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (/\p{M}/u.test(ch) || cp === 0x200d || cp === 0xfe0f) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd) ||
      PICTO.test(ch)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export function emojiCount(s: string): number {
  let n = 0;
  // Count pictographic clusters, not code points (ZWJ sequences count once).
  for (const seg of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) {
    if (PICTO.test(seg.segment)) n++;
  }
  return n;
}

export type ScriptKind = "latin" | "cjk" | "rtl" | "other";

export interface ScriptProfile {
  kind: ScriptKind;
  /** The dominant script has upper/lower case (Latin, Cyrillic, Greek, Armenian, Georgian). */
  cased: boolean;
  rtl: boolean;
  letters: number;
}

/** Dominant script of `text` by letter count. Empty text is treated as Latin. */
export function scriptProfile(text: string): ScriptProfile {
  let cased = 0;
  let cjk = 0;
  let rtl = 0;
  let other = 0;
  let i = 0;
  for (const ch of text) {
    if (++i > 20_000) break;
    if (!/\p{L}/u.test(ch)) continue;
    if (/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u.test(ch))
      cased++;
    else if (CJK.test(ch)) cjk++;
    else if (/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(ch))
      rtl++;
    else other++;
  }
  const letters = cased + cjk + rtl + other;
  if (letters === 0) return { kind: "latin", cased: true, rtl: false, letters };
  const max = Math.max(cased, cjk, rtl, other);
  if (max === cased) return { kind: "latin", cased: true, rtl: false, letters };
  if (max === cjk) return { kind: "cjk", cased: false, rtl: false, letters };
  if (max === rtl) return { kind: "rtl", cased: false, rtl: true, letters };
  return { kind: "other", cased: false, rtl: false, letters };
}

/** A word is all-caps when it has ≥ 2 cased letters and none is lower-case (T7). */
export function isAllCapsWord(word: string): boolean {
  let upper = 0;
  for (const ch of word) {
    if (/\p{Ll}/u.test(ch)) return false;
    if (/\p{Lu}/u.test(ch)) upper++;
  }
  return upper >= 2;
}

/** Characters (counted) that sit in all-caps words of `text`. */
export function capsChars(
  text: string,
  lang: string | null = null,
): { chars: number; caps: number } {
  let chars = 0;
  let caps = 0;
  for (const w of words(text, lang)) {
    const n = countedChars(w);
    chars += n;
    if (isAllCapsWord(w)) caps += n;
  }
  return { chars, caps };
}

/** English syllable estimate (classic vowel-group heuristic used by Flesch implementations). */
export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export interface ProseStats {
  words: number;
  sentences: number;
  syllables: number;
}

/** Word, sentence and syllable counts of English prose (T8). */
export function proseStats(text: string): ProseStats {
  const ws = words(text, "en").filter((w) => /\p{L}/u.test(w));
  const sentences = Math.max(1, (text.match(/[.!?]+(?=\s|$)/g) ?? []).length);
  let syl = 0;
  for (const w of ws) syl += syllables(w);
  return { words: ws.length, sentences, syllables: syl };
}

/** Flesch Reading Ease = 206.835 − 1.015·(words/sentences) − 84.6·(syllables/words). */
export function fleschReadingEase(s: ProseStats): number | null {
  if (s.words === 0 || s.sentences === 0) return null;
  return 206.835 - 1.015 * (s.words / s.sentences) - 84.6 * (s.syllables / s.words);
}

/**
 * Normalized CTA label (DESIGN-SCORE §5.4 H5): lower-cased, punctuation and emoji stripped,
 * whitespace collapsed, at most 60 characters.
 */
export function normalizeLabel(label: string): string {
  return collapseWhitespace(
    label
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\p{Extended_Pictographic}/gu, " ")
      .replace(/[\p{P}\p{S}]/gu, " "),
  ).slice(0, 60);
}

/** Truncate to `max` characters on a code-point boundary. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}
