/**
 * SSRF-safe outbound GET (DESIGN.md §11.7; FREE-TIER.md §8.4, §9.2).
 *
 * - undici Agent with `connect.lookup` = the DNS pin (lookup.ts); explicit dispatcher, so proxy
 *   environment variables are ignored; HTTP/1.1 only; TLS verification on.
 * - Manual redirects (≤ 3 hops), each hop fully re-validated (scheme, port, host, address).
 * - One retry per call for a connection-level failure before any response (EHOSTUNREACH,
 *   ECONNRESET, …), within the same deadline, re-validated like any attempt.
 * - http/https on ports 80/443 only; no cookies, no auth, no referrer; fixed user agent.
 * - One deadline for the whole call (≤ 5 s) plus a separate header deadline, both covering DNS,
 *   connect and TLS; undici's own header/body inactivity timers as a backstop.
 * - Body streamed with a hard cap on DECODED bytes (gzip/deflate/br), aborting as soon as it is
 *   exceeded, plus a cap on raw bytes; content-type allowlist; ≤ 4 concurrent requests per host.
 */
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Agent, request } from "undici";
import { BLOCKED_ADDRESS_CODE, BLOCKED_HOST_CODE, safeLookup } from "./lookup";
import { validateTarget } from "./policy";
import { HostSemaphore } from "./semaphore";

export type SafeFetchError =
  | "bad_url"
  | "bad_scheme"
  | "bad_port"
  | "blocked_host"
  | "blocked_address"
  | "dns"
  | "timeout"
  | "too_large"
  | "redirects"
  | "content_type"
  | "http"
  | "network";

export interface SafeFetchOptions {
  /** Hard cap on decompressed body bytes (≤ 5 MB; image proxy uses the token's max_bytes). */
  maxBytes: number;
  /** Total timeout (header + body), ≤ 5,000 ms. */
  timeoutMs?: number;
  /** Allowed response content types (prefix match), e.g. ["image/"]. */
  accept: readonly string[];
  /**
   * Further response content types accepted as exact (case-insensitive) matches without being
   * advertised in the Accept header; "" accepts a response with no Content-Type. Only for callers
   * that verify the body themselves (fetchImage sniffs magic bytes and never serves this header).
   */
  tolerate?: readonly string[];
  /** ≤ 3. */
  maxRedirects?: number;
}

export type SafeFetchResult =
  | { ok: true; status: number; finalUrl: string; contentType: string; body: Buffer }
  | { ok: false; error: SafeFetchError; status?: number };

/**
 * DESIGN.md §11.7 ceilings, raised 2026-10-04 (5 MB / 5 s before) for the image proxy's big
 * animated GIFs. Ceilings only: every caller passes its own, smaller limits where it wants them
 * (the analysis render keeps 5 MB per image).
 */
export const SAFE_FETCH_MAX_BYTES = 15 * 1024 * 1024;
export const SAFE_FETCH_MAX_TIMEOUT_MS = 15_000;
export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const SAFE_FETCH_MAX_PER_HOST = 4;
export const SAFE_FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; EmailDesignFilter/1.0; +image-proxy)";

const HEADER_TIMEOUT_MS = 3000;
/**
 * Connection-level failures, before any response, that get ONE more attempt: a busy link (a
 * gallery page opens ~180 image fetches at once) sheds some connects with EHOSTUNREACH/ECONNRESET
 * that succeed a moment later. Measured locally: 45 of 480 real email images failed this way in a
 * burst, 0 with one retry after 250 ms. Only when enough of the deadline is left; the retry is a
 * full new attempt (same validation, a fresh pinned DNS lookup, the per-host limit).
 */
