/**
 * Type classification: the rule cascade of DESIGN.md §7.3 (first confident match wins), then the
 * sender prior, the per-template cache, and finally Claude (`needsLlm`, `typeSource: "pending"`).
 *
 * Deliberate refinements (all in DECISIONS.md):
 * - A user's explicit `type_override` is applied before the rules (except security detection),
 *   otherwise a correction could never take effect while a rule keeps firing.
 * - Within `transactional`, subtype priority is payment_failed > shipping > billing, so a
 *   shipping notice with an order summary is still `shipping` (importance 40 for 14 days).
 * - Payment-failure wording needs no amount (a missed failed payment costs the user money).
 * - An explicit event rule (webinar / RSVP / event reminder) sits after the survey rule so the
 *   `event` subtypes are reachable without a calendar part or schema.org markup.
 * - CAN-SPAM primary purpose: the subject and opening text decide; promo footers only add
 *   `secondaryTags: ["promotional"]`.
 */
import { NEWSLETTER_PLATFORMS } from "../headers/esp";
import type {
  ContentExtract,
  EmailType,
  HeaderFacts,
  ParsedEmail,
  SecurityVerdict,
  SenderPrior,
  TypeVerdict,
} from "../types";
import {
  ACTIVITY_KW,
  AMOUNT_RE,
  ANNOUNCEMENT_KW,
  CARRIER_RE,
  CART_KW,
  DIGEST_KW,
  EVENT_KW,
  FORUM_KW,
  hit,
  INVOICE_KW,
  LAUNCH_KW,
  MENTION_KW,
  NEWSLETTER_SUBJECT_KW,
  NOTIFICATION_PLATFORM_DOMAINS,
  ONBOARDING_KW,
  ORDER_KW,
  PAYMENT_FAILED_KW,
  PLAN_CHANGE_KW,
  PRIVACY_KW,
  PROMO_KW,
  RECEIPT_KW,
  RECO_KW,
  REENGAGE_KW,
  RELEASE_NOTES_KW,
  REMINDER_KW,
  SHIPPING_KW,
  SOCIAL_DOMAINS,
  SOCIAL_KW,
  SOCIAL_STRONG_KW,
  SURVEY_DOMAINS,
  SURVEY_KW,
  TERMS_KW,
  TICKET_KW,
  TRACKING_NUMBER_RE,
  TRAVEL_KW,
  TRIAL_KW,
  URGENCY_KW,
  WEBINAR_KW,
  WELCOME_KW,
  WHATS_NEW_KW,
} from "./patterns";
import { textView } from "./text";
import type { TextView } from "./text";

export interface ClassifyTypeInput {
  parsed: ParsedEmail;
  headers: HeaderFacts;
  content: ContentExtract;
  labelIds: readonly string[];
  security: SecurityVerdict;
  prior: SenderPrior | null;
  /** Cached LLM classification for (sender, template), if any. */
  templateClassification: { primaryType: EmailType; subtype: string | null } | null;
}

/** A rule match at or above this confidence ends the cascade. */
export const CONFIDENT = 0.6;
/** Sender-prior majority rule (§7.3 step 15). */
export const PRIOR_MIN_SHARE = 0.8;
export const PRIOR_MIN_EMAILS = 5;

interface Candidate {
  type: EmailType;
  subtype: string | null;
  confidence: number;
  rule: string | null;
  secondary?: string[];
}

const CARRIER_DOMAINS = new Set([
  "ups.com",
  "usps.com",
  "fedex.com",
  "dhl.com",
  "dhl.de",
  "royalmail.com",
  "parcelforce.com",
  "evri.com",
  "dpd.com",
  "dpd.co.uk",
  "gls-group.eu",
  "canadapost-postescanada.ca",
  "canadapost.ca",
  "auspost.com.au",
  "laposte.fr",
  "colissimo.fr",
  "chronopost.fr",
  "postnl.nl",
  "correos.es",
  "poste.it",
  "inpost.pl",
  "postnord.se",
  "ontrac.com",
  "aftership.com",
  "narvar.com",
  "17track.net",
]);

