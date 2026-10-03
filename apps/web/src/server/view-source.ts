/**
 * /api/view-source (FREE-TIER.md §9.3): called only by edf-view with its OIDC token; the HMAC view
 * token covers the user id, which is looked up from the email id and only trusted if the HMAC
 * verifies. Fetches the message live from Gmail (reserving viewer quota, floor 0), runs the viewer
 * sanitizer + CSS rewrite, mints Ed25519 image tokens with byte allowances, and returns {html, height}.
 * The allowances only bound what edf-view may serve; they are not metered: edf-view reports the
 * image bytes it really served (/api/view-stats, service-counts.ts), and those are metered as Fast
 * Origin Transfer (packages/budget/DECISIONS.md, "Fast Origin Transfer"; FREE-TIER.md §8.1).
 */
import "server-only";
import { parseMime } from "@edf/core";
import { extractImageRefs, imageFetchDecision, imagesAllowedFor, isExpiredSignedUrl } from "@edf/core/policy";
import {
  CryptoError,
  EMAIL_ID_RE,
  IMAGE_TOKEN_MAX_BYTES,
  IMAGE_TOKEN_MAX_LENGTH,
  imageTokenExpiry,
  parseViewToken,
  signImageToken,
  signOutLink,
  verifyViewToken,
} from "@edf/crypto";
import { withSystem, withUser } from "@edf/db";
import {
  FLOOR_VIEWER,
  RAW_FIELDS,
  UNITS,
  GmailClient,
  OAuthError,
  TokenRefreshBusyError,
  base64ResponseCap,
  decodeRawMessage,
  isGmailError,
  reserveQuota,
  type GmailError,
  type GmailErrorKind,
} from "@edf/gmail";
import { sanitizeForViewer, type ViewerImageContext } from "@edf/sanitize";
import { env } from "@/env";
import { PHONE_WIDTH, phoneZoom, previewFrameOf } from "@/lib/gallery-preview";
import { getPool } from "./db";
import { imageSigningKeys, outKeys, viewKeys } from "./keys";
import { pipelineDeps } from "./pipeline-deps";
import { isFixtureAccount, readFixtureRaw } from "./fixtures";

/**
 * A full view's ("img") total image allowance and image cap: 60 distinct images sharing 15 MB
 * (fullViewImageAllowances), ≤ 5 MB each (IMAGE_TOKEN_MAX_BYTES). edf-view's per-budget ledger
 * (apps/view budget.ts) is the same 15 MB.
 */
export const EMAIL_BUDGET_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_TOKENS = 60;
/**
 * A gallery card ("card" mode) shows the top of the email at about half size, so only the first
 * distinct images (in document order, CSS backgrounds included) are proxied; the rest keep their
 * alt text, which a card doesn't paint (CARD_MISSING_IMAGE_CSS). Every proxied image is one /img
 * request (the frame has no scripting, so `loading="lazy"` is ignored and every proxied image
 * loads, visible or not) and its Fast Origin Transfer, so this is what keeps gallery browsing
 * inside the free tier (FREE-TIER.md §8.4). The detail view and the full analysis use "img"
 * (every image).
 *
 * 20, from a ground-truth audit (2026-09-30: all 618 real emails loaded exactly as their cards
 * load them): at the old cap of 6, 177 cards had images inside the card's visible part (the top
 * ~1,300–1,600 px of the 800 px layout) left without a src, 1–10 per card on top of the 6 proxied
 * (LinkedIn digests, job boards, shops: 8–36 images each; CSS backgrounds such as Google's
 * value-prop tiles use slots too). Re-measured at 20: the deepest visible image needed slot 20
 * on 4 cards (at most 18 on the rest) and none is left out by the cap (packages/budget
 * DECISIONS.md "Card image cap"). Cost, measured on all 618 cards: ≤ 21 requests per card
 * (1 /v + 20 /img) instead of ≤ 7, 6.5 /img on average instead of 3.6, and ≈ 113 KB of images
 * served per card instead of ≈ 55 KB (the extra images are mostly avatars, icons and thumbnails;
 * ≈ +58 MB of Fast Origin Transfer per 1,000 cards shown on first view). The total allowance stays
 * CARD_BUDGET_BYTES.
 */
export const CARD_MAX_IMAGES = 20;
/**
 * A card's total image allowance, fixed: it does not grow with CARD_MAX_IMAGES (6 MB, as when the
 * cap was 6 × 1 MB). The signed allowances of a card's images never add up to more, so 6 MB is the
 * most one card can make edf-view serve (each token's `mb` is the hard bound; edf-view's per-budget
 * ledger is only a best-effort second layer, per instance). How the 6 MB is shared:
 * cardImageAllowances.
 */
export const CARD_BUDGET_BYTES = 6 * 1024 * 1024;
/**
 * Every image of a view is first given a floor, so the small images later in a digest still load:
 * IMAGE_FLOOR_BYTES each, or an even share of a quarter of the view's budget when that is less
 * (a card past 12 images: 75 KB each at 20; a full view past 30: 64 KB each at 60).
 */
export const IMAGE_FLOOR_BYTES = 128 * 1024;
/**
 * A card's weight for its image in document slot `index` (0-based): 1 for the first four, then
 * (4 ÷ (index + 1))^1.25 (0.76, 0.60, 0.50, 0.42, … 0.13 at slot 20). A card shows only the top of
 * the email, and the later an image comes the less likely it is to be in that part. This curve
 * follows the 2026-10-01 audit of all 630 real cards: an image in slots 1–4 was inside the card's
 * visible part 81–88% of the time; relative to that, slots 5–9 were 0.76, 0.61, 0.51, 0.45, 0.32
 * (the curve: 0.76, 0.60, 0.50, 0.42, 0.36), slots 10–12 0.33–0.38 (0.32–0.25), from slot 13
 * ≤ 0.13 (≤ 0.23; the 1.0 power, 4 ÷ slot, failed one more visible hero). It only
 * matters between images declared alike (a 600 px hero against a 24 px icon is decided by their
 * sizes): Chanty declares every picture by its width alone, so a 600 × 89 header, the 600 × 600
 * hero below it and every 600 px picture further down weigh the same, and only their slots keep
 * the ≈ 800 KB heroes (which loaded under the old 1 MB for the first four) above their size.
 */
export function cardSlotWeight(index: number): number {
  return index < 4 ? 1 : (4 / (index + 1)) ** 1.25;
}
/**
 * What a view knows about an image's size before anything is fetched: the width, height and style
 * written on its element (@edf/sanitize ViewerImageContext; @edf/core/policy ImageRef for the first
 * estimate). A url() in a `<style>` element has none of them.
 */
