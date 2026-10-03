/**
 * Automated / subscription detection (DESIGN.md §7.2 steps 1–4).
 *
 * 1. Exclusions → ledger skip reasons (SENT/DRAFT/CHAT/SPAM, the user's own mail, auto-replies).
 * 2. Personal override: no List-Unsubscribe / List-Id / Feedback-ID and prior contact → personal
 *    (only for senders without a hard automated signal — see DECISIONS.md).
 * 3. Hard positive for subscriptions: one-click POST + https List-Unsubscribe + trusted dkim=pass.
 * 4. Weighted score (weights exactly as §7.2): ≥ 45 subscription, 25–44 ambiguous, < 25 not;
 *    automated when ≥ 25 or any hard signal is present.
 */
import type {
  AutomatedVerdict,
  ContentExtract,
  HeaderFacts,
  LedgerSkipReason,
  ParsedEmail,
  SecurityVerdict,
  SubscriptionSignal,
} from "../types";
import { firstHeader, hasHeader } from "../util/headers";
import { normalizeForMatch } from "../util/text";
import {
  AMOUNT_RE,
  CARRIER_RE,
  hit,
  INVOICE_KW,
  ORDER_KW,
  OTP_KW,
  PAYMENT_FAILED_KW,
  RECEIPT_KW,
  RESET_KW,
  SECURITY_ALERT_KW,
  LOGIN_ALERT_KW,
  SHIPPING_KW,
  TRACKING_NUMBER_RE,
} from "./patterns";
import { detectSecuritySensitive } from "./security";

/** Signal weights (DESIGN.md §7.2 step 4). Calibrated later on a team-labelled corpus. */
export const SUBSCRIPTION_WEIGHTS = {
  list_unsubscribe: 35,
  one_click: 15,
  list_id: 20,
  feedback_id: 15,
  esp: 15,
  category_promotions: 20,
  category_other: 10,
  precedence_bulk: 10,
  auto_generated: 10,
  body_unsubscribe: 10,
  tracking: 10,
  template_repeats: 10,
  no_reply: 5,
  bcc: 5,
  prior_contact: -30,
  freemail_no_list: -15,
  category_personal: -15,
} as const;

export const SUBSCRIPTION_THRESHOLD = 45;
export const AUTOMATED_THRESHOLD = 25;

export interface ClassifyAutomatedInput {
  parsed: ParsedEmail;
  headers: HeaderFacts;
  /** null for a headers-only (format=metadata) evaluation. */
  content: ContentExtract | null;
  labelIds: readonly string[];
  /** Result of the "user emailed this address before" check; null when not checked. */
  priorContact: boolean | null;
  /** The sender already has an email with the same template simhash. */
  senderTemplateRepeats: boolean;
  /** Optional precomputed security verdict (computed here when omitted and content exists). */
  security?: SecurityVerdict | null;
}

/** Schema.org types that prove a transactional message (hard signal). */
const TRANSACTIONAL_SCHEMA = /^(?:Order|ParcelDelivery|Invoice|[A-Za-z]*Reservation)$/;

/** Auto-reply subjects (out-of-office) in common languages. */
const AUTO_REPLY_SUBJECT_RE =
  /^(?:auto(?:matic)?[ -]?(?:reply|response|antwort|matische antwort)|automatic reply|out of (?:the )?office|abwesenheits(?:notiz|meldung)|r[ée]ponse automatique|absence du bureau|respuesta autom[aá]tica|fuera de la oficina|risposta automatica|fuori sede|resposta autom[aá]tica|fora do escrit[oó]rio|automatisch antwoord|afwezig|autosvar|automatyczna odpowied[zź]|автоответ|otomatik yan[iı]t)(?![\p{L}\p{N}])/iu;

/** Transactional / security subjects (the "subject hint"). */
const SUBJECT_HINTS = [
  OTP_KW,
  RESET_KW,
  LOGIN_ALERT_KW,
  SECURITY_ALERT_KW,
  PAYMENT_FAILED_KW,
  INVOICE_KW,
  RECEIPT_KW,
  ORDER_KW,
  SHIPPING_KW,
];

/** Reply / forward prefixes (en, de, nl, sv/no/da, fi, es/it/pt, fr, pl, tr). */
const REPLY_PREFIX_RE =
  /^(?:re|fw|fwd|aw|wg|antw|sv|vs|vb|rv|enc|tr|odp|pd|ynt|ilt)\s?(?:\[\d{1,4}\])?\s?:/iu;