const TRAVEL_STRONG_RE =
  /boarding pass|check-?in (?:is )?(?:now )?open|online check-?in|(?:flight|booking|reservation|trip) (?:confirmation|confirmed|itinerary)|booking reference|e-?ticket|your (?:flight|itinerary|booking|reservation) (?:to|is|has|details|confirmation|#)|搭乗券|予約確認|预订确认|예약 확인/iu;
const TRAVEL_REF_RE =
  /(?:confirmation|booking|reservation|record locator|pnr)\s{0,3}(?:code|number|no\.?|#|reference|ref)?\s{0,3}[:#]?\s{0,3}[a-z0-9]{5,10}(?![a-z0-9])/iu;

/** Bare "your order" (as in "20% off your order") is not billing evidence in a subject. */
const WEAK_ORDER_RE =
  /your order(?! (?:#|no\.?|number|from|with|is|has|was|of|confirmation|confirmed|receipt|summary|details|update))/gu;

const PROMO_KW_GLOBAL = PROMO_KW.map(
  (re) => new RegExp(re.source, `${re.flags.replace("g", "")}g`),
);

const URGENCY_KW_GLOBAL = URGENCY_KW.map(
  (re) => new RegExp(re.source, `${re.flags.replace("g", "")}g`),
);

/** The text with its urgency phrases (URGENCY_KW) blanked out. */
function withoutUrgency(s: string): string {
  let out = s;
  for (const g of URGENCY_KW_GLOBAL) out = out.replace(g, " ");
  return out;
}

function countDistinctPromo(s: string): number {
  const seen = new Set<string>();
  for (const g of PROMO_KW_GLOBAL) {
    g.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = g.exec(s)) !== null && guard++ < 30) {
      seen.add(m[0]);
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return seen.size;
}

interface Signals {
  t: TextView;
  labels: Set<string>;
  fromDomain: string | null;
  listHeaders: boolean;
  promoSubject: boolean;
  promoHead: boolean;
  promoBodyCount: number;
  dealsStrong: boolean;
  notificationPlatform: boolean;
  newsletterPlatform: boolean;
  editorial: boolean;
}

function signalsOf(input: ClassifyTypeInput): Signals {
  const { parsed, headers, content, labelIds } = input;
  const t = textView(parsed, content);
  const listHeaders = headers.listUnsubscribe !== null || headers.listId !== null;
  const editorial =
    content.wordCount >= 350 &&
    content.ctaLabels.length <= 3 &&
    content.deals.length === 0 &&
    (listHeaders || content.hasUnsubscribeLink);
  return {
    t,
    labels: new Set(labelIds),
    fromDomain: headers.fromDomain,
    listHeaders,
    promoSubject: hit(PROMO_KW, t.subject),
    promoHead: hit(PROMO_KW, t.head),
    promoBodyCount: countDistinctPromo(t.body),
    dealsStrong: content.deals.some((d) => d.kind !== "other" || d.code !== null),
    notificationPlatform:
      headers.fromDomain !== null && NOTIFICATION_PLATFORM_DOMAINS.has(headers.fromDomain),
    newsletterPlatform:
      headers.espPlatform !== null && NEWSLETTER_PLATFORMS.has(headers.espPlatform),
    editorial,
  };
}

// ───────────────────────── rules ─────────────────────────

function schemaRule(content: ContentExtract, s: Signals): Candidate | null {
  const items = content.schemaOrg;
  if (items.length === 0) return null;
  const find = (pred: (type: string) => boolean) => items.find((i) => pred(i.type));
  const promo = find((t) => t === "DiscountOffer" || t === "PromotionCard");
  const secondary = promo || s.dealsStrong ? ["promotional"] : [];
  const tx = (subtype: string, rule: string): Candidate => ({
    type: "transactional",
    subtype,
    confidence: 0.95,
    rule,
    secondary,
  });

  const invoice = find((t) => t === "Invoice");
  const order = find((t) => t === "Order");
  const failedStatus = /PastDue|Declined|Failed/i;
  if (invoice && failedStatus.test(invoice.fields.paymentStatus ?? ""))
    return tx("payment_failed", "schema:Invoice");
  if (order && failedStatus.test(order.fields.paymentStatus ?? ""))
    return tx("payment_failed", "schema:Order");
  if (find((t) => t === "ParcelDelivery")) return tx("shipping", "schema:ParcelDelivery");
  if (order) {
    const status = order.fields.orderStatus ?? "";
    if (/InTransit|Delivered|PickupAvailable|OutForDelivery/i.test(status))
      return tx("shipping", "schema:Order");
    if (/PaymentDue/i.test(status)) return tx("invoice", "schema:Order");
    return tx("order", "schema:Order");
  }
  if (invoice) return tx("invoice", "schema:Invoice");
  const reservation = find((t) => t.endsWith("Reservation"));
  if (reservation) {
    return tx(
      reservation.type === "EventReservation" ? "ticket" : "travel",
      `schema:${reservation.type}`,
    );
  }
  if (promo) {
    const coded = Boolean(promo.fields.discountCode) || content.deals.some((d) => d.code !== null);
    return {
      type: "promotional",
      subtype: coded ? "coupon" : "sale",
      confidence: 0.9,
      rule: `schema:${promo.type}`,
    };
  }
  const event = find((t) => t === "Event" || t.endsWith("Event"));
  if (event) {
    const online =
      /Online/i.test(event.fields.eventAttendanceMode ?? "") ||
      /Virtual/i.test(event.fields.location ?? "");
    return {
      type: "event",
      subtype: online ? "webinar" : "invitation",
      confidence: 0.85,
      rule: `schema:${event.type}`,
    };
  }
  return null;
}

function calendarRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  if (!input.parsed.hasCalendar) return null;
  const method = input.parsed.calendarMethod ?? null;
  if (method === "REPLY")
    return { type: "notification", subtype: "activity", confidence: 0.8, rule: "calendar:reply" };
  if (
    TRAVEL_STRONG_RE.test(s.t.subject) ||
    (hit(TRAVEL_KW, s.t.subject) && TRAVEL_REF_RE.test(s.t.body))
  ) {
    return {
      type: "transactional",
      subtype: "travel",
      confidence: 0.85,
      rule: "calendar:travel",
      secondary: ["event"],
    };
  }
  const webinar = hit(WEBINAR_KW, s.t.all);
  return {
    type: "event",
    subtype: webinar ? "webinar" : "invitation",
    confidence: 0.9,
    rule: "calendar",
  };
}

function securityRule(security: SecurityVerdict): Candidate | null {
  if (!security.securitySensitive) return null;
  const subtype =
    security.reason === "password_reset"
      ? "password_reset"
      : security.reason === "login_alert"
        ? "login_alert"
        : security.reason === "security_alert"
          ? "security_alert"
          : "verification_code"; // otp and magic links are one-time credentials
  return {
    type: "account_security",
    subtype,
    confidence: 0.9,
    rule: `security:${security.reason ?? "unknown"}`,
  };
}

function transactionalRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  const { t } = s;
  const secondary = s.dealsStrong || s.promoBodyCount >= 2 ? ["promotional"] : [];

  // Payment failure (no amount needed).
  if (hit(PAYMENT_FAILED_KW, t.subject)) {
    return {
      type: "transactional",
      subtype: "payment_failed",
      confidence: 0.9,
      rule: "billing:payment_failed",
      secondary: [],
    };
  }
  if (hit(PAYMENT_FAILED_KW, t.head) && !s.promoSubject) {
    return {
      type: "transactional",
      subtype: "payment_failed",
      confidence: 0.75,
      rule: "billing:payment_failed",
      secondary: [],
    };
  }

  // Shipping (keyword + carrier / tracking number / carrier link).
  const carrierEvidence =
    CARRIER_RE.test(t.all) ||
    TRACKING_NUMBER_RE.test(t.all) ||
    (input.content.linkDomains ?? []).some((d) => CARRIER_DOMAINS.has(d));
  const shipSubject = hit(SHIPPING_KW, t.subject);
  if (!s.promoSubject || shipSubject) {
    if ((shipSubject || hit(SHIPPING_KW, t.head)) && carrierEvidence) {
      return {
        type: "transactional",
        subtype: "shipping",
        confidence: shipSubject ? 0.9 : 0.8,
        rule: "shipping:carrier",
        secondary,
      };
    }
    if (
      shipSubject &&
      /shipped|on (?:its|the) way|out for delivery|delivered|dispatched|発送|已发货|배송/iu.test(
        t.subject,
      )
    ) {
      return {
        type: "transactional",
        subtype: "shipping",
        confidence: 0.65,
        rule: "shipping:subject",
        secondary,
      };
    }
  }

  // Billing + amount.
  const amount = AMOUNT_RE.test(t.all);
  const subjectForOrder = t.subject.replace(WEAK_ORDER_RE, " ");
  const subjInvoice = hit(INVOICE_KW, t.subject);
  const subjReceipt = hit(RECEIPT_KW, t.subject);
  const subjOrder = hit(ORDER_KW, subjectForOrder) || (hit(ORDER_KW, t.subject) && !s.promoSubject);
  const billingSubtype = (inv: boolean, rec: boolean, ord: boolean): string =>
    inv ? "invoice" : rec ? "receipt" : ord ? "order" : "receipt";
  if ((subjInvoice || subjReceipt || subjOrder) && amount) {
    return {
      type: "transactional",
      subtype: billingSubtype(subjInvoice, subjReceipt, subjOrder),
      confidence: 0.85,
      rule: "billing:subject",
      secondary,
    };
  }
  if (!s.promoSubject && !s.promoHead && amount) {
    const headInvoice = hit(INVOICE_KW, t.head);
    const headReceipt = hit(RECEIPT_KW, t.head);
    const headOrder = hit(ORDER_KW, t.head);
    if (headInvoice || headReceipt || headOrder) {
      return {
        type: "transactional",
        subtype: billingSubtype(headInvoice, headReceipt, headOrder),
        confidence: 0.7,
        rule: "billing:body",
        secondary,
      };
    }
  }

  // Travel / tickets.
  if (
    TRAVEL_STRONG_RE.test(t.subject) ||
    (hit(TRAVEL_KW, t.subject) && TRAVEL_REF_RE.test(t.all))
  ) {
    return {
      type: "transactional",
      subtype: "travel",
      confidence: 0.85,
      rule: "travel",
      secondary,
    };
  }
  if (!s.promoSubject && TRAVEL_STRONG_RE.test(t.head) && TRAVEL_REF_RE.test(t.all)) {
    return {
      type: "transactional",
      subtype: "travel",
      confidence: 0.75,
      rule: "travel:body",
      secondary,
    };
  }
  if (
    hit(TICKET_KW, t.subject) &&
    !s.promoSubject &&
    (amount || TRAVEL_REF_RE.test(t.all) || /order/i.test(t.all))
  ) {
    return { type: "transactional", subtype: "ticket", confidence: 0.8, rule: "ticket", secondary };
  }
  return null;
}

function socialRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  if (s.fromDomain && SOCIAL_DOMAINS.has(s.fromDomain)) {
    return { type: "social", subtype: null, confidence: 0.85, rule: "social:domain" };
  }
  if (s.labels.has("CATEGORY_SOCIAL") && hit(SOCIAL_KW, s.t.all)) {
    return { type: "social", subtype: null, confidence: 0.75, rule: "social:category" };
  }
  const autoish = input.headers.autoSubmitted !== null || input.headers.isNoReply;
  if (hit(SOCIAL_STRONG_KW, s.t.subject) && autoish && !s.notificationPlatform) {
    return { type: "social", subtype: null, confidence: 0.65, rule: "social:subject" };
  }
  return null;
}

function communityRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  if (s.notificationPlatform) return null;
  const h = input.headers;
  const software = h.mailingListSoftware ?? null;
  const subtype =
    software === "Discourse" || /forum|topic|thread/i.test(s.t.subject)
      ? "forum"
      : software === "Google Groups"
        ? "group"
        : "mailing_list";
  if (h.listPost || software) {
    return {
      type: "community",
      subtype,
      confidence: 0.85,
      rule: `community:${software ?? "list-post"}`,
    };
  }
  if (h.listId !== null && hit(FORUM_KW, s.t.all)) {
    return { type: "community", subtype, confidence: 0.75, rule: "community:list-id" };
  }
  if (s.labels.has("CATEGORY_FORUMS") && hit(FORUM_KW, s.t.all)) {
    return { type: "community", subtype, confidence: 0.7, rule: "community:category" };
  }
  return null;
}

function surveyRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  const surveyLinks = (input.content.linkDomains ?? []).some((d) => SURVEY_DOMAINS.has(d));
  if (hit(SURVEY_KW, s.t.subject) && !s.promoSubject) {
    return { type: "survey", subtype: null, confidence: 0.8, rule: "survey:subject" };
  }
  if (hit(SURVEY_KW, s.t.head) && (surveyLinks || !s.promoHead)) {
    return {
      type: "survey",
      subtype: null,
      confidence: surveyLinks ? 0.75 : 0.65,
      rule: "survey:body",
    };
  }
  if (surveyLinks && hit(SURVEY_KW, s.t.body)) {
    return { type: "survey", subtype: null, confidence: 0.65, rule: "survey:links" };
  }
  return null;
}

function eventRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  if (s.promoSubject) return null;
  if (s.listHeaders && hit(NEWSLETTER_SUBJECT_KW, s.t.subject)) return null;
  const subj = hit(EVENT_KW, s.t.subject);
  const head = hit(EVENT_KW, s.t.head);
  const webinar = hit(WEBINAR_KW, s.t.all);
  if (!subj && !(head && (input.content.deadlineAt !== null || webinar))) return null;
  const subtype = hit(REMINDER_KW, s.t.subject)
    ? "event_reminder"
    : webinar
      ? "webinar"
      : "invitation";
  return { type: "event", subtype, confidence: subj ? 0.8 : 0.7, rule: "event" };
}

