/**
 * ESP / sending-platform fingerprinting (DESIGN.md §7.2 "ESP/platform fingerprint"; sender.esp_platform
 * and sender.esp_mta in DATA-MODEL.md §3).
 *
 * Platform (who composed the campaign: Klaviyo, Braze, Substack…) and MTA (who delivered it:
 * Amazon SES, SendGrid…) are kept apart because platforms sit on MTAs (RESEARCH-NOTES: Braze on
 * SES). Evidence comes from vendor header markers, X-Mailer, the Feedback-ID sender id, and the
 * domains of Return-Path, DKIM d=, List-Unsubscribe URIs and Message-ID. Branded domains hide
 * most fingerprints, so "unknown" (null) is a normal answer.
 */
import type { Header } from "../types";
import { registrableDomain } from "../util/domain";

type EspKind = "platform" | "mta";

interface EspRule {
  name: string;
  kind: EspKind;
  /** Typically transactional sending infrastructure (hard "automated" signal, §7.2). */
  transactional?: boolean;
  /** Registrable domains owned by the vendor. */
  domains?: readonly string[];
  /** Regexes over registrable domains (numbered vendor domains). */
  domainPatterns?: readonly RegExp[];
  /** Header-name markers (exact names or prefixes ending in "-"). */
  headers?: readonly string[];
  /** X-Mailer / User-Agent regex. */
  mailer?: RegExp;
  /** Regex over the Feedback-ID SenderId (last colon-separated field). */
  feedbackId?: RegExp;
}