/** Order / invoice / tracking / booking reference followed by an id containing a digit. */
const REFERENCE_RE =
  /(?<![\p{L}\p{N}])(?:order|invoice|receipt|booking|reservation|confirmation|tracking|shipment|parcel|ticket|pedido|commande|bestellung|auftrag|ordine|encomenda|bestelling|zam[óo]wienie|best[äa]llning|注文|订单|주문|заказ|sipari[şs])(?:\s?(?:#|no\.?|nr\.?|number|num\.?|id|n[º°o]\.?))?\s?[:#]?\s?([a-z0-9][a-z0-9-]{3,24})(?![\p{L}\p{N}])/giu;

/**
 * A transactional/security subject from a non-free-mail sender that isn't part of a human reply
 * thread. Shared by the headers-only and the full evaluation so the two stages agree.
 */
function transactionalSubject(parsed: ParsedEmail, headers: HeaderFacts): boolean {
  if (headers.isFreemailSender) return false;
  const rawSubject = (parsed.subject ?? "").trim();
  if (REPLY_PREFIX_RE.test(rawSubject) || hasHeader(parsed.headers, "in-reply-to")) return false;
  const subject = normalizeForMatch(rawSubject);
  return SUBJECT_HINTS.some((res) => hit(res, subject));
}

/**
 * Body evidence (never the subject itself) that backs a transactional subject: an order /
 * invoice / tracking reference with a digit, an amount, a carrier or tracking number, or
 * shipping / billing wording.
 */
function hasTransactionalEvidence(content: ContentExtract): boolean {
  const body = normalizeForMatch(content.visibleText);
  REFERENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = REFERENCE_RE.exec(body)) !== null && guard++ < 20) {
    if (/\d/.test(m[1] ?? "")) return true;
  }
  return (
    AMOUNT_RE.test(body) ||
    TRACKING_NUMBER_RE.test(body) ||
    CARRIER_RE.test(body) ||
    hit(SHIPPING_KW, body) ||
    hit(PAYMENT_FAILED_KW, body) ||
    hit(INVOICE_KW, body) ||
    hit(RECEIPT_KW, body) ||
    hit(ORDER_KW, body)
  );
}

function skip(reason: LedgerSkipReason): AutomatedVerdict {
  return {
    automated: false,
    skipReason: reason,
    isSubscription: false,
    subscriptionScore: 0,
    signals: [],
    ambiguous: false,
    needsPriorContactCheck: false,
    hardSignals: [],
  };
}

function isAutoReply(parsed: ParsedEmail, headers: HeaderFacts): boolean {
  if (headers.autoSubmitted === "auto-replied") return true;
  const h = parsed.headers;
  if (
    hasHeader(h, "x-autoreply") ||
    hasHeader(h, "x-autorespond") ||
    hasHeader(h, "x-autoresponder")
  )
    return true;
  const precedence = firstHeader(h, "precedence")?.trim().toLowerCase();
  if (precedence === "auto_reply" || precedence === "auto-reply") return true;
  return AUTO_REPLY_SUBJECT_RE.test((parsed.subject ?? "").trim());
}

