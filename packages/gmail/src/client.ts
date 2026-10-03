/**
 * Gmail REST client (DESIGN.md §5.2, §5.5; FREE-TIER.md §4.2, §4.8).
 *
 *  - One client per mailbox: ≤ 4 concurrent requests (FIFO semaphore).
 *  - One transparent retry on 401, after asking the token provider for a token other than the
 *    one that was rejected (forces a refresh under the lease).
 *  - Every response is size-capped while streaming and validated with Zod.
 *  - Errors are typed (`GmailError.kind`) and never carry bodies, tokens or addresses.
 *  - Quota reservation is the caller's job (every call site reserves `UNITS[...]` first, §5.2);
 *    the client never reserves or logs anything.
 *  - Redirects are refused so a bearer token can never be forwarded to another host.
 */
import type { z } from "zod";
import { GmailError, type GmailErrorKind } from "./errors";
import {
  attachmentSchema,
  googleErrorSchema,
  historyListSchema,
  messageSchema,
  messagesListSchema,
  profileSchema,
  type GmailMessage,
  type GmailProfile,
  type HistoryListResponse,
  type MessagesListResponse,
} from "./schemas";
import { decodeBase64Url, isUint64, Semaphore } from "./util";

/**
 * Returns a valid access token. When `rejectedToken` is given (Gmail answered 401 with it),
 * the provider must return a *different* token, refreshing under the lease if needed.
 */
export type GetAccessToken = (opts?: { rejectedToken?: string }) => Promise<string>;

export interface GmailClientOptions {
  getAccessToken: GetAccessToken;
  /** Injectable for tests (HTTP-level fakes). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** ≤ 4 (DESIGN.md §5.2); values above 4 are clamped. */
  maxConcurrent?: number;
  /** Per-request timeout including the body. Default 30 s. */
  timeoutMs?: number;
  /** Default `https://gmail.googleapis.com/gmail/v1/users/me`. */
  baseUrl?: string;
  /** Jitter source for rate-limit backoff (tests). */
  random?: () => number;
  /** Clock for Retry-After dates (tests). */
  now?: () => number;
}

export type HistoryType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";
/** The four history types every poll requests (FREE-TIER.md §4.2 step 3). */
export const HISTORY_TYPES: readonly HistoryType[] = [
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
];

export type MessageFormat = "raw" | "metadata" | "minimal" | "full";

/** Primary-tab mail is fetched headers-only with exactly these fields (DESIGN.md §5.2). */
export const METADATA_FIELDS =
  "id,threadId,labelIds,historyId,internalDate,sizeEstimate,payload/headers";
/** Automated mail: raw RFC 822 for postal-mime (DECISIONS.md D3). */
export const RAW_FIELDS = "id,threadId,labelIds,snippet,historyId,internalDate,sizeEstimate,raw";
/** Fallback when raw exceeds its cap: the parsed MIME tree (large parts arrive as attachmentId). */
export const FULL_FIELDS =
  "id,threadId,labelIds,snippet,historyId,internalDate,sizeEstimate,payload";

/** Default cap for list/history/profile responses. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Default cap for a `format=raw` response (≈ 3 MB of RFC 822 after base64url overhead). */
export const DEFAULT_RAW_MAX_BYTES = 4 * 1024 * 1024;
/** Default cap for a `format=full` response (bodies above Gmail's inline size arrive as attachmentId). */
export const DEFAULT_FULL_MAX_BYTES = 4 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const MAX_CONCURRENT = 4;

/** HTTP body cap for a base64url response whose decoded payload may be `decodedBytes` long. */
export function base64ResponseCap(decodedBytes: number): number {
  return Math.ceil((decodedBytes * 4) / 3) + 16 * 1024;
}

/**
 * Backoff for 429 / 403 rate limits without a usable Retry-After: 1 s → 2 s → … → 64 s, plus up
 * to 1 s of jitter (DESIGN.md §5.5). `attempt` is 1-based.
 */
export function rateLimitBackoffMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(64_000, 1000 * 2 ** Math.min(n - 1, 6));
  return base + Math.floor(Math.min(Math.max(random(), 0), 1) * 1000);
}

/** Parse Retry-After (seconds or HTTP-date) into ms, clamped to [1 s, 15 min]; null if absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const s = value.trim();
  let ms: number;
  if (/^\d{1,7}$/.test(s)) ms = Number(s) * 1000;
  else {
    const at = Date.parse(s);
    if (Number.isNaN(at)) return null;
    ms = at - nowMs;
  }
  return Math.min(15 * 60_000, Math.max(1000, ms));
}

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);
const POLICY_REASONS = new Set(["domainPolicy", "insufficientPermissions", "failedPrecondition"]);
/** Project-level refusals: every mailbox is affected, so they are handled like the daily limit. */
const PROJECT_REASONS = new Set([
  "dailyLimitExceeded",
  "accessNotConfigured",
  "SERVICE_DISABLED",
  "projectNotLinked",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT_PROJECT",
]);