/** Our own table, written from vendor documentation and public header samples. */
const RULES: readonly EspRule[] = [
  // ── MTAs / sending infrastructure ──
  {
    name: "Amazon SES",
    kind: "mta",
    transactional: true,
    domains: ["amazonses.com", "awstrack.me"],
    headers: ["x-ses-outgoing", "x-ses-configuration-set"],
    feedbackId: /^amazonses$/i,
  },
  {
    name: "SendGrid",
    kind: "mta",
    transactional: true,
    domains: ["sendgrid.net", "sendgrid.com"],
    headers: ["x-sg-eid", "x-sg-id"],
    mailer: /sendgrid/i,
  },
  {
    name: "Mailgun",
    kind: "mta",
    transactional: true,
    domains: ["mailgun.org", "mailgun.net", "mailgun.info"],
    headers: ["x-mailgun-"],
    mailer: /mailgun/i,
  },
  {
    name: "Postmark",
    kind: "mta",
    transactional: true,
    domains: ["mtasv.net", "postmarkapp.com", "pstmrk.it"],
    headers: ["x-pm-message-id", "x-pm-tag", "x-pm-rcpt"],
    feedbackId: /^postmark$/i,
  },
  {
    name: "SparkPost",
    kind: "mta",
    transactional: true,
    domains: ["sparkpostmail.com", "sparkpost.com", "spgo.io"],
    headers: ["x-msys-api"],
  },
  {
    name: "Mandrill",
    kind: "mta",
    transactional: true,
    domains: ["mandrillapp.com", "mandrill.com"],
    headers: ["x-mandrill-user", "x-mc-metadata"],
    mailer: /mandrill/i,
  },
  {
    name: "Mailjet",
    kind: "mta",
    transactional: true,
    domains: ["mailjet.com", "mjt.lu"],
    headers: ["x-mj-mid", "x-mj-smtpguid", "x-mailjet-"],
    mailer: /mailjet/i,
  },
  {
    name: "Resend",
    kind: "mta",
    transactional: true,
    domains: ["resend.com", "resend.dev"],
  },
  // ── Commerce platforms (their own sending) ──
  {
    name: "Shopify",
    kind: "platform",
    transactional: true,
    domains: ["shopifyemail.com", "shopify.com"],
    headers: ["x-shopify-"],
  },
  { name: "Squarespace", kind: "platform", domains: ["squarespace-mail.com"] },
  // ── Marketing / lifecycle platforms ──
  {
    name: "Klaviyo",
    kind: "platform",
    domains: ["klaviyomail.com", "klaviyo.com", "kmail-lists.com"],
    domainPatterns: [/^klclick\d*\.com$/],
    headers: ["x-kmail-", "x-klaviyo-"],
    mailer: /klaviyo/i,
    feedbackId: /^klaviyo$/i,
  },
  {
    name: "Mailchimp",
    kind: "platform",
    domains: [
      "mcsv.net",
      "mcdlv.net",
      "mailchimpapp.net",
      "rsgsv.net",
      "list-manage.com",
      "mailchimp.com",
      "mailchi.mp",
    ],
    headers: ["x-mc-user"],
    mailer: /mailchimp/i,
    feedbackId: /^(?:mc|mailchimp)$/i,
  },
  {
    name: "Braze",
    kind: "platform",
    domains: ["braze.com", "braze.eu", "appboy.com", "braze-images.com"],
    headers: ["x-braze-"],
    feedbackId: /^braze$/i,
  },
  {
    name: "Iterable",
    kind: "platform",
    domains: ["iterable.com", "itbl.co"],
    headers: ["x-iterable-"],
    feedbackId: /^iterable$/i,
  },
  {
    name: "Salesforce Marketing Cloud",
    kind: "platform",
    domains: ["exacttarget.com", "exct.net", "marketingcloudapps.com", "sfmc-content.com"],
    headers: ["x-sfmc-stack"],
    feedbackId: /^(?:sfmc|exacttarget)$/i,
  },
  { name: "Salesforce Pardot", kind: "platform", domains: ["pardot.com"] },
  {
    name: "HubSpot",
    kind: "platform",
    domains: [
      "hubspotemail.net",
      "hsms06.com",
      "hubspotlinks.com",
      "hubspot.com",
      "hubspotstarter.net",
    ],
    headers: ["x-hs-cid", "x-hubspot-"],
    feedbackId: /^hubspot$/i,
  },
  {
    name: "Customer.io",
    kind: "platform",
    domains: ["customeriomail.com", "customer.io"],
    headers: ["x-cio-"],
    feedbackId: /^(?:customerio|cio)$/i,
  },
  {
    name: "Substack",
    kind: "platform",
    domains: ["substack.com", "substackcdn.com"],
    mailer: /substack/i,
  },
  {
    name: "beehiiv",
    kind: "platform",
    domains: ["beehiiv.com"],
    headers: ["x-beehiiv-"],
    feedbackId: /^beehiiv$/i,
  },
  {
    name: "Kit (ConvertKit)",
    kind: "platform",
    domains: ["convertkit.com", "ck.page", "kit.com", "filekitcdn.com"],
    domainPatterns: [/^convertkit-mail\d*\.com$/, /^kit-mail\d*\.com$/],
    mailer: /convertkit/i,
  },
  {
    name: "Campaign Monitor",
    kind: "platform",
    domains: ["createsend.com", "cmail1.com"],
    domainPatterns: [/^createsend\d+\.com$/, /^cmail\d+\.com$/],
  },
  {
    name: "Brevo",
    kind: "platform",
    domains: ["sendinblue.com", "brevo.com", "sibautomation.com", "mailin.fr"],
    domainPatterns: [/^sendib[mt]\d\.com$/],
    headers: ["x-mailin-eid", "x-mailin-campaign", "x-sib-id"],
    mailer: /sendinblue|brevo/i,
  },
  {
    name: "MailerLite",
    kind: "platform",
    domains: ["mailerlite.com", "mlsend.com", "mlsend2.com", "mlcdn.com"],
    mailer: /mailerlite/i,
  },
  { name: "Sailthru", kind: "platform", domains: ["sailthru.com"], headers: ["x-sailthru-"] },
  { name: "Cordial", kind: "platform", domains: ["cordial.io", "cordial.com", "crdl.io"] },
  {
    name: "Attentive",
    kind: "platform",
    domains: ["attentivemobile.com", "attn.tv", "attentive.com"],
  },
  {
    name: "Omnisend",
    kind: "platform",
    domains: ["omnisend.com", "omnisrv.com", "soundestlink.com", "soundest.net"],
  },
  {
    name: "Intercom",
    kind: "platform",
    domains: ["intercom.io", "intercom-mail.com", "intercom.com"],
  },
  {
    name: "Constant Contact",
    kind: "platform",
    domains: ["rs6.net", "constantcontact.com", "ctctcdn.com"],
  },
  {
    name: "ActiveCampaign",
    kind: "platform",
    domains: ["activehosted.com", "activecampaign.com"],
    domainPatterns: [/^acemln[a-d]\.com$/],
  },
  {
    name: "Zoho Campaigns",
    kind: "platform",
    domains: ["maillist-manage.com", "maillist-manage.eu", "maillist-manage.in", "zcsend.net"],
  },
  { name: "Marketo", kind: "platform", domains: ["mktomail.com", "marketo.com", "mktdns.com"] },
  { name: "Oracle Eloqua", kind: "platform", domains: ["en25.com", "eloqua.com"] },
  { name: "Oracle Responsys", kind: "platform", domainPatterns: [/^rsys\d+\.net$/] },
  { name: "Emarsys", kind: "platform", domains: ["emarsys.net", "emarsys.com"] },
  { name: "Bloomreach", kind: "platform", domains: ["exponea.com"] },
  { name: "Blueshift", kind: "platform", domains: ["getblueshift.com"] },
  { name: "Buttondown", kind: "platform", domains: ["buttondown.email", "buttondown.com"] },
  { name: "Ghost", kind: "platform", domains: ["ghost.io"] },
  { name: "AWeber", kind: "platform", domains: ["aweber.com", "aweber.net"] },
  { name: "GetResponse", kind: "platform", domains: ["getresponse.com", "getresponse-mail.com"] },
  { name: "Drip", kind: "platform", domains: ["getdrip.com", "drip.com"] },
  { name: "Loops", kind: "platform", domains: ["loops.so"] },
];