export interface ImageSizeHint {
  width?: string | null;
  height?: string | null;
  style?: string | null;
}
/** The email layout width the card renders at: wider declared sizes are scaled down to it. */
const LAYOUT_WIDTH_PX = 800;
/** An image with no declared size (unsized, or a CSS background) counts as 150 × 150. */
const UNKNOWN_SIDE_PX = 150;
/** A declared width without a height counts as 4:3 (a height without a width likewise). */
const ASSUMED_ASPECT = 0.75;
const MIN_AREA_PX2 = 16 * 16;
const MAX_AREA_PX2 = LAYOUT_WIDTH_PX * 1600;

/** CSS px of a declared length: `600`, `600px` (an attribute or a style value), `50%` as a share of a 600 px column; else null. */
function declaredPx(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.length > 40) return null;
  const m = /^\s*(\d{1,5}(?:\.\d{1,4})?)\s*(px|%)?\s*(?:!\s*important)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "%" ? (Math.min(n, 100) / 100) * 600 : n;
}

/** The value of `prop` in an inline style (the last declaration wins), or null. */
function styleValue(style: string | null | undefined, prop: string): string | null {
  if (!style) return null;
  let value: string | null = null;
  for (const decl of style.slice(0, 4096).split(";")) {
    const colon = decl.indexOf(":");
    if (colon > 0 && decl.slice(0, colon).trim().toLowerCase() === prop) value = decl.slice(colon + 1);
  }
  return value;
}

/**
 * An image's declared display area in CSS px² (its weight in cardImageAllowances and
 * fullViewImageAllowances): width × height from its `width`/`height` attributes, else its inline
 * style's `width`/`height`, else `max-width`/`max-height`; at most the 800 px layout wide; a missing
 * height ¾ of the width (and the reverse); neither 150 × 150; clamped to [16², 800 × 1600].
 */
export function imageDisplayArea(h: ImageSizeHint): number {
  const dim = (attr: string | null | undefined, prop: string) =>
    declaredPx(attr) ?? declaredPx(styleValue(h.style, prop)) ?? declaredPx(styleValue(h.style, `max-${prop}`));
  let w = dim(h.width, "width") || null;
  let ht = dim(h.height, "height") || null;
  if (w !== null && w > LAYOUT_WIDTH_PX) {
    if (ht !== null) ht = (ht * LAYOUT_WIDTH_PX) / w;
    w = LAYOUT_WIDTH_PX;
  }
  const ew = w ?? (ht !== null ? ht / ASSUMED_ASPECT : UNKNOWN_SIDE_PX);
  const eh = ht ?? (w !== null ? w * ASSUMED_ASPECT : UNKNOWN_SIDE_PX);
  return Math.min(MAX_AREA_PX2, Math.max(MIN_AREA_PX2, ew * eh));
}

/**
 * Shares `budget` among a view's images (document order): image i gets
 * min(5 MB, max(min[i], floor + level × weight[i])) at the highest level the budget covers. So
 * every image gets at least its minimum, the rest is shared in proportion to the weights, and what
 * an image capped at IMAGE_TOKEN_MAX_BYTES can't take goes to the others (water-filling). Whole
 * bytes, adding up to at most `budget` (the rounding's leftover, or what capped images can't use,
 * stays unminted). Each min[i] is at least `floor`, and they add up to at most `budget`.
 */
function shareBudget(min: readonly number[], weight: readonly number[], floor: number, budget: number): number[] {
  const cap = IMAGE_TOKEN_MAX_BYTES;
  const at = (i: number, level: number) => Math.min(cap, Math.max(min[i]!, floor + level * weight[i]!));
  const total = (level: number) => min.reduce((s, _, i) => s + at(i, level), 0);
  // The levels where an image rises above its minimum or reaches the cap. Between two of them the
  // total grows linearly, so the budget's level is solved exactly within its interval.
  const levels = [
    ...new Set([0, ...min.flatMap((m, i) => [Math.max(0, (m - floor) / weight[i]!), Math.max(0, (cap - floor) / weight[i]!)])]),
  ].sort((a, b) => a - b);
  let k = 0;
  while (k + 1 < levels.length && total(levels[k + 1]!) <= budget) k++;
  let out: number[];
  if (k + 1 === levels.length) {
    out = min.map((_, i) => Math.floor(at(i, levels[k]!))); // the budget covers every image's cap
  } else {
    const mid = (levels[k]! + levels[k + 1]!) / 2;
    const rising = min.map((m, i) => m < floor + mid * weight[i]! && floor + mid * weight[i]! < cap);
    let pool = budget;
    let w = 0;
    for (const [i, r] of rising.entries()) {
      if (r) w += weight[i]!;
      pool -= r ? floor : Math.floor(at(i, mid));
    }
    out = min.map((m, i) =>
      rising[i] ? Math.min(cap, Math.max(m, floor + Math.floor((pool * weight[i]!) / w))) : Math.floor(at(i, mid)),
    );
  }
  // Raising a rounded share to its minimum can pass the budget by a few bytes: taken back from the largest.
  for (let over = out.reduce((s, a) => s + a, 0) - budget; over > 0; ) {
    const i = out.indexOf(Math.max(...out));
    const d = Math.min(over, out[i]!);
    out[i] = out[i]! - d;
    over -= d;
  }
  return out;
}

/**
 * The allowances of a card's images (document order, at most CARD_MAX_IMAGES), from their declared
 * sizes. Nothing about an image's real size is known before edf-view fetches it, but where it is
 * shown says how much room it takes: a hero, a banner or a product shot is drawn large, and its file
 * is large; an avatar, an icon or a logo is drawn small. And a card shows only the top of the email.
 *
 *  1. Every image gets a floor of min(128 KB, 1.5 MB ÷ n) (IMAGE_FLOOR_BYTES, a quarter of the
 *     budget): 128 KB up to 12 images, 75 KB at 20, so the small images later in a digest still load.
 *  2. The rest is shared in proportion to imageDisplayArea × cardSlotWeight (the first four images
 *     1, then (4 ÷ slot)^1.25), each image up to the full view's per-image cap
 *     (IMAGE_TOKEN_MAX_BYTES, 5 MB); what a capped image can't take goes to the others, in
 *     proportion again (shareBudget).
 *
 * So a lone hero gets 5 MB (a one-picture mailer's 3–5 MB PNG shows in its card), a 600 × 600
 * hero ≈ 4.9 MB beside a logo and four 100 px images, ≈ 4.5 MB beside a logo and 18 icons; three
 * 600 × 600 GIFs 1.8, 1.8 and 1.1 MB beside 11 icons; six alike images 1.1 MB each for the first
 * four, then 0.87 and 0.71 MB; 20 alike 595 KB for the first four down to 146 KB. The allowances
 * add up to at most CARD_BUDGET_BYTES.
 * Chosen on the 2026-10-01 audit of all 630 real cards (every image's real size, its slot and
 * whether it shows in the card): images inside a card's visible part left as placeholders because
 * of their allowance went from 38 on 31 cards (1 MB for the first four, then an even share of the
 * rest) to 8 on 6 (by size alone 11 on 9, two of them Chanty heroes that loaded before; an even
 * 6 MB ÷ n split 25 on 22), and none that loaded under the old split fails; what is left are large
 * images in one card that together outgrow 6 MB, or that are declared alike (or not at all) but
 * differ in weight (packages/budget DECISIONS.md "Card image allowance by displayed size").
 *
 * The result depends on every image of the card, so it must be computed for exactly the images the
 * card mints: buildViewSource estimates them from extractImageRefs, re-mints from the rendered list
 * when that differs, and never mints an allowance the rest of the budget can't cover in full.
 */
