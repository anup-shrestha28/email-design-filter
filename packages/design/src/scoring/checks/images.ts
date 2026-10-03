/**
 * Images & Media — 8.5 deterministic points + I6 (AI, 1.5) (DESIGN-SCORE §5.5).
 */
import type { ImageLoadReason, RenderFeatures } from "../../features/render";
import type { StaticDesignFeatures } from "../../features/static";
import type { ScoreContext } from "../../types";
import { meanOf, ramp } from "../../util/math";
import { MEGABYTE } from "../weights";
import {
  type CheckFn,
  type CheckTable,
  isOutcome,
  notApplicable,
  notEvaluated,
  r3,
  requireRender,
  scored,
} from "../kit";

const DAY_MS = 86_400_000;

/**
 * Load reasons (render-2026.4) that say nothing certain about the design, whatever the status:
 * our limits, the image policy, an expired signed link (a 410 past its expiry is not the sender's
 * "gone"), the fetch, a missing inline part or an image never fetched. Read before the status.
 */
const NOT_EVIDENCE: ReadonlySet<ImageLoadReason> = new Set<ImageLoadReason>([
  "too_large",
  "too_many_pixels",
  "budget",
  "tracker",
  "pixel",
  "per_recipient",
  "policy",
  "images_off",
  "not_http",
  "expired",
  "timeout",
  "network",
  "missing_cid",
  "not_fetched",
]);

/**
 * Images weren't requested for this email (`loads[].reason = "images_off"`): our policy for
 * account-security, transactional, security-sensitive and suspicious mail, and every email in
 * privacy mode. Nothing is drawn, which says nothing about the design: the image facts that need
 * pictures (drawn count, unknown share, G3) are not measured.
 */
export function imagesOff(r: RenderFeatures): boolean {
  return r.images.loads.some((l) => l.reason === "images_off");
}

export interface ImageLoadTally {
  /** Images with a definitive outcome (loaded, or definitively broken). */
  evaluated: number;
  ok: number;
  /** Definitively broken: the sender's server said "gone" (404/410) or sent a non-image. */
  broken: number;
  /** Of `broken`: HTTP 404/410. */
  missing: number;
  /** Of `broken`: a 2xx answer that isn't a decodable image. */
  notImage: number;
  /** Same as `broken` (kept for I3's stored value). */
  failed: number;
  /** SVG images (`unsupported`, render-2026.4): Gmail doesn't show them — a finding, not broken. */
  svg: number;
  /**
   * Share of the content-image area (`loads[].area`, render-2026.4) the broken images cover;
   * null when a load has no area (older renders) or the areas add up to 0.
   */
  brokenArea: number | null;
}

/**
 * Classify content-image loads (DESIGN-SCORE §5.5 I3, §4 CAP_BROKEN_IMAGES).
 *
 * Verdict policy: a failed image is the designer's fault only when the sender's server
 * definitively said so — HTTP 404/410 ("missing"), or a 2xx answer that is not a decodable image
 * ("not an image"). Everything else says nothing certain about the design and is not evaluated
 * for that image: timeouts, DNS/network errors, policy/tracker/SSRF blocks ("blocked"), our own
 * size limits ("too_large"), missing cid parts, redirects, 401/403/429 and 5xx answers (often
 * bot protection or a temporary outage), and any load whose render-2026.4 `reason` is one of
 * those (`NOT_EVIDENCE`: a 410 on an expired signed link included). A 404/410 on an email older
 * than 30 days is link rot, not a design defect, and is not evaluated either. An SVG
 * (`unsupported`) is counted apart: Gmail doesn't show it, a small finding of its own (I3), never
 * a broken image.
 */
export function tallyLoads(
  loads: RenderFeatures["images"]["loads"],
  ctx: ScoreContext,
): ImageLoadTally {
  const old = ctx.now.getTime() - ctx.receivedAt.getTime() > 30 * DAY_MS;
  const t: ImageLoadTally = {
    evaluated: 0,
    ok: 0,
    broken: 0,
    missing: 0,
    notImage: 0,
    failed: 0,
    svg: 0,
    brokenArea: null,
  };
  let area = 0;
  let brokenArea = 0;
  let areas = loads.length > 0;
  for (const l of loads) {
    if (l.area === undefined) areas = false;
    else area += l.area;
    if (l.status === "unsupported" || l.reason === "svg") {
      t.svg++;
      continue;
    }
    if (l.reason !== undefined && NOT_EVIDENCE.has(l.reason)) continue;
    if (typeof l.status !== "number") continue;
    const gone = l.status === 404 || l.status === 410;
    const okStatus = l.status >= 200 && l.status < 300;
    if (gone) {
      if (old) continue;
      t.evaluated++;
      t.broken++;
      t.missing++;
      brokenArea += l.area ?? 0;
    } else if (okStatus) {
      t.evaluated++;
      if (l.decoded) t.ok++;
      else {
        t.broken++;
        t.notImage++;
        brokenArea += l.area ?? 0;
      }
    }
  }
  t.failed = t.broken;
  // Areas that add up to 0 (broken images with no declared size lay out flat) say nothing: the
  // count rule decides, as for renders without areas.
  if (areas && area > 0) t.brokenArea = brokenArea / area;
  return t;
}