/** Platforms whose use signals a newsletter publication (DESIGN.md §7.3 rule 11). */
export const NEWSLETTER_PLATFORMS: ReadonlySet<string> = new Set([
  "Substack",
  "beehiiv",
  "Ghost",
  "Buttondown",
  "Kit (ConvertKit)",
]);

const DOMAIN_INDEX = new Map<string, EspRule>();
for (const rule of RULES) for (const d of rule.domains ?? []) DOMAIN_INDEX.set(d, rule);

function ruleForDomain(domain: string | null): EspRule | null {
  if (!domain) return null;
  const direct = DOMAIN_INDEX.get(domain);
  if (direct) return direct;
  for (const rule of RULES) {
    if (rule.domainPatterns?.some((re) => re.test(domain))) return rule;
  }
  return null;
}

export interface EspEvidence {
  headers: readonly Header[];
  /** Hosts / domains observed (Return-Path, DKIM d=, List-Unsubscribe, Message-ID…), with weight. */
  domains: ReadonlyArray<{ host: string | null; weight: number }>;
  feedbackId: string | null;
  mailer: string | null;
}

export interface EspDetection {
  platform: string | null;
  mta: string | null;
  /** Detected vendor is typically used for transactional sending. */
  transactional: boolean;
}

/** Scores every rule against the evidence and returns the best platform and MTA. */
export function detectEsp(ev: EspEvidence): EspDetection {
  const scores = new Map<EspRule, number>();
  const add = (rule: EspRule | null, w: number): void => {
    if (rule) scores.set(rule, (scores.get(rule) ?? 0) + w);
  };

  const names = ev.headers.map((h) => h.name);
  for (const rule of RULES) {
    if (
      rule.headers?.some((m) =>
        m.endsWith("-") ? names.some((n) => n.startsWith(m)) : names.includes(m),
      )
    ) {
      add(rule, 3);
    }
    if (rule.mailer && ev.mailer && rule.mailer.test(ev.mailer.slice(0, 256))) add(rule, 3);
  }

  if (ev.feedbackId) {
    const fields = ev.feedbackId.slice(0, 512).split(":");
    const senderId = (fields[fields.length - 1] ?? "").trim();
    if (senderId) for (const rule of RULES) if (rule.feedbackId?.test(senderId)) add(rule, 3);
  }

  for (const { host, weight } of ev.domains) add(ruleForDomain(registrableDomain(host)), weight);

  let platform: [EspRule, number] | null = null;
  let mta: [EspRule, number] | null = null;
  for (const [rule, score] of scores) {
    if (score < 2) continue;
    if (rule.kind === "platform") {
      if (!platform || score > platform[1]) platform = [rule, score];
    } else if (!mta || score > mta[1]) {
      mta = [rule, score];
    }
  }
  const platformName = platform?.[0].name ?? null;
  const mtaName = mta?.[0].name ?? null;
  return {
    platform: platformName ?? mtaName,
    mta: mtaName,
    transactional: Boolean(platform?.[0].transactional || mta?.[0].transactional),
  };
}
