import { createRequire as __edfCreateRequire } from 'node:module'; const require = __edfCreateRequire(import.meta.url);

// src/budget.ts
var EMAIL_BUDGET_BYTES = 40 * 1024 * 1024;
var TTL_MS = 48 * 3600 * 1e3;
var MAX_ENTRIES = 1e4;
var EmailBudget = class {
  #used = /* @__PURE__ */ new Map();
  remaining(id, now) {
    const e = this.#used.get(id);
    if (e === void 0 || now - e.at > TTL_MS) return EMAIL_BUDGET_BYTES;
    return Math.max(0, EMAIL_BUDGET_BYTES - e.bytes);
  }
  spend(id, bytes, now) {
    const e = this.#used.get(id);
    const fresh = e === void 0 || now - e.at > TTL_MS;
    this.#used.delete(id);
    this.#used.set(id, { bytes: (fresh ? 0 : e.bytes) + bytes, at: fresh ? now : e.at });
    while (this.#used.size > MAX_ENTRIES) {
      const oldest = this.#used.keys().next().value;
      if (oldest === void 0) break;
      this.#used.delete(oldest);
    }
  }
};

// src/tokens.ts
import { createPublicKey, verify } from "node:crypto";
var VIEW_TOKEN_RE = /^([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,11})\.(img|noimg|card)\.([A-Za-z0-9_-]{43})$/;
var EMAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var VIEW_TOKEN_MAX_TTL_SEC = 300;
var KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
var USER_ID_RE = /^[\x21-\x7e]{1,128}$/;
var SHORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var B64URL_RE = /^[A-Za-z0-9_-]*$/;
var IMAGE_TOKEN_MAX_LENGTH = 4096;
var IMAGE_TOKEN_MAX_BYTES = 15 * 1024 * 1024;
var IMAGE_TOKEN_MAX_LIFETIME_SEC = 48 * 3600;
var IMAGE_TOKEN_CLOCK_SKEW_SEC = 300;
function gateViewToken(token, nowSec) {
  if (typeof token !== "string" || token.length > 128) return { ok: false, reason: "format" };
  const m = VIEW_TOKEN_RE.exec(token);
  if (m === null) return { ok: false, reason: "format" };
  const exp = Number(m[2]);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "format" };
  if (nowSec > exp) return { ok: false, reason: "expired" };
  if (exp > nowSec + VIEW_TOKEN_MAX_TTL_SEC) return { ok: false, reason: "future" };
  return { ok: true, token, exp, mode: m[3] };
}
function b64urlStrict(s, len) {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s || len !== void 0 && buf.length !== len) return null;
  return buf;
}
function parseImagePublicKeys(json) {
  if (typeof json !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const out = /* @__PURE__ */ new Map();
  for (const [kid, value] of Object.entries(parsed)) {
    if (!KID_RE.test(kid) || typeof value !== "string") return null;
    const v = value.trim();
    try {
      let key;
      if (v.startsWith("-----")) {
        if (!v.startsWith("-----BEGIN PUBLIC KEY-----") || v.includes("PRIVATE")) return null;
        key = createPublicKey({ key: v, format: "pem" });
      } else {
        if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
        key = createPublicKey({ key: Buffer.from(v, "base64"), format: "der", type: "spki" });
      }
      if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
      out.set(kid, key);
    } catch {
      return null;
    }
  }
  return out.size > 0 && out.size <= 32 ? out : null;
}
function canonical(c) {
  const { u, e, x, url, mb, b } = c;
  if (typeof u !== "string" || !USER_ID_RE.test(u)) return null;
  if (typeof e !== "string" || !SHORT_ID_RE.test(e)) return null;
  if (typeof b !== "string" || !SHORT_ID_RE.test(b)) return null;
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) return null;
  if (typeof mb !== "number" || !Number.isSafeInteger(mb) || mb < 1 || mb > IMAGE_TOKEN_MAX_BYTES)
    return null;
  if (typeof url !== "string" || url.length > 2048) return null;
  let p;
  try {
    p = new URL(url);
  } catch {
    return null;
  }
  if (p.protocol !== "http:" && p.protocol !== "https:" || p.username || p.password || p.href !== url)
    return null;
  return JSON.stringify(["img/v1", u, e, x, url, mb, b]);
}
function verifyImageToken(keys, token, nowSec) {
  try {
    if (typeof token !== "string" || token.length > IMAGE_TOKEN_MAX_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [kid, payloadB64, sigB64] = parts;
    const key = KID_RE.test(kid) ? keys.get(kid) : void 0;
    if (key === void 0) return null;
    const payload = b64urlStrict(payloadB64);
    const sig = b64urlStrict(sigB64, 64);
    if (payload === null || sig === null || payload.length === 0) return null;
    if (!verify(null, payload, key, sig)) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== 7 || arr[0] !== "img/v1") return null;
    const claims = {
      u: arr[1],
      e: arr[2],
      x: arr[3],
      url: arr[4],
      mb: arr[5],
      b: arr[6]
    };
    if (canonical(claims) !== text) return null;
    if (nowSec > claims.x || claims.x > nowSec + IMAGE_TOKEN_MAX_LIFETIME_SEC + IMAGE_TOKEN_CLOCK_SKEW_SEC)
      return null;
    return claims;
  } catch {
    return null;
  }
}

