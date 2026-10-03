/**
 * Hard caps for show-stoppers (DESIGN-SCORE §4). Every cap is ≤ 69, so a capped email can never
 * appear under "Good design". Caps fire only on measured facts, and only for severe problems a
 * reader can see: image-only, unreadable main text, broken images, a genuinely broken phone
 * layout, Gmail clipping, a visible merge tag.
 */
import { CLIP_BYTES } from "../constants";
import type { ContrastGroup } from "../features/render";
import type { CapId, DesignIssue } from "../types";
import { firstMergeTag } from "../util/patterns";
import { imagesOffRatio, tallyLoads } from "./checks/images";
import { clipShareAfter } from "./checks/technical";
import { tally } from "./contrast";
import type { CheckInput } from "./kit";
import {
  BROKEN_IMAGES_CAP_AREA,
  BROKEN_IMAGES_CAP_MIN,
  BROKEN_IMAGES_CAP_SHARE,
  CONTRAST_CAP_SHARE,
  MOBILE_OVERFLOW_K,
  MOBILE_UNREADABLE_PX,
  MOBILE_UNTAPPABLE_PX,
} from "./weights";

export const CAP_LIMITS: Readonly<Record<CapId, number>> = {
  CAP_IMAGE_ONLY: 49,
  CAP_CONTRAST: 59,
  CAP_BROKEN_IMAGES: 59,
  CAP_MOBILE_BROKEN: 64,
  CAP_CLIPPED: 69,
  CAP_MERGE_TAG: 69,
};

export const CAP_ISSUE: Readonly<Record<CapId, DesignIssue | null>> = {
  CAP_IMAGE_ONLY: "image_only",
  CAP_CONTRAST: "contrast",
  CAP_BROKEN_IMAGES: "broken_images",
  CAP_MOBILE_BROKEN: "mobile",
  CAP_CLIPPED: "clipped",
  CAP_MERGE_TAG: null,
};

export interface CapHit {
  id: CapId;
  limit: number;
  /** Measured facts behind the trigger (for the explanation). */
  value: Record<string, number | boolean | string | null>;
}

/** Groups that are main content for CAP_CONTRAST: body copy and headlines, not fine print. */
export function mainContentGroups(groups: readonly ContrastGroup[]): ContrastGroup[] {
  return groups.filter((g) => (g.role === "body" || g.role === "heading") && g.fine !== true);
}

/**
 * Evaluate every cap against the features (render facts may be the template sample's).
 *
 * Verdict policy (DECISIONS.md "Verdict policy"): every cap is a severe, visible, deterministic
 * defect — an email with a cap is a "Bad design" whatever the pending AI review says.
 */
