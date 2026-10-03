/**
 * Response headers and static bodies for edf-view (FREE-TIER.md §9.3; DESIGN.md §11.5).
 */
import { VIEW_TOKEN_MAX_TTL_SEC } from "./tokens";

export interface Origins {
  appOrigin: string;
  viewOrigin: string;
}

/** §9.3 step 4, changed only in its origins. */
export function viewCsp(o: Origins): string {
  return (
    `default-src 'none'; img-src ${o.viewOrigin}/img/ data:; style-src 'unsafe-inline'; font-src 'none'; ` +
    `form-action 'none'; base-uri 'none'; frame-ancestors ${o.appOrigin}; sandbox allow-popups allow-popups-to-escape-sandbox`
  );
}

/** Error pages and anything not tied to a live token: never stored anywhere. */
export const VIEW_NO_STORE = "private, no-store";

/**
 * A served email may be kept in the viewer's OWN browser cache until its view token expires, so a
 * gallery card that scrolls away and comes back with the same URL (the app reuses a URL for 200 s
 * of its 240 s life) reloads from the browser without another /v request, /api/view-source call or
 * Gmail fetch (FREE-TIER.md §8.4). `private` keeps it out of every shared cache: Vercel's CDN does
 * not cache a private response, and the URL carries the user's token. No `s-maxage`, no `public`.
 * The browser cache is partitioned by top-level site, so only the app's pages can hit it.
 * Trade-off (accepted, documented): the email may sit on the user's own disk cache after expiry
 * until evicted, and an email deleted or reclassified within the token's last ≤ 240 s can still be
 * shown from that cache until the token expires.
 */
export function viewCacheControl(expSec: number, nowSec: number): string {
  const ttl = Math.min(expSec - nowSec, VIEW_TOKEN_MAX_TTL_SEC);
  return ttl > 0 ? `private, max-age=${ttl}` : VIEW_NO_STORE;
}

/** Exactly the §9.3 viewer headers (plus the content type); errors keep `private, no-store`. */
export function viewHeaders(o: Origins, cacheControl = VIEW_NO_STORE): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": viewCsp(o),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": cacheControl,
  };
}

export const IMAGE_CSP = "default-src 'none'; sandbox";
/** Successful image responses are served from the CDN on repeat (§8.4). */
export const IMAGE_CACHE_LONG = "public, s-maxage=86400, immutable";
/**
 * IMAGE_CACHE_LONG plus a browser `max-age` bounded by the image token's remaining life (and the
 * CDN's day). Image tokens are deterministic for a UTC day (Ed25519 is deterministic and the
 * expiry is rounded to midnight + 24 h), so the same email's images keep the same URLs across view
 * token re-mints: revisits load them from the browser without reaching the edge at all, which is
 * also what keeps the gallery under edf-view's per-IP WAF rule (FREE-TIER.md §8.4). Without a
 * `max-age` browsers wouldn't reuse them (`s-maxage` is for shared caches only).
 */
export function imageCacheLong(expSec: number, nowSec: number): string {
  const ttl = Math.min(expSec - nowSec, IMAGE_BROWSER_MAX_AGE_SEC);
  return ttl > 0 ? `public, max-age=${ttl}, s-maxage=86400, immutable` : IMAGE_CACHE_LONG;
}
const IMAGE_BROWSER_MAX_AGE_SEC = 86400;
/** The static placeholder (`/img/unavailable`): the same bytes for every user, for a day. */
export const STATIC_IMAGE_CACHE = "public, max-age=86400, s-maxage=86400, immutable";
/** Transient upstream failures: cache briefly so retries don't hammer the function. */
export const IMAGE_CACHE_SHORT = "public, s-maxage=300";
export const NO_STORE = "no-store";

const ERROR_TEXT: Record<number, string> = {
  400: "This link has expired. Close and reopen the email.",
  403: "This email can't be shown.",
  404: "This email is no longer available.",
  405: "Not allowed.",
  429: "Too many requests. Try again in a minute.",
  502: "This email couldn't be loaded right now.",
  503: "This email couldn't be loaded right now.",
  504: "This email took too long to load.",
};

/**
 * Small neutral error page served with the same CSP and headers as the viewer. It must read as a
 * placeholder wherever it lands: the app's gallery cards show the top of an 800 px wide frame
 * zoomed to about half size and cropped to its middle 600 px (no script runs in the sandboxed frame,
 * so the card can't tell an error page from an email, and it shows only the top ~250–600 px of
 * the frame). So the message sits near the top, centred across the width, large, on a neutral
 * grey, with a plain title, and never pushed against an edge.
 */