// src/http.ts
function viewCsp(o) {
  return `default-src 'none'; img-src ${o.viewOrigin}/img/ data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${o.appOrigin}; sandbox allow-popups allow-popups-to-escape-sandbox`;
}
var VIEW_NO_STORE = "private, no-store";
function viewCacheControl(expSec, nowSec) {
  const ttl = Math.min(expSec - nowSec, VIEW_TOKEN_MAX_TTL_SEC);
  return ttl > 0 ? `private, max-age=${ttl}` : VIEW_NO_STORE;
}
function viewHeaders(o, cacheControl = VIEW_NO_STORE) {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": viewCsp(o),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": cacheControl
  };
}
var IMAGE_CSP = "default-src 'none'; sandbox";
var IMAGE_CACHE_LONG = "public, s-maxage=86400, immutable";
function imageCacheLong(expSec, nowSec) {
  const ttl = Math.min(expSec - nowSec, IMAGE_BROWSER_MAX_AGE_SEC);
  return ttl > 0 ? `public, max-age=${ttl}, s-maxage=86400, immutable` : IMAGE_CACHE_LONG;
}
var IMAGE_BROWSER_MAX_AGE_SEC = 86400;
var STATIC_IMAGE_CACHE = "public, max-age=86400, s-maxage=86400, immutable";
var IMAGE_CACHE_SHORT = "public, s-maxage=300";
var NO_STORE = "no-store";
var ERROR_TEXT = {
  400: "This link has expired. Close and reopen the email.",
  403: "This email can't be shown.",
  404: "This email is no longer available.",
  405: "Not allowed.",
  429: "Too many requests. Try again in a minute.",
  502: "This email couldn't be loaded right now.",
  503: "This email couldn't be loaded right now.",
  504: "This email took too long to load."
};
function errorPage(status, o, extra = {}, head = false) {
  const text = ERROR_TEXT[status] ?? ERROR_TEXT[502];
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Email unavailable</title><style>html,body{margin:0;min-height:100%}body{box-sizing:border-box;min-height:100vh;padding:72px 32px 32px;background:#f4f4f5;color:#52525b;text-align:center;font:22px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}h1{margin:0 auto 10px;font-size:32px;line-height:1.25;font-weight:600;color:#3f3f46}p{margin:0 auto;max-width:24em}</style></head><body><div><h1>Preview unavailable</h1><p>${text}</p></div></body></html>`;
  return new Response(head ? null : html, { status, headers: { ...viewHeaders(o), ...extra } });
}
function cardRetryPage(status, o, refreshSec, nextPath) {
  const bar = (w, h, extra = "") => `<div class="b" style="width:${w};height:${h}px${extra}"></div>`;
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Loading preview</title><style>html,body{margin:0}body{background:#f4f4f5;padding:32px 0}.m{box-sizing:border-box;width:600px;max-width:100%;margin:0 auto;padding:32px 40px;background:#fff}.b{background:#e4e4e7;border-radius:6px;margin:0 0 16px;animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.55}}@media (prefers-reduced-motion:reduce){.b{animation:none}}</style></head><body><div class="m" aria-busy="true" aria-label="Loading preview">' + bar("132px", 28, ";margin-bottom:32px") + bar("100%", 260, ";margin-bottom:32px") + bar("88%", 22) + bar("94%", 16) + bar("90%", 16) + bar("72%", 16, ";margin-bottom:32px") + bar("184px", 44, ";border-radius:22px") + bar("96%", 16, ";margin-top:40px") + bar("84%", 16) + "</div></body></html>";
  return new Response(html, {
    status,
    headers: { ...viewHeaders(o), refresh: `${refreshSec}; url=${nextPath}` }
  });
}
var TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);
var UNAVAILABLE_IMAGE_PATH = "unavailable";
function unavailableSvg() {
  const icon = (m) => m < 48 ? m / 2 : Math.max(24, Math.min(40, 0.07 * m));
  const scale = (m) => (icon(m) * 100 / (24 * m)).toFixed(3);
  const top = (m) => Math.max(16, Math.min(50, 9600 / m)).toFixed(1);
  const css = [`.b{transform:scale(${scale(32)})}`, "@media (max-width:15.98px),(max-height:15.98px){.i{display:none}}"];
  for (let lo = 48; lo < 1600; lo = Math.round(lo * 1.4)) {
    const mid = lo * Math.sqrt(1.4);
    css.push(
      `@media (min-width:${lo}px) and (min-height:${lo}px){.b{transform:scale(${scale(mid)})}` + (Number(top(mid)) < 50 ? `.p{transform:translate(50px,${top(mid)}px)}}` : "}")
    );
  }
  css.push("@media (min-width:150px) and (min-height:96px){.l{display:inline}.i{transform:translate(-12px,-20px)}}");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 100 100" preserveAspectRatio="xMidYMin meet"><style>${css.join("")}</style><rect x="-49950" y="-49950" width="100000" height="100000" fill="#f3f4f6"/><g class="p" transform="translate(50 50)"><g class="b" transform="scale(.3)"><g class="i" transform="translate(-12 -12)" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.75" cy="9.75" r="1.75"/><path d="M21 15.5l-4.5-4.5L7 20"/></g><text class="l" display="none" y="16" text-anchor="middle" font-family="system-ui,Arial,sans-serif" font-size="10.5" fill="#6b7280">Picture unavailable</text></g></g></svg>`;
}
var UNAVAILABLE_SVG = Buffer.from(unavailableSvg(), "utf8");
var UNAVAILABLE_SVG_TYPE = "image/svg+xml";
function imageResponse(body, contentType, cacheControl, status = 200, head = false) {
  return new Response(head ? null : new Uint8Array(body.buffer, body.byteOffset, body.byteLength), {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(body.length),
      "content-security-policy": IMAGE_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl
    }
  });
}

