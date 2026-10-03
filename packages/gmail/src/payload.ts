/**
 * Gmail payload adapter (DESIGN.md §5.2; DECISIONS.md G3): turns a `format=full` message into
 * the same `ParsedEmail` contract postal-mime produces for `format=raw`. Used only when the raw
 * message exceeds its size cap. Content stays in memory and is never logged or persisted.
 *
 *  - Walks the MIME tree iteratively (depth ≤ 64, ≤ 1,000 parts).
 *  - Body `data` is base64url of the *transfer-decoded* bytes; the charset comes from the part's
 *    Content-Type and is decoded with TextDecoder.
 *  - A text/html or text/plain body delivered as `attachmentId` is fetched through the
 *    caller's callback (which reserves quota and calls `attachments.get`) with a byte cap.
 *  - Attachments are metadata only; inline (`cid:`) images are omitted (`inline: []`).
 */
import type { AttachmentMeta, GmailMessageMeta, Header, ParsedEmail } from "@edf/core";
import { GmailError } from "./errors";
import {
  decodeCharset,
  decodeHeaderValue,
  decodeSnippetEntities,
  parseAddressList,
  parseMailDate,
  parseParams,
} from "./mime";
import type { GmailMessage, GmailMessagePart } from "./schemas";
import { decodeBase64Url } from "./util";

/** Fetch an attachment body (decoded bytes), refusing anything larger than `maxBytes`. */
export type FetchAttachment = (
  attachmentId: string,
  opts: { maxBytes: number },
) => Promise<Uint8Array>;

export interface PayloadAdapterOptions {
  /** Cap per text body part (decoded bytes). Default 2 MiB. */
  maxBodyBytes?: number;
  /** Cap on all text bodies together. Default 4 MiB. */
  maxTotalBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_PARTS = 1000;
const METHOD = "users.messages.get";

interface Node {
  part: GmailMessagePart;
  depth: number;
  /** Index of the nearest multipart/alternative ancestor that is this node's direct parent, else -1. */
  alternativeParent: number;
}

interface BodyCandidate {
  kind: "html" | "text";
  part: GmailMessagePart;
  charset: string | null;
  alternativeParent: number;
  order: number;
}

function headerOf(part: GmailMessagePart, name: string): string | null {
  const h = part.headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

/**
 * Build a `ParsedEmail` from a `format=full` message. Throws `GmailError("too_large")` when a
 * body exceeds its cap and `GmailError("bad_response")` for malformed payloads.
 */
export async function parsedFromGmailPayload(
  message: GmailMessage,
  fetchAttachment: FetchAttachment,
  opts: PayloadAdapterOptions = {},
): Promise<ParsedEmail> {
  const root = message.payload;
  if (!root) throw new GmailError("bad_response", { method: METHOD, reason: "no_payload" });
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTotal = opts.maxTotalBodyBytes ?? DEFAULT_MAX_TOTAL_BODY_BYTES;

  const rawHeaders = root.headers ?? [];
  const headers: Header[] = rawHeaders.map((h) => ({
    name: h.name.toLowerCase(),
    value: decodeHeaderValue(h.value),
  }));
  const first = (name: string): string | null =>
    headers.find((h) => h.name === name)?.value ?? null;
  // Address lists are parsed from the undecoded value: an encoded-word may carry `,` `<` `@`,
  // which must stay inside the display name (parseAddressList decodes names after splitting).
  const addresses = (name: string) =>
    parseAddressList(rawHeaders.find((h) => h.name.toLowerCase() === name)?.value);

  // Iterative DFS in document order.
  const candidates: BodyCandidate[] = [];
  const attachments: AttachmentMeta[] = [];
  let hasCalendar = false;
  let hasAmp = false;
  let count = 0;
  let altCounter = 0;
  const stack: Node[] = [{ part: root, depth: 0, alternativeParent: -1 }];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (++count > MAX_PARTS || node.depth > MAX_DEPTH) {
      throw new GmailError("bad_response", { method: METHOD, reason: "mime_too_complex" });
    }
    const { part } = node;
    const ct = parseParams(headerOf(part, "content-type"));
    const mimeType = (part.mimeType || ct.value || "text/plain").toLowerCase();
    if (mimeType.startsWith("multipart/")) {
      const altId = mimeType === "multipart/alternative" ? ++altCounter : -1;
      const children = part.parts ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({
          part: children[i] as GmailMessagePart,
          depth: node.depth + 1,
          alternativeParent: altId,
        });
      }
      continue;
    }
    const disposition = parseParams(headerOf(part, "content-disposition")).value;
    const filename = part.filename && part.filename.length > 0 ? part.filename : null;
    if (mimeType === "text/calendar" || mimeType === "application/ics") hasCalendar = true;
    if (mimeType === "text/x-amp-html") {
      hasAmp = true;
      continue;
    }
    const isBody =
      (mimeType === "text/html" || mimeType === "text/plain") &&
      disposition !== "attachment" &&
      filename === null;
    if (isBody) {
      candidates.push({
        kind: mimeType === "text/html" ? "html" : "text",
        part,
        charset: ct.params.charset ?? null,
        alternativeParent: node.alternativeParent,
        order: candidates.length,
      });
      continue;
    }
    const cid = headerOf(part, "content-id");
    attachments.push({
      filename,
      mimeType,
      size: part.body?.size ?? 0,
      disposition:
        disposition === "attachment" ? "attachment" : disposition === "inline" ? "inline" : null,
      contentId: cid ? cid.trim().replace(/^<|>$/g, "").toLowerCase() || null : null,
    });
  }