export function cardImageAllowances(hints: readonly ImageSizeHint[]): number[] {
  const n = Math.min(hints.length, CARD_MAX_IMAGES);
  if (n === 0) return [];
  const floor = Math.min(IMAGE_FLOOR_BYTES, Math.floor(CARD_BUDGET_BYTES / 4 / n));
  const weight = hints.slice(0, n).map((h, i) => imageDisplayArea(h) * cardSlotWeight(i));
  return shareBudget(new Array<number>(n).fill(floor), weight, floor, CARD_BUDGET_BYTES);
}

/**
 * The allowances of a full view's images (document order, at most MAX_IMAGE_TOKENS): its 15 MB
 * shared as a card shares its 6 MB (shareBudget), with three differences.
 *
 *  - Each of the first CARD_MAX_IMAGES images (the ones its card proxies, in the same order)
 *    starts from what the card gives it, so opening an email never shows "Picture unavailable"
 *    where its card showed the picture (a card's hero can get up to 5 MB, more than an even
 *    15 MB ÷ n share; the others start from min(128 KB, 3.75 MB ÷ n)).
 *  - The whole email is shown, so there is no slot weight.
 *  - The budget is not tight, so the share leans less on declared size: in proportion to the
 *    image's declared side, √imageDisplayArea, not its area.
 *
 * So up to three images get 5 MB each, n alike images 15 MB ÷ n each (as the even split before), a
 * hero keeps at least its card's 4–5 MB beside a dozen others. On the 2026-10-01 audit's full views
 * of all 630 real emails (4,166 images, real sizes known): images over their allowance went from 8
 * (an even split, of every image the scan found, proxied or not) to 3, none that loaded before
 * fails, and none loads in its card but not here (by area instead of side: 4, two that loaded
 * before fail). They add up to at most EMAIL_BUDGET_BYTES (the card's minimums to at most 6 MB +
 * 40 × 64 KB). Like a card's, the result depends on every image, so buildViewSource re-mints from
 * the rendered list when it differs.
 */
export function fullViewImageAllowances(hints: readonly ImageSizeHint[]): number[] {
  const n = Math.min(hints.length, MAX_IMAGE_TOKENS);
  if (n === 0) return [];
  const floor = Math.min(IMAGE_FLOOR_BYTES, Math.floor(EMAIL_BUDGET_BYTES / 4 / n));
  const card = cardImageAllowances(hints);
  const min = Array.from({ length: n }, (_, i) => Math.max(floor, card[i] ?? 0));
  const weight = hints.slice(0, n).map((h) => Math.sqrt(imageDisplayArea(h)));
  return shareBudget(min, weight, floor, EMAIL_BUDGET_BYTES);
}
/**
 * Appended to a card's document: an image left without a src (past the cap, or dropped by the
 * privacy policy) keeps its box and its alt attribute but paints nothing. (An image that can't be
 * shown for any other reason has a src: edf-view's "Picture unavailable" placeholder,
 * VIEWER_UNAVAILABLE_IMAGE_PATH.)
 * Chrome draws such an image as a broken-image icon plus its alt text (underlined inside a link),
 * which at card size reads as clutter, and some senders' alt texts are whole sentences (a wall of
 * text where the design should be). `opacity: 0` hides all of it (icon, text, the link's
 * underline) without changing layout, and unlike `visibility: hidden` or `display: none` it leaves
 * the image in the accessibility tree, so a screen reader still gets the alt text (checked in
 * Chrome 148; the transparent colours are a fallback). Appended after the sanitized document, so it
 * can't land inside an element or attribute: the parser moves a `<style>` after `</html>` into the
 * body, and being last it wins over the email's own rules of equal weight. The detail view
 * ("img"/"noimg") keeps showing alt text.
 */
export const CARD_MISSING_IMAGE_CSS =
  "<style>html body img:not([src]){opacity:0!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}</style>";
/**
 * Card image tokens carry their own budget id (`<emailId>_<exp36>_c`), so edf-view can tell card
 * images apart in its counters (`img_card_bytes_served`, a diagnostic subset of
 * `img_bytes_served`). Card and full views alike meter only their HTML here; their images are
 * metered from edf-view's exact byte reports (packages/budget/DECISIONS.md, "Fast Origin
 * Transfer"; FREE-TIER.md §8.1).
 */
export const CARD_BUDGET_SUFFIX = "_c";
/**
 * `/img/unavailable` on edf-view (mirrors apps/view http.ts UNAVAILABLE_IMAGE_PATH): its "Picture
 * unavailable" placeholder as a static image, CDN- and browser-cached for a day, the same SVG a
 * failed image fetch is answered with. The src of an <img> this view already knows can't be shown:
 * an expired signed URL (gone at the source), one the signer refuses, one past a full view's
 * 60-image cap. An image blocked for privacy (a tracker, a pixel, a per-recipient URL) keeps no
 * src instead, invisible in a card as before; so does one past a card's cap (CARD_MISSING_IMAGE_CSS),
 * and so does a CSS background in any of these cases (dropped, so the email's background colour
 * shows, as before).
 */
export const VIEWER_UNAVAILABLE_IMAGE_PATH = "unavailable";
/**
 * Gmail's default text font, for text the email sets no font on: a bare frame shows it in the
 * browser's default Times New Roman, Gmail web in Arial (2 of 267 emails in the 2026-09-30 visual
 * audit looked serif here and sans-serif in Gmail). Zero specificity and first in `<head>`, before
 * the email's own CSS, so any font the email sets wins however it sets it (a rule on `html`, `body`,
 * `*` or a table, `<font face>`, an inline style), and inheritance carries it everywhere else. It is
 * the renderer's "No font set" sentinel with Gmail's stack in place of `"__default__"` (@edf/design
 * render-kit html.ts: the same selector in the same place), so exactly the text the analysis
 * reports as "No font set" shows in Arial here. Every mode (img, noimg, card).
 *
 * The light version, as Gmail web shows it, is not set here: a frame's `prefers-color-scheme`
 * follows its `<iframe>` element's `color-scheme` in the embedding page, which inherited the app's
 * dark theme (so an email's dark-mode CSS applied whenever the app was dark), and nothing inside the
 * document can change it (checked in Chrome 148: an email's `<meta name="color-scheme"
 * content="light">` or `"only light"` changes nothing). apps/web globals.css sets `color-scheme:
 * light` on every iframe.
 */