// src/stats.ts
var STATS_INTERVAL_MS = 6e4;
var STATS_FLUSH_BYTES = 4 * 1024 * 1024;
var STATS_MIN_INTERVAL_MS = 1e4;
var STATS_TRAILING_MS = 12e3;
var STAT_MAX_VALUE = 1e7;
var STATS_MAX_WINDOW_MS = 86400 * 1e3;
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
var Stats = class {
  #counts = {};
  #since;
  #last;
  #flushing = false;
  /** Bumped by every report sent, so a delayed report scheduled before it stands down. */
  #epoch = 0;
  #trailing = null;
  constructor(now) {
    this.#since = now;
    this.#last = now;
  }
  add(key, n = 1) {
    this.#counts[key] = (this.#counts[key] ?? 0) + n;
  }
  snapshot() {
    return { ...this.#counts };
  }
  /**
   * Whether a report is due at `now`: STATS_INTERVAL_MS since the last one, or STATS_FLUSH_BYTES of
   * served image bytes pending and at least STATS_MIN_INTERVAL_MS since the last one.
   */
  due(now) {
    if (this.#flushing || Object.keys(this.#counts).length === 0) return false;
    const since = now - this.#last;
    if (since >= STATS_INTERVAL_MS) return true;
    return since >= STATS_MIN_INTERVAL_MS && (this.#counts.img_bytes_served ?? 0) >= STATS_FLUSH_BYTES;
  }
  /**
   * Report if due (`due()`); returns a promise that never rejects. Callers hand it to `waitUntil`
   * so the response never waits for it. A failed report puts its counts back for the next one.
   */
  maybeFlush(deps, request) {
    const now = deps.now();
    if (!this.due(now)) return Promise.resolve();
    return this.#send(deps, request, now);
  }
  /** The delayed report scheduled by `scheduleTrailing` and not yet fired or superseded, if any. */
  get trailing() {
    return this.#trailing;
  }
  /**
   * While served image bytes are pending and no delayed report is scheduled, schedule one
   * STATS_TRAILING_MS from now and return its promise (it never rejects) for the caller to hand to
   * `waitUntil`; otherwise null. It stands down if any report goes out before it fires (the next
   * request with pending bytes then schedules a fresh one), so it never breaks the 10 s spacing:
   * the last report went out no later than when it was scheduled.
   */
  scheduleTrailing(deps, request) {
    if (this.#trailing !== null || (this.#counts.img_bytes_served ?? 0) === 0) return null;
    const epoch = this.#epoch;
    const p = (deps.sleep ?? defaultSleep)(STATS_TRAILING_MS).then(() => {
      if (this.#trailing === p) this.#trailing = null;
      if (epoch !== this.#epoch || this.#flushing) return;
      if (Object.keys(this.#counts).length === 0) return;
      return this.#send(deps, request, deps.now());
    }).catch(() => void 0);
    this.#trailing = p;
    return p;
  }
  #send(deps, request, now) {
    const sent = {};
    const carry = {};
    for (const [k, v] of Object.entries(this.#counts)) {
      sent[k] = Math.min(v, STAT_MAX_VALUE);
      if (v > STAT_MAX_VALUE) carry[k] = v - STAT_MAX_VALUE;
    }
    const windowStart = Math.max(this.#since, now - STATS_MAX_WINDOW_MS);
    this.#counts = carry;
    this.#since = now;
    this.#last = now;
    this.#flushing = true;
    this.#epoch += 1;
    this.#trailing = null;
    return this.#post(deps, request, sent, windowStart, now).then((ok) => {
      if (!ok) {
        for (const [k, v] of Object.entries(sent)) this.add(k, v);
        this.#since = Math.min(this.#since, windowStart);
      }
    }).finally(() => {
      this.#flushing = false;
    });
  }
  async #post(deps, request, counts, windowStart, windowEnd) {
    try {
      const token = await deps.token(request);
      if (token === null) {
        deps.log({ ev: "stats_skipped", code: "no_oidc_token" });
        return false;
      }
      const res = await deps.fetchImpl(deps.statsUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          v: 1,
          windowStart: Math.floor(windowStart / 1e3),
          windowEnd: Math.floor(windowEnd / 1e3),
          counts
        }),
        redirect: "error",
        signal: AbortSignal.timeout(3e3)
      });
      await res.body?.cancel().catch(() => void 0);
      if (res.status < 200 || res.status >= 300) {
        deps.log({ ev: "stats_failed", status: res.status });
        return false;
      }
      return true;
    } catch {
      deps.log({ ev: "stats_failed", code: "network" });
      return false;
    }
  }
};

// src/trackers.ts
var TRACKER_SUFFIXES = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "list-manage.com",
  // Mailchimp open tracking (images live on mcusercontent.com)
  "mailtrack.io",
  "mailfoogae.appspot.com",
  // Streak
  "t.yesware.com",
  "bananatag.com",
  "getnotify.com",
  "emltrk.com",
  "mailstat.us",
  "pixel.wp.com",
  "bat.bing.com",
  "ct.sendgrid.net",
  "mandrillapp.com",
  "open.convertkit-mail.com",
  "open.convertkit-mail2.com",
  "track.hubspot.com",
  "pi.pardot.com",
  "p.typekit.net",
  "track.mixmax.com",
  "r.superhuman.com",
  "mixpanel.com",
  "facebook.com"
];
function isTrackerUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  return TRACKER_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

// src/app.ts
var MAX_IMAGE_RESPONSE_BYTES = 15 * 1024 * 1024;
var CARD_MAX_WIDTH = 800;
var FULL_MAX_WIDTH = 1600;
var CARD_BUDGET_SUFFIX = "_c";
var MAX_VIEW_SOURCE_BYTES = Math.floor(4.5 * 1024 * 1024);
var VIEW_SOURCE_TIMEOUT_MS = 25e3;
var IMAGE_FETCH_TIMEOUT_MS = 15e3;
var CARD_RETRY_DELAYS_SEC = [2, 4, 8];
var CARD_RETRY_PARAM = "r";
var CARD_RETRY_MIN_TOKEN_SEC = 5;
var TRANSIENT_UPSTREAM_ERRORS = /* @__PURE__ */ new Set([
  "busy",
  "token_busy",
  "gmail_rate_limited",
  "gmail_server",
  "gmail_network"
]);
var UPSTREAM_ERROR_BODY_MAX = 1024;
function cardRetryAttempt(url) {
  const r = url.searchParams.get(CARD_RETRY_PARAM);
  if (r === null) return 0;
  const n = /^[1-9]$/.test(r) ? Number(r) : Infinity;
  return Math.min(n, CARD_RETRY_DELAYS_SEC.length);
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
function defaultLog(e) {
  console.log(JSON.stringify({ svc: "edf-view", ...e }));
}
var DETERMINISTIC_FAILURES = /* @__PURE__ */ new Set([
  "bad_url",
  "bad_scheme",
  "bad_port",
  "blocked_host",
  "blocked_address",
  "content_type",
  "redirects",
  "not_image",
  "too_many_pixels"
]);
function routeParams(url, prefix) {
  const m = prefix === "v" ? /^\/v\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname) : /^\/img\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
  return m === null ? null : m.slice(1);
}
async function readCapped(res, max) {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => void 0);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function upstreamErrorCode(res) {
  try {
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await res.body?.cancel().catch(() => void 0);
      return null;
    }
    const bytes = await readCapped(res, UPSTREAM_ERROR_BODY_MAX);
    if (bytes === null) return null;
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}
function spread(emailId, attempt) {
  let h = attempt;
  for (let i = 0; i < emailId.length; i++) h = h * 31 + emailId.charCodeAt(i) >>> 0;
  return h % 2;
}
function upstreamStatus(status) {
  if (status === 400) return 400;
  if (status === 401 || status === 403) return 403;
  if (status === 404 || status === 410) return 404;
  if (status === 429) return 429;
  if (status === 503) return 503;
  return 502;
}
function createViewApp(deps) {
  const { config } = deps;
  const stats = new Stats(deps.now());
  const budget = new EmailBudget();
  const statsDeps = {
    statsUrl: `${config.appOrigin}/api/view-stats`,
    token: deps.token,
    fetchImpl: deps.fetchApp,
    now: deps.now,
    log: deps.log,
    sleep: deps.sleep
  };
  async function finish(request, response, waitUntil) {
    const bg = stats.maybeFlush(statsDeps, request);
    if (waitUntil) {
      waitUntil(bg);
      const trailing = stats.scheduleTrailing(statsDeps, request);
      if (trailing) waitUntil(trailing);
    } else await bg;
    return response;
  }
  async function view(request) {
    stats.add("view_requests");
    if (request.method !== "GET") return errorPage(405, config, { allow: "GET" });
    const url = new URL(request.url);
    const params = routeParams(url, "v");
    if (params === null) {
      stats.add("view_rejected_format");
      return errorPage(404, config);
    }
    const [rawToken, emailId] = params;
    const gate = gateViewToken(rawToken, Math.floor(deps.now() / 1e3));
    if (!gate.ok || !EMAIL_ID_RE.test(emailId)) {
      stats.add(
        gate.ok || gate.reason === "format" ? "view_rejected_format" : "view_rejected_expiry"
      );
      return errorPage(400, config);
    }
    const transientFailure = (status) => {
      if (gate.mode !== "card") return errorPage(status, config);
      const attempt = cardRetryAttempt(url);
      const base = CARD_RETRY_DELAYS_SEC[attempt];
      if (base === void 0) return errorPage(status, config);
      const delay = base + spread(emailId, attempt);
      if (gate.exp - Math.floor(deps.now() / 1e3) < delay + CARD_RETRY_MIN_TOKEN_SEC)
        return errorPage(status, config);
      stats.add("view_card_retry");
      return cardRetryPage(
        status,
        config,
        delay,
        `/v/${gate.token}/${emailId}?${CARD_RETRY_PARAM}=${attempt + 1}`
      );
    };
    const oidc = await deps.token(request);
    if (oidc === null) {
      stats.add("view_upstream_error");
      deps.log({ ev: "view_error", code: "no_oidc_token" });
      return errorPage(503, config);
    }
    let res;
    stats.add("view_forwarded");
    try {
      res = await deps.fetchApp(`${config.appOrigin}/api/view-source/${gate.token}/${emailId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${oidc}`, accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(VIEW_SOURCE_TIMEOUT_MS)
      });
    } catch (err) {
      stats.add("view_upstream_error");
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      deps.log({ ev: "view_error", code: timeout ? "timeout" : "network" });
      return transientFailure(timeout ? 504 : 502);
    }
    if (res.status !== 200) {
      const reason = res.status === 503 ? await upstreamErrorCode(res) : null;
      if (res.status !== 503) await res.body?.cancel().catch(() => void 0);
      stats.add("view_upstream_error");
      deps.log({
        ev: "view_error",
        code: "upstream_status",
        status: res.status,
        ...reason === null ? {} : { reason }
      });
      const status = upstreamStatus(res.status);
      const transient = res.status === 429 || reason !== null && TRANSIENT_UPSTREAM_ERRORS.has(reason);
      return transient ? transientFailure(status) : errorPage(status, config);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const bytes = type === "application/json" ? await readCapped(res, MAX_VIEW_SOURCE_BYTES).catch(() => null) : null;
    let html = null;
    if (bytes !== null) {
      try {
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const heightOk = typeof body.height === "number" && Number.isFinite(body.height) && body.height >= 0 && body.height <= 1e6;
        if (typeof body.html === "string" && body.html.length > 0 && heightOk) html = body.html;
      } catch {
        html = null;
      }
    } else {
      await res.body?.cancel().catch(() => void 0);
    }
    if (html === null) {
      stats.add("view_upstream_error");
      deps.log({ ev: "view_error", code: "bad_upstream_body" });
      return errorPage(502, config);
    }
    return new Response(html, {
      status: 200,
      headers: viewHeaders(config, viewCacheControl(gate.exp, Math.floor(deps.now() / 1e3)))
    });
  }
  function placeholder(cacheControl, status = 200) {
    return imageResponse(UNAVAILABLE_SVG, UNAVAILABLE_SVG_TYPE, cacheControl, status);
  }
  async function img(request) {
    stats.add("img_requests");
    if (request.method !== "GET") return placeholder(NO_STORE, 405);
    const params = routeParams(new URL(request.url), "img");
    if (params !== null && params[0] === UNAVAILABLE_IMAGE_PATH)
      return placeholder(STATIC_IMAGE_CACHE);
    const now = deps.now();
    const nowSec = Math.floor(now / 1e3);
    const claims = params === null ? null : verifyImageToken(config.imgKeys, params[0], nowSec);
    if (claims === null) {
      stats.add("img_bad_signature");
      return placeholder(NO_STORE, 403);
    }
    if (isTrackerUrl(claims.url)) {
      stats.add("img_blocked_tracker");
      return imageResponse(TRANSPARENT_GIF, "image/gif", imageCacheLong(claims.x, nowSec));
    }
    const tokenCap = Math.min(claims.mb, MAX_IMAGE_RESPONSE_BYTES);
    const budgetKey = `${claims.u}
${claims.e}
${claims.b}`;
    const left = budget.remaining(budgetKey, now);
    if (left <= 0) {
      stats.add("img_budget_exceeded");
      return placeholder(NO_STORE);
    }
    const maxBytes = Math.min(tokenCap, left);
    let r;
    try {
      r = await deps.fetchImage(claims.url, { maxBytes, timeoutMs: IMAGE_FETCH_TIMEOUT_MS });
    } catch {
      r = { ok: false, reason: "network" };
    }
    if (!r.ok) {
      stats.add(r.reason === "too_large" ? "img_too_large" : "img_upstream_error");
      const budgetLimited = r.reason === "too_large" && maxBytes < tokenCap;
      const cache = budgetLimited ? NO_STORE : DETERMINISTIC_FAILURES.has(r.reason) || r.reason === "too_large" ? imageCacheLong(claims.x, Math.floor(deps.now() / 1e3)) : IMAGE_CACHE_SHORT;
      deps.log({
        ev: "img_error",
        code: r.reason,
        // Which image server, and the allowance: enough to tell a refusing host or an
        // over-the-cap picture apart, never the image's address (it can carry tracking ids).
        host: hostOf(claims.url),
        mb: maxBytes,
        ...r.status === void 0 ? {} : { status: r.status }
      });
      return placeholder(cache);
    }
    const card = claims.b.endsWith(CARD_BUDGET_SUFFIX);
    let body = r.body;
    let contentType = r.contentType;
    if (deps.shrinkImage !== void 0) {
      const cpu = process.cpuUsage();
      const small = await deps.shrinkImage(
        { body: r.body, format: r.format, width: r.width, height: r.height },
        card ? CARD_MAX_WIDTH : FULL_MAX_WIDTH
      ).catch(() => null);
      const used = process.cpuUsage(cpu);
      stats.add("img_resize_cpu_ms", Math.round((used.user + used.system) / 1e3));
      if (small !== null) {
        body = small.body;
        contentType = small.contentType;
        stats.add("img_resized");
      }
    }
    budget.spend(budgetKey, body.length, now);
    stats.add("img_ok");
    stats.add("img_bytes_served", body.length);
    if (card) stats.add("img_card_bytes_served", body.length);
    return imageResponse(body, contentType, imageCacheLong(claims.x, Math.floor(deps.now() / 1e3)));
  }
  const guard = (fn, fallback) => async (request, waitUntil) => {
    let response;
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
    stats
  };
}
function contextWaitUntil() {
  const ctx = globalThis[/* @__PURE__ */ Symbol.for("@vercel/request-context")];
  const fn = ctx?.get?.()?.waitUntil;
  return typeof fn === "function" ? fn : void 0;
}

// src/config.ts
function productionLike(env) {
  return env.NODE_ENV === "production" || typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV !== "" || env.VERCEL === "1";
}
function origin(v, dev) {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.origin !== v) return null;
    if (u.protocol === "https:") return u.origin;
    if (dev && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))
      return u.origin;
  } catch {
  }
  return null;
}
function loadViewConfig(env, opts = {}) {
  const dev = opts.dev === true;
  if (dev && productionLike(env)) return { ok: false, code: "dev_in_production" };
  if (env.VERCEL_TOKEN || env.VERCEL_API_TOKEN || env.VERCEL_ACCESS_TOKEN)
    return { ok: false, code: "vercel_token_present" };
  const imgKeys = parseImagePublicKeys(env.IMG_PUBKEYS);
  if (imgKeys === null) return { ok: false, code: "img_pubkeys" };
  const appOrigin = origin(env.APP_ORIGIN, dev);
  const viewOrigin = origin(env.VIEW_ORIGIN, dev);
  if (appOrigin === null) return { ok: false, code: "app_origin" };
  if (viewOrigin === null) return { ok: false, code: "view_origin" };
  if (appOrigin === viewOrigin || !dev && new URL(appOrigin).hostname === new URL(viewOrigin).hostname) {
    return { ok: false, code: "origins_not_separate" };
  }
  return { ok: true, config: { imgKeys, appOrigin, viewOrigin } };
}

