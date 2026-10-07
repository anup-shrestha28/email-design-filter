/**
 * edf-view request handling (FREE-TIER.md §8.4, §9.3). Two routes:
 *
 * `GET /v/:token/:emailId` — gate the view token without a secret (shape; exp not past and
 *   ≤ now + 300 s), then `GET {APP_ORIGIN}/api/view-source/{token}/{emailId}` with edf-view's
 *   function OIDC token, expect `{html, height}` JSON, and serve the HTML with exactly the §9.3
 *   headers, except that it may stay in the viewer's own browser cache (`private, max-age` = the
 *   token's remaining life; never a shared cache). Upstream problems → a small neutral error page
 *   with the same headers and `private, no-store`, except that a gallery card (a `card` token)
 *   whose upstream failed transiently gets a loading skeleton that retries itself (below, "Card
 *   retries").
 *
 * `GET /img/:token` — verify the Ed25519 image token (public keys only) and expiry; tracker hosts
 *   get a 1×1 transparent GIF; enforce the per-email budget (best effort); fetch through the
 *   SSRF-safe fetcher with maxBytes = min(token.mb, 15 MB, budget left); serve it shrunk to the
 *   width it is shown at (resize.ts: a card's image at most CARD_MAX_WIDTH, the opened design's
 *   FULL_MAX_WIDTH, as WebP when that is smaller) or else the bytes as fetched with the sniffed
 *   Content-Type, CDN-cached for a day and browser-cached for the token's remaining life (≤ 1 day).
 *   Failures → the "Picture unavailable" placeholder (http.ts UNAVAILABLE_SVG), cached as before: deterministic failures for the token's life, transient
 *   ones 5 min at the CDN, budget-limited ones not at all (a later view may load them).
 *   `GET /img/unavailable` (UNAVAILABLE_IMAGE_PATH) is that placeholder as a static image, for the
 *   <img> elements edf-app already knows can't be shown (it drops such a CSS background instead).
 *
 * Counters go to `/api/view-stats` in the background (`waitUntil`) once a minute, or sooner once
 * 4 MB of served image bytes are pending, never twice within 10 s; while image bytes are pending, a
 * delayed report 12 s later catches a burst followed by silence (stats.ts).
 */
import type { fetchImage as FetchImage, ImageFetchResult } from "@edf/fetch";
import { EmailBudget } from "./budget";
import type { ViewConfig } from "./config";
import {
  IMAGE_CACHE_SHORT,
  NO_STORE,
  STATIC_IMAGE_CACHE,
  TRANSPARENT_GIF,
  UNAVAILABLE_IMAGE_PATH,
  UNAVAILABLE_SVG,
  UNAVAILABLE_SVG_TYPE,
  cardRetryPage,
  errorPage,
  imageCacheLong,
  imageResponse,
  viewCacheControl,
  viewHeaders,
} from "./http";
import type { TokenSource } from "./oidc";
import type { ShrinkImage } from "./resize";
import { Stats } from "./stats";
import { EMAIL_ID_RE, gateViewToken, verifyImageToken } from "./tokens";
import { isTrackerUrl } from "./trackers";

/**
 * Per-response backstop (§8.4 item 3): 15 MB (2026-10-04, was 5 MB: marketing GIFs of 5–15 MB (shops' animated heroes) showed "Picture unavailable" while Gmail showed them), the signed per-image ceiling (tokens.ts
 * IMAGE_TOKEN_MAX_BYTES) and the SSRF-safe fetcher's own limit; under the 20 MB the CDN caches. It was 4 MB, under Vercel's 4.5 MB
 * function body limit, which only binds functions that don't stream: Node.js functions stream by
 * default (Hobby since 2024-07-08), a streamed response has no such limit, and Vercel's CDN caches
 * streamed function responses up to 20 MB (vercel.com/docs/caching/cdn-cache "Limits"). Week-1
 * check in FREE-TIER.md §8.4: an image of 4.5–5 MB must come back whole, not as a 500
 * FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE; if it doesn't, set this (and the token ceiling) back to 4 MB.
 */
export const MAX_IMAGE_RESPONSE_BYTES = 15 * 1024 * 1024;
/**
 * Widest image served to a gallery card (px): a card is at most ~560 device px wide at 2×, and the
 * phone's single column ~1,000 at 3× (a little soft there, crisp everywhere else). resize.ts.
 */
