/**
 * `extractContent`: static content facts from the raw (unsanitised) HTML or text/plain part
 * (DESIGN.md §5.5 step 3; FREE-TIER.md §4.6). One cheerio/parse5 parse and one DOM walk; the
 * text-level detectors then run on bounded strings. No network access, no DOMPurify/jsdom.
 */
import { isClickTrackingUrl } from "../policy";
import type {
  ContentExtract,
  DealCandidate,
  ParsedEmail,
  SchemaOrgItem,
  SecurityLinkKind,
  TrackingFacts,
} from "../types";
import { parseListUnsubscribe } from "../headers/list-unsubscribe";
import {
  normalizeHost,
  parseHttpUrl,
  registrableDomain,
  safeDecodeURIComponent,
} from "../util/domain";
import { dateHeaderOffsetMinutes, firstHeader } from "../util/headers";
import { simhash64 } from "../util/hash";
import {
  collapseKeepingLines,
  collapseWhitespace,
  normalizeForMatch,
  stripInvisible,
  truncateAtWord,
} from "../util/text";
import type { DateCandidate, DateContext } from "./dates";
import {
  DEADLINE_KEYWORDS_RE,
  EXPIRY_KEYWORDS_RE,
  findKeywordDates,
  findPhraseExpiries,
  parseSchemaDate,
} from "./dates";
import { extractDeals } from "./deals";
import { countWords, detectLanguage } from "./language";
import {
  EXACT_UNSUBSCRIBE_TEXT_RE,
  GENERIC_LINK_TEXT_RE,
  hasReceivingStatement,
  isPreferencesText,
  isUnsubscribeText,
  PREFERENCES_HREF_RE,
  securityLinkKindsOf,
  UNSUBSCRIBE_HREF_RE,
  VIEW_ONLINE_RE,
} from "./patterns";
import { hasPostalAddress } from "./postal";
import { extractSchemaOrg } from "./schema-org";
import type { LinkRecord, WalkResult } from "./walk";
import { walkHtml } from "./walk";

export interface ExtractContentOptions {
  receivedAt: Date;
  userAddresses: readonly string[];
  fromDomain: string | null;
}

/** HTML larger than this is truncated before parsing (the renderer caps at 2 MB, §6.2). */
export const MAX_EXTRACT_HTML_CHARS = 2_000_000;
export const MAX_VISIBLE_TEXT = 4000;
const MAX_CTA_LABELS = 10;
const MAX_LINK_DOMAINS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const DAY_FIRST_TLDS = /\.(?:uk|au|nz|ie|in|za|sg|hk|my|pk|ng|ke)$/;

// ───────────────────────── plain text ─────────────────────────

const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]{1,2048}/g;

function lineShape(line: string): string {
  const len = line.length;
  const bucket = len <= 20 ? "s" : len <= 60 ? "m" : len <= 120 ? "l" : "x";
  const first = (line.split(/\s+/)[0] ?? "").replace(/\d/g, "0").toLowerCase().slice(0, 12);
  const flags =
    (/^[-*•·–]/.test(line) ? "b" : "") +
    (/^\d/.test(line) ? "n" : "") +
    (/https?:\/\//.test(line) ? "u" : "") +
    (/:$/.test(line) ? "c" : "");
  return `${bucket}${flags}:${first}`;
}

/** Plain-text equivalent of the HTML walk (text-only mail). */
function walkPlainText(text: string): WalkResult {
  const t = text.length > 200_000 ? text.slice(0, 200_000) : text;
  const links: LinkRecord[] = [];
  URL_IN_TEXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_IN_TEXT_RE.exec(t)) !== null && links.length < 400) {
    const lineStart = t.lastIndexOf("\n", m.index - 1) + 1;
    const prevLineStart = t.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
    const before = t.slice(Math.max(prevLineStart, m.index - 100), m.index);
    links.push({
      href: m[0].replace(/[.,;:!?]+$/, ""),
      text: "",
      before,
      buttonLike: false,
      imageAlt: null,
    });
  }
  const skeleton = new Set<string>();
  const lines = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 400);
  let prev = "^";
  for (const line of lines) {
    const shape = lineShape(line);
    skeleton.add(`${prev}>${shape}`);
    prev = shape;
  }
  return {
    text: t,
    preheader: "",
    links,
    imageCount: 0,
    pixelCount: 0,
    pixelHosts: [],
    jsonLd: [],
    microdata: [],
    skeleton,
    htmlLang: null,
  };
}

