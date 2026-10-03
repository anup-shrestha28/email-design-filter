/**
 * Search text for `email.search_tsv` (DESIGN.md §9.2): subject + sender, plus a short excerpt
 * unless the email is security-sensitive (§7.4: subject and sender only). The excerpt itself is
 * never persisted — only the tsvector built from this string. Font names get no special
 * treatment (they are not indexed, §8.1).
 */
import { collapseWhitespace, stripControl, truncateAtWord } from "../util/text";
import { redactSensitive } from "./redact";

export const MAX_SEARCH_TEXT = 2000;

export interface SearchTextInput {
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  /** Visible-text excerpt (ContentExtract.visibleText). */
  excerpt: string | null;
  securitySensitive: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']{1,2048}/giu;
const EMAIL_RE = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/gu;

/** Builds the string that feeds `to_tsvector('simple', …)` (≤ 2,000 chars). */
export function buildSearchText(input: SearchTextInput): string {
  const subject = input.subject
    ? input.securitySensitive
      ? redactSensitive(input.subject)
      : input.subject
    : "";
  const parts = [subject, input.fromName ?? "", input.fromAddress ?? ""];
  if (!input.securitySensitive && input.excerpt) {
    parts.push(
      redactSensitive(input.excerpt.slice(0, 6000)).replace(URL_RE, " ").replace(EMAIL_RE, " "),
    );
  }
  const text = collapseWhitespace(stripControl(parts.filter((p) => p.length > 0).join(" \n ")));
  return truncateAtWord(text, MAX_SEARCH_TEXT);
}