/**
 * Content images whose absence says nothing certain about the design (methodology 2026.5): not
 * drawn because of our limits, the privacy policy, an expired or refused link, a redirect, a
 * server error, the network or a missing part — everything but a definitive outcome (drawn; 404 /
 * 410 on a recent email; a non-image; an SVG).
 */
function unknownLoad(l: RenderFeatures["images"]["loads"][number], old: boolean): boolean {
  if (l.decoded) return false;
  if (l.status === "unsupported" || l.reason === "svg") return false;
  if (l.reason !== undefined && NOT_EVIDENCE.has(l.reason)) return true;
  if (typeof l.status !== "number") return true;
  if (l.status === 404 || l.status === 410) return old;
  return !(l.status >= 200 && l.status < 300);
}

/** A not-drawn image recorded with less area than this has no known size (it laid out flat). */
const UNSIZED_AREA = 100;

/**
 * Share of the content images that weren't drawn for unknown reasons (`unknownLoad`) — when most
 * are, the imagery can't be judged (the G3 imagery bar). By image area when the render recorded
 * it for every load (render-2026.4: a missing hero outweighs five drawn icons) and every missing
 * image has a size, else by count over the load entries (one per distinct URL from render-2026.4,
 * one per image before); null without any, and with images off for the email (`imagesOff`: not
 * requested, not "didn't load").
 */
export function imagesUnknownShare(r: RenderFeatures, ctx: ScoreContext): number | null {
  const loads = r.images.loads;
  if (loads.length === 0 || imagesOff(r)) return null;
  const old = ctx.now.getTime() - ctx.receivedAt.getTime() > 30 * DAY_MS;
  const unknown = loads.filter((l) => unknownLoad(l, old));
  // A missing image laid out flat weighs nothing by area, whatever its real size: count instead.
  const sized = unknown.every((l) => (l.area ?? 0) >= UNSIZED_AREA);
  if (sized && loads.every((l) => l.area !== undefined)) {
    const total = loads.reduce((sum, l) => sum + (l.area ?? 0), 0);
    if (total > 0) return unknown.reduce((sum, l) => sum + (l.area ?? 0), 0) / total;
  }
  return unknown.length / loads.length;
}

/**
 * The image share the email could have if its not-drawn images (`unknownLoad`) had loaded: I1's
 * share plus their recorded area (`loads[].area`, desktop px², render-2026.4) over the desktop page
 * — an upper bound, since a not-drawn image with a declared width already lays out as a sized
 * placeholder inside the share. 1 when such an image has no known size (it could be any size).
 * Renders before render-2026.4 logged only images that laid out, all of them inside the share:
 * the share itself. G3 blames image loading only when this could reach its bar.
 */
export function imageShareIfLoaded(r: RenderFeatures, ctx: ScoreContext): number {
  const share = r.images.share;
  const loads = r.images.loads;
  if (loads.length === 0 || loads.some((l) => l.area === undefined)) return share;
  const old = ctx.now.getTime() - ctx.receivedAt.getTime() > 30 * DAY_MS;
  const missing = loads.filter((l) => unknownLoad(l, old));
  if (missing.some((l) => (l.area ?? 0) < UNSIZED_AREA)) return 1;
  const page = r.layout.desktopContentWidth * r.layout.desktopHeight;
  const extra = missing.reduce((sum, l) => sum + (l.area ?? 0), 0);
  return page > 0 ? Math.min(1, share + extra / page) : share;
}

/**
 * A content image that wasn't drawn for unknown reasons (`unknownLoad`) could have been a large
 * picture: its recorded area (`loads[].area`, desktop px²) is at least `minArea`, or it has no
 * known size (no area, or laid out flat). The Excellent gate's G4 then can't tell whether the
 * email has a hero picture (`imagery_unknown`, not `hero`).
 */
export function largeImageMissing(r: RenderFeatures, ctx: ScoreContext, minArea: number): boolean {
  if (imagesOff(r)) return false;
  const old = ctx.now.getTime() - ctx.receivedAt.getTime() > 30 * DAY_MS;
  return r.images.loads.some(
    (l) =>
      unknownLoad(l, old) && (l.area === undefined || l.area < UNSIZED_AREA || l.area >= minArea),
  );
}

/**
 * Content images drawn from a decoded picture: `images.drawn` (render-2026.4); before it, the
 * decoded load entries, or every content image when none was logged.
 */
export function drawnImages(r: RenderFeatures): number {
  if (r.images.drawn !== undefined) return r.images.drawn;
  if (r.images.loads.length > 0) return r.images.loads.filter((l) => l.decoded).length;
  return r.images.content;
}

/**
 * Distinct content images declared in the HTML: `images.declared` (render-2026.4); before it, the
 * static pass's content-image count (null when that pass failed).
 */