// ───────────────────────── link analysis ─────────────────────────

interface LinkFacts {
  hasUnsubscribeLink: boolean;
  hasPreferencesLink: boolean;
  linkCount: number;
  clickTrackerHosts: string[];
  utmCampaign: string | null;
  utmMediumEmail: boolean;
  linkDomains: string[];
  securityLinkKinds: SecurityLinkKind[];
  ctaLabels: string[];
}

function unsubscribeTargets(parsed: ParsedEmail): Array<{ host: string; path: string }> {
  const lu = parseListUnsubscribe(firstHeader(parsed.headers, "list-unsubscribe"));
  const out: Array<{ host: string; path: string }> = [];
  for (const uri of lu?.https ?? []) {
    const u = parseHttpUrl(uri);
    if (u) out.push({ host: normalizeHost(u.hostname), path: u.pathname.toLowerCase() });
  }
  return out;
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function sharesListUnsubscribeTarget(
  u: URL,
  targets: ReadonlyArray<{ host: string; path: string }>,
): boolean {
  const host = normalizeHost(u.hostname);
  const segs = pathSegments(u.pathname.toLowerCase());
  return targets.some((t) => {
    if (t.host !== host) return false;
    const ts = pathSegments(t.path);
    if (ts.join("/") === segs.join("/")) return true;
    return ts.length >= 2 && segs.length >= 2 && ts[0] === segs[0] && ts[1] === segs[1];
  });
}

/** Normalised CTA label: NFKC, lower-case, trimmed of arrows/emoji/punctuation, ≤ 7 words. */
export function normalizeCtaLabel(raw: string): string | null {
  const s = collapseWhitespace(stripInvisible(raw).normalize("NFKC"))
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toLowerCase();
  if (s.length === 0 || s.length > 60) return null;
  const words = s.split(" ").length;
  if (words > 7) return null;
  return s;
}

function utmFrom(u: URL): { campaign: string | null; medium: string | null } {
  let campaign: string | null = null;
  let medium: string | null = null;
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (key === "utm_campaign" && campaign === null && v.trim())
      campaign = collapseWhitespace(v).slice(0, 100);
    else if (key === "utm_medium" && medium === null) medium = v.trim().toLowerCase();
  }
  return { campaign, medium };
}

