/**
 * Shared contracts for the ingest side of the pipeline (DESIGN.md §5–§7, FREE-TIER.md §4).
 *
 * Everything here is plain data: JSON-serialisable except for `Date` and `Uint8Array`
 * fields, which are called out. Enum lists mirror the CHECK constraints in DATA-MODEL.md §3;
 * a DB test asserts they stay in sync.
 */

// ───────────────────────── enums (mirror DB CHECK constraints) ─────────────────────────

export const EMAIL_TYPES = [
  "promotional",
  "newsletter",
  "product_update",
  "lifecycle",
  "transactional",
  "account_security",
  "account_notice",
  "notification",
  "event",
  "social",
  "community",
  "survey",
  "other",
] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Subtypes per internal type (DESIGN.md §7.3 table). `account_notice.plan_change` is the
 * machine code for "plan changes". Types without subtypes map to an empty list.
 */
export const EMAIL_SUBTYPES = {
  promotional: ["sale", "coupon", "cart_reminder", "product_launch", "recommendation"],
  newsletter: ["editorial", "digest"],
  product_update: ["feature", "release_notes", "announcement"],
  lifecycle: ["welcome", "onboarding", "trial_ending", "re_engagement"],
  account_notice: ["terms", "privacy", "plan_change"],
  transactional: ["order", "shipping", "receipt", "invoice", "payment_failed", "travel", "ticket"],
  account_security: ["verification_code", "password_reset", "login_alert", "security_alert"],
  notification: ["activity", "mention", "reminder"],
  social: [],
  community: ["forum", "mailing_list", "group"],
  event: ["invitation", "webinar", "event_reminder"],
  survey: [],
  other: [],
} as const satisfies Record<EmailType, readonly string[]>;
export type EmailSubtype = (typeof EMAIL_SUBTYPES)[EmailType][number];

/** The 8 filter groups shown in the UI (DESIGN.md §7.3). */
export const TYPE_GROUPS = {
  promotions: ["promotional"],
  newsletters: ["newsletter"],
  updates: ["product_update", "lifecycle", "account_notice"],
  orders: ["transactional"],
  security: ["account_security"],
  notifications: ["notification", "social", "community"],
  events: ["event"],
  other: ["survey", "other"],
} as const satisfies Record<string, readonly EmailType[]>;
export type TypeGroup = keyof typeof TYPE_GROUPS;

export const TYPE_SOURCES = [
  "rule",
  "sender_prior",
  "template_cache",
  "llm",
  "user",
  "pending",
] as const;
export type TypeSource = (typeof TYPE_SOURCES)[number];

export const IMPORTANCE_LEVELS = ["high", "normal", "low"] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

export const GMAIL_CATEGORIES = ["promotions", "updates", "social", "forums", "personal"] as const;
export type GmailCategory = (typeof GMAIL_CATEGORIES)[number];

export const AUTH_RESULTS = ["pass", "fail", "none", "unknown"] as const;
export type AuthResult = (typeof AUTH_RESULTS)[number];

export const DEAL_KINDS = [
  "percent_off",
  "amount_off",
  "bogo",
  "free_shipping",
  "gift",
  "other",
] as const;
export type DealKind = (typeof DEAL_KINDS)[number];

export const LEDGER_SKIP_REASONS = [
  "personal",
  "sent",
  "draft",
  "chat",
  "spam",
  "auto_reply",
  "parse_error",
  "gmail_error",
  "too_large",
] as const;
export type LedgerSkipReason = (typeof LEDGER_SKIP_REASONS)[number];

// ───────────────────────── parsed message ─────────────────────────

export interface Address {
  /** Lower-cased mailbox address, e.g. "news@example.com". */
  address: string;
  /** Display name, decoded (RFC 2047), or null. */
  name: string | null;
}

/** One header, in message order. `name` is lower-cased; `value` is unfolded and decoded. */
export interface Header {
  name: string;
  value: string;
}

/** An inline (`cid:`) image part, kept only for rendering. Never stored. */
export interface InlinePart {
  /** Content-ID without angle brackets, lower-cased. */
  cid: string;
  mimeType: string;
  /** Decoded bytes. */
  content: Uint8Array;
}

export interface AttachmentMeta {
  filename: string | null;
  mimeType: string;
  size: number;
  disposition: "attachment" | "inline" | null;
  contentId: string | null;
}

