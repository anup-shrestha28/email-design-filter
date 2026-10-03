/**
 * Language detection with franc-min (ISO 639-3) mapped to ISO 639-1 (`email.language`).
 * franc is "easily confused on small samples" (RESEARCH-NOTES), so detection only runs on ≥ 20
 * words, and the candidate set is restricted to languages franc-min models well and that plausibly
 * appear in a personal inbox — low-resource languages that short English text is often mistaken
 * for (Tagalog-like Cebuano, Javanese, Hausa, …) are excluded. See DECISIONS.md.
 */
import { franc } from "franc-min";

export const MIN_WORDS_FOR_LANGUAGE = 20;

const ISO3_TO_ISO1: Record<string, string> = {
  eng: "en",
  spa: "es",
  por: "pt",
  fra: "fr",
  deu: "de",
  ita: "it",
  nld: "nl",
  pol: "pl",
  swe: "sv",
  tur: "tr",
  ron: "ro",
  hun: "hu",
  ces: "cs",
  hrv: "hr",
  bos: "bs",
  srp: "sr",
  ind: "id",
  zlm: "ms",
  vie: "vi",
  tgl: "tl",
  swh: "sw",
  rus: "ru",
  ukr: "uk",
  bel: "be",
  bul: "bg",
  kaz: "kk",
  arb: "ar",
  urd: "ur",
  pes: "fa",
  hin: "hi",
  mar: "mr",
  npi: "ne",
  ben: "bn",
  tel: "te",
  tam: "ta",
  guj: "gu",
  kan: "kn",
  mal: "ml",
  mya: "my",
  pan: "pa",
  amh: "am",
  tha: "th",
  sin: "si",
  ell: "el",
  cmn: "zh",
  jpn: "ja",
  kor: "ko",
  azj: "az",
  uzn: "uz",
};

const ONLY = Object.keys(ISO3_TO_ISO1);

const URL_OR_EMAIL_RE =
  /\bhttps?:\/\/\S{1,2048}|\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}\b/g;

/** ISO 639-1 code of the dominant language, or null (too short / undetermined). */
export function detectLanguage(text: string, wordCount: number): string | null {
  if (wordCount < MIN_WORDS_FOR_LANGUAGE) return null;
  const sample = text.slice(0, 6000).replace(URL_OR_EMAIL_RE, " ").replace(/\d+/g, " ");
  let code: string;
  try {
    code = franc(sample, { only: ONLY, minLength: 20 });
  } catch {
    return null;
  }
  return ISO3_TO_ISO1[code] ?? null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Word count with `Intl.Segmenter` (DESIGN-SCORE §2.1), bounded to the first 100k chars. */
export function countWords(text: string): number {
  let n = 0;
  for (const seg of segmenter.segment(text.length > 100_000 ? text.slice(0, 100_000) : text)) {
    if (seg.isWordLike) n++;
  }
  return n;
}