export const VIEWER_DEFAULT_FONT_CSS = "<style>:where(html){font-family:Arial,Helvetica,sans-serif}</style>";
/** The start of sanitizeForViewer's output: `<!DOCTYPE html>`, `<html>` (its attributes double-quoted), `<head>`. */
const DOCUMENT_HEAD_RE = /^<!DOCTYPE html>\n<html(?:\s+[^\s"'>=/]+(?:="[^"]*")?)*\s*><head>/i;

/**
 * `doc` (a sanitizeForViewer document) with VIEWER_DEFAULT_FONT_CSS first in its `<head>`. Should
 * the document ever start otherwise, the style goes right after the doctype, which the HTML parser
 * also puts first in the head (a `<style>` before `<html>` opens the head; the `<html>` and `<head>`
 * tags that follow only add their attributes).
 */
export function withDefaultFont(doc: string): string {
  const m = DOCUMENT_HEAD_RE.exec(doc);
  if (m) return m[0] + VIEWER_DEFAULT_FONT_CSS + doc.slice(m[0].length);
  const doctype = /^<!DOCTYPE html>\n?/i.exec(doc)?.[0] ?? "";
  return doctype + VIEWER_DEFAULT_FONT_CSS + doc.slice(doctype.length);
}
/**
 * The phone preview's "fit to screen" (the gallery detail's Phone, the email page's Mobile 375):
 * both lay the email out in a frame exactly PHONE_WIDTH wide, where its width media queries (and,
 * read as the frame's width, its device-width ones: sanitizeForViewer `phoneWidth`) apply as in
 * the analysis' phone pass. An email the analysis measured wider than the phone even then (a fixed
 * 600 px table: `layout.mobileContentWidth`) is zoomed out to fit, as phone mail apps do, by
 * lib/gallery-preview.ts `phoneZoom`, the same zoom the app sizes the frame by. The page keeps its
 * phone layout width (`width` 375 px), so what is fluid stays laid out as on the phone and only the
 * wider part runs on, and the whole is then shown at the zoom: the text the reader sees is the
 * analysis' phone text size (`phoneTextPx`). Only in a frame no wider than the phone, so the
 * desktop preview and the cards are unchanged; a zoom on the root doesn't change what the frame's
 * media queries see (checked in Chrome 148), so it can't switch itself off. Nothing when the email
 * fits the phone or its layout wasn't measured.
 */
export function phoneFitCss(layout: unknown): string {
  const zoom = phoneZoom(previewFrameOf(layout));
  if (!(zoom < 1)) return "";
  return `<style>@media (max-width:${PHONE_WIDTH}px){:root:root{zoom:${zoom}!important;width:${PHONE_WIDTH}px!important}}</style>`;
}
const DATA_URI_MAX = 256 * 1024;
/**
 * Inline (cid:) images inlined as data: URIs in one view, in total, counting every occurrence (each
 * is a copy in the HTML). Past it the rest are dropped (alt kept) so the view still fits the body cap.
 */
const DATA_URI_TOTAL_MAX = 2 * 1024 * 1024;
/**
 * The JSON body /api/view-source may return: Vercel refuses a response over 4.5 MB (FREE-TIER.md §2), and
 * edf-view reads at most that much (its MAX_VIEW_SOURCE_BYTES). edf-view's image responses now allow
 * 5 MB because they are streamed (MAX_IMAGE_RESPONSE_BYTES); this buffered JSON body keeps 4 MB.
 */
export const VIEW_SOURCE_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Characters of the text version kept when an email is too large to show as HTML (≤ 6 bytes each once escaped). */
const TEXT_FALLBACK_MAX_CHARS = 512 * 1024;
const ALLOWED_INLINE = new Set(["image/png", "image/gif", "image/jpeg", "image/webp"]);

export type ViewSourceResult =
  | {
      ok: true;
      html: string;
      height: number;
      /**
       * The image allowances minted for this view: an upper bound on what edf-view may serve for
       * them, never metered (edf-view's reports of the bytes it served are; service-counts.ts).
       */
      imageBytesMinted: number;
      unsignableUrls: number;
    }
  | { ok: false; status: 401 | 404 | 429 | 503; error: string };

/**
 * Sign a URL the email controls; null when the signer refuses it (too long, token over the cap), so
 * one odd image or link is dropped instead of failing the whole view.
 */
function trySign(sign: () => string): string | null {
  try {
    return sign();
  } catch (err) {
    if (err instanceof CryptoError) return null;
    throw err;
  }
}

/** Whether the route's response body (it sends `{html, height}` as JSON) is within the cap. */
function fitsBody(html: string, height: number): boolean {
  return Buffer.byteLength(JSON.stringify({ html, height })) <= VIEW_SOURCE_MAX_BODY_BYTES;
}

function textDocument(text: string, note?: string): string {
  const intro = note
    ? `<p style="font:14px/1.5 system-ui,sans-serif;margin:16px;color:#555">${escapeHtml(note)}</p>`
    : "";
  return `<!doctype html><html><body>${intro}<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;margin:16px">${escapeHtml(text)}</pre></body></html>`;
}

const TEXT_SKIP = new Set(["script", "style", "head", "title", "template", "noscript", "svg"]);
const TEXT_BREAK = new Set(["br", "p", "div", "tr", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote", "section", "article", "header", "footer"]);
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", zwnj: "", zwj: "", shy: "" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "\uFFFD";
  });
}

/**
 * Readable text of an HTML body, for the too-large fallback of an email with no text/plain part:
 * tags dropped (script/style/head content too), block ends as line breaks, entities decoded. One
 * forward scan with indexOf (no backtracking regex over the email), stopping at `max` characters.
 */