function promoSubtype(input: ClassifyTypeInput, s: Signals): string | null {
  const { t } = s;
  if (hit(CART_KW, t.subject) || hit(CART_KW, t.head)) return "cart_reminder";
  if (input.content.deals.some((d) => d.code !== null)) return "coupon";
  if (
    input.content.deals.length > 0 ||
    /(?<![\p{L}])(?:sale|clearance|deals?)(?![\p{L}])|% ?off/u.test(t.subject)
  ) {
    return "sale";
  }
  if (hit(LAUNCH_KW, t.subject) || hit(LAUNCH_KW, t.head)) return "product_launch";
  if (hit(RECO_KW, t.subject) || hit(RECO_KW, t.head)) return "recommendation";
  return s.promoBodyCount > 0 ? "sale" : null;
}

function promoRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  const { t } = s;
  const h = input.headers;
  const klaviyoMarketing =
    h.espPlatform === "Klaviyo" && (h.dkimSelectors ?? []).some((sel) => /^km\d*$/.test(sel));
  const catPromo = s.labels.has("CATEGORY_PROMOTIONS");
  // Subjects whose primary purpose is not an ad (CAN-SPAM subject test).
  const otherPurposeSubject =
    hit(WELCOME_KW, t.subject) ||
    hit(TRIAL_KW, t.subject) ||
    hit(WHATS_NEW_KW, t.subject) ||
    hit(TERMS_KW, t.subject) ||
    hit(PRIVACY_KW, t.subject) ||
    hit(PLAN_CHANGE_KW, t.subject) ||
    hit(ONBOARDING_KW, t.subject);
  const newsletterish = s.newsletterPlatform || s.editorial;
  const secondary = hit(WELCOME_KW, t.subject) || hit(REENGAGE_KW, t.subject) ? ["lifecycle"] : [];
  const make = (confidence: number, rule: string): Candidate => ({
    type: "promotional",
    subtype: promoSubtype(input, s),
    confidence,
    rule,
    secondary,
  });

  if (hit(CART_KW, t.subject)) return { ...make(0.85, "promo:cart"), subtype: "cart_reminder" };
  // A plan / billing notice whose only promotional words are urgency ("Last chance: your
  // subscription will be deactivated soon") isn't an ad: the notice rules below decide.
  const urgentNotice =
    hit(PLAN_CHANGE_KW, t.subject) && !hit(PROMO_KW, withoutUrgency(t.subject)) && !s.dealsStrong;
  if (s.promoSubject && !urgentNotice && !(newsletterish && hit(NEWSLETTER_SUBJECT_KW, t.subject)))
    return make(0.85, "promo:subject");
  if (otherPurposeSubject || newsletterish) return null;
  if (s.dealsStrong) return make(0.8, "promo:deal");
  if (s.promoBodyCount >= 2) return make(0.7, "promo:tokens");
  if (klaviyoMarketing) return make(0.7, "promo:klaviyo-km");
  if (
    (hit(LAUNCH_KW, t.subject) || hit(RECO_KW, t.subject)) &&
    (catPromo || s.promoBodyCount > 0)
  ) {
    return make(0.7, "promo:launch");
  }
  if (catPromo) return make(0.65, "promo:category");
  return null;
}

function newsletterRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  const c = input.content;
  const digest =
    hit(DIGEST_KW, s.t.subject) ||
    (c.linkCount >= 15 && c.wordCount > 0 && c.wordCount / c.linkCount < 35);
  const subtype = digest ? "digest" : "editorial";
  if (s.newsletterPlatform)
    return { type: "newsletter", subtype, confidence: 0.85, rule: "newsletter:platform" };
  const subscribed =
    s.listHeaders ||
    c.hasUnsubscribeLink ||
    s.labels.has("CATEGORY_PROMOTIONS") ||
    s.labels.has("CATEGORY_UPDATES");
  if (hit(NEWSLETTER_SUBJECT_KW, s.t.subject) && subscribed && !s.notificationPlatform) {
    return { type: "newsletter", subtype, confidence: 0.8, rule: "newsletter:subject" };
  }
  // Long text alone doesn't make a newsletter when the subject states another purpose.
  const t = s.t;
  const otherPurposeSubject =
    hit(WHATS_NEW_KW, t.subject) ||
    hit(WELCOME_KW, t.subject) ||
    hit(TRIAL_KW, t.subject) ||
    hit(ONBOARDING_KW, t.subject) ||
    hit(TERMS_KW, t.subject) ||
    hit(PRIVACY_KW, t.subject) ||
    hit(PLAN_CHANGE_KW, t.subject);
  if (s.editorial && !s.notificationPlatform && !otherPurposeSubject) {
    return { type: "newsletter", subtype, confidence: 0.7, rule: "newsletter:editorial" };
  }
  return null;
}

