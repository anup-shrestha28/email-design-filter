/**
 * A linear-time HTML tag tokenizer for pre-parse passes over hostile markup (nesting limiter,
 * image-reference scan). It understands comments, quoted attribute values and raw-text elements.
 * An over-long pseudo-tag (no ">" within `maxTagLength`) is skipped as text *from where the scan
 * stopped*, so no input position is scanned more than a bounded number of times.
 */

export interface TagToken {
  /** Lower-case tag name. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Raw attribute source (between the name and ">"). */
  attrs: string;
  /** Offsets of "<" and just past ">". */
  start: number;
  end: number;
  /** For raw-text elements (script, style, …): the text up to the closing tag. */
  rawText?: string;
}

export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes",
  "iframe",
  "noscript",
  "plaintext",
]);

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isNameChar(c: number): boolean {
  return isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
}

/**
 * Calls `visit` for every tag in document order. Returning `false` from `visit` stops the scan.
 */
export function forEachTag(
  html: string,
  visit: (tag: TagToken) => boolean | void,
  opts: { maxTagLength?: number; maxTags?: number } = {},
): void {
  const maxTagLength = opts.maxTagLength ?? 8192;
  let budget = opts.maxTags ?? Number.POSITIVE_INFINITY;
  const n = html.length;
  let i = 0;
  while (i < n && budget-- > 0) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return;
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      if (e < 0) return;
      i = e + 3;
      continue;
    }
    let j = lt + 1;
    const closing = html.charCodeAt(j) === 47; // "/"
    if (closing) j++;
    if (!isLetter(html.charCodeAt(j))) {
      const next = html.charCodeAt(lt + 1);
      if (next === 33 || next === 63) {
        // <!DOCTYPE …> / <?xml …?>
        const e = html.indexOf(">", lt + 2);
        if (e < 0) return;
        i = e + 1;
      } else {
        i = lt + 1;
      }
      continue;
    }
    let k = j;
    while (k < n && k - j < 64 && isNameChar(html.charCodeAt(k))) k++;
    const name = html.slice(j, k).toLowerCase();
    const limit = Math.min(n, lt + maxTagLength);
    let p = k;
    let quote = 0;
    while (p < limit) {
      const ch = html.charCodeAt(p);
      if (quote !== 0) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) {
        quote = ch;
      } else if (ch === 62) {
        break;
      }
      p++;
    }
    if (p >= limit) {
      if (limit >= n) return;
      i = p; // skip the over-long pseudo-tag from here; never rescan it
      continue;
    }
    const attrs = html.slice(k, p);
    const token: TagToken = {
      name,
      closing,
      selfClosing: html.charCodeAt(p - 1) === 47,
      attrs,
      start: lt,
      end: p + 1,
    };
    if (!closing && RAW_TEXT_ELEMENTS.has(name) && !token.selfClosing) {
      const closeRe = new RegExp(`</${name}(?![a-zA-Z0-9:-])`, "gi");
      closeRe.lastIndex = token.end;
      const close = closeRe.exec(html);
      const stop = close ? close.index : n;
      token.rawText = html.slice(token.end, stop);
      if (visit(token) === false) return;
      i = stop; // the closing tag is tokenized next
      continue;
    }
    if (visit(token) === false) return;
    i = token.end;
  }
}