/** Classifies automated vs personal and subscription status (DESIGN.md §7.2). */
export function classifyAutomated(input: ClassifyAutomatedInput): AutomatedVerdict {
  const { parsed, headers, content, labelIds, priorContact } = input;
  const labels = new Set(labelIds);

  // Step 1 — exclusions.
  if (labels.has("SENT")) return skip("sent");
  if (labels.has("DRAFT")) return skip("draft");
  if (labels.has("CHAT")) return skip("chat");
  if (labels.has("SPAM")) return skip("spam");
  if (headers.fromSelf) return skip("sent");
  if (isAutoReply(parsed, headers)) return skip("auto_reply");

  // Step 4 — weighted signals (computed first; the override and thresholds use them).
  const W = SUBSCRIPTION_WEIGHTS;
  const signals: SubscriptionSignal[] = [];
  const add = (code: keyof typeof W): void => {
    signals.push({ code, weight: W[code] });
  };
  const listHeaders =
    headers.listUnsubscribe !== null || headers.listId !== null || headers.feedbackId !== null;
  if (headers.listUnsubscribe !== null) add("list_unsubscribe");
  if (headers.oneClick) add("one_click");
  if (headers.listId !== null) add("list_id");
  if (headers.feedbackId !== null) add("feedback_id");
  if (headers.espPlatform !== null) add("esp");
  if (labels.has("CATEGORY_PROMOTIONS")) add("category_promotions");
  if (
    labels.has("CATEGORY_UPDATES") ||
    labels.has("CATEGORY_SOCIAL") ||
    labels.has("CATEGORY_FORUMS")
  )
    add("category_other");
  if (headers.precedence === "bulk" || headers.precedence === "list") add("precedence_bulk");
  if (headers.autoSubmitted === "auto-generated") add("auto_generated");
  if (content?.hasUnsubscribeLink) add("body_unsubscribe");
  if (content && (content.tracking.pixelCount > 0 || content.tracking.utmMediumEmail))
    add("tracking");
  if (input.senderTemplateRepeats) add("template_repeats");
  if (headers.isNoReply) add("no_reply");
  if (headers.deliveredByBcc) add("bcc");
  if (priorContact === true) add("prior_contact");
  if (headers.isFreemailSender && !listHeaders) add("freemail_no_list");
  if (labels.has("CATEGORY_PERSONAL")) add("category_personal");
  const score = signals.reduce((s, x) => s + x.weight, 0);

  // Hard automated signals (§7.2) plus two documented additions that protect important mail:
  // security-pattern mail and no-reply senders are never personal correspondence.
  const hardSignals: string[] = [];
  if (content?.schemaOrg.some((i) => TRANSACTIONAL_SCHEMA.test(i.type)))
    hardSignals.push("schema_transactional");
  if (headers.espTransactional) hardSignals.push("esp_transactional");
  if (headers.autoSubmitted === "auto-generated" || headers.autoSubmitted === "auto-notified") {
    hardSignals.push("auto_submitted");
  }
  const security =
    input.security ?? (content ? detectSecuritySensitive({ parsed, content, headers }) : null);
  // Not for free-mail senders: services don't send OTPs from gmail.com, people quoting codes do.
  if (security?.securitySensitive && !headers.isFreemailSender)
    hardSignals.push("security_pattern");
  if (headers.isNoReply && !headers.isFreemailSender) hardSignals.push("no_reply");
  // Self-hosted shops (WooCommerce, Shopware on their own SMTP) send receipts and shipping
  // notices with no ESP or list headers. A transactional subject from a non-free-mail sender is
  // enough to fetch the body (headers-only); with the body it also needs transactional evidence.
  if (transactionalSubject(parsed, headers)) {
    if (!content) hardSignals.push("subject_hint");
    else if (hasTransactionalEvidence(content)) hardSignals.push("transactional_pattern");
  }

  // Step 2 — personal override (ambiguous senders only: no list headers, no hard signal).
  if (priorContact === true && !listHeaders && hardSignals.length === 0) {
    return { ...skip("personal"), subscriptionScore: clampScore(score), signals };
  }

  // Step 3 — hard positive (oneClick already requires a Gmail-verified covering DKIM signature).
  const hardPositive =
    headers.oneClick &&
    (headers.listUnsubscribe?.https.length ?? 0) > 0 &&
    headers.auth.dkim === "pass";
  // §7.1: a subscription is list/bulk mail *with an unsubscribe mechanism*. Without one (e.g. an
  // SES-sent OTP scoring 45 on Feedback-ID + ESP + no-reply + category) it isn't a subscription.
  const hasUnsubscribeMechanism =
    headers.listUnsubscribe !== null ||
    headers.listId !== null ||
    content?.hasUnsubscribeLink === true;
  // Ambiguous mail gets a provisional answer (the column is NOT NULL); the sender prior / Claude
  // resolve it later. Provisional = an unsubscribe mechanism exists in header or body.
  const provisional = headers.listUnsubscribe !== null || content?.hasUnsubscribeLink === true;
  const decision = decideSubscription(score, {
    hardSignal: hardSignals.length > 0,
    hardPositive,
    hasUnsubscribeMechanism,
    provisional,
  });
  if (!decision.automated) {
    return {
      ...skip("personal"),
      subscriptionScore: clampScore(score),
      signals,
      hardSignals,
    };
  }
  const { isSubscription, ambiguous } = decision;

  const needsPriorContactCheck =
    priorContact === null &&
    !listHeaders &&
    hardSignals.length === 0 &&
    ambiguous &&
    !headers.isNoReply;

  return {
    automated: true,
    skipReason: null,
    isSubscription,
    subscriptionScore: clampScore(score),
    signals,
    ambiguous,
    needsPriorContactCheck,
    hardSignals,
  };
}

/**
 * The threshold part of §7.2 step 4 as a pure function: automated when score ≥ 25 or a hard
 * signal fired; subscription when (hard positive or score ≥ 45 or ambiguous-with-provisional)
 * and an unsubscribe mechanism exists; ambiguous for 25–44 without the hard positive.
 */
export function decideSubscription(
  score: number,
  opts: {
    hardSignal: boolean;
    hardPositive: boolean;
    hasUnsubscribeMechanism: boolean;
    provisional: boolean;
  },
): { automated: boolean; isSubscription: boolean; ambiguous: boolean } {
  const automated = score >= AUTOMATED_THRESHOLD || opts.hardSignal;
  if (!automated) return { automated: false, isSubscription: false, ambiguous: false };
  const ambiguous =
    !opts.hardPositive && score >= AUTOMATED_THRESHOLD && score < SUBSCRIPTION_THRESHOLD;
  const isSubscription =
    opts.hasUnsubscribeMechanism &&
    (opts.hardPositive || score >= SUBSCRIPTION_THRESHOLD || (ambiguous && opts.provisional));
  return { automated, isSubscription, ambiguous };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