function lifecycleRule(s: Signals): Candidate | null {
  const { t } = s;
  const head = t.head.slice(0, 300);
  if (hit(TRIAL_KW, t.subject))
    return {
      type: "lifecycle",
      subtype: "trial_ending",
      confidence: 0.85,
      rule: "lifecycle:trial",
    };
  if (hit(WELCOME_KW, t.subject))
    return { type: "lifecycle", subtype: "welcome", confidence: 0.85, rule: "lifecycle:welcome" };
  if (hit(REENGAGE_KW, t.subject))
    return {
      type: "lifecycle",
      subtype: "re_engagement",
      confidence: 0.8,
      rule: "lifecycle:re_engagement",
    };
  if (hit(ONBOARDING_KW, t.subject))
    return {
      type: "lifecycle",
      subtype: "onboarding",
      confidence: 0.75,
      rule: "lifecycle:onboarding",
    };
  if (hit(TRIAL_KW, head))
    return { type: "lifecycle", subtype: "trial_ending", confidence: 0.7, rule: "lifecycle:trial" };
  if (hit(WELCOME_KW, head))
    return { type: "lifecycle", subtype: "welcome", confidence: 0.65, rule: "lifecycle:welcome" };
  return null;
}

function updatesRule(s: Signals): Candidate | null {
  const { t } = s;
  const notice = (subtype: string, confidence: number): Candidate => ({
    type: "account_notice",
    subtype,
    confidence,
    rule: `notice:${subtype}`,
  });
  if (hit(TERMS_KW, t.subject)) return notice("terms", 0.85);
  if (hit(PRIVACY_KW, t.subject)) return notice("privacy", 0.85);
  if (hit(PLAN_CHANGE_KW, t.subject)) return notice("plan_change", 0.8);
  if (hit(TERMS_KW, t.head)) return notice("terms", 0.75);
  if (hit(PRIVACY_KW, t.head)) return notice("privacy", 0.75);
  if (hit(PLAN_CHANGE_KW, t.head)) return notice("plan_change", 0.7);
  const whatsNewSubject = hit(WHATS_NEW_KW, t.subject);
  if (whatsNewSubject || hit(WHATS_NEW_KW, t.head)) {
    const subtype = hit(RELEASE_NOTES_KW, t.all)
      ? "release_notes"
      : hit(ANNOUNCEMENT_KW, t.subject)
        ? "announcement"
        : "feature";
    return {
      type: "product_update",
      subtype,
      confidence: whatsNewSubject ? 0.8 : 0.65,
      rule: "product_update",
    };
  }
  return null;
}

function notificationRule(input: ClassifyTypeInput, s: Signals): Candidate | null {
  const h = input.headers;
  const autoish = h.autoSubmitted !== null || h.isNoReply || s.notificationPlatform;
  if (!autoish) return null;
  if (!hit(ACTIVITY_KW, s.t.subject) && !hit(ACTIVITY_KW, s.t.head)) return null;
  const subtype = hit(MENTION_KW, s.t.all)
    ? "mention"
    : hit(REMINDER_KW, s.t.subject)
      ? "reminder"
      : "activity";
  return { type: "notification", subtype, confidence: 0.7, rule: "notification" };
}