function analyzeLinks(links: readonly LinkRecord[], parsed: ParsedEmail): LinkFacts {
  const targets = unsubscribeTargets(parsed);
  const facts: LinkFacts = {
    hasUnsubscribeLink: false,
    hasPreferencesLink: false,
    linkCount: 0,
    clickTrackerHosts: [],
    utmCampaign: null,
    utmMediumEmail: false,
    linkDomains: [],
    securityLinkKinds: [],
    ctaLabels: [],
  };
  for (const link of links) {
    const href = link.href;
    const hrefLower = href.slice(0, 16).toLowerCase();
    const isWeb = hrefLower.startsWith("http://") || hrefLower.startsWith("https://");
    const isMail = hrefLower.startsWith("mailto:");
    if (!isWeb && !isMail && !hrefLower.startsWith("tel:")) continue;
    facts.linkCount++;
    const textNorm = normalizeForMatch(collapseWhitespace(link.text));
    const beforeNorm = normalizeForMatch(collapseWhitespace(link.before)).slice(-80);
    const u = isWeb ? parseHttpUrl(href) : null;

    // Unsubscribe (U1): link text, "click here" + context, List-Unsubscribe target, ESP paths.
    if (!facts.hasUnsubscribeLink) {
      const pathQuery = u
        ? safeDecodeURIComponent(`${u.pathname}?${[...u.searchParams.keys()].join("&")}`)
        : "";
      if (
        isUnsubscribeText(textNorm) ||
        EXACT_UNSUBSCRIBE_TEXT_RE.test(textNorm) ||
        (GENERIC_LINK_TEXT_RE.test(textNorm) && isUnsubscribeText(beforeNorm)) ||
        // Plain-text mail: bare URLs have no link text, so the words before them decide.
        (textNorm === "" && isUnsubscribeText(beforeNorm.slice(-60))) ||
        (u !== null && sharesListUnsubscribeTarget(u, targets)) ||
        (u !== null && UNSUBSCRIBE_HREF_RE.test(pathQuery)) ||
        (isMail && /unsubscribe/i.test(href))
      ) {
        facts.hasUnsubscribeLink = true;
      }
    }
    if (
      !facts.hasPreferencesLink &&
      (isPreferencesText(textNorm) ||
        (textNorm === "" && isPreferencesText(beforeNorm.slice(-60))) ||
        (u !== null && PREFERENCES_HREF_RE.test(u.pathname)))
    ) {
      facts.hasPreferencesLink = true;
    }

    if (u) {
      const reg = registrableDomain(u.hostname);
      if (reg && facts.linkDomains.length < MAX_LINK_DOMAINS && !facts.linkDomains.includes(reg))
        facts.linkDomains.push(reg);
      if (
        reg &&
        isClickTrackingUrl(href) &&
        !facts.clickTrackerHosts.includes(reg) &&
        facts.clickTrackerHosts.length < 10
      ) {
        facts.clickTrackerHosts.push(reg);
      }
      const utm = utmFrom(u);
      let campaign = utm.campaign;
      let medium = utm.medium;
      // One level of nested destination (tracking redirects carry the target URL in a parameter).
      if (campaign === null || medium !== "email") {
        for (const v of u.searchParams.values()) {
          if (!/^https?:/i.test(v)) continue;
          const inner = parseHttpUrl(v);
          if (!inner) continue;
          const n = utmFrom(inner);
          campaign = campaign ?? n.campaign;
          if (medium !== "email") medium = n.medium ?? medium;
          break;
        }
      }
      if (facts.utmCampaign === null && campaign) facts.utmCampaign = campaign;
      if (medium === "email") facts.utmMediumEmail = true;
      for (const kind of securityLinkKindsOf(textNorm, `${u.pathname}${u.search}`.toLowerCase())) {
        if (!facts.securityLinkKinds.includes(kind)) facts.securityLinkKinds.push(kind);
      }
    }

    if (link.buttonLike || link.imageAlt) {
      const label = normalizeCtaLabel(link.text.trim() ? link.text : (link.imageAlt ?? ""));
      if (
        label &&
        facts.ctaLabels.length < MAX_CTA_LABELS &&
        !facts.ctaLabels.includes(label) &&
        !isUnsubscribeText(label) &&
        !isPreferencesText(label) &&
        !VIEW_ONLINE_RE.test(label)
      ) {
        facts.ctaLabels.push(label);
      }
    }
  }
  return facts;
}

// ───────────────────────── dates ─────────────────────────

function dateContext(
  parsed: ParsedEmail,
  opts: ExtractContentOptions,
  language: string | null,
): DateContext {
  const host = opts.fromDomain ?? "";
  return {
    receivedAt: opts.receivedAt,
    tzOffsetMinutes: dateHeaderOffsetMinutes(firstHeader(parsed.headers, "date")),
    language,
    dayFirst: DAY_FIRST_TLDS.test(host),
  };
}