  // Within one multipart/alternative keep only the last candidate of each kind (RFC 2046:
  // the last alternative is the richest); elsewhere concatenate in document order.
  const chosen = candidates.filter(
    (c) =>
      c.alternativeParent === -1 ||
      !candidates.some(
        (o) =>
          o.kind === c.kind && o.alternativeParent === c.alternativeParent && o.order > c.order,
      ),
  );

  let totalBytes = 0;
  const decodeBody = async (c: BodyCandidate): Promise<string> => {
    const body = c.part.body ?? {};
    let bytes: Uint8Array;
    if (body.data !== undefined) {
      const decoded = decodeBase64Url(body.data);
      if (!decoded)
        throw new GmailError("bad_response", { method: METHOD, reason: "bad_body_encoding" });
      bytes = decoded;
    } else if (body.attachmentId) {
      const remaining = Math.min(maxBody, maxTotal - totalBytes);
      if ((body.size ?? 0) > remaining) throw new GmailError("too_large", { method: METHOD });
      bytes = await fetchAttachment(body.attachmentId, { maxBytes: remaining });
    } else bytes = new Uint8Array(0);
    if (bytes.byteLength > maxBody) throw new GmailError("too_large", { method: METHOD });
    totalBytes += bytes.byteLength;
    if (totalBytes > maxTotal) throw new GmailError("too_large", { method: METHOD });
    return decodeCharset(bytes, c.charset);
  };

  const htmlParts: string[] = [];
  const textParts: string[] = [];
  for (const c of chosen) {
    const s = await decodeBody(c);
    (c.kind === "html" ? htmlParts : textParts).push(s);
  }
  const html = htmlParts.length > 0 ? htmlParts.join("\n") : null;
  const text = textParts.length > 0 ? textParts.join("\n") : null;
  const from = addresses("from")[0] ?? null;

  return {
    headers,
    messageId: first("message-id")?.trim() || null,
    subject: first("subject"),
    from,
    replyTo: addresses("reply-to"),
    to: addresses("to"),
    cc: addresses("cc"),
    date: parseMailDate(first("date")),
    html,
    htmlBytes: html === null ? 0 : Buffer.byteLength(html, "utf8"),
    text,
    hasCalendar,
    hasAmp,
    attachments,
    inline: [],
  };
}

/**
 * Gmail metadata that accompanies every fetch (`GmailMessageMeta`). Requires `historyId` and
 * `internalDate` in the response (all our `fields=` selectors include them). The snippet's
 * HTML entities are decoded to plain text.
 */
export function metaFromGmailMessage(msg: GmailMessage): GmailMessageMeta {
  if (msg.historyId === undefined || msg.internalDate === undefined) {
    throw new GmailError("bad_response", { method: METHOD, reason: "missing_meta" });
  }
  const ms = Number(msg.internalDate);
  if (!Number.isSafeInteger(ms))
    throw new GmailError("bad_response", { method: METHOD, reason: "bad_date" });
  return {
    id: msg.id,
    threadId: msg.threadId ?? null,
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet === undefined ? null : decodeSnippetEntities(msg.snippet),
    historyId: msg.historyId,
    internalDate: new Date(ms),
    sizeEstimate: msg.sizeEstimate ?? null,
  };
}