function htmlText(html: string, max: number): string {
  let out = "";
  let i = 0;
  let skip: string | null = null;
  while (i < html.length && out.length < max) {
    const lt = html.indexOf("<", i);
    const end = lt < 0 ? html.length : lt;
    if (skip === null && end > i) out += decodeEntities(html.slice(i, end).replace(/\s+/g, " "));
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const m = /^<(\/?)([a-z][a-z0-9]*)/i.exec(html.slice(lt, Math.min(gt, lt + 16)));
    i = gt + 1;
    if (!m) continue;
    const name = m[2]!.toLowerCase();
    if (skip !== null) {
      if (m[1] && name === skip) skip = null;
    } else if (!m[1] && TEXT_SKIP.has(name) && html[gt - 1] !== "/") {
      skip = name;
    } else if (TEXT_BREAK.has(name)) {
      out += "\n";
    }
  }
  return out
    .replace(/[ \t]+/g, " ") // runs first, so the next pattern can't backtrack over a long one
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

// ───────────────────────── live Gmail fetch: per-mailbox limit and retries ─────────────────────────
//
// Time budget. edf-view aborts its call to this route after 25 s (apps/view VIEW_SOURCE_TIMEOUT_MS;
// its function's maxDuration is 30 s), and the gallery hands a card's load slot to the next card
// after 15 s (preview-urls.tsx LOAD_TIMEOUT_MS; the frame itself keeps loading). Here no Gmail
// attempt starts later than VIEWER_GMAIL_START_BUDGET_MS (8 s) after the fetch began (slot wait and
// backoff included), and each attempt times out after VIEWER_GMAIL_TIMEOUT_MS (12 s, vs the
// client's 30 s default, which outlived edf-view's 25 s), so the fetch ends within 20 s even in
// the worst case, leaving ≥ 4 s for the sanitizer. A normal fetch is one attempt of ~0.3–2 s; a
// rate-limited one typically one retry after Gmail's 1–3 s backoff, so a card still loads well
// inside its 15 s slot. When the budget runs out the view fails fast with a transient code and
// edf-view's card retry page tries again a few seconds later (apps/view app.ts).

/**
 * Viewer Gmail fetches in flight per mailbox in this server instance. Each view builds its own
 * GmailClient, so the client's own ≤ 4 semaphore never spans two views: a gallery (6 card loads
 * at a time plus the first screen, preview-urls.tsx) could put many messages.get calls in flight
 * for one mailbox at once, and a warm instance serves all of them. A ground-truth audit loading
 * 618 real cards ~8 at a time got 233 × 503 `gmail_rate_limited` (Gmail's per-user limit). 3 in
 * flight still serves a screen of cards in a few seconds and leaves room for the background
 * jobs' own ≤ 4 (DESIGN.md §5.2).
 */
export const VIEWER_GMAIL_CONCURRENCY = 3;
/** Views waiting for a slot per mailbox; one more is refused at once (`busy`, transient). */
export const VIEWER_GMAIL_MAX_QUEUE = 24;
/** Attempts per view (1 + 2 retries), only for transient failures (VIEWER_RETRY_KINDS). */
export const VIEWER_GMAIL_MAX_ATTEMPTS = 3;
/** No attempt (nor the wait for a slot) starts later than this after the fetch began. */
export const VIEWER_GMAIL_START_BUDGET_MS = 8_000;
/** Per-attempt timeout (response body included). */
export const VIEWER_GMAIL_TIMEOUT_MS = 12_000;
/**
 * Worth retrying within one view: Gmail's rate limit (429 / 403 rate reasons) and transient
 * server or network failures. `unauthorized` is already retried once inside the client with a
 * refreshed token; `not_found`, `policy`, `daily_limit`, `bad_request`, `too_large` and
 * `bad_response` would fail the same way again.
 */
export const VIEWER_RETRY_KINDS: ReadonlySet<GmailErrorKind> = new Set(["rate_limited", "server", "network"]);

/**
 * A FIFO counting semaphore per key (a mailbox id), for one server instance. Memory stays bounded:
 * a key's entry exists only while one of its slots is held or waited for, and each key queues at
 * most `maxQueue` waiters.
 */
export class KeyedSemaphore {
  private readonly entries = new Map<string, { active: number; queue: Array<() => void> }>();

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  /** Keys with a slot held or waited for (0 when idle). */
  get size(): number {
    return this.entries.size;
  }

  /** Slots of `key` currently held. */
  inFlight(key: string): number {
    return this.entries.get(key)?.active ?? 0;
  }

  /**
   * Take one of `key`'s slots, waiting up to `waitMs` for one to free up. Resolves to the release
   * function (call it exactly once; later calls are ignored), or null when none freed up in time
   * or the queue is full.
   */
  acquire(key: string, waitMs: number): Promise<(() => void) | null> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { active: 0, queue: [] };
      this.entries.set(key, entry);
    }
    const e = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = e.queue.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else if (--e.active === 0 && this.entries.get(key) === e) this.entries.delete(key);
    };
    if (e.active < this.limit) {
      e.active++;
      return Promise.resolve(release);
    }
    if (e.queue.length >= this.maxQueue || waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(release);
      };
      const timer = setTimeout(() => {
        const i = e.queue.indexOf(grant);
        if (i >= 0) e.queue.splice(i, 1);
        resolve(null);
      }, waitMs);
      e.queue.push(grant);
    });
  }
}

/** Process-wide: every view in this instance shares it (bounded, see KeyedSemaphore). */
export const viewerGmailSlots = new KeyedSemaphore(VIEWER_GMAIL_CONCURRENCY, VIEWER_GMAIL_MAX_QUEUE);

/** The view was refused before or between Gmail attempts, for a transient reason. */
export class ViewerFetchRefused extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly code: "quota" | "busy",
  ) {
    super(`viewer fetch refused: ${code}`);
    this.name = "ViewerFetchRefused";
  }
}

/**
 * Wait before retry number `attempt` (1-based) of a transient failure, with up to 250 ms of
 * jitter so views that failed together don't retry together. A rate limit waits what Gmail asked
 * for (`retryAfterMs`: its Retry-After, or the client's own 1 s → 2 s → … backoff, which grows
 * with the client's streak, and this view reuses its client across attempts); a server or network
 * failure 0.5 s, then 1 s.
 */
export function viewerRetryDelayMs(err: GmailError, attempt: number, random: () => number = Math.random): number {
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 1) * 250);
  if (err.kind === "rate_limited") return Math.max(1000, err.retryAfterMs ?? 1000) + jitter;
  return 500 * 2 ** Math.max(0, attempt - 1) + jitter;
}

/**
 * One view's Gmail fetch: reserve quota, call Gmail, and on a transient failure (VIEWER_RETRY_KINDS)
 * back off and try again, at most VIEWER_GMAIL_MAX_ATTEMPTS times and never starting an attempt
 * after `deadline`. Any other error, or the last one, is rethrown as is.
 *
 * Quota: every attempt reserves UNITS.messagesGet again. Each attempt is a request Gmail receives
 * and counts against the per-user rate limit whether or not it answers 429 (a rate limiter counts
 * the requests it refuses), and the bucket models requests sent (DESIGN.md §5.2), so it must never
 * count fewer than were sent; a Gmail 429 means Gmail already sees more traffic than the bucket
 * does. Erring high costs at most 2 × 20 extra units per view and only makes background work
 * yield sooner (its 1,000-unit floor). A refused reservation ends the view as 429 `quota`.
 */
