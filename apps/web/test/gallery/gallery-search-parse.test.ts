/**
 * The gallery's search box read into terms (lib/gallery-search.ts), pure: words, pieces between
 * punctuation, quoted phrases, `-word`, `or`, symbols-only searches and the accent folding the SQL
 * side shares (FOLD_FROM / FOLD_TO for Postgres translate()).
 */
import { describe, expect, it } from "vitest";
import {
  FOLD_FROM,
  FOLD_TO,
  foldAccents,
  parseGallerySearch,
  type SearchTerm,
} from "@/lib/gallery-search";

const word = (parts: string[], runs = parts, not = false): SearchTerm => ({
  kind: "word",
  not,
  parts,
  runs,
});

/** A word typed with symbols after it: its last piece must be a whole word, not a prefix. */
const whole = (parts: string[], runs = parts, not = false): SearchTerm => ({
  ...word(parts, runs, not),
  exact: true,
});

describe("parseGallerySearch", () => {
  it("nothing to search: an empty or blank box", () => {
    expect(parseGallerySearch("")).toEqual([]);
    expect(parseGallerySearch("   ")).toEqual([]);
    expect(parseGallerySearch("\u0000\t ")).toEqual([]);
  });

  it("every word is a term (all prefixes), lowercased", () => {
    expect(parseGallerySearch("Mongo Search")).toEqual([[word(["mongo"]), word(["search"])]]);
    expect(parseGallerySearch("  autumn   sale ")).toEqual([[word(["autumn"]), word(["sale"])]]);
  });

  it("apostrophes and other punctuation split a word into pieces; the index's joiners stay", () => {
    expect(parseGallerySearch("don't")).toEqual([[word(["don", "t"])]]);
    expect(parseGallerySearch("don’t")).toEqual([[word(["don", "t"])]]);
    expect(parseGallerySearch("shouldn’t!")).toEqual([[whole(["shouldn", "t"])]]);
    expect(parseGallerySearch("hello,world")).toEqual([[word(["hello", "world"])]]);
    // Hyphenated words, hosts, paths and addresses stay whole, as Postgres indexes them.
    expect(parseGallerySearch("rust-embedded")).toEqual([
      [word(["rust-embedded"], ["rust", "embedded"])],
    ]);
    expect(parseGallerySearch("LinkedIn.com")).toEqual([
      [word(["linkedin.com"], ["linkedin", "com"])],
    ]);
    expect(parseGallerySearch("bob@example.com")).toEqual([
      [word(["bob@example.com"], ["bob", "example", "com"])],
    ]);
    // Edge punctuation is dropped; no quote or backslash ever reaches a piece.
    expect(parseGallerySearch("Montserrat'):*")).toEqual([[whole(["montserrat"])]]);
    expect(parseGallerySearch("-rust-")).toEqual([[whole(["rust"], ["rust"], true)]]);
    for (const t of parseGallerySearch("a\\b'c|d&e (f) g:* h!i").flat())
      for (const p of t.parts) expect(p).not.toMatch(/['\\|&!():*]/);
  });

  it("symbols typed after a word end it: a whole word, not a prefix (C++ is not every c… word)", () => {
    expect(parseGallerySearch("C++")).toEqual([[whole(["c"])]]);
    expect(parseGallerySearch("10%")).toEqual([[whole(["10"])]]);
    expect(parseGallerySearch("C# jobs")).toEqual([[whole(["c"]), word(["jobs"])]]);
    expect(parseGallerySearch("jobs.")).toEqual([[whole(["jobs"])]]);
    // Symbols before or inside a word don't end it; the last piece stays a prefix.
    expect(parseGallerySearch("$1")).toEqual([[word(["1"])]]);
    expect(parseGallerySearch("don't")[0]![0]!.exact).toBeUndefined();
    expect(parseGallerySearch("linkedin.com")[0]![0]!.exact).toBeUndefined();
  });

  it("accents: the pieces keep them (the index has them), the runs are folded", () => {
    expect(parseGallerySearch("Estée")).toEqual([[word(["estée"], ["estee"])]]);
    expect(parseGallerySearch("GRÜNS")).toEqual([[word(["grüns"], ["gruns"])]]);
  });

  it('"quoted words" are one exact phrase; smart quotes too; an open quote runs to the end', () => {
    expect(parseGallerySearch('"Full Stack" jobs')).toEqual([
      [
        { kind: "phrase", not: false, parts: ["Full Stack"], runs: ["full", "stack"] },
        word(["jobs"]),
      ],
    ]);
    expect(parseGallerySearch("“full stack”")).toEqual(parseGallerySearch('"full stack"'));
    expect(parseGallerySearch('"full stack')).toEqual(parseGallerySearch('"full stack"'));
  });

  it('-word and -"phrase" leave out; a lone - is only a separator', () => {
    expect(parseGallerySearch("jobs -linkedin")).toEqual([
      [word(["jobs"]), word(["linkedin"], ["linkedin"], true)],
    ]);
    expect(parseGallerySearch('-"full stack"')[0]![0]).toMatchObject({ kind: "phrase", not: true });
    expect(parseGallerySearch("Jobs - LinkedIn")).toEqual([[word(["jobs"]), word(["linkedin"])]]);
    expect(parseGallerySearch("a-b")).toEqual([[word(["a-b"], ["a", "b"])]]);
  });

  it("or between terms finds either side (a b or c = a and b, or c); elsewhere it's a word", () => {
    expect(parseGallerySearch("a b or c")).toEqual([[word(["a"]), word(["b"])], [word(["c"])]]);
    expect(parseGallerySearch("jobs OR internships")).toEqual([
      [word(["jobs"])],
      [word(["internships"])],
    ]);
    expect(parseGallerySearch("or")).toEqual([[word(["or"])]]);
    expect(parseGallerySearch("jobs or")).toEqual([[word(["jobs"]), word(["or"])]]);
    expect(parseGallerySearch("or jobs")).toEqual([[word(["or"]), word(["jobs"])]]);
    expect(parseGallerySearch("orders")).toEqual([[word(["orders"])]]);
  });

  it("no letters or digits at all: that text itself, never nothing", () => {
    const lit = (text: string, not = false): SearchTerm => ({
      kind: "literal",
      not,
      parts: [text],
      runs: [],
    });
    expect(parseGallerySearch("🎁")).toEqual([[lit("🎁")]]);
    expect(parseGallerySearch("!!!")).toEqual([[lit("!!!")]]);
    expect(parseGallerySearch("%")).toEqual([[lit("%")]]);
    expect(parseGallerySearch("'")).toEqual([[lit("'")]]);
    expect(parseGallerySearch("\\")).toEqual([[lit("\\")]]);
    expect(parseGallerySearch("-")).toEqual([[lit("-")]]);
    expect(parseGallerySearch("-!!!")).toEqual([[lit("!!!", true)]]);
    expect(parseGallerySearch('""')).toEqual([[lit('""')]]);
    // Next to real words they are separators, as in the index.
    expect(parseGallerySearch("gift 🎁")).toEqual([[word(["gift"])]]);
  });

  it("control characters are spaces; the text is NFKC-normalised (full-width letters)", () => {
    expect(parseGallerySearch("a\u0000b")).toEqual([[word(["a"]), word(["b"])]]);
    expect(parseGallerySearch("ＳＡＬＥ")).toEqual([[word(["sale"])]]);
  });
});

describe("accent folding shared with SQL", () => {
  it("pairs each accented Latin letter with its plain letter, both cases", () => {
    expect(FOLD_FROM.length).toBe(FOLD_TO.length);
    expect(FOLD_TO).toMatch(/^[A-Za-z]+$/);
    expect(FOLD_FROM).not.toMatch(/['\\]/);
    for (const [from, to] of [
      ["é", "e"],
      ["É", "E"],
      ["ü", "u"],
      ["ñ", "n"],
      ["ç", "c"],
      ["ệ", "e"],
    ]) {
      const i = FOLD_FROM.indexOf(from!);
      expect(i, from).toBeGreaterThanOrEqual(0);
      expect(FOLD_TO[i], from).toBe(to);
    }
    expect(foldAccents("Crème Brûlée ESTÉE")).toBe("creme brulee estee");
    expect(foldAccents("Łódź ß")).toBe("łodz ß"); // letters without a plain form stay
  });
});