export function evaluateCaps(input: CheckInput): CapHit[] {
  const hits: CapHit[] = [];
  const r = input.render;
  const add = (id: CapId, value: CapHit["value"]) =>
    hits.push({ id, limit: CAP_LIMITS[id], value });

  if (r) {
    // CAP_IMAGE_ONLY: L_legible < 200 AND img_share ≥ 0.5 AND images-off ratio (I4) < 0.3.
    const ratio = imagesOffRatio(r);
    if (ratio !== null) {
      if (r.text.chars.legible < 200 && r.images.share >= 0.5 && ratio < 0.3) {
        add("CAP_IMAGE_ONLY", {
          legibleChars: r.text.chars.legible,
          imgShare: r.images.share,
          imagesOffRatio: ratio,
        });
      }
    }
    // CAP_CONTRAST: > 40% of MAIN-CONTENT characters fail AA — body copy and headlines; the
    // footer and fine print (small legal/disclaimer text) are A1 deductions, never the cap.
    // Sub-1.3:1 hidden runs of ≥ 20 characters still count as failing (monotonic rule).
    const t = tally(mainContentGroups(r.contrast.groups), ["body", "heading"]);
    const decided = t.pass + t.fail;
    if (decided > 0 && t.fail / decided > CONTRAST_CAP_SHARE) {
      add("CAP_CONTRAST", {
        failShare: t.fail / decided,
        fg: t.worst?.fg ?? null,
        bg: t.worst?.bg ?? null,
        ratio: t.worst?.ratio ?? null,
        role: t.worst?.role ?? null,
        rendered: t.worst?.rendered ?? null,
      });
    }
    // CAP_BROKEN_IMAGES: > 50% of evaluated content images DEFINITIVELY broken (404/410 or a
    // non-image), and at least 2 of them — one missing logo is an I3 deduction, not a cap — and,
    // when the render measured image areas, ≥ 20% of the image area (an SVG never counts: I3).
    const loads = tallyLoads(r.images.loads, input.ctx);
    if (
      loads.broken >= BROKEN_IMAGES_CAP_MIN &&
      loads.broken / loads.evaluated > BROKEN_IMAGES_CAP_SHARE &&
      (loads.brokenArea === null || loads.brokenArea >= BROKEN_IMAGES_CAP_AREA)
    ) {
      add("CAP_BROKEN_IMAGES", {
        broken: loads.broken,
        evaluated: loads.evaluated,
        missing: loads.missing,
        notImage: loads.notImage,
        brokenArea: loads.brokenArea,
      });
    }
    // CAP_MOBILE_BROKEN: genuinely broken on a phone — sideways scroll / under half size, text
    // below the phone legibility floor after scaling, or a primary button shrunk until it can't
    // be tapped. A readable non-responsive 600px email is not broken (M1/M2/M3/M7/T1 deduct).
    const k = r.layout.k;
    const eff = r.text.body.mobile === null ? null : r.text.body.mobile * k;
    const cta = r.cta.primary;
    const ctaPx = cta
      ? Math.max(Math.min(cta.target.w, cta.target.h), Math.min(cta.visual.w, cta.visual.h)) * k
      : null;
    const reason =
      k < MOBILE_OVERFLOW_K
        ? "overflow"
        : eff !== null && eff < MOBILE_UNREADABLE_PX
          ? "text"
          : k < 0.99 && ctaPx !== null && ctaPx < MOBILE_UNTAPPABLE_PX
            ? "tap"
            : null;
    if (reason !== null)
      add("CAP_MOBILE_BROKEN", {
        reason,
        k,
        bodyPx: eff,
        ctaPx,
        contentWidth: Math.round(r.layout.mobileContentWidth),
      });
  }

  // CAP_CLIPPED: the clip offset falls before the primary CTA, or > 25% of visible text is after it.
  if (input.static.htmlBytes > CLIP_BYTES) {
    const after = clipShareAfter(input);
    const ctaAfter =
      input.ownRender && r
        ? r.clip.ctaAfterClip === true
        : input.static.cta.primaryOffset !== null && input.static.cta.primaryOffset >= CLIP_BYTES;
    if (ctaAfter || after > 0.25)
      add("CAP_CLIPPED", {
        bytes: input.static.htmlBytes,
        afterShare: after,
        ctaAfterClip: ctaAfter,
      });
  }

  // CAP_MERGE_TAG: an unrendered merge tag in the subject or the first mobile viewport.
  const subjectTag = input.ctx.subject ? firstMergeTag(input.ctx.subject) : null;
  const screenTag =
    input.ownRender && r ? r.mergeTagFirstViewport : input.static.mergeTags.firstScreen;
  // The tag a reader sees in the email itself is quoted first (with its words around it, e.g.
  // "Hi {{ first_name }}"); a subject-line tag second.
  if (subjectTag !== null || screenTag) {
    const screenSample = screenTag ? (input.static.mergeTags.sample ?? null) : null;
    add("CAP_MERGE_TAG", {
      subject: subjectTag !== null,
      firstScreen: screenTag,
      tag: screenSample ?? subjectTag ?? input.static.mergeTags.sample ?? null,
      snippet: screenTag ? (input.static.mergeTags.snippet ?? null) : null,
      subjectTag,
    });
  }

  return hits;
}