const RETRYABLE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
const CONNECT_RETRY_DELAY_MS = 250;
const CONNECT_RETRY_MIN_REMAINING_MS = 1500;
const RAW_SLACK_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const agent = new Agent({
  connect: { lookup: safeLookup, timeout: SAFE_FETCH_MAX_TIMEOUT_MS, rejectUnauthorized: true },
  allowH2: false,
  connections: SAFE_FETCH_MAX_PER_HOST,
  pipelining: 1,
  keepAliveTimeout: 4000,
  keepAliveMaxTimeout: 10_000,
  headersTimeout: SAFE_FETCH_MAX_TIMEOUT_MS,
  bodyTimeout: SAFE_FETCH_MAX_TIMEOUT_MS,
  maxHeaderSize: 16 * 1024,
  maxResponseSize: SAFE_FETCH_MAX_BYTES + RAW_SLACK_BYTES,
});

const perHost = new HostSemaphore(SAFE_FETCH_MAX_PER_HOST);

class FetchFailure extends Error {
  constructor(
    readonly code: SafeFetchError,
    readonly status?: number,
  ) {
    super(code);
  }
}

/** A connect-phase failure worth one retry (RETRYABLE_CONNECT_CODES); `cause` keeps the original. */
class RetryableConnectError extends Error {
  constructor(cause: unknown) {
    super("connect failed", { cause });
  }
}

/** True if `err` (or anything in its cause / AggregateError chain) carries one of `codes`. */
function hasErrorCode(err: unknown, codes: ReadonlySet<string>): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const e = stack.pop();
    if (e === null || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const rec = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof rec.code === "string" && codes.has(rec.code)) return true;
    if (rec.cause !== undefined) stack.push(rec.cause);
    if (Array.isArray(rec.errors)) stack.push(...rec.errors);
  }
  return false;
}

interface Options {
  maxBytes: number;
  timeoutMs: number;
  accept: string[];
  tolerate: ReadonlySet<string>;
  maxRedirects: number;
}

function normalizeOptions(o: SafeFetchOptions): Options {
  if (typeof o !== "object" || o === null) throw new TypeError("safeFetch: options required");
  if (!Number.isSafeInteger(o.maxBytes) || o.maxBytes < 1 || o.maxBytes > SAFE_FETCH_MAX_BYTES) {
    throw new RangeError("safeFetch: maxBytes must be an integer in [1, 15 MB]");
  }
  const timeoutMs = o.timeoutMs ?? SAFE_FETCH_MAX_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("safeFetch: bad timeoutMs");
  const maxRedirects = o.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0)
    throw new RangeError("safeFetch: bad maxRedirects");
  if (
    !Array.isArray(o.accept) ||
    o.accept.length === 0 ||
    o.accept.some((a) => typeof a !== "string" || a === "")
  ) {
    throw new TypeError("safeFetch: accept must be a non-empty list");
  }
  const tolerate = o.tolerate ?? [];
  if (!Array.isArray(tolerate) || tolerate.some((t) => typeof t !== "string")) {
    throw new TypeError("safeFetch: tolerate must be a list of strings");
  }
  return {
    maxBytes: o.maxBytes,
    timeoutMs: Math.min(timeoutMs, SAFE_FETCH_MAX_TIMEOUT_MS),
    accept: o.accept.map((a) => a.toLowerCase()),
    tolerate: new Set(tolerate.map((t) => t.trim().toLowerCase())),
    maxRedirects: Math.min(maxRedirects, SAFE_FETCH_MAX_REDIRECTS),
  };
}

function single(h: string | string[] | undefined): string | undefined | null {
  if (Array.isArray(h)) return h.length === 1 ? h[0] : null;
  return h;
}

function acceptHeader(accept: string[]): string {
  return accept.map((a) => (a.endsWith("/") ? `${a}*` : a)).join(", ");
}

/** Map any error surfacing from undici/zlib/our own checks to a result code. */
function classify(err: unknown, deadlineHit: boolean): SafeFetchError {
  if (err instanceof FetchFailure) return err.code;
  if (deadlineHit) return "timeout";
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const e = stack.pop();
    if (e === null || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const rec = e as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    const code = typeof rec.code === "string" ? rec.code : "";
    if (code === BLOCKED_ADDRESS_CODE) return "blocked_address";
    if (code === BLOCKED_HOST_CODE) return "blocked_host";
    if (
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "EAI_NODATA" ||
      code === "EAI_NONAME"
    )
      return "dns";
    if (
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "ETIMEDOUT" ||
      rec.name === "TimeoutError"
    ) {
      return "timeout";
    }
    if (code === "UND_ERR_RES_EXCEEDED_MAX_SIZE") return "too_large";
    if (rec.cause !== undefined) stack.push(rec.cause);
    if (Array.isArray(rec.errors)) stack.push(...rec.errors);
  }
  return "network";
}