export async function fetchForViewer<T>(o: {
  reserve: () => Promise<boolean>;
  fetch: () => Promise<T>;
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    if (!(await o.reserve())) throw new ViewerFetchRefused(429, "quota");
    try {
      return await o.fetch();
    } catch (err) {
      if (!isGmailError(err) || !VIEWER_RETRY_KINDS.has(err.kind) || attempt >= VIEWER_GMAIL_MAX_ATTEMPTS) throw err;
      const wait = viewerRetryDelayMs(err, attempt, o.random);
      if (now() + wait > o.deadline) throw err;
      await sleep(wait);
    }
  }
}

/**
 * The error code a failed live fetch returns (logged too; kinds only, no ids or content). The
 * transient ones, which edf-view's card retry page retries (apps/view TRANSIENT_UPSTREAM_ERRORS),
 * are `quota` (429), `busy`, `token_busy` and `gmail_rate_limited` / `gmail_server` /
 * `gmail_network` (503).
 */
function fetchErrorCode(err: unknown): string {
  if (isGmailError(err)) return `gmail_${err.kind}`;
  if (err instanceof TokenRefreshBusyError || (err instanceof OAuthError && err.retriable)) return "token_busy";
  return "fetch_failed";
}

export async function buildViewSource(token: string, emailId: string): Promise<ViewSourceResult> {
  const parsedToken = parseViewToken(token);
  if (!parsedToken || !EMAIL_ID_RE.test(emailId)) return { ok: false, status: 401, error: "bad_token" };
  const pool = await getPool();
  const userId = await withSystem(pool, async (_db, c) =>
    (await c.query<{ u: string | null }>("SELECT lookup_email_owner($1::uuid) AS u", [emailId])).rows[0]?.u ?? null,
  );
  // Verify against a placeholder when unknown so timing doesn't reveal whether the id exists.
  const verified = verifyViewToken(viewKeys(), token, { userId: userId ?? "__none__", emailId, nowSec: Math.floor(Date.now() / 1000) });
  if (!userId || !verified) return { ok: false, status: userId ? 401 : 404, error: userId ? "bad_token" : "not_found" };

  const row = await withUser(pool, userId, async (_db, c) => {
    const r = await c.query<{
      mailbox_id: string;
      provider_message_id: string;
      primary_type: string;
      suspicious: boolean;
      security_sensitive: boolean;
      mailbox_status: string;
      provider_account_id: string;
      load_images: boolean;
      desktop_height: number | null;
      layout: unknown;
    }>(
      `SELECT e.mailbox_id, e.provider_message_id, e.primary_type, e.suspicious, e.security_sensitive,
              m.status AS mailbox_status, m.provider_account_id, coalesce(us.load_images_for_analysis, true) AS load_images,
              coalesce(a.score_summary #>> '{layout,desktopHeight}', a.features #>> '{render,layout,desktopHeight}')::float8::int AS desktop_height,
              -- The gallery's own layout source (queries/gallery.ts), for the phone preview's zoom.
              coalesce(a.score_summary -> 'layout', a.features #> '{render,layout}') AS layout
       FROM email e JOIN mailbox m ON m.id = e.mailbox_id
       LEFT JOIN user_settings us ON us.user_id = e.user_id
       LEFT JOIN email_analysis a ON a.email_id = e.id
       WHERE e.id = $1`,
      [emailId],
    );
    const addrs = await c.query<{ a: string }>("SELECT lower(email_address::text) AS a FROM mailbox WHERE user_id = $1", [userId]);
    return r.rows[0] ? { ...r.rows[0], addresses: addrs.rows.map((x) => x.a) } : null;
  });
  if (!row) return { ok: false, status: 404, error: "not_found" };
  if (row.mailbox_status !== "active") return { ok: false, status: 503, error: "mailbox_unavailable" };

  let raw: Uint8Array;
  if (isFixtureAccount(row.provider_account_id)) {
    const fixture = await readFixtureRaw(row.provider_message_id);
    if (!fixture) return { ok: false, status: 404, error: "not_found" };
    raw = fixture;
  } else {
    const started = Date.now();
    const release = await viewerGmailSlots.acquire(row.mailbox_id, VIEWER_GMAIL_START_BUDGET_MS);
    if (release === null) {
      console.error("[edf] view_source.fetch_failed", { error: "busy" });
      return { ok: false, status: 503, error: "busy" };
    }
    try {
      const deps = await pipelineDeps();
      // One client for this view's attempts, so its rate-limit backoff grows across them.
      const client = new GmailClient({
        getAccessToken: deps.tokens.forMailbox(userId, row.mailbox_id),
        maxConcurrent: 1,
        timeoutMs: VIEWER_GMAIL_TIMEOUT_MS,
      });
      const msg = await fetchForViewer({
        reserve: async () =>
          (await withUser(pool, userId, (db) => reserveQuota(db, { mailboxId: row.mailbox_id, units: UNITS.messagesGet, floor: FLOOR_VIEWER }))).ok,
        fetch: () => client.messagesGet(row.provider_message_id, { format: "raw", fields: RAW_FIELDS, maxBytes: base64ResponseCap(8 * 1024 * 1024) }),
        deadline: started + VIEWER_GMAIL_START_BUDGET_MS,
      });
      raw = decodeRawMessage(msg);
    } catch (err) {
      if (err instanceof ViewerFetchRefused) {
        console.error("[edf] view_source.fetch_failed", { error: err.code });
        return { ok: false, status: err.status, error: err.code };
      }
      if (isGmailError(err, "not_found")) {
        // Deleted in Gmail: never shown again (FREE-TIER.md §4.6).
        await withUser(pool, userId, async (_db, c) => {
          await c.query("DELETE FROM email WHERE id = $1", [emailId]);
          await c.query(
            "UPDATE message_ledger SET state = 'skipped', reason = 'gmail_error', updated_at = now() WHERE mailbox_id = $1 AND provider_message_id = $2",
            [row.mailbox_id, row.provider_message_id],
          );
        });
        return { ok: false, status: 404, error: "deleted" };
      }
      const error = fetchErrorCode(err);
      // The kind only (no ids, addresses or bodies): without it a blank preview is undiagnosable.
      console.error("[edf] view_source.fetch_failed", { error });
      return { ok: false, status: 503, error };
    } finally {
      release();
    }
  }
  const parsed = await parseMime(raw);
  const e = env();
  const viewOrigin = e.VIEW_ORIGIN.replace(/\/$/, "");
  const appOrigin = e.APP_ORIGIN.replace(/\/$/, "");
  const imagePrefix = `${viewOrigin}/img/`;
  // Longest URL the image rewriter returns: the prefix plus a signed token (base64url and dots, which
  // CSS never escapes; the signer refuses a longer one). The sanitizer checks the raw string, its
  // parsed href (a Unicode host is longer as punycode) and, in a CSS url(), that href as written,
  // where \ " ' ( ) and space take a backslash and "<" a space. CSS url()s reserve this much room,
  // instead of the sanitizer's 8 KB default, so a minted token is never refused for its length.
  const prefixHref = new URL(imagePrefix).href;
  const prefixCssLength = prefixHref.length + (prefixHref.match(/[\\"'() <]/g)?.length ?? 0);
  const imageMaxLength = Math.max(imagePrefix.length, prefixCssLength) + IMAGE_TOKEN_MAX_LENGTH;

  const cardMode = verified.mode === "card";
  const imagesAllowed =
    (verified.mode === "img" || cardMode) &&
    imagesAllowedFor({
      primaryType: row.primary_type,
      securitySensitive: row.security_sensitive,
      suspicious: row.suspicious,
      loadImagesForAnalysis: true, // viewing is an explicit user action; privacy mode governs analysis only
    });
  const html = parsed.html ?? textDocument(parsed.text ?? "");
  // Inline (cid:) images travel inside the message and never contact the sender, so the privacy
  // rule that keeps remote images out of transactional mail (tracking) doesn't apply to them: a
  // receipt's embedded logo shows. Never in the images-off view, security or suspicious mail.
  const inlineAllowed =
    verified.mode !== "noimg" &&
    !row.security_sensitive &&
    !row.suspicious &&
    row.primary_type !== "account_security";
  const maxImages = cardMode ? CARD_MAX_IMAGES : MAX_IMAGE_TOKENS;
  const policy = { userAddresses: row.addresses, imagesAllowed: true };
  const refs = imagesAllowed && parsed.html ? extractImageRefs(parsed.html, { max: MAX_IMAGE_TOKENS }) : [];
  const budgetBytes = cardMode ? CARD_BUDGET_BYTES : EMAIL_BUDGET_BYTES;
  const nowSec = Math.floor(Date.now() / 1000);
  const loadable = (r: (typeof refs)[number]) => imageFetchDecision(r, policy).allowed && !isExpiredSignedUrl(r.src, nowSec);
  // The allowances of the images a view proxies, in mint (document) order, by declared size: a
  // card's 6 MB per cardImageAllowances, a full view's 15 MB per fullViewImageAllowances (never
  // less for an image than its card gives it). ≤ 5 MB each; they add up to at most the budget.
  const allowancesFor = cardMode ? cardImageAllowances : fullViewImageAllowances;
  // First estimate of the images, from extractImageRefs: the ones the policy lets through, up to
  // the view's cap, with their declared sizes. It can be off: the scan keeps only each URL's first
  // occurrence (a hidden dark-mode copy before the shown logo makes that URL look like a pixel),
  // stops at 2 MB of HTML (200 KB of CSS), counts images the sanitizer drops, and doesn't see the
  // size of the element a style attribute's url() sits on. Too few, the budget runs out before the
  // cap (the next image would get no src, or a leftover of a few bytes that edf-view could only
  // answer with its placeholder); otherwise the images get other shares than their exact list
  // gives (and a full view could give an image less than its card does). So the render records the
  // images it really proxies (`wanted`, `wantedHints`) and, when the estimate was off, the view is
  // minted again from that exact list (below).
  let plan = allowancesFor(refs.filter(loadable).slice(0, maxImages));
  const signing = imageSigningKeys();
  const exp = imageTokenExpiry(new Date());
  // One budget per email per expiry day (fits edf-view's 64-char [A-Za-z0-9_-] id). A uuidv7 prefix
  // would be shared by every email inserted in the same ~65 s.
  const budgetId = `${emailId}_${exp.toString(36)}${cardMode ? CARD_BUDGET_SUFFIX : ""}`;
  let minted = 0;
  let mintedBytes = 0;
  let unsignable = 0;
  let inlinedChars = 0;
  let inlineOn = true;
  const inline = new Map(parsed.inline.map((p) => [p.cid, p]));
  // One token per distinct URL (the sanitizer calls `image` for every occurrence, so a repeated
  // spacer or icon must not use up the 60-token cap), and never more allowance in total than the
  // email's budget.
  const imageUrls = new Map<string, string | null>();
  // Distinct URLs this render proxies or would with budget left, in document order (≤ the cap),
  // and the declared size of each one's first proxied occurrence.
  let wanted: string[] = [];
  let wantedHints: ImageSizeHint[] = [];
  // Whether an image found no allowance in `plan` (the estimate saw too few images).
  let short = false;
  // edf-view's "Picture unavailable" image (VIEWER_UNAVAILABLE_IMAGE_PATH): the src of an <img>
  // that can't be shown and is known so here, so it shows the same honest placeholder a failed
  // fetch gets, without a fetch (a cached static image). Images blocked for privacy keep no src
  // instead: they stay invisible in a card, as before. So does a CSS background (`image` below).
  const unavailableSrc = `${imagePrefix}${VIEWER_UNAVAILABLE_IMAGE_PATH}`;
  const isToken = (v: string | null | undefined): v is string => typeof v === "string" && v !== unavailableSrc;
  // URLs one occurrence dropped as a pixel (size or hidden style) before another loaded them.
  const pixelDropped = new Set<string>();
  const dataUris = new Map<string, string | null>();
  // Signed once per distinct link (a second sanitizer pass below reuses them).
  const links = new Map<string, string | null>();
  /** Signs `url` with allowance `mb`; null (counted, and the URL settled as unavailable) when the signer refuses it. */
  const mint = (url: string, mb: number): string | null => {
    const t = signing ? trySign(() => signImageToken(signing, { u: userId, e: emailId, x: exp, url, mb, b: budgetId })) : null;
    if (t === null) {
      unsignable++;
      imageUrls.set(url, unavailableSrc);
      return null;
    }
    minted++;
    mintedBytes += mb;
    imageUrls.set(url, `${imagePrefix}${t}`);
    return `${imagePrefix}${t}`;
  };

  /** The src for one image occurrence: a token, the placeholder (unavailableSrc) or null (none). */
  const imageSrc = (url: string, img: ViewerImageContext): string | null => {
    if (!imagesAllowed || !signing) return null;
    // The same tracker, pixel (size, max-size, hidden style) and per-recipient decision the
    // analysis makes, from the attributes on this occurrence's element.
    const decision = imageFetchDecision({ src: url, width: img.width, height: img.height, style: img.style }, policy);
    if (!decision.allowed) {
      // A pixel-sized or hidden occurrence of a URL that another occurrence of this email loads
      // anyway shares that token: typically the dark-mode or mobile copy of a logo, hidden
      // inline and revealed by the email's own CSS (packages/core DECISIONS.md "Hidden copies").
      // The same URL is fetched either way, so this adds no request and tells the sender
      // nothing more. The URL-level rules (tracker host, per-recipient) can't differ between
      // occurrences, so only a `pixel` decision can.
      if (decision.reason === "pixel") {
        const known = imageUrls.get(url);
        if (isToken(known)) return known;
        pixelDropped.add(url);
      }
      return null;
    }
    const known = imageUrls.get(url);
    if (known !== undefined) return known;
    // An expired signed CDN URL (LinkedIn's `e`) is gone at the source: proxying it could only
    // fail, using up a request and, in a card, a slot. An <img> shows the placeholder straight
    // away (a background is dropped: `image` below).
    if (isExpiredSignedUrl(url, nowSec)) {
      imageUrls.set(url, unavailableSrc);
      return unavailableSrc;
    }
    if (wanted.length >= maxImages) {
      // Past the cap. A card paints nothing for it (CARD_MISSING_IMAGE_CSS; the cap is sized so
      // none of these is in a card's visible part); the opened design shows the placeholder for
      // an <img> (and drops a background).
      const src = cardMode ? null : unavailableSrc;
      imageUrls.set(url, src);
      return src;
    }
    wanted.push(url);
    wantedHints.push({ width: img.width, height: img.height, style: img.style });
    // Never a partial allowance: a token for less than the image's share (a leftover of a few
    // bytes, say) would only fetch the image to answer `too_large`. An image the plan has no
    // share for waits for the view to be minted again from the exact list instead.
    const allowance = plan[minted];
    if (allowance === undefined || budgetBytes - mintedBytes < allowance) {
      short = true;
      imageUrls.set(url, null);
      return null;
    }
    const src = mint(url, allowance);
    if (src !== null) return src;
    // Unsignable (too long for a token): it doesn't use up a slot or a share.
    wanted.pop();
    wantedHints.pop();
    return unavailableSrc;
  };

  const rewriters: Parameters<typeof sanitizeForViewer>[1] = {
    // The opened design's phone preview (a PHONE_WIDTH frame) switches the email's device-width
    // phone styles on as a phone would; wider frames see exactly what the email wrote. Not in a
    // card, whose frame is never that narrow.
    ...(cardMode ? {} : { phoneWidth: PHONE_WIDTH }),
    // The placeholder is for an <img> only. A CSS background (a style url() or a `background`
    // attribute) known here not to load is dropped, as before, so the email's own background colour
    // shows: drawn as a background, the placeholder would cover that colour with a light fill
    // (repeated as 1 px tiles, hiding white text on a dark cell) or be stretched by
    // `background-size: cover` and cropped (its icon and words cut off). Decided per occurrence,
    // so a URL used both ways gets the right one each time.
    image: (url, img) => {
      const src = imageSrc(url, img);
      return src === unavailableSrc && img.kind !== "img" ? null : src;
    },
    imageMaxLength,
    cid: (cid) => {
      if (!inlineAllowed || !inlineOn) return null;
      let uri = dataUris.get(cid);
      if (uri === undefined) {
        const p = inline.get(cid);
        uri =
          p && ALLOWED_INLINE.has(p.mimeType) && p.content.byteLength <= DATA_URI_MAX
            ? `data:${p.mimeType};base64,${Buffer.from(p.content).toString("base64")}`
            : null;
        dataUris.set(cid, uri);
      }
      if (uri === null || inlinedChars + uri.length > DATA_URI_TOTAL_MAX) return null;
      inlinedChars += uri.length;
      return uri;
    },
    link: (url) => {
      if (row.suspicious) return null; // links disabled in suspicious mail (DESIGN.md §11.5)
      // /out opens web links only (DESIGN.md §11.5), so a mailto: link is disabled (its text stays)
      // rather than sent to a page that can only refuse it.
      if (!/^https?:/i.test(url)) return null;
      const known = links.get(url);
      if (known !== undefined) return known;
      const t = trySign(() => signOutLink(outKeys(), { sessionId: `u:${userId}`, url, exp: Math.floor(Date.now() / 1000) + 3600 }));
      if (t === null) unsignable++;
      const out = t === null ? null : `${appOrigin}/out?u=${encodeURIComponent(url)}&t=${encodeURIComponent(t)}`;
      links.set(url, out);
      return out;
    },
  };
  const height = Math.min(20_000, Math.max(200, row.desktop_height ?? 1200));
  const phoneFitStyle = cardMode ? "" : phoneFitCss(row.layout);
  const render = () => {
    const doc = withDefaultFont(sanitizeForViewer(html, rewriters).html);
    return cardMode ? doc + CARD_MISSING_IMAGE_CSS : doc + phoneFitStyle;
  };
  let out = render();
  // The estimate was off (an image found no share, or the images got other shares than their exact
  // list gives, in either mode, too high or too low): mint again, with allowances for exactly the
  // images the render proxies. The sanitizer's decisions don't depend on the allowances, so the
  // next render proxies the same URLs in the same order, and their allowances fit the budget.
  // They're minted up front, so a hidden copy that comes before the occurrence loading its URL gets
  // the token too. Tokens of the discarded render are never handed out. (Unless short, the first
  // `minted` entries of `plan` are exactly the allowances minted, in order.)
  const exact = allowancesFor(wantedHints);
  if (short || exact.length !== minted || exact.some((a, i) => a !== plan[i])) {
    const urls = wanted;
    const hints = wantedHints;
    plan = exact;
    // Keep the URLs settled as unloadable (expired, unsignable, over the cap); forget the tokens.
    // (The ones found short stay null until minted just below.)
    for (const [u, v] of imageUrls) if (isToken(v)) imageUrls.delete(u);
    pixelDropped.clear();
    wanted = [...urls];
    wantedHints = [...hints];
    minted = 0;
    mintedBytes = 0;
    for (const [i, u] of urls.entries()) mint(u, plan[i]!);
    inlinedChars = 0;
    out = render();
  }
  if ([...pixelDropped].some((u) => isToken(imageUrls.get(u)))) {
    // A hidden copy came before the occurrence that loads its URL: once more, so it gets the
    // token too (tokens and links are reused; nothing new is minted).
    inlinedChars = 0;
    out = render();
  }
  if (!fitsBody(out, height) && inlinedChars > 0) {
    // Over the body cap: the same view without inline images (tokens and links are reused).
    inlineOn = false;
    out = render();
  }
  if (!fitsBody(out, height)) {
    // Still too large (the HTML itself): the text version, so the email can be read at all (the
    // HTML's own text when the email has no text/plain part). It carries no image tokens, so the
    // ones minted for the discarded HTML are never handed out (and never served).
    const text = (parsed.text?.trim() ? parsed.text : htmlText(html, TEXT_FALLBACK_MAX_CHARS))
      .slice(0, TEXT_FALLBACK_MAX_CHARS)
      .replace(/[\uD800-\uDBFF]$/, "");
    out = sanitizeForViewer(textDocument(text, "This email is too large to show as designed. Here is its text version."), rewriters).html;
    mintedBytes = 0;
  }
  return {
    ok: true,
    html: out,
    height,
    imageBytesMinted: mintedBytes,
    unsignableUrls: unsignable,
  };
}
