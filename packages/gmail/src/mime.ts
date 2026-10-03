/**
 * Minimal, allocation-bounded MIME header helpers for the Gmail payload adapter:
 * RFC 2047 encoded-words, Content-Type/Disposition parameters, RFC 5322 address lists.
 * Inputs are hostile: every loop is linear in the input length.
 */
import type { Address } from "@edf/core";

/** Decode bytes in a MIME charset (Node has full ICU); unknown labels fall back to UTF-8. */
export function decodeCharset(bytes: Uint8Array, charset: string | null | undefined): string {
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function normalizeCharset(charset: string | null | undefined): string {
  if (!charset) return "utf-8";
  const c = charset
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "");
  if (c === "" || c === "us-ascii" || c === "ascii" || c === "ansi_x3.4-1968") return "utf-8";
  if (c === "utf8") return "utf-8";
  return c.length > 40 ? "utf-8" : c;
}

const ENCODED_WORD = /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]*)\?=/g;

function decodeQ(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/**
 * Decode RFC 2047 encoded-words. Whitespace between adjacent encoded-words is dropped, and
 * adjacent words in the same charset are decoded together so a multi-byte character split
 * across two words survives.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  const parts: Array<{ text: string } | { charset: string; bytes: Uint8Array }> = [];
  let last = 0;
  for (const m of value.matchAll(ENCODED_WORD)) {
    const start = m.index;
    const between = value.slice(last, start);
    const prev = parts[parts.length - 1];
    if (between.length > 0 && !(prev && "charset" in prev && /^[ \t\r\n]+$/.test(between))) {
      parts.push({ text: between });
    }
    const charset = (m[1] as string).split("*")[0] ?? "utf-8";
    const enc = (m[2] as string).toUpperCase();
    const payload = m[3] as string;
    const bytes = enc === "B" ? Uint8Array.from(Buffer.from(payload, "base64")) : decodeQ(payload);
    const tail = parts[parts.length - 1];
    if (tail && "charset" in tail && tail.charset.toLowerCase() === charset.toLowerCase()) {
      const merged = new Uint8Array(tail.bytes.length + bytes.length);
      merged.set(tail.bytes);
      merged.set(bytes, tail.bytes.length);
      tail.bytes = merged;
    } else parts.push({ charset, bytes });
    last = start + m[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts.map((p) => ("text" in p ? p.text : decodeCharset(p.bytes, p.charset))).join("");
}

/** Unfold a header value (RFC 5322 §2.2.3) and decode encoded-words. */
export function decodeHeaderValue(value: string): string {
  return decodeEncodedWords(value.replace(/\r?\n[ \t]+/g, " ")).trim();
}

export interface ParsedParams {
  /** Lower-cased value before the first `;`, e.g. "text/html" or "attachment". */
  value: string;
  /** Lower-cased parameter names; values unquoted. */
  params: Record<string, string>;
}

/** Parse `type/subtype; a=b; c="d"` (Content-Type, Content-Disposition). */
export function parseParams(header: string | null | undefined): ParsedParams {
  if (!header) return { value: "", params: {} };
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  const s = header.slice(0, 8192);
  let i = s.indexOf(";");
  const value = (i === -1 ? s : s.slice(0, i)).trim().toLowerCase();
  while (i !== -1 && i < s.length) {
    i++;
    const eq = s.indexOf("=", i);
    if (eq === -1) break;
    const name = s.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (s[j] === " " || s[j] === "\t") j++;
    let v = "";
    if (s[j] === '"') {
      j++;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) j++;
        v += s[j];
        j++;
      }
      i = s.indexOf(";", j);
    } else {
      const end = s.indexOf(";", j);
      v = (end === -1 ? s.slice(j) : s.slice(j, end)).trim();
      i = end;
    }
    if (name && /^[a-z0-9*_.-]{1,64}$/.test(name) && !(name in params)) params[name] = v;
  }
  return { value, params };
}

/**
 * Parse an RFC 5322 address list: `"Name" <a@b>`, `Name <a@b>`, `a@b (Name)`, groups
 * (`Team: a@b, c@d;`). Addresses are lower-cased; display names are decoded (RFC 2047).
 * Pass the raw, undecoded header value: display names are decoded only after the list is split,
 * so an encoded `,` `<` or `@` can never become structure. Entries without a usable `@` are
 * dropped, as on the postal-mime path.
 */
export function parseAddressList(header: string | null | undefined): Address[] {
  if (!header) return [];
  const s = header.slice(0, 16_384);
  const out: Address[] = [];
  let buf = "";
  let comment = "";
  let inQuote = false;
  let depth = 0; // comment nesting
  let inAngle = false;
  const flush = () => {
    const a = parseMailbox(buf, comment);
    if (a) out.push(a);
    buf = "";
    comment = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (depth > 0) {
      if (ch === "\\" && i + 1 < s.length) {
        comment += s[++i];
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth > 0) comment += ch;
      continue;
    }
    if (inQuote) {
      if (ch === "\\" && i + 1 < s.length) {
        buf += s[++i];
        continue;
      }
      if (ch === '"') inQuote = false;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      buf += ch;
    } else if (ch === "(") {
      depth = 1;
      comment = comment ? `${comment} ` : "";
    } else if (ch === "<") {
      inAngle = true;
      buf += ch;
    } else if (ch === ">") {
      inAngle = false;
      buf += ch;
    } else if (!inAngle && ch === ":" && !buf.includes("<")) {
      // Group name: discard it, keep the members.
      buf = "";
      comment = "";
    } else if (!inAngle && (ch === "," || ch === ";")) {
      flush();
    } else buf += ch;
  }
  flush();
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

function parseMailbox(raw: string, comment: string): Address | null {
  const text = raw.trim();
  if (!text) return null;
  const lt = text.lastIndexOf("<");
  const gt = text.lastIndexOf(">");
  let address: string;
  let name: string | null;
  if (lt !== -1 && gt > lt) {
    address = text.slice(lt + 1, gt).trim();
    const n = unquote(text.slice(0, lt)).trim();
    name = n ? decodeHeaderValue(n) : null;
  } else {
    address = unquote(text).trim();
    name = null;
  }
  if (!name && comment.trim()) name = decodeHeaderValue(comment.trim());
  address = address.replace(/\s+/g, "").toLowerCase();
  const at = address.lastIndexOf("@");
  if (address.length > 320 || at <= 0 || at === address.length - 1) return null;
  return { address, name: name && name.length > 0 ? name.slice(0, 512) : null };
}

/** Parse a Date header; null if absent or invalid. */
export function parseMailDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const cleaned = value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const t = Date.parse(cleaned);
  return Number.isNaN(t) ? null : new Date(t);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the HTML entities Gmail uses in `snippet` (numeric plus a few named ones). */
export function decodeSnippetEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}