/**
 * Map an HTTP failure to a `GmailErrorKind` (DESIGN.md §5.5). Pure; exported for tests.
 * `notFoundKind` distinguishes a deleted message from an expired history cursor.
 */
export function classifyGmailFailure(
  status: number,
  reason: string | null,
  googleStatus: string | null,
  notFoundKind: "not_found" | "history_expired",
): GmailErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 404) return notFoundKind;
  if (status === 429) return "rate_limited";
  if (status === 403 || status === 400) {
    if (reason && RATE_REASONS.has(reason)) return "rate_limited";
    if (reason && PROJECT_REASONS.has(reason)) return "daily_limit";
    if (reason && POLICY_REASONS.has(reason)) return "policy";
    if (googleStatus === "FAILED_PRECONDITION") return "policy";
    if (googleStatus === "RESOURCE_EXHAUSTED") return "rate_limited";
    return status === 403 ? "policy" : "bad_request";
  }
  if (status >= 500) return "server";
  return "bad_response";
}

const SAFE_REASON = /^[A-Za-z_]{1,64}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,4096}$/;

async function readCapped(res: Response, maxBytes: number, method: string): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new GmailError("too_large", { method, status: res.status });
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GmailError("too_large", { method, status: res.status });
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof GmailError) throw err;
    throw new GmailError("network", { method, status: res.status });
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export interface HistoryListParams {
  /** uint64 decimal string. */
  startHistoryId: string;
  pageToken?: string | undefined;
  /** 1..500, default 500 (FREE-TIER.md §4.2 step 3). */
  maxResults?: number;
  historyTypes?: readonly HistoryType[];
}

export interface MessagesListParams {
  q: string;
  pageToken?: string | undefined;
  /** 1..500, default 500. */
  maxResults?: number;
  includeSpamTrash?: boolean;
  labelIds?: readonly string[];
}

export interface MessagesGetParams {
  format: MessageFormat;
  metadataHeaders?: readonly string[];
  /** Gmail partial-response `fields=` selector, e.g. `METADATA_FIELDS`. */
  fields?: string;
  /** Cap on the HTTP response body (encoded JSON), enforced while streaming. */
  maxBytes?: number;
}

export class GmailClient {
  private readonly getToken: GetAccessToken;
  private readonly fetchImpl: typeof fetch;
  private readonly sem: Semaphore;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly random: () => number;
  private readonly now: () => number;
  private rateLimitStreak = 0;