class ByteCap extends Transform {
  #seen = 0;
  constructor(readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#seen += chunk.length;
    if (this.#seen > this.limit) cb(new FetchFailure("too_large"));
    else cb(null, chunk);
  }
}

function decoderFor(encoding: string | undefined | null): Transform | null {
  if (encoding === null) throw new FetchFailure("content_type");
  const e = (encoding ?? "").trim().toLowerCase();
  if (e === "" || e === "identity") return null;
  if (e === "gzip" || e === "x-gzip") return createGunzip();
  if (e === "deflate") return createInflate();
  if (e === "br") return createBrotliDecompress();
  // Stacked or unknown codings (e.g. "gzip, gzip", zstd) are refused rather than guessed at.
  throw new FetchFailure("content_type");
}

async function readBody(
  body: NodeJS.ReadableStream & AsyncIterable<Buffer>,
  encoding: string | undefined | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const decoder = decoderFor(encoding);
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = async (source: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw new FetchFailure("too_large");
      chunks.push(chunk);
    }
  };
  const rawCap = new ByteCap(decoder === null ? maxBytes : maxBytes + RAW_SLACK_BYTES);
  if (decoder === null) await pipeline(body, rawCap, sink, { signal });
  else await pipeline(body, rawCap, decoder, sink, { signal });
  return Buffer.concat(chunks, total);
}

type UndiciResponse = Awaited<ReturnType<typeof request>>;

/**
 * undici only acts on an abort once the request is on a socket: an abort during DNS, TCP connect
 * or TLS is merely recorded, and the call waits for the Agent's connect timeout. So settle on the
 * abort ourselves, keeping the deadline and header budget true while connecting; a response that
 * still arrives afterwards is discarded. The caller keeps its per-host slot until `pending`
 * settles, so abandoned connection attempts still count towards the per-host limit.
 */
