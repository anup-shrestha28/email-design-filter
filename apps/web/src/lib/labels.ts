/** Plain-English labels for product vocabulary (DESIGN.md, DESIGN-SCORE.md, FREE-TIER.md). */
import type { EmailType, TypeGroup, TypeSource, AuthVerdict } from "@edf/core/types";
import type {
  CheckId,
  CheckStatus,
  DesignBand,
  DesignIssue,
  EmailClientId,
  FontClass,
  FontRole,
  PillarId,
  StaticChip,
} from "@edf/design/types";
import type {
  DealFilter,
  DealView,
  DesignFilter,
  FrequencyBand,
  SortKey,
} from "@/server/queries/types";

/**
 * The score bands as words. The 70–84 band is "Solid", not "Good": "Good design" is the gallery's
 * strict verdict (85+, no cap), and one page must never give "Good" two meanings (DESIGN-SCORE §3.1).
 */
export const BAND_LABELS: Record<DesignBand, string> = {
  excellent: "Excellent",
  good: "Solid",
  needs_work: "Needs work",
  poor: "Poor",
};

export const DESIGN_FILTER_LABELS: Record<DesignFilter, string> = {
  good: "Good design",
  needs_work: "Needs work",
  bad: "Bad design",
  provisional: "Provisional",
  plain_text: "Plain text",
  not_analysed: "Not analysed",
};

export const ISSUE_LABELS: Record<DesignIssue, string> = {
  image_only: "Image-only",
  contrast: "Low contrast",
  mobile: "Not mobile-friendly",
  clipped: "Clipped in Gmail",
  broken_images: "Broken images",
};

export const DEAL_FILTER_LABELS: Record<DealFilter, string> = {
  active: "Active",
  ending: "Ending ≤ 48h",
  has_code: "Has code",
};

export const FREQUENCY_LABELS: Record<FrequencyBand, string> = {
  daily: "Daily",
  several_weekly: "Several a week",
  weekly: "Weekly",
  monthly: "Monthly",
  rare: "Rarely",
};

export const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  score: "Design score",
  importance: "Importance",
  deal_ending: "Deal ending soonest",
};

export const DATE_LABELS = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
} as const;

export const TYPE_SOURCE_LABELS: Record<TypeSource, string> = {
  rule: "Rules",
  sender_prior: "Sender history",
  template_cache: "Same template as earlier mail",
  llm: "AI (Claude)",
  user: "You",
  pending: "Still deciding",
};

export const SUBTYPE_LABELS: Record<string, string> = {
  sale: "Sale",
  coupon: "Coupon",
  cart_reminder: "Cart reminder",
  product_launch: "Product launch",
  recommendation: "Recommendation",
  editorial: "Editorial",
  digest: "Digest",
  feature: "New feature",
  release_notes: "Release notes",
  announcement: "Announcement",
  welcome: "Welcome",
  onboarding: "Onboarding",
  trial_ending: "Trial ending",
  re_engagement: "Re-engagement",
  terms: "Terms update",
  privacy: "Privacy update",
  plan_change: "Plan change",
  order: "Order",
  shipping: "Shipping",
  receipt: "Receipt",
  invoice: "Invoice",
  payment_failed: "Payment failed",
  travel: "Travel",
  ticket: "Ticket",
  verification_code: "Verification code",
  password_reset: "Password reset",
  login_alert: "Sign-in alert",
  security_alert: "Security alert",
  activity: "Activity",
  mention: "Mention",
  reminder: "Reminder",
  forum: "Forum",
  mailing_list: "Mailing list",
  group: "Group",
  invitation: "Invitation",
  webinar: "Webinar",
  event_reminder: "Event reminder",
};

export function subtypeLabel(code: string | null): string | null {
  if (!code) return null;
  return SUBTYPE_LABELS[code] ?? code.replaceAll("_", " ");
}