function deadlineFrom(
  parsed: ParsedEmail,
  schema: readonly SchemaOrgItem[],
  deals: readonly DealCandidate[],
  textDeadlines: readonly DateCandidate[],
  receivedAt: Date,
): Date | null {
  const lo = receivedAt.getTime() - HOUR;
  const hi = receivedAt.getTime() + 180 * DAY;
  const earliest = (candidates: readonly Date[]): Date | null => {
    let best: Date | null = null;
    for (const c of candidates) {
      const t = c.getTime();
      if (Number.isNaN(t) || t < lo || t > hi) continue;
      if (!best || t < best.getTime()) best = c;
    }
    return best;
  };
  // Structured dates (calendar DTSTART with its TZID, schema.org) are exact; prefer them over
  // text dates, which lack a reliable timezone.
  const structured: Date[] = [];
  if (parsed.calendarStart) structured.push(parsed.calendarStart);
  for (const item of schema) {
    // Event/reservation start and invoice due date (an arrival estimate is not a user deadline).
    for (const key of ["startDate", "paymentDueDate"]) {
      const d = parseSchemaDate(item.fields[key]);
      if (d) structured.push(d);
    }
  }
  const fromStructured = earliest(structured);
  if (fromStructured) return fromStructured;
  const textual: Date[] = [];
  for (const d of deals) if (d.endsAt && d.endsAtConfidence >= 0.4) textual.push(d.endsAt);
  for (const c of textDeadlines) textual.push(c.at);
  return earliest(textual);
}

// ───────────────────────── main ─────────────────────────

/** Extracts static content facts (DESIGN.md §5.5 step 3, §7.6, §7.7; DESIGN-SCORE U1/U3/U4). */
export function extractContent(parsed: ParsedEmail, opts: ExtractContentOptions): ContentExtract {
  const walk: WalkResult = parsed.html
    ? walkHtml(
        parsed.html.length > MAX_EXTRACT_HTML_CHARS
          ? parsed.html.slice(0, MAX_EXTRACT_HTML_CHARS)
          : parsed.html,
      )
    : walkPlainText(parsed.text ?? "");

  const body = collapseKeepingLines(stripInvisible(walk.text));
  const preheaderClean = collapseWhitespace(stripInvisible(walk.preheader)).slice(0, 500);
  const preheader = preheaderClean.length >= 2 ? preheaderClean : null;
  const visibleText = truncateAtWord(preheader ? `${preheader}\n${body}` : body, MAX_VISIBLE_TEXT);

  const wordCount = countWords(body);
  const language = detectLanguage(body, wordCount);
  const links = analyzeLinks(walk.links, parsed);
  const schema = extractSchemaOrg(walk.jsonLd, walk.microdata);

  // Deal/expiry text: subject + preheader + body (NFKC, original case for code matching).
  const dealText = `${parsed.subject ?? ""}\n${preheader ?? ""}\n${body}`
    .normalize("NFKC")
    .slice(0, 30_000);
  const dealTextLower = dealText.toLowerCase();
  const ctx = dateContext(parsed, opts, language);
  const expiries = [
    ...findPhraseExpiries(dealTextLower, ctx),
    ...findKeywordDates(dealText, EXPIRY_KEYWORDS_RE, ctx, 0.8),
  ];
  const deals = extractDeals({
    text: dealText,
    receivedAt: opts.receivedAt,
    language,
    schemaOrg: schema.items,
    referenceNumbers: schema.referenceNumbers,
    expiries,
  });
  const textDeadlines = findKeywordDates(dealText, DEADLINE_KEYWORDS_RE, ctx, 0.7);
  const bodyNorm = normalizeForMatch(body.length > 60_000 ? body.slice(-60_000) : body);

  const tracking: TrackingFacts = {
    pixelCount: walk.pixelCount,
    pixelHosts: walk.pixelHosts,
    clickTrackerHosts: links.clickTrackerHosts,
    utmCampaign: links.utmCampaign,
    utmMediumEmail: links.utmMediumEmail,
  };

  return {
    visibleText,
    preheader,
    wordCount,
    language,
    hasUnsubscribeLink: links.hasUnsubscribeLink,
    linkCount: links.linkCount,
    ctaLabels: links.ctaLabels,
    imageCount: walk.imageCount,
    tracking,
    schemaOrg: schema.items,
    deals,
    deadlineAt: deadlineFrom(parsed, schema.items, deals, textDeadlines, opts.receivedAt),
    postalAddress: hasPostalAddress(body),
    receivingStatement: hasReceivingStatement(bodyNorm),
    simhash: simhash64(walk.skeleton),
    hasPreferencesLink: links.hasPreferencesLink,
    linkDomains: links.linkDomains,
    securityLinkKinds: links.securityLinkKinds,
  };
}