/**
 * The result of MIME parsing (postal-mime for raw RFC 822; the Gmail payload adapter for
 * very large messages). Contains message content: it lives in memory only and is never
 * persisted (DATA-MODEL.md §1 "Minimize content").
 */
export interface ParsedEmail {
  headers: Header[];
  messageId: string | null;
  subject: string | null;
  from: Address | null;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  /** The Date header, if present and valid. */
  date: Date | null;
  /** Decoded text/html part (UTF-16 JS string), or null for plain-text-only mail. */
  html: string | null;
  /** UTF-8 byte length of the decoded text/html part (DESIGN-SCORE X1). 0 when no HTML. */
  htmlBytes: number;
  /** Decoded text/plain part, or null. */
  text: string | null;
  /** A text/calendar part is present (DESIGN.md §7.3 rule 2). */
  hasCalendar: boolean;
  /** A text/x-amp-html part is present ("AMP version not scored"). */
  hasAmp: boolean;
  attachments: AttachmentMeta[];
  /** Up to 10 inline images (DESIGN.md §5.2), each ≤ 1 MB. */
  inline: InlinePart[];
  /**
   * DTSTART of the first VEVENT in the text/calendar part, as an instant (deadline signal for
   * importance, DESIGN.md §7.5). Optional: adapters that don't read the part leave it unset.
   */
  calendarStart?: Date | null;
  /** iTIP METHOD of the calendar part (REQUEST, CANCEL, PUBLISH, …), upper-case. */
  calendarMethod?: string | null;
}

/** Gmail message metadata that accompanies every fetch (not part of the MIME). */
export interface GmailMessageMeta {
  id: string;
  threadId: string | null;
  labelIds: string[];
  /** Gmail's snippet; what Gmail users see as preview text (DESIGN-SCORE C2). */
  snippet: string | null;
  /** Message.historyId as a decimal string (uint64). */
  historyId: string;
  /** internalDate (ms since epoch) as a Date. */
  internalDate: Date;
  sizeEstimate: number | null;
}

// ───────────────────────── header facts ─────────────────────────

export type AuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy"
  | "unknown";

export interface AuthFacts {
  /** True when an Authentication-Results header from mx.google.com was found (topmost only). */
  found: boolean;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  arc: AuthVerdict;
  /** `header.i` / `header.d` domains of passing DKIM signatures (registrable, lower-case). */
  dkimPassDomains: string[];
  /** DMARC `header.from` domain, if reported. */
  dmarcHeaderFrom: string | null;
  /** DMARC policy (p=), if reported. */
  dmarcPolicy: string | null;
  /** Registrable domain of `smtp.mailfrom` (SPF identity), if reported. */
  spfMailFromDomain?: string | null;
}

export interface ListUnsubscribe {
  /** https: URIs in header order (http: URIs are ignored). */
  https: string[];
  /** mailto: URIs in header order. */
  mailto: string[];
}

export interface HeaderFacts {
  listUnsubscribe: ListUnsubscribe | null;
  /**
   * RFC 8058 one-click: an https List-Unsubscribe URI, List-Unsubscribe-Post exactly
   * "List-Unsubscribe=One-Click", and a DKIM-Signature whose h= covers both headers
   * (DESIGN-SCORE §9).
   */
  oneClick: boolean;
  listId: string | null;
  feedbackId: string | null;
  precedence: "bulk" | "list" | "junk" | null;
  autoSubmitted: "auto-generated" | "auto-replied" | "auto-notified" | null;
  auth: AuthFacts;
  /** Summary for `email.auth_result`. */
  authResult: AuthResult;
  /** DMARC fail AND From not aligned AND no arc=pass (DESIGN.md §7.8). */
  suspicious: boolean;
  /** ESP / platform fingerprint, e.g. "Klaviyo", "Mailchimp", "SendGrid". */
  espPlatform: string | null;
  /** Registrable domain of the From address (tldts). */
  fromDomain: string | null;
  /** Local part matches no-reply patterns. */
  isNoReply: boolean;
  /** None of the user's addresses appears in To/Cc (delivered by BCC or list expansion). */
  deliveredByBcc: boolean;
  /** From domain is a consumer mailbox provider (gmail.com, outlook.com, …). */
  isFreemailSender: boolean;
  /** Mail sent by one of the user's own addresses. */
  fromSelf: boolean;
  /** DKIM selectors (s=) seen in DKIM-Signature headers, lower-case (e.g. Klaviyo "km1"). */
  dkimSelectors?: string[];
  /** Sending MTA when distinct from the platform (e.g. Braze via "Amazon SES"); → sender.esp_mta. */
  espMta?: string | null;
  /** The ESP is sending infrastructure typically used for transactional mail (hard signal, §7.2). */
  espTransactional?: boolean;
  /** A List-Post header is present (discussion lists; RFC 2369). */
  listPost?: boolean;
  /** Mailing-list software fingerprint ("Mailman", "Google Groups", "groups.io", "Discourse", …). */
  mailingListSoftware?: string | null;
}

