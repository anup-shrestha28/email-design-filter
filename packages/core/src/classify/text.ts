/** Normalised text views shared by the classifiers (computed once per email, memoised). */
import type { ContentExtract, ParsedEmail } from "../types";
import { normalizeForMatch } from "../util/text";

export interface TextView {
  /** NFKC lower-cased subject. */
  subject: string;
  /** NFKC lower-cased visible text (≤ 4,000 chars, preheader first). */
  body: string;
  /** First ~600 characters of `body` — where CAN-SPAM's primary purpose lives. */
  head: string;
  /** subject + "\n" + body. */
  all: string;
}

const cache = new WeakMap<ContentExtract, Map<string, TextView>>();

/** Text view for an email; `content` may be null for headers-only (metadata) evaluation. */
export function textView(parsed: ParsedEmail, content: ContentExtract | null): TextView {
  const subjectRaw = parsed.subject ?? "";
  if (content) {
    const byContent = cache.get(content);
    const hit = byContent?.get(subjectRaw);
    if (hit) return hit;
  }
  const subject = normalizeForMatch(subjectRaw);
  const body = content ? normalizeForMatch(content.visibleText) : "";
  const view: TextView = { subject, body, head: body.slice(0, 600), all: `${subject}\n${body}` };
  if (content) {
    let byContent = cache.get(content);
    if (!byContent) {
      byContent = new Map();
      cache.set(content, byContent);
    }
    byContent.set(subjectRaw, view);
  }
  return view;
}