// src/oidc.ts
var JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
function requestContextHeader(name) {
  const ctx = globalThis[/* @__PURE__ */ Symbol.for("@vercel/request-context")];
  const v = ctx?.get?.()?.headers?.[name];
  return typeof v === "string" ? v : null;
}
var vercelTokenSource = async (request) => {
  const t = request.headers.get("x-vercel-oidc-token") ?? requestContextHeader("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN ?? null;
  return t !== null && t.length <= 8192 && JWT_RE.test(t) ? t : null;
};

// src/runtime.ts
var built = null;
function runtime(fetchImage, shrinkImage) {
  if (built !== null) return built;
  const cfg = loadViewConfig(process.env);
  if (!cfg.ok) {
    defaultLog({ ev: "misconfigured", code: cfg.code });
    built = { code: cfg.code };
    return built;
  }
  built = {
    app: createViewApp({
      config: cfg.config,
      token: vercelTokenSource,
      fetchApp: fetch,
      fetchImage,
      ...shrinkImage === void 0 ? {} : { shrinkImage },
      now: Date.now,
      log: defaultLog
    })
  };
  return built;
}
var noImageFetch = async () => ({ ok: false, reason: "network" });
function unavailable() {
  return new Response("Service unavailable", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store"
    }
  });
}

// src/v.ts
var v_default = {
  fetch(request) {
    const r = runtime(noImageFetch);
    return "app" in r ? r.app.view(request, contextWaitUntil()) : Promise.resolve(unavailable());
  }
};
export {
  v_default as default
};