// ───────────────────────── content extraction ─────────────────────────

export interface SchemaOrgItem {
  /** schema.org @type, e.g. "Order", "ParcelDelivery", "DiscountOffer", "EventReservation". */
  type: string;
  /** A few whitelisted scalar fields (orderStatus, trackingNumber, discountCode, …); no PII blobs. */
  fields: Record<string, string>;
}

export interface DealCandidate {
  kind: DealKind;
  /** Percent (0–100) for percent_off, amount for amount_off, else null. */
  value: number | null;
  /** ISO 4217, upper-case. */
  currency: string | null;
  isUpTo: boolean;
  minSpend: number | null;
  /** Coupon code; may be per-recipient, so private to the user and never aggregated. */
  code: string | null;
  startsAt: Date | null;
  /** Undated deals: received_at + 14 days with low confidence (DESIGN.md §7.7). */
  endsAt: Date | null;
  endsAtConfidence: number;
  source: "jsonld" | "regex" | "llm";
}

export interface TrackingFacts {
  /** Open-tracking pixels found (never fetched). */
  pixelCount: number;
  /** Registrable domains of pixel hosts. */
  pixelHosts: string[];
  /** Registrable domains of click-tracking redirect hosts on visible links. */
  clickTrackerHosts: string[];
  /** utm_campaign from visible hrefs (first seen). */
  utmCampaign: string | null;
  /** Any visible href carries utm_medium=email. */
  utmMediumEmail: boolean;
}

export interface ContentExtract {
  /**
   * Visible text excerpt (≤ 4,000 chars), in reading order, whitespace-collapsed, hidden
   * preheader and footer boilerplate included. In memory only: it feeds search_tsv,
   * classification and deal extraction and is never persisted.
   */
  visibleText: string;
  /** Hidden preheader text, if any (first hidden text before visible content). */
  preheader: string | null;
  wordCount: number;
  /** ISO 639-1, or null when undetermined. */
  language: string | null;
  /** A visible link matching unsubscribe / opt-out patterns in the body. */
  hasUnsubscribeLink: boolean;
  linkCount: number;
  /** Normalized labels of button-like links (template matching, FREE-TIER.md §5.4). */
  ctaLabels: string[];
  /** Content images (non-pixel <img>). */
  imageCount: number;
  tracking: TrackingFacts;
  schemaOrg: SchemaOrgItem[];
  deals: DealCandidate[];
  /** A deadline-like date in the email (event start, payment due, offer end), for importance. */
  deadlineAt: Date | null;
  /** A postal address was detected near the end of the email (trust badge, static detection). */
  postalAddress: boolean;
  /** A "you're receiving this because…" statement was found. */
  receivingStatement: boolean;
  /**
   * 64-bit simhash of the DOM skeleton as a signed decimal string (fits PG bigint).
   * Template match = Hamming distance ≤ 3 (DATA-MODEL.md §5).
   */
  simhash: string;
  /** A visible manage-preferences / frequency link (DESIGN-SCORE U3). */
  hasPreferencesLink?: boolean;
  /** Registrable domains of visible links, first-seen order, ≤ 30. */
  linkDomains?: string[];
  /** Kinds of security action links found (reset / verify / login / secure), for §7.4 detection. */
  securityLinkKinds?: SecurityLinkKind[];
}

export type SecurityLinkKind = "reset" | "verify" | "login" | "secure";

// ───────────────────────── classification ─────────────────────────

export interface SubscriptionSignal {
  code: string;
  weight: number;
}