export const CARD_MAX_WIDTH = 800;
/** Widest image served to the opened design (px): twice its 600–800 px layout. resize.ts. */
export const FULL_MAX_WIDTH = 1600;
/** Budget-id suffix edf-app gives gallery-card image tokens (apps/web server/view-source.ts). */
export const CARD_BUDGET_SUFFIX = "_c";
/** Vercel's response body limit bounds what edf-app can send us. */
export const MAX_VIEW_SOURCE_BYTES = Math.floor(4.5 * 1024 * 1024);
export const VIEW_SOURCE_TIMEOUT_MS = 25_000;
/** A 15 MB GIF from a slow sender needs more than the 5 s it was (2026-10-04: timeouts seen). */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/*
 * Card retries. A gallery card whose view fails transiently (Gmail's per-user rate limit, the
 * per-mailbox fetch limit, the viewer quota, an upstream timeout or network error) used to keep
 * the error page, which at card size looks blank; the card can't notice (its frame runs no script)
 * and the app only re-mints on a later visit. Now such a card gets cardRetryPage: a loading
 * skeleton whose HTTP `Refresh` header loads the same signed path again, with `?r=<attempt>`,
 * after CARD_RETRY_DELAYS_SEC (2 s, 4 s, 8 s: three retries, ≈ 14 s of waiting plus a second of
 * spread per email id so cards that failed together don't return together). Nothing about the
 * view's security changes: the same view token, re-checked by the gate and by edf-app on every
 * retry, the same CSP and sandbox, no script. It never outlives its token: a retry is offered only
 * if the token is still valid CARD_RETRY_MIN_TOKEN_SEC after the refresh fires (so the last one
 * isn't refused as expired), and an expired token gets the "link has expired" page as before.
 * Persistent failures (a disconnected mailbox, Gmail's policy or daily-limit refusals, a bad
 * token) are not retried: edf-app's 503 body names its error (apps/web view-source.ts), and only
 * the transient codes below retry. Only `card` views retry: the opened design ("img"/"noimg") has
 * its own "Try again" and a person looking at it, and a skeleton there would hide why it failed.
 */
/** Seconds before each retry of a card view (its length is the number of retries). */
export const CARD_RETRY_DELAYS_SEC = [2, 4, 8] as const;
/** The query parameter carrying the retry number (1…CARD_RETRY_DELAYS_SEC.length). */
export const CARD_RETRY_PARAM = "r";
/** A retry is offered only while the view token stays valid this long after the refresh fires. */
export const CARD_RETRY_MIN_TOKEN_SEC = 5;
/**
 * edf-app's transient view-source errors (apps/web server/view-source.ts fetchErrorCode): 429
 * `quota` always; on a 503 these codes. Any other 503 (`mailbox_unavailable`, `gmail_policy`,
 * `gmail_daily_limit`, `gmail_unauthorized`, …) would fail the same way again.
 */
export const TRANSIENT_UPSTREAM_ERRORS: ReadonlySet<string> = new Set([
  "busy",
  "token_busy",
  "gmail_rate_limited",
  "gmail_server",
  "gmail_network",
]);
/** How much of an upstream error body is read to find its code (edf-app sends `{"error":"…"}`). */
const UPSTREAM_ERROR_BODY_MAX = 1024;

/** The retry number a card view carries (0 for the first load); past the last, the last. */
export function cardRetryAttempt(url: URL): number {
  const r = url.searchParams.get(CARD_RETRY_PARAM);
  if (r === null) return 0;
  const n = /^[1-9]$/.test(r) ? Number(r) : Infinity;
  return Math.min(n, CARD_RETRY_DELAYS_SEC.length);
}

export type WaitUntil = (p: Promise<unknown>) => void;