export function errorPage(
  status: number,
  o: Origins,
  extra: Record<string, string> = {},
  head = false,
): Response {
  const text = ERROR_TEXT[status] ?? ERROR_TEXT[502];
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Email unavailable</title>' +
    "<style>html,body{margin:0;min-height:100%}body{box-sizing:border-box;min-height:100vh;padding:72px 32px 32px;" +
    "background:#f4f4f5;color:#52525b;text-align:center;font:22px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    "h1{margin:0 auto 10px;font-size:32px;line-height:1.25;font-weight:600;color:#3f3f46}" +
    "p{margin:0 auto;max-width:24em}</style>" +
    `</head><body><div><h1>Preview unavailable</h1><p>${text}</p></div></body></html>`;
  return new Response(head ? null : html, { status, headers: { ...viewHeaders(o), ...extra } });
}

/**
 * A gallery card's "still loading" page (app.ts, card retry): served in place of the error page
 * when a card view failed transiently, with an HTTP `Refresh` header that loads the same signed
 * view again after `refreshSec` seconds. Why a header and not `<meta http-equiv="refresh">`: the
 * card's frame is sandboxed without `allow-scripts` (EMAIL_FRAME_SANDBOX, and this CSP's own
 * `sandbox`), which sets the "sandboxed automatic features" flag, and the HTML spec's declarative
 * refresh steps skip a `<meta>` refresh under that flag but not the header ("if meta is given");
 * checked in headless Chrome 148 with the real frame sandbox and this CSP: the meta refresh never
 * fires, the header navigates the frame, on 200, 429 and 503 alike. `nextPath` is built from the
 * validated token and email id only. It looks like a neutral skeleton of an email (a logo bar, a
 * hero, a few lines of text and a button, laid out on the 800 px frame the card shows at about half
 * size), never an error. No script, same CSP and headers as every view page, `private, no-store`.
 */
export function cardRetryPage(status: number, o: Origins, refreshSec: number, nextPath: string): Response {
  const bar = (w: string, h: number, extra = "") =>
    `<div class="b" style="width:${w};height:${h}px${extra}"></div>`;
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Loading preview</title>' +
    "<style>html,body{margin:0}body{background:#f4f4f5;padding:32px 0}" +
    ".m{box-sizing:border-box;width:600px;max-width:100%;margin:0 auto;padding:32px 40px;background:#fff}" +
    ".b{background:#e4e4e7;border-radius:6px;margin:0 0 16px;animation:p 1.6s ease-in-out infinite}" +
    "@keyframes p{50%{opacity:.55}}@media (prefers-reduced-motion:reduce){.b{animation:none}}</style>" +
    '</head><body><div class="m" aria-busy="true" aria-label="Loading preview">' +
    bar("132px", 28, ";margin-bottom:32px") +
    bar("100%", 260, ";margin-bottom:32px") +
    bar("88%", 22) +
    bar("94%", 16) +
    bar("90%", 16) +
    bar("72%", 16, ";margin-bottom:32px") +
    bar("184px", 44, ";border-radius:22px") +
    bar("96%", 16, ";margin-top:40px") +
    bar("84%", 16) +
    "</div></body></html>";
  return new Response(html, {
    status,
    headers: { ...viewHeaders(o), refresh: `${refreshSec}; url=${nextPath}` },
  });
}

/** 1×1 transparent GIF (trackers). */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
/**
 * The path segment of edf-view's static "Picture unavailable" image, `/img/unavailable` (never a
 * valid token: tokens are `kid.payload.sig`). edf-app points an <img> it already knows can't be
 * shown at it (an expired signed URL, one the signer refuses, one past a full view's image cap;
 * apps/web server/view-source.ts), so the frame shows the same placeholder a failed fetch gets,
 * with no fetch and, once cached, no request. A CSS background in those cases is dropped instead,
 * so the email's own background colour shows (the placeholder would cover it).
 */
export const UNAVAILABLE_IMAGE_PATH = "unavailable";

/**
 * The SVG behind UNAVAILABLE_SVG. Layout: an SVG drawn as an image with an intrinsic size is scaled
 * to the box (Chrome synthesizes a viewBox), so the drawing lives in a 100 × 100 viewBox with
 * `meet`, top-aligned (one unit is 1% of the box's smaller side, `m`), and the tile is a rect far larger than
 * the viewBox (the root clips at the box, not at the viewBox), so it fills any box. The icon would
 * then grow with the box (300 px in a 600 px hero), so its scale comes from media queries, which
 * in an SVG image test the box it is drawn in: half of `m` while `m` < 48 px, then 24–40 px
 * (7% of `m`), in steps of ×1.4; only the tile below 16 px; the words "Picture unavailable"
 * under the icon once the box is at least 150 × 96 px; centred, but in a box over ≈ 200 px about
 * 96 px from its top (a card shows only the top of a tall hero). Without its `<style>` (a browser that
 * refused it) the presentation attributes still draw the tile and an icon at 7% of `m`, no words.
 */
function unavailableSvg(): string {
  const icon = (m: number) => (m < 48 ? m / 2 : Math.max(24, Math.min(40, 0.07 * m)));
  // The badge (a 24-unit icon glyph and its label) is scaled so the icon is icon(m) px wide:
  // scale × 24 × m / 100 = icon(m), evaluated at each step's geometric middle.
  const scale = (m: number) => ((icon(m) * 100) / (24 * m)).toFixed(3);
  // In a large box the badge sits ≈ 96 px below its top instead of at its centre (never lower
  // than the centre), so it shows in a gallery card, which crops a tall hero to its top part.
  const top = (m: number) => Math.max(16, Math.min(50, 9600 / m)).toFixed(1);
  const css = [`.b{transform:scale(${scale(32)})}`, "@media (max-width:15.98px),(max-height:15.98px){.i{display:none}}"];
  for (let lo = 48; lo < 1600; lo = Math.round(lo * 1.4)) {
    const mid = lo * Math.sqrt(1.4);
    css.push(
      `@media (min-width:${lo}px) and (min-height:${lo}px){.b{transform:scale(${scale(mid)})}` +
        (Number(top(mid)) < 50 ? `.p{transform:translate(50px,${top(mid)}px)}}` : "}"),
    );
  }
  css.push("@media (min-width:150px) and (min-height:96px){.l{display:inline}.i{transform:translate(-12px,-20px)}}");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 100 100" preserveAspectRatio="xMidYMin meet">' +
    `<style>${css.join("")}</style>` +
    '<rect x="-49950" y="-49950" width="100000" height="100000" fill="#f3f4f6"/>' +
    '<g class="p" transform="translate(50 50)"><g class="b" transform="scale(.3)">' +
    '<g class="i" transform="translate(-12 -12)" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.75" cy="9.75" r="1.75"/><path d="M21 15.5l-4.5-4.5L7 20"/></g>' +
    '<text class="l" display="none" y="16" text-anchor="middle" font-family="system-ui,Arial,sans-serif" font-size="10.5" fill="#6b7280">Picture unavailable</text>' +
    "</g></g></svg>"
  );
}

