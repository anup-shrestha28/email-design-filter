/**
 * The gallery's search box (`?q=`), read the way people type it. Pure and client-safe; the SQL is
 * queries/gallery.ts searchCondition. The rules (Postgres' own web-search rules, plus prefixes):
 *  - Every word matches the start of a word ("mongo" finds "MongoDB", "jobs" finds "Jobs"), in the
 *    words of the email (`email.search_tsv`: subject, sender and a text excerpt), or the start of any
 *    part of the sender's address ("linkedin.com" and "trybetterbrand" find their senders).
 *  - "Quoted words" match exactly, in that order. `-word` leaves out the designs that have it.
 *    `or` between words finds either side (`a b or c` is "a and b", or "c").
 *  - Punctuation splits a word the way the index does: "don't" is "don" then "t", so it finds
 *    "don't" and "don’t" alike. Symbols typed after a word end it: "C++" and "10%" find the whole
 *    words "c" and "10" (the index keeps no symbols), not every word starting with them.
 *  - Accents don't matter in the subject or the sender's name: "estee" finds "Estée".
 *  - A search with no letters or digits at all ("🎁", "!!!", "%") looks for that exact text in the
 *    subject and sender name, so it never quietly shows everything.
 */

/** One thing the search looks for. */
export interface SearchTerm {
  /**
   * word: matched as the start of a word; phrase: "quoted", exact and in order; literal: no letters
   * or digits, found as typed in the subject or sender name.
   */
  kind: "word" | "phrase" | "literal";
  /** `-word`: designs that match are left out. */
  not: boolean;
  /**
   * word: its pieces between punctuation, lowercased ("don't" → ["don", "t"]; "linkedin.com" stays
   * whole, as the index keeps it); the last piece is a prefix. phrase / literal: the text itself.
   */
  parts: string[];
  /**
   * Its letters-and-digits runs, lowercased and without accents ("Estée" → ["estee"]): what the
   * sender's address and the accent-free subject / name are matched against.
   */
  runs: string[];
  /**
   * word: the last piece is a whole word, not a prefix — it was typed with symbols after it
   * ("C++", "10%", "jobs!"), which the index drops, so the word clearly ended there ("C++" must not
   * find every word starting with "c").
   */
  exact?: true;
}

/** Alternatives (`or`), each a list of terms that must all match. Empty = no search. */
export type GallerySearch = SearchTerm[][];

/**
 * Latin letters with accents → the plain letter, both cases (À → A, é → e): Postgres translate()
 * and `foldAccents` use the same pairs, so both sides of a match fold alike.
 */
function foldPairs(): [string, string] {
  let from = "";
  let to = "";
  for (const [lo, hi] of [
    [0xc0, 0x24f],
    [0x1e00, 0x1eff],
  ] as const) {
    for (let cp = lo; cp <= hi; cp++) {
      const ch = String.fromCodePoint(cp);
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      if (base !== ch && /^[A-Za-z]$/.test(base)) {
        from += ch;
        to += base;
      }
    }
  }
  return [from, to];
}
export const [FOLD_FROM, FOLD_TO] = foldPairs();
const FOLD = new Map([...FOLD_FROM].map((ch, i) => [ch, FOLD_TO[i]!]));

/** `s` lowercased, with accented Latin letters made plain (exactly what the SQL side does). */
export function foldAccents(s: string): string {
  let out = "";
  for (const ch of s) out += FOLD.get(ch) ?? ch;
  return out.toLowerCase();
}

/** Anything but letters, marks, digits and the joiners the index keeps inside a word splits it. */
const WORD_BREAK = /[^\p{L}\p{M}\p{N}\-./@_+]+/gu;
const EDGE = /^[-./@_+]+|[-./@_+]+$/gu;
const RUN_BREAK = /[^\p{L}\p{M}\p{N}]+/u;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
/** Typed with something after its last letter or digit ("C++", "10%", "jobs!"). */
const ENDS_IN_SYMBOL = /[^\p{L}\p{M}\p{N}]$/u;
const QUOTES = new Set(['"', "“", "”", "„"]);
const SPACE = /\s/u;
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Longest search read (the URL's `q` is cut to 100 characters already). */
const MAX_TEXT = 200;

function runsOf(text: string): string[] {
  return foldAccents(text)
    .split(RUN_BREAK)
    .filter((r) => r !== "");
}

function literal(text: string, not: boolean): SearchTerm {
  return { kind: "literal", not, parts: [text], runs: [] };
}

function wordTerm(raw: string, not: boolean): SearchTerm {
  const parts = raw
    .toLowerCase()
    .replace(WORD_BREAK, " ")
    .split(" ")
    .map((p) => p.replace(EDGE, ""))
    .filter((p) => p !== "" && HAS_ALNUM.test(p));
  if (parts.length === 0) return literal(raw, not);
  const term: SearchTerm = { kind: "word", not, parts, runs: runsOf(parts.join(" ")) };
  if (ENDS_IN_SYMBOL.test(raw)) term.exact = true;
  return term;
}

function phraseTerm(body: string, not: boolean): SearchTerm | null {
  const text = body.trim();
  if (text === "") return null;
  if (!HAS_ALNUM.test(text)) return literal(text, not);
  return { kind: "phrase", not, parts: [text], runs: runsOf(text) };
}

type Token = { or: true } | { or: false; term: SearchTerm | null };

/** The search `q` as terms (see the rules at the top). */
export function parseGallerySearch(q: string): GallerySearch {
  const s = q.normalize("NFKC").replace(CONTROL, " ").slice(0, MAX_TEXT).trim();
  if (s === "") return [];
  const chars = [...s];
  const tokens: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    if (SPACE.test(chars[i]!)) {
      i++;
      continue;
    }
    // "-" right before a word or a quote leaves it out; a lone "-" is just a character.
    let not = false;
    if (chars[i] === "-" && i + 1 < chars.length && !SPACE.test(chars[i + 1]!)) {
      not = true;
      i++;
    }
    if (QUOTES.has(chars[i]!)) {
      let end = i + 1;
      while (end < chars.length && !QUOTES.has(chars[end]!)) end++;
      tokens.push({ or: false, term: phraseTerm(chars.slice(i + 1, end).join(""), not) });
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < chars.length && !SPACE.test(chars[end]!) && !QUOTES.has(chars[end]!)) end++;
    const raw = chars.slice(i, end).join("");
    i = end;
    if (!not && raw.toLowerCase() === "or") tokens.push({ or: true });
    else tokens.push({ or: false, term: wordTerm(raw, not) });
  }

  const alternatives: SearchTerm[][] = [[]];
  tokens.forEach((t, k) => {
    const current = alternatives[alternatives.length - 1]!;
    if (!t.or) {
      if (t.term) current.push(t.term);
      return;
    }
    // "or" joins two sides; at the start, at the end or doubled it's just the word "or".
    const next = tokens[k + 1];
    if (current.length > 0 && next && !next.or && next.term) alternatives.push([]);
    else current.push(wordTerm("or", false));
  });

  // Punctuation-only bits next to real words are separators ("Jobs - LinkedIn"), as in the index.
  const hasWords = alternatives.some((a) => a.some((t) => t.kind !== "literal"));
  const kept = alternatives
    .map((a) => (hasWords ? a.filter((t) => t.kind !== "literal") : a))
    .filter((a) => a.length > 0);
  // Nothing searchable at all (e.g. `""`): look for the text itself rather than ignore it.
  return kept.length > 0 ? kept : [[literal(s, false)]];
}