/** Best-effort provisional type while Claude is pending. */
function provisional(s: Signals, weak: Candidate | null): Candidate {
  if (weak) return weak;
  if (s.labels.has("CATEGORY_PROMOTIONS"))
    return { type: "promotional", subtype: null, confidence: 0.3, rule: "gmail:promotions" };
  if (s.labels.has("CATEGORY_SOCIAL"))
    return { type: "social", subtype: null, confidence: 0.3, rule: "gmail:social" };
  if (s.labels.has("CATEGORY_FORUMS"))
    return { type: "community", subtype: null, confidence: 0.3, rule: "gmail:forums" };
  if (s.labels.has("CATEGORY_UPDATES"))
    return { type: "notification", subtype: null, confidence: 0.3, rule: "gmail:updates" };
  return { type: "other", subtype: null, confidence: 0.2, rule: null };
}

function secondaryFor(c: Candidate, s: Signals): string[] {
  const tags = new Set(c.secondary ?? []);
  const promoContent = s.dealsStrong || s.promoBodyCount >= 2;
  if (
    promoContent &&
    c.type !== "promotional" &&
    c.type !== "account_security" &&
    !(c.type === "transactional" && c.subtype === "payment_failed")
  ) {
    tags.add("promotional");
  }
  tags.delete(c.type);
  return [...tags];
}

/** Classifies the email type (DESIGN.md §7.3). */
export function classifyType(input: ClassifyTypeInput): TypeVerdict {
  const s = signalsOf(input);
  const rules: Array<() => Candidate | null> = [
    () => schemaRule(input.content, s),
    () => calendarRule(input, s),
    () => securityRule(input.security),
    () => transactionalRule(input, s),
    () => socialRule(input, s),
    () => communityRule(input, s),
    () => surveyRule(input, s),
    () => eventRule(input, s),
    () => promoRule(input, s),
    () => newsletterRule(input, s),
    () => lifecycleRule(s),
    () => updatesRule(s),
    () => notificationRule(input, s),
  ];

  let matched: Candidate | null = null;
  let weak: Candidate | null = null;
  for (const rule of rules) {
    const c = rule();
    if (!c) continue;
    if (c.confidence >= CONFIDENT) {
      matched = c;
      break;
    }
    if (!weak || c.confidence > weak.confidence) weak = c;
  }

  const prior = input.prior;
  // User override first (never over security detection: minimisation must hold).
  if (prior?.typeOverride && !input.security.securitySensitive) {
    return {
      primaryType: prior.typeOverride,
      subtype: matched && matched.type === prior.typeOverride ? matched.subtype : null,
      secondaryTags: [],
      typeConfidence: 1,
      typeSource: "user",
      rule: "user_override",
      needsLlm: false,
    };
  }

  if (matched) {
    return {
      primaryType: matched.type,
      subtype: matched.subtype,
      secondaryTags: secondaryFor(matched, s),
      typeConfidence: matched.confidence,
      typeSource: "rule",
      rule: matched.rule,
      needsLlm: false,
    };
  }

  // Step 15 — sender prior majority.
  if (
    prior?.majorityType &&
    prior.majorityShare >= PRIOR_MIN_SHARE &&
    prior.emailCount >= PRIOR_MIN_EMAILS
  ) {
    return {
      primaryType: prior.majorityType,
      subtype: null,
      secondaryTags: [],
      typeConfidence: Math.min(0.9, prior.majorityShare * 0.9),
      typeSource: "sender_prior",
      rule: "sender_prior",
      needsLlm: false,
    };
  }

  // Step 16 — per-(sender, template) cached Claude classification.
  if (input.templateClassification) {
    return {
      primaryType: input.templateClassification.primaryType,
      subtype: input.templateClassification.subtype,
      secondaryTags: [],
      typeConfidence: 0.8,
      typeSource: "template_cache",
      rule: "template_cache",
      needsLlm: false,
    };
  }

  const p = provisional(s, weak);
  return {
    primaryType: p.type,
    subtype: p.subtype,
    secondaryTags: secondaryFor(p, s),
    typeConfidence: p.confidence,
    typeSource: "pending",
    rule: p.rule,
    needsLlm: true,
  };
}