function settleOnAbort(
  pending: Promise<UndiciResponse>,
  signal: AbortSignal,
): Promise<UndiciResponse> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
      pending.then(
        (late) => {
          late.body.on("error", () => undefined);
          late.body.destroy();
        },
        () => undefined,
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

type Hop =
  | { kind: "redirect"; location: string; status: number }
  | { kind: "done"; result: SafeFetchResult };

async function fetchOnce(
  url: URL,
  hostKey: string,
  o: Options,
  signal: AbortSignal,
  deadline: number,
): Promise<Hop> {
  const release = await perHost.acquire(hostKey, signal);
  let pending: Promise<UndiciResponse> | undefined;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    const headerBudget = Math.min(remaining, HEADER_TIMEOUT_MS);
    const headerController = new AbortController();
    const headerTimer = setTimeout(
      () => headerController.abort(new FetchFailure("timeout")),
      headerBudget,
    );
    headerTimer.unref?.();
    const requestSignal = AbortSignal.any([signal, headerController.signal]);
    let res: UndiciResponse;
    try {
      pending = request(url, {
        dispatcher: agent,
        method: "GET",
        headers: {
          "user-agent": SAFE_FETCH_USER_AGENT,
          accept: acceptHeader(o.accept),
          "accept-encoding": "gzip, deflate, br",
        },
        signal: requestSignal,
        headersTimeout: headerBudget,
        bodyTimeout: remaining,
      });
      res = await settleOnAbort(pending, requestSignal);
    } catch (err) {
      // Our own aborts (deadline, header budget) arrive as FetchFailure and are never retried.
      if (
        !(err instanceof FetchFailure) &&
        !requestSignal.aborted &&
        hasErrorCode(err, RETRYABLE_CONNECT_CODES)
      ) {
        throw new RetryableConnectError(err);
      }
      throw err;
    } finally {
      clearTimeout(headerTimer);
    }
    const status = res.statusCode;
    const body = res.body;
    try {
      if (REDIRECT_STATUSES.has(status)) {
        const loc = single(res.headers.location);
        if (typeof loc !== "string" || loc.length === 0 || loc.length > 8192) {
          return { kind: "done", result: { ok: false, error: "http", status } };
        }
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          return { kind: "done", result: { ok: false, error: "bad_url", status } };
        }
        return { kind: "redirect", location: next.href, status };
      }
      if (status !== 200) return { kind: "done", result: { ok: false, error: "http", status } };

      const rawType = single(res.headers["content-type"]);
      const contentType =
        typeof rawType === "string" ? (rawType.split(";")[0] ?? "").trim().toLowerCase() : "";
      const accepted =
        (contentType !== "" && o.accept.some((a) => contentType.startsWith(a))) ||
        // A repeated Content-Type header (rawType null) is never "missing".
        (rawType !== null && o.tolerate.has(contentType));
      if (!accepted) {
        return { kind: "done", result: { ok: false, error: "content_type", status } };
      }
      const encoding = single(res.headers["content-encoding"]);
      const lenHeader = single(res.headers["content-length"]);
      if (
        (encoding === undefined || encoding === "identity") &&
        typeof lenHeader === "string" &&
        /^\d+$/.test(lenHeader)
      ) {
        if (Number(lenHeader) > o.maxBytes)
          return { kind: "done", result: { ok: false, error: "too_large", status } };
      }
      const buf = await readBody(body, encoding, o.maxBytes, signal);
      return {
        kind: "done",
        result: { ok: true, status, finalUrl: url.href, contentType, body: buf },
      };
    } finally {
      // Never keep an unread body (or its socket) around. undici emits RequestAbortedError when
      // an unfinished body is destroyed; that is expected here, so swallow it.
      if (!body.destroyed) {
        body.on("error", () => undefined);
        body.destroy();
      }
    }
  } finally {
    // An attempt we gave up on may still be connecting (until the Agent's connect timeout); it
    // keeps the slot until it settles. Otherwise `pending` has settled and this is immediate.
    if (pending === undefined) release();
    else pending.then(release, release);
  }
}

/**
 * Resolve once, validate every address (ipaddr.js process(); unicast only), connect to the
 * pinned IP via an undici Agent `connect.lookup`; manual redirects (each re-validated);
 * http/https on ports 80/443 only; no cookies/auth; fixed user agent; proxy env ignored.
 * Never throws for network conditions (only for invalid options).
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const o = normalizeOptions(opts);
  const deadline = Date.now() + o.timeoutMs;
  const controller = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    controller.abort(new FetchFailure("timeout"));
  }, o.timeoutMs);
  timer.unref?.();
  try {
    let current = url;
    let retried = false;
    for (let hops = 0; ; hops++) {
      const target = validateTarget(current);
      if (!target.ok) return { ok: false, error: target.error };
      let hop: Hop;
      try {
        hop = await fetchOnce(target.url, target.hostKey, o, controller.signal, deadline);
      } catch (err) {
        if (
          !(err instanceof RetryableConnectError) ||
          retried ||
          deadline - Date.now() < CONNECT_RETRY_DELAY_MS + CONNECT_RETRY_MIN_REMAINING_MS
        ) {
          throw err;
        }
        retried = true;
        await delay(CONNECT_RETRY_DELAY_MS, undefined, { signal: controller.signal });
        hop = await fetchOnce(target.url, target.hostKey, o, controller.signal, deadline);
      }
      if (hop.kind === "done") return hop.result;
      if (hops >= o.maxRedirects) return { ok: false, error: "redirects", status: hop.status };
      current = hop.location;
    }
  } catch (err) {
    const code = classify(err, deadlineHit);
    const status = err instanceof FetchFailure ? err.status : undefined;
    return status === undefined ? { ok: false, error: code } : { ok: false, error: code, status };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