/** Importance reason codes → plain words (DESIGN.md §7.5). */
export function importanceReasonLabel(code: string): string {
  if (code.startsWith("type:")) {
    const t = code.slice(5);
    const known: Record<string, string> = {
      payment_failed: "A payment failed",
      shipping: "A delivery is on its way",
      security_alert: "Security alert",
      login_alert: "New sign-in to an account",
      verification_code: "Verification code",
      password_reset: "Password reset",
      event: "Upcoming event",
    };
    return known[t] ?? `${subtypeLabel(t) ?? t}`;
  }
  if (code.startsWith("user_bias:")) {
    const n = Number(code.slice(10));
    return n > 0 ? "You raised this sender's importance" : "You lowered this sender's importance";
  }
  const map: Record<string, string> = {
    starred: "You starred it in Gmail",
    gmail_important: "Gmail marked it important",
    engaged_sender: "You often read this sender",
    deal_ending: "A deal ends within 48 hours",
    deadline: "A deadline is coming up",
    never_opened_sender: "You rarely open this sender",
    dmarc_guard: "Capped: AI label without a DMARC pass",
  };
  return map[code] ?? code.replaceAll("_", " ");
}

export const IMPORTANCE_LABELS = { high: "High", normal: "Normal", low: "Low" } as const;

export const PILLAR_LABELS: Record<PillarId, string> = {
  accessibility: "Accessibility",
  mobile: "Mobile & Responsiveness",
  typography: "Readability & Typography",
  hierarchy: "Visual Hierarchy & CTA",
  images: "Images & Media",
  layout: "Layout, Color & Consistency",
  content: "Content & Structure",
  technical: "Technical Health",
  footer: "Footer & Unsubscribe UX",
};

export const PILLAR_SHORT: Record<PillarId, string> = {
  accessibility: "Accessibility",
  mobile: "Mobile",
  typography: "Typography",
  hierarchy: "Hierarchy & CTA",
  images: "Images",
  layout: "Layout",
  content: "Content",
  technical: "Technical",
  footer: "Footer",
};

export const PILLAR_WEIGHTS: Record<PillarId, number> = {
  accessibility: 20,
  mobile: 15,
  typography: 15,
  hierarchy: 15,
  images: 10,
  layout: 10,
  content: 5,
  technical: 5,
  footer: 5,
};

export const CHECK_LABELS: Record<CheckId, string> = {
  A1: "Text contrast",
  A2: "Text alternatives",
  A3: "Link purpose",
  A4: "Language declared",
  A5: "Layout tables presentational",
  A6: "Heading structure",
  A7: "Target size",
  A8: "Links distinguishable",
  A9: "Document title",
  A10: "ARIA misuse",
  A11: "Text direction",
  A12: "Reading order",
  A13: "Images of text",
  M1: "Fits the phone",
  M2: "Fluid without media queries",
  M3: "Readable column width",
  M4: "Primary button touch size",
  M5: "Images adapt",
  M6: "Dark-mode resilience",
  M7: "Side gutters",
  T1: "Mobile body text size",
  T2: "Desktop body text size",
  T3: "Line height",
  T4: "Line length",
  T5: "Alignment",
  T6: "Typographic system",
  T7: "Uppercase overuse",
  T8: "Prose readability",
  H1: "Primary button present",
  H2: "Button placement",
  H3: "Button prominence",
  H4: "Button label clarity",
  H5: "Button focus",
  H6: "Type-scale contrast",
  H7: "Visual hierarchy clarity",
  I1: "Not image-dominated",
  I2: "Key content is live text",
  I3: "Images load",
  I4: "Images-off resilience",
  I5: "Image weight",
  I6: "Imagery quality & relevance",
  L1: "Container width",
  L2: "Whitespace balance",
  L3: "Visual clutter",
  L4: "Alignment grid",
  L5: "Colour discipline",
  L6: "Component consistency",
  L7: "In-email brand coherence",
  L8: "Visual polish & consistency",
  C1: "Subject line",
  C2: "Preview text",
  C3: "Scannability",
  C4: "Copy clarity",
  C5: "Content length",
  X1: "Gmail clipping",
  X2: "Client compatibility risk",
  X3: "Personalization & link integrity",
  X4: "Style budget",
  U1: "Visible unsubscribe link",
  U2: "Unsubscribe legibility",
  U3: "Preference management",
  U4: "“Why you’re receiving this”",
};

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  pass: "Pass",
  partial: "Partial",
  fail: "Fail",
  not_applicable: "Not applicable",
  not_evaluated: "Not evaluated",
  needs_review: "Needs review",
};

