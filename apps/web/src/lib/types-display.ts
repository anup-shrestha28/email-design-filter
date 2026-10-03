/** Display helpers shared by server and client. */
import { TYPE_GROUPS, type EmailType, type TypeGroup } from "@edf/core/types";

const GROUP_OF = new Map<EmailType, TypeGroup>();
for (const [group, types] of Object.entries(TYPE_GROUPS) as Array<[TypeGroup, readonly EmailType[]]>) {
  for (const t of types) GROUP_OF.set(t, group);
}

export function typeGroupOf(t: EmailType): TypeGroup {
  return GROUP_OF.get(t) ?? "other";
}

export const TYPE_LABELS: Record<EmailType, string> = {
  promotional: "Promotion",
  newsletter: "Newsletter",
  product_update: "Product update",
  lifecycle: "Lifecycle",
  transactional: "Order / receipt",
  account_security: "Security",
  account_notice: "Account notice",
  notification: "Notification",
  event: "Event",
  social: "Social",
  community: "Community",
  survey: "Survey",
  other: "Other",
};