  constructor(opts: GmailClientOptions) {
    this.getToken = opts.getAccessToken;
    this.fetchImpl = opts.fetch ?? fetch;
    const limit = Math.min(
      MAX_CONCURRENT,
      Math.max(1, Math.floor(opts.maxConcurrent ?? MAX_CONCURRENT)),
    );
    this.sem = new Semaphore(limit);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.baseUrl = (opts.baseUrl ?? "https://gmail.googleapis.com/gmail/v1/users/me").replace(
      /\/+$/,
      "",
    );
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** Requests currently in flight (≤ 4). */
  get inFlight(): number {
    return this.sem.inFlight;
  }

  /** `users.getProfile` (1 unit): the address and the current historyId. */
  async getProfile(): Promise<GmailProfile> {
    return this.call("users.getProfile", "/profile", new URLSearchParams(), profileSchema, {});
  }

  /**
   * `users.history.list` (2 units). A 404 means the cursor is outside Gmail's history window:
   * it surfaces as `GmailError("history_expired")` (FREE-TIER.md §4.2 step 9).
   */
  async historyList(p: HistoryListParams): Promise<HistoryListResponse> {
    if (!isUint64(p.startHistoryId))
      throw new TypeError("historyList: startHistoryId must be a uint64 string");
    const q = new URLSearchParams({
      startHistoryId: p.startHistoryId,
      maxResults: String(clampMax(p.maxResults)),
    });
    for (const t of p.historyTypes ?? HISTORY_TYPES) {
      if (!HISTORY_TYPES.includes(t)) throw new TypeError("historyList: unknown history type");
      q.append("historyTypes", t);
    }
    if (p.pageToken) q.set("pageToken", p.pageToken);
    return this.call("users.history.list", "/history", q, historyListSchema, {
      notFoundKind: "history_expired",
    });
  }

  /** `users.messages.list` (5 units per page of ≤ 500 ids). */
  async messagesList(p: MessagesListParams): Promise<MessagesListResponse> {
    if (typeof p.q !== "string" || p.q.length > 2048)
      throw new TypeError("messagesList: invalid q");
    const q = new URLSearchParams({ q: p.q, maxResults: String(clampMax(p.maxResults)) });
    if (p.includeSpamTrash) q.set("includeSpamTrash", "true");
    for (const l of p.labelIds ?? []) q.append("labelIds", l);
    if (p.pageToken) q.set("pageToken", p.pageToken);
    return this.call("users.messages.list", "/messages", q, messagesListSchema, {});
  }

  /**
   * `users.messages.get` (20 units, any format). `maxBytes` caps the HTTP body while streaming;
   * exceeding it throws `GmailError("too_large")` without reading the rest.
   */
  async messagesGet(id: string, p: MessagesGetParams): Promise<GmailMessage> {
    if (!MESSAGE_ID.test(id)) throw new TypeError("messagesGet: invalid message id");
    const q = new URLSearchParams({ format: p.format });
    for (const h of p.metadataHeaders ?? []) q.append("metadataHeaders", h);
    if (p.fields) q.set("fields", p.fields);
    const cap =
      p.maxBytes ??
      (p.format === "raw"
        ? DEFAULT_RAW_MAX_BYTES
        : p.format === "full"
          ? DEFAULT_FULL_MAX_BYTES
          : DEFAULT_MAX_RESPONSE_BYTES);
    return this.call("users.messages.get", `/messages/${id}`, q, messageSchema, { maxBytes: cap });
  }

  /**
   * `users.messages.attachments.get` (20 units). Returns the decoded bytes; `maxBytes` caps the
   * decoded size (the HTTP body cap is derived from it).
   */
  async attachmentsGet(
    messageId: string,
    attachmentId: string,
    p: { maxBytes: number },
  ): Promise<Uint8Array> {
    if (!MESSAGE_ID.test(messageId)) throw new TypeError("attachmentsGet: invalid message id");
    if (!ATTACHMENT_ID.test(attachmentId))
      throw new TypeError("attachmentsGet: invalid attachment id");
    const method = "users.messages.attachments.get";
    const res = await this.call(
      method,
      `/messages/${messageId}/attachments/${attachmentId}`,
      new URLSearchParams(),
      attachmentSchema,
      { maxBytes: base64ResponseCap(p.maxBytes) },
    );
    const bytes = decodeBase64Url(res.data);
    if (!bytes) throw new GmailError("bad_response", { method });
    if (bytes.byteLength > p.maxBytes) throw new GmailError("too_large", { method });
    return bytes;
  }

  private async call<S extends z.ZodType>(
    method: string,
    path: string,
    query: URLSearchParams,
    schema: S,
    opts: { maxBytes?: number; notFoundKind?: "not_found" | "history_expired" },
  ): Promise<z.infer<S>> {
    return this.sem.run(async () => {
      let token = await this.getToken();
      let res = await this.send(method, path, query, token);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        token = await this.getToken({ rejectedToken: token });
        res = await this.send(method, path, query, token);
      }
      if (!res.ok) throw await this.toError(method, res, opts.notFoundKind ?? "not_found");
      this.rateLimitStreak = 0;
      const bytes = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES, method);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new GmailError("bad_response", { method, status: res.status });
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new GmailError("bad_response", { method, status: res.status });
      return parsed.data as z.infer<S>;
    });
  }

  private async send(
    method: string,
    path: string,
    query: URLSearchParams,
    token: string,
  ): Promise<Response> {
    const qs = query.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GmailError("network", { method });
    }
  }

  private async toError(
    method: string,
    res: Response,
    notFoundKind: "not_found" | "history_expired",
  ): Promise<GmailError> {
    let reason: string | null = null;
    let googleStatus: string | null = null;
    try {
      const bytes = await readCapped(res, ERROR_BODY_MAX_BYTES, method);
      const parsed = googleErrorSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (parsed.success) {
        const e = parsed.data.error;
        const r =
          e.errors?.find((x) => x.reason)?.reason ?? e.details?.find((x) => x.reason)?.reason;
        reason = r && SAFE_REASON.test(r) ? r : null;
        googleStatus = e.status && SAFE_REASON.test(e.status) ? e.status : null;
      }
    } catch {
      // Unreadable error body: classify by status alone.
    }
    const kind = classifyGmailFailure(res.status, reason, googleStatus, notFoundKind);
    let retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
    if (kind === "rate_limited") {
      this.rateLimitStreak++;
      retryAfterMs ??= rateLimitBackoffMs(this.rateLimitStreak, this.random);
    }
    return new GmailError(kind, {
      method,
      status: res.status,
      reason: reason ?? googleStatus,
      retryAfterMs,
    });
  }
}

function clampMax(n: number | undefined): number {
  const v = n ?? 500;
  if (!Number.isInteger(v) || v < 1) throw new RangeError("maxResults must be a positive integer");
  return Math.min(500, v);
}

/** Decode `message.raw` (format=raw) into RFC 822 bytes; throws `bad_response` if absent/invalid. */
export function decodeRawMessage(message: GmailMessage): Uint8Array {
  const bytes = message.raw === undefined ? null : decodeBase64Url(message.raw);
  if (!bytes) throw new GmailError("bad_response", { method: "users.messages.get" });
  return bytes;
}
