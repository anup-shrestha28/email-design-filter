/**
 * Type-based applicability matrices (DESIGN-SCORE §5.4, §5.7 C5, §5.9). Data-based N/A (no
 * images, no links, …) is decided inside each check.
 */
import type { EmailType } from "@edf/core/types";
import type { CheckId } from "../types";
import { hasButtonCta } from "./checks/hierarchy";
import type { CheckInput } from "./kit";

/** Types where H1–H2 apply and H3–H5 apply unconditionally (DESIGN-SCORE §5.4). */
export const ACTION_TYPES: ReadonlySet<EmailType> = new Set([
  "promotional",
  "product_update",
  "lifecycle",
  "event",
  "survey",
]);

/** Types exempt from the footer pillar (CAN-SPAM transactional/relationship; §5.9). */
const FOOTER_EXEMPT: ReadonlySet<EmailType> = new Set([
  "transactional",
  "account_security",
  "account_notice",
]);

/** C5 is N/A for these (§5.7). */
const LENGTH_EXEMPT: ReadonlySet<EmailType> = new Set(["newsletter", "community"]);

/** Footer & Unsubscribe UX applies iff subscription mail and not transactional/account (§5.9). */
export function footerApplies(primaryType: EmailType, isSubscription: boolean): boolean {
  return isSubscription && !FOOTER_EXEMPT.has(primaryType);
}

/** Null when the check applies, else the reason it doesn't. */
export function inapplicableReason(id: CheckId, input: CheckInput): string | null {
  const t = input.ctx.primaryType;
  switch (id) {
    case "H1":
    case "H2":
      return ACTION_TYPES.has(t) ? null : "type";
    case "H3":
    case "H4":
    case "H5":
      return ACTION_TYPES.has(t) || hasButtonCta(input) ? null : "type_without_button";
    case "U1":
    case "U2":
    case "U3":
    case "U4":
      return footerApplies(t, input.ctx.isSubscription)
        ? null
        : "not_subscription_or_transactional";
    case "C5":
      return LENGTH_EXEMPT.has(t) ? "type" : null;
    default:
      return null;
  }
}
