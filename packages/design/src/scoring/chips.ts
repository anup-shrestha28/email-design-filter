/**
 * Static issue chips (FREE-TIER.md §5.4 "Static only": no number, just chips such as
 * "Clipped in Gmail", "merge tags in subject", "no unsubscribe link"). Computed for every
 * coverage level so list badges work everywhere.
 */
import { CLIP_BYTES, NEAR_CLIP_BYTES } from "../constants";
import type { StaticDesignFeatures } from "../features/static";
import type { ScoreContext, StaticChip } from "../types";
import { hasMergeTag } from "../util/patterns";
import { footerApplies } from "./applicability";
import { GMAIL_STYLE_LIMIT } from "../static/css";

export function staticChips(st: StaticDesignFeatures, ctx: ScoreContext): StaticChip[] {
  const chips: StaticChip[] = [];
  if (st.htmlBytes > CLIP_BYTES)
    chips.push({ code: "clipped", label: "Clipped in Gmail", severity: "high" });
  else if (st.htmlBytes > NEAR_CLIP_BYTES)
    chips.push({ code: "near_clip", label: "Close to Gmail's clipping limit", severity: "low" });
  if (ctx.subject && hasMergeTag(ctx.subject))
    chips.push({ code: "merge_tag_subject", label: "Merge tag in subject", severity: "high" });
  // The static pass failed: its zero counts are placeholders, not "no unsubscribe" / "no lang".
  if (st.unavailable === true) return chips;
  if (st.mergeTags.body > 0)
    chips.push({ code: "merge_tag", label: "Unrendered merge tag", severity: "medium" });
  if (footerApplies(ctx.primaryType, ctx.isSubscription) && st.footer.unsubscribe === "none") {
    chips.push({ code: "no_unsubscribe", label: "No unsubscribe link", severity: "high" });
  }
  if (st.images.content > 0 && st.images.withAlt / st.images.content < 0.5) {
    chips.push({ code: "no_alt_text", label: "Images missing alt text", severity: "medium" });
  }
  if (!st.lang.html && !st.lang.wrapper)
    chips.push({ code: "no_lang", label: "No language declared", severity: "low" });
  if (st.style.bytes > GMAIL_STYLE_LIMIT || st.style.mediaAfterLimit) {
    chips.push({
      code: "style_budget",
      label: "Styles exceed Gmail's 16 KB limit",
      severity: "medium",
    });
  }
  if (st.links.emptyOrHash + st.links.javascript + st.links.placeholder > 0) {
    chips.push({ code: "broken_links", label: "Broken or placeholder links", severity: "medium" });
  }
  return chips;
}
