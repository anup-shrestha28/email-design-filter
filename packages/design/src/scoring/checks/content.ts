/**
 * Content & Structure — 2.5 deterministic points + C4 (AI, 2.5) (DESIGN-SCORE §5.7).
 */
import type { EmailType } from "@edf/core/types";
import { VIEWPORT_V } from "../../constants";
import { band, meanOf, ramp } from "../../util/math";
import { UNSUBSCRIBE_TEXT, VIEW_ONLINE_TEXT, looksLikePostalAddress } from "../../util/patterns";
import { collapseWhitespace, displayWidth, emojiCount, wordCount } from "../../util/text";
import {
  type CheckFn,
  type CheckTable,
  isOutcome,
  notApplicable,
  notEvaluated,
  r3,
  requireRender,
  scored,
} from "../kit";

/** Multi-word, ≥ 10 letters, all upper-case (SpamAssassin SUBJ_ALL_CAPS semantics). */
export function isAllCapsSubject(subject: string): boolean {
  const s = subject.replace(/^(?:\s*(?:re|fwd?|aw|wg|tr)\s*:\s*)+/i, "");
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length < 10 || wordCount(s) < 2) return false;
  return !/\p{Ll}/u.test(s) && /\p{Lu}/u.test(s);
}

/**
 * C1 Subject line — mean of `ramp(display width, 100, 60)`, ≤ 9 words (else 0.5), not ALL
 * CAPS, ≤ 1 emoji, and no `?!` combination. Empty subject fails; unknown is not evaluated.
 */
export const checkC1: CheckFn = (input) => {
  const subject = input.ctx.subject;
  if (subject === null) return notEvaluated("no_subject");
  const s = collapseWhitespace(subject);
  if (s === "") return scored(0, { empty: true });
  const width = displayWidth(s);
  const nWords = wordCount(s, input.ctx.language);
  const caps = isAllCapsSubject(s);
  const emoji = emojiCount(s);
  const pling = /\?/.test(s) && /!/.test(s);
  const credit =
    meanOf([
      ramp(width, 100, 60),
      nWords <= 9 ? 1 : 0.5,
      caps ? 0 : 1,
      emoji <= 1 ? 1 : 0,
      pling ? 0 : 1,
    ]) ?? 0;
  return scored(credit, { width, words: nWords, allCaps: caps, emoji, questionExclamation: pling });
};

/** Dice coefficient of character bigrams (0..1), used for snippet/subject similarity. */
export function bigramSimilarity(a: string, b: string): number {
  const norm = (s: string) => collapseWhitespace(s).toLowerCase().slice(0, 500);
  const x = norm(a);
  const y = norm(b);
  if (x.length < 2 || y.length < 2) return x === y && x.length > 0 ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      overlap++;
      grams.set(g, n - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/** Boilerplate preview text: view-in-browser, trouble viewing, unsubscribe, a postal address. */
export function isBoilerplatePreview(snippet: string): boolean {
  const head = snippet.slice(0, 80);
  return VIEW_ONLINE_TEXT.test(head) || UNSUBSCRIBE_TEXT.test(head) || looksLikePostalAddress(head);
}

/**
 * C2 Preview text (Gmail snippet) — `boilerplate ? 0 : 0.6 + 0.4 × band(len, 20, 40, 130, 200)`,
 * then −0.3 when its similarity to the subject exceeds 0.8.
 */
export const checkC2: CheckFn = (input) => {
  const snippet = input.ctx.snippet;
  if (snippet === null) return notEvaluated("no_snippet");
  const s = collapseWhitespace(snippet);
  const len = Array.from(s).length;
  if (s === "" || isBoilerplatePreview(s)) return scored(0, { boilerplate: true, length: len });
  let credit = 0.6 + 0.4 * band(len, 20, 40, 130, 200);
  const similarity = input.ctx.subject ? bigramSimilarity(s, input.ctx.subject) : 0;
  if (similarity > 0.8) credit -= 0.3;
  return scored(credit, { boilerplate: false, length: len, similarity: r3(similarity) });
};

/** C3 Scannability — N/A ≤ 150 words; mean of `ramp(avg paragraph lines, 8, 4)` and `ramp(max words between headings, 500, 300)`. */
export const checkC3: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  if (r.text.words <= 150) return notApplicable({ words: r.text.words });
  const a = r.text.avgParagraphLines === null ? null : ramp(r.text.avgParagraphLines, 8, 4);
  const b =
    r.text.maxWordsBetweenHeadings === null ? null : ramp(r.text.maxWordsBetweenHeadings, 500, 300);
  const s = meanOf([a, b]);
  if (s === null) return notApplicable({ reason: "no_paragraphs" });
  return scored(s, {
    words: r.text.words,
    avgParagraphLines: r.text.avgParagraphLines === null ? null : r3(r.text.avgParagraphLines),
    maxWordsBetweenHeadings: r.text.maxWordsBetweenHeadings,
  });
};

const SHORT_FORM: ReadonlySet<EmailType> = new Set([
  "transactional",
  "account_security",
  "account_notice",
  "notification",
]);

/**
 * C5 Content length — D = contentHeight@375 × k / V screens. Transactional/account/notification:
 * `ramp(D, 6, 3)`; everything else that applies: `ramp(D, 12, 6)` (newsletter/community are N/A
 * via applicability).
 */
export const checkC5: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const screens = (r.layout.mobileHeight * r.layout.k) / VIEWPORT_V;
  const short = SHORT_FORM.has(input.ctx.primaryType);
  return scored(short ? ramp(screens, 6, 3) : ramp(screens, 12, 6), {
    screens: r3(screens),
    shortForm: short,
  });
};

export const CONTENT_CHECKS: CheckTable = { C1: checkC1, C2: checkC2, C3: checkC3, C5: checkC5 };
