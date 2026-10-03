/**
 * RFC 822 → `ParsedEmail` with postal-mime 3.0.1 (DESIGN.md §5.5 step 2; FREE-TIER.md §4.6).
 *
 * Input is hostile: the raw size is bounded before parsing (postal-mime bounds nesting depth and
 * header bytes but not breadth), limits are set explicitly, and nothing from the message is ever
 * put into an error message.
 */
import PostalMime, { decodeWords } from "postal-mime";
import type { Attachment as PmAttachment, Header as PmHeader } from "postal-mime";
import type {
  Address,
  AttachmentMeta,
  Header,
  InlinePart,
  LedgerSkipReason,
  ParsedEmail,
} from "../types";
import { collapseWhitespace, safeSlice, stripControl, stripInvisible } from "../util/text";
import { parseCalendar } from "./calendar";

/** Parser limits. Exported so callers and tests can reason about them. */
export const MIME_LIMITS = {
  /** Raw message bytes accepted (Gmail's 25 MB cap plus base64/transfer overhead). */
  maxBytes: 40 * 1024 * 1024,
  /** MIME part nesting depth (real mail rarely exceeds 6–8). */
  maxNestingDepth: 32,
  /** Header bytes across all parts (postal-mime counts every part's headers together). */
  maxHeadersSize: 512 * 1024,
  /** Inline message/rfc822 recursion (forwards of forwards). */
  maxRfc822NestingDepth: 3,
  /** Inline images kept for rendering (DESIGN.md §5.2). */
  maxInlineImages: 10,
  maxInlineImageBytes: 1024 * 1024,
  /** Attachment metadata entries kept. */
  maxAttachments: 200,
  /** Recipients kept per address header. */
  maxAddresses: 500,
} as const;

export type MimeParseErrorCode = "empty" | "too_large" | "unparseable";

/**
 * Thrown only when nothing usable can be parsed. `ledgerReason` is the `message_ledger.reason`
 * the pipeline records (DATA-MODEL.md §3). The message never contains email content.
 */
export class MimeParseError extends Error {
  readonly code: MimeParseErrorCode;
  readonly ledgerReason: Extract<LedgerSkipReason, "parse_error" | "too_large">;

  constructor(code: MimeParseErrorCode, message: string) {
    super(message);
    this.name = "MimeParseError";
    this.code = code;
    this.ledgerReason = code === "too_large" ? "too_large" : "parse_error";
  }
}

export interface ParseMimeOptions {
  /** Override the raw-size cap (bytes). */
  maxBytes?: number;
}

/** Headers whose values are structured tokens; RFC 2047 decoding is never applied to them. */
const NO_DECODE = new Set([
  "authentication-results",
  "arc-authentication-results",
  "arc-message-signature",
  "arc-seal",
  "dkim-signature",
  "received",
  "received-spf",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "content-type",
  "content-transfer-encoding",
  "message-id",
  "references",
  "in-reply-to",
  "return-path",
]);

/** A header name as RFC 5322 defines it: printable ASCII except colon, no spaces. */
const HEADER_NAME_RE = /^[!-9;-~]{1,128}$/;

/** Headers whose presence shows the input really was an email. */
const KNOWN_HEADERS = new Set([
  "from",
  "to",
  "subject",
  "date",
  "message-id",
  "content-type",
  "mime-version",
  "received",
  "return-path",
  "delivered-to",
  "reply-to",
  "sender",
  "dkim-signature",
  "authentication-results",
  "list-unsubscribe",
]);

function byteLengthOf(raw: Uint8Array | ArrayBuffer | string): number {
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  return raw.byteLength;
}

function contentBytes(content: PmAttachment["content"]): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

function cleanHeaderValue(name: string, value: string): string {
  let v = stripControl(value.replace(/[\r\n]+/g, " ")).trim();
  if (!NO_DECODE.has(name) && v.includes("=?")) {
    try {
      v = stripControl(decodeWords(v)).trim();
    } catch {
      // keep the undecoded value
    }
  }
  return v;
}