export interface ViewDeps {
  config: ViewConfig;
  token: TokenSource;
  fetchApp: typeof fetch;
  fetchImage: typeof FetchImage;
  /** Shrinks a fetched image to the width it is shown at (resize.ts); only the image route has it. */
  shrinkImage?: ShrinkImage;
  /** The process's CPU time so far (ms), reported as `cpu_ms` (stats.ts); production only. */
  cpuMs?: () => number;
  now: () => number;
  log: (e: Record<string, string | number>) => void;
  /** Timer for the delayed stats report (tests inject one); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ViewApp {
  view(request: Request, waitUntil?: WaitUntil): Promise<Response>;
  img(request: Request, waitUntil?: WaitUntil): Promise<Response>;
  stats: Stats;
}

/** The host of an image URL ("?" when it doesn't parse). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

export function defaultLog(e: Record<string, string | number>): void {
  console.log(JSON.stringify({ svc: "edf-view", ...e }));
}

/** Transient failures are cached briefly; deterministic ones for a day (same token ⇒ same result). */
const DETERMINISTIC_FAILURES = new Set([
  "bad_url",
  "bad_scheme",
  "bad_port",
  "blocked_host",
  "blocked_address",
  "content_type",
  "redirects",
  "not_image",
  "too_many_pixels",
]);

/**
 * Only the public path forms are accepted. vercel.json rewrites `/v/:token/:emailId` and
 * `/img/:token` to the functions, and Vercel hands the function the original request path (the
 * rewrite's query parameters are ignored here). A direct call to `/api/v` or `/api/img` therefore
 * never matches, so it is refused before any upstream work. This is defence in depth: the edf-view
 * firewall (FREE-TIER.md §8.4) already denies every path starting with `/api/` at the edge, and
 * its rate-limit rule covers all requests with no path condition (a `/v/*` + `/img/*` condition
 * could be sidestepped with encoding tricks, so it must not be narrowed back to those paths); if
 * the deny rule is ever missing, this check still stops direct calls. On each new preview deploy
 * open /v/test/test: a 404 means Vercel passed the rewritten path instead (every /v and /img request
 * would then fail here). A preview can't show an email (503 for everything without viewer settings;
 * with them /v/test/test gets 400 and a real /v link gets 403, as only the production viewer is
 * accepted), so finish on production, where /v/test/test answers 400 and a real /v link renders
 * (docs/SETUP.md §2 step 9).
 *
 * Segments must be plain token characters, so percent-encoded bytes (`%2F`, `%2e`, `%76`…), empty
 * segments (`//v/…`) and trailing slashes never match. URL parsing (the `Request` itself) has
 * already collapsed dot segments, `%2e%2e` included, so `/api/v/%2e%2e/%2e%2e/v/…` arrives as the
 * canonical `/v/…`: whether the edge rules see the raw or the collapsed path is a WAF question
 * (FREE-TIER.md §8.4), not something this code can observe.
 */
function routeParams(url: URL, prefix: "v" | "img"): string[] | null {
  const m =
    prefix === "v"
      ? /^\/v\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      : /^\/img\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
  return m === null ? null : m.slice(1);
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The `error` code of edf-app's small JSON error body (a plain code, else null). Never throws. */
async function upstreamErrorCode(res: Response): Promise<string | null> {
  try {
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(res, UPSTREAM_ERROR_BODY_MAX);
    if (bytes === null) return null;
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      error?: unknown;
    };
    return typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

/** 0 or 1 s, from the email id: cards that failed together come back a second apart. */
function spread(emailId: string, attempt: number): number {
  let h = attempt;
  for (let i = 0; i < emailId.length; i++) h = (h * 31 + emailId.charCodeAt(i)) >>> 0;
  return h % 2;
}

function upstreamStatus(status: number): number {
  if (status === 400) return 400;
  if (status === 401 || status === 403) return 403;
  if (status === 404 || status === 410) return 404;
  if (status === 429) return 429;
  if (status === 503) return 503;
  return 502;
}

export function createViewApp(deps: ViewDeps): ViewApp {
  const { config } = deps;
  const stats = new Stats(deps.now(), deps.cpuMs);
  const budget = new EmailBudget();
  const statsDeps = {
    statsUrl: `${config.appOrigin}/api/view-stats`,
    token: deps.token,
    fetchImpl: deps.fetchApp,
    now: deps.now,
    log: deps.log,
    sleep: deps.sleep,
  };

  async function finish(
    request: Request,
    response: Response,
    waitUntil?: WaitUntil,
  ): Promise<Response> {
    // The report (if due) never delays the response: it runs under waitUntil. Only a runtime
    // that offers no waitUntil awaits it, since a promise left running there could be frozen
    // with the instance (and edf-app meters Fast Origin Transfer from these counts).
    const bg = stats.maybeFlush(statsDeps, request);
    if (waitUntil) {
      waitUntil(bg);
      // Image bytes still pending (no report due yet): a delayed report under this request's
      // waitUntil, so they are sent even if no further request reaches this instance.
      const trailing = stats.scheduleTrailing(statsDeps, request);
      if (trailing) waitUntil(trailing);
    } else await bg;
    return response;
  }

  async function view(request: Request): Promise<Response> {
    stats.add("view_requests");
    if (request.method !== "GET") return errorPage(405, config, { allow: "GET" });
    const url = new URL(request.url);
    const params = routeParams(url, "v");
    if (params === null) {
      stats.add("view_rejected_format");
      return errorPage(404, config);
    }
    const [rawToken, emailId] = params as [string, string];
    const gate = gateViewToken(rawToken, Math.floor(deps.now() / 1000));
    if (!gate.ok || !EMAIL_ID_RE.test(emailId)) {
      stats.add(
        gate.ok || gate.reason === "format" ? "view_rejected_format" : "view_rejected_expiry",
      );
      return errorPage(400, config);
    }
    /** A transient failure: a card gets its self-retrying skeleton while retries and token last. */
    const transientFailure = (status: number): Response => {
      if (gate.mode !== "card") return errorPage(status, config);
      const attempt = cardRetryAttempt(url);
      const base = CARD_RETRY_DELAYS_SEC[attempt];
      if (base === undefined) return errorPage(status, config);
      const delay = base + spread(emailId, attempt);
      if (gate.exp - Math.floor(deps.now() / 1000) < delay + CARD_RETRY_MIN_TOKEN_SEC)
        return errorPage(status, config);
      stats.add("view_card_retry");
      return cardRetryPage(
        status,
        config,
        delay,
        `/v/${gate.token}/${emailId}?${CARD_RETRY_PARAM}=${attempt + 1}`,
      );
    };
    const oidc = await deps.token(request);
    if (oidc === null) {
      stats.add("view_upstream_error");
      deps.log({ ev: "view_error", code: "no_oidc_token" });
      return errorPage(503, config);
    }
    let res: Response;
    stats.add("view_forwarded");
    try {
      res = await deps.fetchApp(`${config.appOrigin}/api/view-source/${gate.token}/${emailId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${oidc}`, accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(VIEW_SOURCE_TIMEOUT_MS),
      });
    } catch (err) {
      stats.add("view_upstream_error");
      const timeout =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      deps.log({ ev: "view_error", code: timeout ? "timeout" : "network" });
      return transientFailure(timeout ? 504 : 502);
    }
    if (res.status !== 200) {
      const reason = res.status === 503 ? await upstreamErrorCode(res) : null;
      if (res.status !== 503) await res.body?.cancel().catch(() => undefined);
      stats.add("view_upstream_error");
      deps.log({
        ev: "view_error",
        code: "upstream_status",
        status: res.status,
        ...(reason === null ? {} : { reason }),
      });
      const status = upstreamStatus(res.status);
      const transient =
        res.status === 429 || (reason !== null && TRANSIENT_UPSTREAM_ERRORS.has(reason));
      return transient ? transientFailure(status) : errorPage(status, config);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const bytes =
      type === "application/json"
        ? await readCapped(res, MAX_VIEW_SOURCE_BYTES).catch(() => null)
        : null;
    let html: string | null = null;
    if (bytes !== null) {
      try {
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
          html?: unknown;
          height?: unknown;
        };
        const heightOk =
          typeof body.height === "number" &&
          Number.isFinite(body.height) &&
          body.height >= 0 &&
          body.height <= 1_000_000;
        if (typeof body.html === "string" && body.html.length > 0 && heightOk) html = body.html;
      } catch {
        html = null;
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    if (html === null) {
      stats.add("view_upstream_error");
      deps.log({ ev: "view_error", code: "bad_upstream_body" });
      return errorPage(502, config);
    }
    // Browser-private cache until the token expires (http.ts viewCacheControl), counted from now,
    // after the upstream call, so a slow upstream never stretches it past `exp`.
    return new Response(html, {
      status: 200,
      headers: viewHeaders(config, viewCacheControl(gate.exp, Math.floor(deps.now() / 1000))),
    });
  }

  /**
   * The "Picture unavailable" placeholder (http.ts UNAVAILABLE_SVG). Like the 35-byte GIF it
   * replaced, its ≈ 1.8 KB are not counted in `img_bytes_served` (that counts the images served):
   * they are a small response like the HTML error pages, which the `vercel_fot` calibration covers
   * (packages/budget DECISIONS.md "Card image allowance by displayed size"), and counting them would
   * let garbage-token requests from anyone schedule stats reports.
   */
  function placeholder(cacheControl: string, status = 200): Response {
    return imageResponse(UNAVAILABLE_SVG, UNAVAILABLE_SVG_TYPE, cacheControl, status);
  }

  async function img(request: Request): Promise<Response> {
    stats.add("img_requests");
    if (request.method !== "GET") return placeholder(NO_STORE, 405);
    const params = routeParams(new URL(request.url), "img");
    // The static placeholder (no token, nothing fetched): the same bytes for everyone, so the CDN
    // and the browser keep it for a day.
    if (params !== null && params[0] === UNAVAILABLE_IMAGE_PATH)
      return placeholder(STATIC_IMAGE_CACHE);
    const now = deps.now();
    const nowSec = Math.floor(now / 1000);
    const claims =
      params === null ? null : verifyImageToken(config.imgKeys, params[0] as string, nowSec);
    if (claims === null) {
      stats.add("img_bad_signature");
      return placeholder(NO_STORE, 403);
    }
    if (isTrackerUrl(claims.url)) {
      stats.add("img_blocked_tracker");
      return imageResponse(TRANSPARENT_GIF, "image/gif", imageCacheLong(claims.x, nowSec));
    }
    const tokenCap = Math.min(claims.mb, MAX_IMAGE_RESPONSE_BYTES);
    // Keyed on the whole signed binding. edf-app now mints `b` per email and expiry day
    // (`<emailId>_<exp36>`), so this equals one budget per `b`; tokens minted before that (≤ 48 h
    // old) carry a `b` shared by many emails and users, which `u` and `e` keep apart.
    const budgetKey = `${claims.u}\n${claims.e}\n${claims.b}`;
    const left = budget.remaining(budgetKey, now);
    if (left <= 0) {
      stats.add("img_budget_exceeded");
      return placeholder(NO_STORE);
    }
    const maxBytes = Math.min(tokenCap, left);
    let r: ImageFetchResult;
    try {
      r = await deps.fetchImage(claims.url, { maxBytes, timeoutMs: IMAGE_FETCH_TIMEOUT_MS });
    } catch {
      r = { ok: false, reason: "network" };
    }
    if (!r.ok) {
      stats.add(r.reason === "too_large" ? "img_too_large" : "img_upstream_error");
      const budgetLimited = r.reason === "too_large" && maxBytes < tokenCap;
      const cache = budgetLimited
        ? NO_STORE
        : DETERMINISTIC_FAILURES.has(r.reason) || r.reason === "too_large"
          ? imageCacheLong(claims.x, Math.floor(deps.now() / 1000))
          : IMAGE_CACHE_SHORT;
      deps.log({
        ev: "img_error",
        code: r.reason,
        // Which image server, and the allowance: enough to tell a refusing host or an
        // over-the-cap picture apart, never the image's address (it can carry tracking ids).
        host: hostOf(claims.url),
        mb: maxBytes,
        ...(r.status === undefined ? {} : { status: r.status }),
      });
      return placeholder(cache);
    }
    // A gallery card's image (edf-app mints card budgets as `<emailId>_<exp36>_c`).
    const card = claims.b.endsWith(CARD_BUDGET_SUFFIX);
    let body = r.body;
    let contentType = r.contentType;
    if (deps.shrinkImage !== undefined) {
      // Its CPU reaches edf-app's meter in the instance's `cpu_ms` (stats.ts).
      const small = await deps
        .shrinkImage(
          { body: r.body, format: r.format, width: r.width, height: r.height },
          card ? CARD_MAX_WIDTH : FULL_MAX_WIDTH,
        )
        .catch(() => null);
      if (small !== null) {
        body = small.body;
        contentType = small.contentType;
        stats.add("img_resized");
      }
    }
    // The bytes served are what crosses Fast Origin Transfer and what the per-email budget holds.
    budget.spend(budgetKey, body.length, now);
    stats.add("img_ok");
    stats.add("img_bytes_served", body.length);
    if (card) stats.add("img_card_bytes_served", body.length);
    return imageResponse(body, contentType, imageCacheLong(claims.x, Math.floor(deps.now() / 1000)));
  }

  const guard =
    (fn: (request: Request) => Promise<Response>, fallback: () => Response) =>
    async (request: Request, waitUntil?: WaitUntil): Promise<Response> => {
      let response: Response;
      try {
        response = await fn(request);
      } catch {
        deps.log({ ev: "error", code: "internal" });
        response = fallback();
      }
      return finish(request, response, waitUntil);
    };

  return {
    view: guard(view, () => errorPage(502, config)),
    img: guard(img, () => placeholder(NO_STORE)),
    stats,
  };
}

/** Vercel's `waitUntil` from the request context, when the runtime provides it. */
export function contextWaitUntil(): WaitUntil | undefined {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined;
  const fn = ctx?.get?.()?.waitUntil;
  return typeof fn === "function" ? fn : undefined;
}