export function declaredImages(r: RenderFeatures | null, st: StaticDesignFeatures): number | null {
  if (r?.images.declared !== undefined) return r.images.declared;
  return st.unavailable === true ? null : st.images.content;
}

/** Characters of live text under which an image-heavy email has its text in pictures. */
const IMAGE_TEXT_CHARS = 200;

/**
 * Text baked into pictures (2026-10-01 audit; the gallery's "text in images" problems): images
 * cover ≥ 50% of the email with < 200 legible characters (CAP_IMAGE_ONLY's thresholds without its
 * images-off test), or content images are declared but none was drawn (renders before
 * render-2026.4: the render found no content image) with < 200 — a picture too large to load.
 * Never by the drawn count when images were off for the email (`imagesOff`): nothing was drawn by
 * our policy, and a short receipt with a logo isn't text in pictures.
 */
export function textInImages(r: RenderFeatures, st: StaticDesignFeatures): boolean {
  if (r.text.chars.legible >= IMAGE_TEXT_CHARS) return false;
  if (r.images.share >= 0.5) return true;
  if (imagesOff(r)) return false;
  const declared = declaredImages(r, st);
  return declared !== null && declared >= 1 && (r.images.drawn ?? r.images.content) === 0;
}

/**
 * Images-off ratio (I4, CAP_IMAGE_ONLY), null when pass M-off didn't run. With content images
 * but nothing legible in the first two viewports even with images on, nothing survives either,
 * so the ratio is 0 (an image-only email must not escape the check through 0/0).
 */
export function imagesOffRatio(r: RenderFeatures): number | null {
  const off = r.imagesOff;
  if (!off) return null;
  if (off.on === 0) return r.images.content > 0 ? 0 : 1;
  return Math.min(1, off.off / off.on);
}

/** I1 Not image-dominated — N/A if img_share < 0.25, else `ramp(L_legible, 50, 500)`. */
export const checkI1: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const share = r.images.share;
  if (share < 0.25) return notApplicable({ imgShare: r3(share) });
  const legible = r.text.chars.legible;
  return scored(ramp(legible, 50, 500), { imgShare: r3(share), legibleChars: legible });
};

/**
 * I2 Key content is live text — mean of (a) `ramp(first-viewport legible chars, 10, 40)` and
 * (b) the primary-CTA label is live text; the OCR part (c) is dropped while OCR is off
 * (FREE-TIER.md §5.7).
 */
export const checkI2: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const a = ramp(r.text.firstViewportLegible, 10, 40);
  const cta = r.cta.primary;
  const b = cta ? (cta.live ? 1 : 0) : null;
  return scored(meanOf([a, b]) ?? a, {
    firstViewportChars: r.text.firstViewportLegible,
    ctaLive: cta ? cta.live : null,
  });
};

/** I3: each SVG (Gmail doesn't show it) costs this much credit, at most `SVG_PENALTY_MAX`. */
const SVG_PENALTY = 0.15;
const SVG_PENALTY_MAX = 0.3;

/**
 * I3 Images load — `ramp(share of evaluated content images that load and decode, 0.8, 1.0)`,
 * minus 0.15 per SVG image (at most 0.3): Gmail doesn't show SVG, a small finding, not a broken
 * image (methodology 2026.5).
 */
export const checkI3: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const t = tallyLoads(r.images.loads, input.ctx);
  if (r.images.content === 0 && t.svg === 0) return notApplicable({ reason: "no_images" });
  if (t.evaluated === 0 && t.svg === 0) return notEvaluated("no_image_evaluated");
  const base = t.evaluated > 0 ? ramp(t.ok / t.evaluated, 0.8, 1) : 1;
  return scored(Math.max(0, base - Math.min(SVG_PENALTY_MAX, SVG_PENALTY * t.svg)), {
    evaluated: t.evaluated,
    failed: t.failed,
    missing: t.missing,
    notImage: t.notImage,
    svg: t.svg,
  });
};

/** I4 Images-off resilience — (legible + alt chars) images off ÷ images on → `ramp(ratio, 0.2, 0.8)`. */
export const checkI4: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  if (r.images.content === 0) return notApplicable({ reason: "no_images" });
  const ratio = imagesOffRatio(r);
  if (ratio === null) return notEvaluated("pass_skipped");
  return scored(ramp(ratio, 0.2, 0.8), { ratio: r3(ratio) });
};

/** I5 Image weight — `ramp(bytes of loaded content images, 3 MB, 1 MB)`. */
export const checkI5: CheckFn = (input) => {
  const r = requireRender(input);
  if (isOutcome(r)) return r;
  const loaded = r.images.loads.filter(
    (l) => typeof l.status === "number" && l.status >= 200 && l.status < 300,
  ).length;
  if (r.images.content === 0 || loaded === 0) return notApplicable({ reason: "no_loaded_images" });
  return scored(ramp(r.images.bytes, 3 * MEGABYTE, MEGABYTE), { bytes: r.images.bytes });
};

export const IMAGES_CHECKS: CheckTable = {
  I1: checkI1,
  I2: checkI2,
  I3: checkI3,
  I4: checkI4,
  I5: checkI5,
};