export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  heading: "headings",
  body: "body text",
  button: "buttons",
  navigation: "navigation",
  footer: "footer",
};

export const FONT_CLASS_LABELS: Record<FontClass, string> = {
  web: "web font",
  likely_web: "likely web font",
  system: "system font",
  not_loaded: "not loaded",
};

export const CLIENT_LABELS: Record<EmailClientId, string> = {
  gmail_web: "Gmail (web)",
  gmail_android: "Gmail (Android)",
  gmail_ios: "Gmail (iPhone)",
  outlook_classic: "Outlook for Windows (classic)",
  outlook_new: "New Outlook & Outlook.com",
  apple_mail: "Apple Mail & iOS Mail",
  samsung: "Samsung Email",
};

export const STATIC_CHIP_FALLBACK: Record<StaticChip["code"], string> = {
  clipped: "Clipped in Gmail",
  near_clip: "Close to Gmail's clipping limit",
  merge_tag_subject: "Merge tag in subject",
  merge_tag: "Unrendered merge tag",
  no_unsubscribe: "No unsubscribe link",
  no_alt_text: "Images without alt text",
  no_lang: "No language declared",
  style_budget: "Styles over Gmail's 16 KB budget",
  broken_links: "Broken links",
};

export const AUTH_VERDICT_LABELS: Record<AuthVerdict, string> = {
  pass: "Pass",
  fail: "Fail",
  softfail: "Soft fail",
  neutral: "Neutral",
  none: "None",
  temperror: "Temporary error",
  permerror: "Permanent error",
  policy: "Policy",
  unknown: "Unknown",
};

export const TRUST_MISSING_LABELS: Record<string, string> = {
  dmarc: "DMARC",
  one_click: "one-click unsubscribe",
  unsubscribe: "visible unsubscribe link",
  postal_address: "postal address",
};

export const TYPE_GROUP_ORDER: TypeGroup[] = [
  "newsletters",
  "promotions",
  "orders",
  "notifications",
  "events",
  "updates",
  "security",
  "other",
];

/** The 13 internal types in menu order ("Correct type"). */
export const EMAIL_TYPE_ORDER: EmailType[] = [
  "newsletter",
  "promotional",
  "product_update",
  "lifecycle",
  "account_notice",
  "transactional",
  "account_security",
  "notification",
  "social",
  "community",
  "event",
  "survey",
  "other",
];

/** "30% off", "Up to $20 off", "Free shipping on orders over $75"… */
export function dealTitle(
  d: Pick<DealView, "kind" | "value" | "currency" | "isUpTo" | "minSpend">,
): string {
  const money = (v: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: d.currency ?? "USD",
      maximumFractionDigits: Number.isInteger(v) ? 0 : 2,
    }).format(v);
  const upTo = d.isUpTo ? "Up to " : "";
  let base: string;
  switch (d.kind) {
    case "percent_off":
      base = d.value !== null ? `${upTo}${d.value}% off` : "Percentage off";
      break;
    case "amount_off":
      base = d.value !== null ? `${upTo}${money(d.value)} off` : "Money off";
      break;
    case "bogo":
      base = "Buy one, get one";
      break;
    case "free_shipping":
      base = "Free shipping";
      break;
    case "gift":
      base = "Free gift";
      break;
    default:
      base = "Special offer";
  }
  return d.minSpend ? `${base} on orders over ${money(d.minSpend)}` : base;
}