/**
 * edf-view's "Picture unavailable" placeholder (`image/svg+xml`), for every image it can't show:
 * gone at the source (403/404/410), larger than its allowance or than any view allows, over the
 * pixel cap, not an image, a timeout, the email's byte budget used up, a bad token, and the static
 * UNAVAILABLE_IMAGE_PATH. A soft light tile with a small picture icon (and the words where they
 * fit), so it reads as intentional; it replaced a 1×1 grey GIF, which stretched into a flat grey
 * box that looked like a broken page. Trackers still get TRANSPARENT_GIF: those are blocked on
 * purpose and stay invisible.
 *
 * Same footprint as the old GIF: its intrinsic size is 1 × 1 px (ratio 1:1), so a failed image
 * takes exactly the box it took before (its width/height attributes or CSS; an unsized one stays
 * 1 px, a width-only one a square) and no layout moves. Checked in headless Chrome 148 at 24–600 px,
 * width-only, unsized, and as a CSS background (`cover` and repeated). It is made for an <img>: a
 * request can't tell a CSS background from an <img> (both `Sec-Fetch-Dest: image`), so a proxied
 * background whose fetch fails gets it too, where it paints a light fill over the element's
 * background colour, as the grey GIF did (repeated as 1 px tiles: no icon; `cover`: scaled to the
 * box's larger side and cropped). edf-app drops the backgrounds it knows can't load.
 *
 * Safety: a constant written here, never email content, so the proxy still never serves an email's
 * own SVG (@edf/fetch refuses it). An SVG drawn as an image runs no script and loads nothing (the
 * HTML spec's secure animated mode); this one has no script, links, external references or event
 * handlers anyway (test/view.test.ts asserts it), and it is served with IMAGE_CSP and nosniff like
 * every image, so opened on its own it can't run anything either. The frame's CSP is unchanged
 * (`img-src <viewOrigin>/img/ data:`). Chrome applies its `<style>` under IMAGE_CSP (checked); a
 * browser that didn't would still draw the tile and the icon from the attributes.
 */
export const UNAVAILABLE_SVG = Buffer.from(unavailableSvg(), "utf8");
export const UNAVAILABLE_SVG_TYPE = "image/svg+xml";

export function imageResponse(
  body: Buffer,
  contentType: string,
  cacheControl: string,
  status = 200,
  head = false,
): Response {
  return new Response(head ? null : new Uint8Array(body.buffer, body.byteOffset, body.byteLength), {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(body.length),
      "content-security-policy": IMAGE_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": cacheControl,
    },
  });
}