function cleanName(name: string | undefined): string | null {
  if (!name) return null;
  let n = collapseWhitespace(stripInvisible(stripControl(name)));
  if (n.length >= 2 && n.startsWith('"') && n.endsWith('"')) n = n.slice(1, -1).trim();
  n = safeSlice(n, 200);
  return n.length > 0 ? n : null;
}

/** RFC 5322 dot-atom-text (atext extended with UTF-8 per RFC 6532). */
const DOT_ATOM_RE =
  /^[\w!#$%&'*+\-/=?^`{|}~\u0080-\uffff]+(?:\.[\w!#$%&'*+\-/=?^`{|}~\u0080-\uffff]+)*$/;

/** Non-ASCII characters that are not atext in practice: Unicode spaces, C1 controls, invisibles. */
const NOT_ATEXT_RE = /[\s\u0080-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;

/**
 * `"x"@a.example` and `x@a.example` are the same mailbox (RFC 5322 3.4.1), so a quoted local
 * part whose content is a plain dot-atom loses its quotes, as in postal-mime. Local parts that
 * genuinely need quoting (spaces, `@`, `"`, `\`, ...) stay quoted. `escaped` says whether the
 * quoted-pairs are still escaped (angle form); the bare-form lexer has already unescaped them,
 * and unescaping twice would turn `"\\x"` (a backslash then x) into `x`.
 */
function unquoteLocalPart(rawAddress: string, escaped: boolean): string {
  const at = rawAddress.lastIndexOf("@");
  if (at < 0) return rawAddress;
  const local = rawAddress.slice(0, at).trim();
  if (local.length < 2 || !local.startsWith('"') || !local.endsWith('"')) return rawAddress;
  let content = local.slice(1, -1);
  if (escaped) content = content.replace(/\\([\s\S])/g, "$1");
  return DOT_ATOM_RE.test(content) && !NOT_ATEXT_RE.test(content)
    ? content + rawAddress.slice(at)
    : rawAddress;
}

function toAddress(rawAddress: string, rawName: string, escaped: boolean): Address | null {
  const address = unquoteLocalPart(rawAddress, escaped).replace(/\s+/g, "").toLowerCase();
  if (address.length < 3 || address.length > 320) return null;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  let name = rawName;
  if (name.includes("=?")) {
    try {
      name = decodeWords(name);
    } catch {
      // keep the undecoded name
    }
  }
  return { address, name: cleanName(name) };
}

/** An addr-spec written without angle brackets (`a@b.example`, `"a b"@c.example`). */
const BARE_ADDR_SPEC_RE = /^(?:"[^"]*"|[^@\s"]+)@[^@\s"]+$/;

interface PhraseWord {
  text: string;
  quoted: boolean;
}

/** Builds one mailbox from its literal parts; encoded-words are decoded in the name only. */
function toMailbox(words: PhraseWord[], angle: string | null, comment: string): Address | null {
  let address = angle;
  let nameWords = words;
  if (address === null) {
    // Quoted strings and encoded-words are display text, never an address. The first
    // addr-spec wins (as in postal-mime); any later one stays in the name.
    const i = words.findIndex(
      (w) => !w.quoted && !w.text.includes("=?") && BARE_ADDR_SPEC_RE.test(w.text),
    );
    if (i < 0) return null;
    address = (words[i] as PhraseWord).text;
    nameWords = words.filter((_, j) => j !== i);
  } else if (address.trimStart().startsWith("@")) {
    // Obsolete source route `<@relay:user@host>`: the mailbox is after the last colon.
    address = address.slice(address.lastIndexOf(":") + 1);
  }
  const name = nameWords.map((w) => w.text).join(" ");
  // A bare addr-spec comes from the lexer with its quoted-pairs already unescaped.
  return toAddress(address, name.trim() ? name : comment, angle !== null);
}

/**
 * Parses one raw (undecoded) RFC 5322 address-list header value into `out`.
 *
 * postal-mime 3.0.1's addressParser decodes a mailbox written only as encoded-words and
 * re-parses the result, so `From: =?utf-8?Q?=3Csecurity=40paypal.com=3E?=` came back as
 * security@paypal.com. Here the list is split and every address is taken from literal text
 * before anything is decoded: an encoded `,` `;` `<` `>` `:` or `@` can never add a mailbox
 * or change an address. Entries without a usable `@` are dropped. Linear in the input.
 */
function parseAddressHeader(value: string, out: Address[]): void {
  let words: PhraseWord[] = [];
  let word = "";
  let angle: string | null = null;
  let comment = "";
  let inQuote = false;
  let inAngle = false;
  let depth = 0; // comment nesting
  const endWord = () => {
    if (word) words.push({ text: word, quoted: false });
    word = "";
  };
  const flush = () => {
    endWord();
    if (out.length < MIME_LIMITS.maxAddresses) {
      const a = toMailbox(words, angle, comment.trim());
      if (a) out.push(a);
    }
    words = [];
    angle = null;
    comment = "";
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (depth > 0) {
      if (ch === "\\" && i + 1 < value.length) {
        comment += value[++i];
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth > 0) comment += ch;
    } else if (inQuote) {
      if (ch === "\\" && i + 1 < value.length) word += value[++i];
      else if (ch === '"') {
        inQuote = false;
        // A quoted local part (`"a b"@c.example`) stays literal and joins the addr-spec.
        if (value[i + 1] === "@") word = `"${word}"`;
        else {
          if (word) words.push({ text: word, quoted: true });
          word = "";
        }
      } else word += ch;
    } else if (ch === "(") {
      endWord();
      depth = 1;
      if (comment) comment += " ";
    } else if (inAngle) {
      // A second `<` restarts the address (Apple Mail drops text before the last one).
      if (ch === ">") inAngle = false;
      else if (ch === "<") angle = "";
      else angle += ch;
    } else if (ch === '"') {
      endWord();
      inQuote = true;
    } else if (ch === "<") {
      endWord();
      // Only the first angle address counts; a later one is display text (brackets dropped).
      if (angle === null) {
        angle = "";
        inAngle = true;
      }
    } else if (ch === ":" && angle === null) {
      // Group name: discard it, keep the members.
      word = "";
      words = [];
      comment = "";
    } else if (ch === "," || ch === ";") {
      flush();
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch !== ">") {
      word += ch;
    }
  }
  flush();
}

/**
 * Address lists re-derived from the raw header values postal-mime keeps undecoded, never from
 * its parsed `from`/`to`/`cc`/`replyTo` (see `parseAddressHeader`). Every occurrence of the
 * header is parsed separately, so an unclosed quote in one cannot swallow the next.
 */
function addressesOf(rawHeaders: readonly PmHeader[], key: string): Address[] {
  const out: Address[] = [];
  for (const h of rawHeaders) {
    if (h.key === key && h.value) parseAddressHeader(h.value, out);
  }
  return out;
}

/** The first mailbox of the first From header (as postal-mime picks it). */
function fromAddress(rawHeaders: readonly PmHeader[]): Address | null {
  const h = rawHeaders.find((x) => x.key === "from");
  if (!h?.value) return null;
  const out: Address[] = [];
  parseAddressHeader(h.value, out);
  return out[0] ?? null;
}

function cleanCid(cid: string | undefined): string | null {
  if (!cid) return null;
  const c = cid
    .trim()
    .replace(/^<+|>+$/g, "")
    .trim()
    .toLowerCase();
  return c.length > 0 && c.length <= 512 ? c : null;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const year = d.getUTCFullYear();
  return year >= 1970 && year <= 2200 ? d : null;
}

function nonEmpty(s: string | undefined): string | null {
  return typeof s === "string" && s.trim().length > 0 ? s : null;
}

/**
 * Parses a raw RFC 822 message. Throws `MimeParseError` for empty or over-size input, or when
 * the parser fails / finds neither known headers nor a body.
 */
export async function parseMime(
  raw: Uint8Array | ArrayBuffer | string,
  options: ParseMimeOptions = {},
): Promise<ParsedEmail> {
  const maxBytes = options.maxBytes ?? MIME_LIMITS.maxBytes;
  const size = byteLengthOf(raw);
  if (size === 0) throw new MimeParseError("empty", "empty message");
  if (size > maxBytes) throw new MimeParseError("too_large", "message exceeds size limit");

  let email;
  try {
    email = await PostalMime.parse(raw, {
      maxNestingDepth: MIME_LIMITS.maxNestingDepth,
      maxHeadersSize: MIME_LIMITS.maxHeadersSize,
      maxRfc822NestingDepth: MIME_LIMITS.maxRfc822NestingDepth,
      attachmentEncoding: "arraybuffer",
    });
  } catch {
    throw new MimeParseError("unparseable", "MIME parser rejected the message");
  }

  const headers: Header[] = [];
  for (const h of email.headers) {
    const name = (h.key ?? "").trim().toLowerCase();
    if (!HEADER_NAME_RE.test(name)) continue;
    headers.push({ name, value: cleanHeaderValue(name, h.value ?? "") });
  }

  const html = nonEmpty(email.html);
  const text = nonEmpty(email.text);
  const usable = html !== null || text !== null || headers.some((h) => KNOWN_HEADERS.has(h.name));
  if (!usable) throw new MimeParseError("unparseable", "no usable headers or body");

  let hasCalendar = false;
  let hasAmp = false;
  let calendarStart: Date | null = null;
  let calendarMethod: string | null = null;
  const attachments: AttachmentMeta[] = [];
  const inline: InlinePart[] = [];

  for (const a of email.attachments) {
    const mimeType = (a.mimeType || "application/octet-stream").trim().toLowerCase();
    if (mimeType === "text/x-amp-html") {
      hasAmp = true;
      continue;
    }
    const bytes =
      a.content === undefined || a.content === null ? new Uint8Array(0) : contentBytes(a.content);
    if (mimeType === "text/calendar" || mimeType === "application/ics") {
      if (!hasCalendar) {
        const cal = parseCalendar(bytes);
        calendarStart = cal.start;
        calendarMethod = cal.method ?? (a.method ? a.method.toUpperCase() : null);
      }
      hasCalendar = true;
    }
    const contentId = cleanCid(a.contentId);
    if (attachments.length < MIME_LIMITS.maxAttachments) {
      attachments.push({
        filename: cleanName(a.filename ?? undefined),
        mimeType,
        size: bytes.byteLength,
        disposition: a.disposition ?? null,
        contentId,
      });
    }
    if (
      contentId &&
      mimeType.startsWith("image/") &&
      mimeType !== "image/svg+xml" &&
      !a.rfc822DepthExceeded &&
      inline.length < MIME_LIMITS.maxInlineImages &&
      bytes.byteLength > 0 &&
      bytes.byteLength <= MIME_LIMITS.maxInlineImageBytes
    ) {
      inline.push({ cid: contentId, mimeType, content: bytes });
    }
  }

  const subjectRaw = nonEmpty(email.subject);
  const subject = subjectRaw
    ? safeSlice(collapseWhitespace(stripInvisible(stripControl(subjectRaw))), 998)
    : null;
  const messageIdRaw = nonEmpty(email.messageId);

  return {
    headers,
    messageId: messageIdRaw ? safeSlice(messageIdRaw.trim(), 998) : null,
    subject: subject && subject.length > 0 ? subject : null,
    from: fromAddress(email.headers),
    replyTo: addressesOf(email.headers, "reply-to"),
    to: addressesOf(email.headers, "to"),
    cc: addressesOf(email.headers, "cc"),
    date: parseDate(email.date),
    html,
    htmlBytes: html ? Buffer.byteLength(html, "utf8") : 0,
    text,
    hasCalendar,
    hasAmp,
    attachments,
    inline,
    calendarStart,
    calendarMethod,
  };
}
