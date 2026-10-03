/**
 * Sender Trust & Compliance badge (DESIGN-SCORE §9; DESIGN.md §7.8). Separate from the score.
 *
 * - Failed authentication: DMARC or DKIM fail in Gmail's own Authentication-Results — except when
 *   Gmail also reports arc=pass (forwarded / mailing-list mail that broke DKIM in transit; §7.8
 *   excludes exactly that mail from "Suspicious", and flagging it as spoofing would put every
 *   list message into Needs attention). See DECISIONS.md.
 * - Trusted: DMARC pass, plus one-click unsubscribe for commercial mail.
 * - Partially compliant: everything else, with the missing items listed.
 *
 * "Commercial" = subscription mail outside the transactional/relationship types, the same
 * applicability rule as the footer checks (DESIGN-SCORE §5.9).
 */
import type { ContentExtract, EmailType, HeaderFacts, TrustBadge } from "../types";

export interface TrustBadgeInput {
  headers: HeaderFacts;
  content: ContentExtract;
  isSubscription: boolean;
  primaryType: EmailType;
  /** U1 visible-unsubscribe result (design analysis), or null to use the static detection. */
  visibleUnsubscribe: boolean | null;
}

const NON_COMMERCIAL: ReadonlySet<EmailType> = new Set([
  "transactional",
  "account_security",
  "account_notice",
]);

/** Builds the trust badge (DESIGN-SCORE §9). */
export function buildTrustBadge(input: TrustBadgeInput): TrustBadge {
  const { headers, content } = input;
  const auth = headers.auth;
  const commercial = input.isSubscription && !NON_COMMERCIAL.has(input.primaryType);
  const failed = (auth.dmarc === "fail" || auth.dkim === "fail") && auth.arc !== "pass";

  const visibleUnsubscribe = commercial
    ? (input.visibleUnsubscribe ?? content.hasUnsubscribeLink)
    : null;
  const postalAddress = commercial ? content.postalAddress : null;

  const missing: string[] = [];
  if (auth.dmarc !== "pass") missing.push("dmarc");
  if (commercial && !headers.oneClick) missing.push("one_click");
  if (commercial && visibleUnsubscribe === false) missing.push("unsubscribe");
  if (commercial && postalAddress === false) missing.push("postal_address");

  let state: TrustBadge["state"];
  if (failed) state = "failed_auth";
  else if (auth.dmarc === "pass" && (!commercial || headers.oneClick)) state = "trusted";
  else state = "partial";

  return {
    state,
    spf: auth.spf,
    dkim: auth.dkim,
    dmarc: auth.dmarc,
    oneClick: headers.oneClick,
    visibleUnsubscribe,
    postalAddress,
    missing,
    tracking: {
      pixels: content.tracking.pixelCount,
      clickTrackerHosts: content.tracking.clickTrackerHosts,
      utmCampaign: content.tracking.utmCampaign,
    },
  };
}