export interface AutomatedVerdict {
  /** Only automated mail is stored (DESIGN.md §7.1). */
  automated: boolean;
  /** Set when not automated or skipped. */
  skipReason: LedgerSkipReason | null;
  isSubscription: boolean;
  /** Weighted score (DESIGN.md §7.2 step 4), clamped to 0..100 for storage. */
  subscriptionScore: number;
  signals: SubscriptionSignal[];
  /** 25–44 → resolved by sender prior, then Claude (DESIGN.md §7.2). */
  ambiguous: boolean;
  /** The personal-override check (a 5-unit messages.list) is worth running for this sender. */
  needsPriorContactCheck: boolean;
  /** Hard "automated" signals that fired (explanations/debugging), e.g. "schema_transactional". */
  hardSignals?: string[];
}

export interface TypeVerdict {
  primaryType: EmailType;
  subtype: string | null;
  secondaryTags: string[];
  /** 0..1 */
  typeConfidence: number;
  typeSource: TypeSource;
  /** Matched rule code (e.g. "schema:Order", "security:otp"), for explanations/debugging. */
  rule: string | null;
  /** No rule matched confidently; needs sender prior or LLM (DESIGN.md §7.3 steps 15–16). */
  needsLlm: boolean;
}

export interface SecurityVerdict {
  /** OTP / password reset / magic link / security alert (DESIGN.md §7.4). */
  securitySensitive: boolean;
  reason: "otp" | "password_reset" | "magic_link" | "login_alert" | "security_alert" | null;
}

export interface SenderPrior {
  /** The user's explicit correction ("always classify as …"). */
  typeOverride: EmailType | null;
  /** Majority type and its share over the sender's recent emails. */
  majorityType: EmailType | null;
  majorityShare: number;
  emailCount: number;
  /** Aggregates for importance. */
  readRate60d: number | null;
  emailsPerWeek: number | null;
  userImportanceBias: number;
  muted: boolean;
}

export interface ImportanceInput {
  primaryType: EmailType;
  subtype: string | null;
  typeSource: TypeSource;
  securitySensitive: boolean;
  suspicious: boolean;
  authResult: AuthResult;
  labelIds: string[];
  receivedAt: Date;
  now: Date;
  deals: Pick<DealCandidate, "endsAt">[];
  /** Deadline-like date in the email (event date, payment due), if extracted. */
  deadlineAt: Date | null;
  prior: Pick<SenderPrior, "readRate60d" | "emailsPerWeek" | "userImportanceBias"> | null;
}

export interface ImportanceResult {
  /** 0..100 at `now`, including active time-bound boosts. */
  score: number;
  level: Importance;
  /**
   * Reason codes stored in `email.importance_reasons`. Plain codes explain the score
   * ("type:payment_failed", "starred", "gmail_important", "engaged_sender", "deal_ending",
   * "never_opened_sender", "user_bias:+1"). Time-bound boosts are encoded as
   * "boost:<code>:<points>:<expiresUnixSec>" so decay can be computed at read time from the
   * stored row alone (FREE-TIER.md §4.2): effective = score − Σ points of boosts with
   * expiry ≤ now. Negative points are allowed (e.g. an OTP's high score lapsing).
   */
  reasons: string[];
  /** Earliest expiry among active boosts (→ `email.importance_expires_at`), or null. */
  expiresAt: Date | null;
}

// ───────────────────────── trust badge ─────────────────────────

export interface TrustBadge {
  state: "trusted" | "partial" | "failed_auth";
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  oneClick: boolean;
  /** Visible unsubscribe link in the body (U1), null when not applicable. */
  visibleUnsubscribe: boolean | null;
  /** Postal address detected in the footer (static detection), null when not applicable. */
  postalAddress: boolean | null;
  /** Missing items for "Partially compliant", as codes: "dmarc", "one_click", "unsubscribe", "postal_address". */
  missing: string[];
  tracking: {
    pixels: number;
    clickTrackerHosts: string[];
    utmCampaign: string | null;
  };
}

// ───────────────────────── LLM classification (Message Batches) ─────────────────────────

/** What the LLM classifier returns (validated with Zod in classify/llm.ts). */
export interface LlmClassification {
  primaryType: EmailType;
  subtype: string | null;
  isSubscription: boolean;
  confidence: number;
}
