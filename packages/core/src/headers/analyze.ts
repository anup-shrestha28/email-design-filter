/**
 * `analyzeHeaders`: every header-derived fact the classifier and the trust badge need
 * (DESIGN.md §7.2, §7.6, §7.8; DESIGN-SCORE §9). Pure and synchronous.
 */
import type { AuthFacts, AuthResult, HeaderFacts, ParsedEmail } from "../types";
import { domainOfAddress, hostOfUrl, localPartOf, registrableDomain } from "../util/domain";
import { allHeaders, firstHeader, hasHeader, hasHeaderPrefix } from "../util/headers";
import { collapseWhitespace, safeSlice } from "../util/text";
import { parseAuthenticationResults } from "./auth-results";
import { parseDkimSignatures } from "./dkim";
import { detectEsp } from "./esp";
import { isOneClick, parseListUnsubscribe } from "./list-unsubscribe";
import { canonicalMailbox, FREEMAIL_DOMAINS, isNoReplyLocalPart } from "./lists";

export interface AnalyzeHeadersOptions {
  /** The user's own addresses (primary + aliases), any case. */
  userAddresses: readonly string[];
}

/**
 * Summary for `email.auth_result`. `pass` means **DMARC pass** — deliberately strict, because
 * the importance guardrail (§7.3) keys on it. `fail` = DMARC fail, or (no DMARC verdict and)
 * DKIM failed with no passing signature, or SPF hard-failed with no passing DKIM.
 */
export function summarizeAuth(auth: AuthFacts): AuthResult {
  if (!auth.found) return "unknown";
  if (auth.dmarc === "pass") return "pass";
  if (auth.dmarc === "fail") return "fail";
  if (auth.dkim === "fail") return "fail";
  if (auth.spf === "fail" && auth.dkim !== "pass") return "fail";
  return "none";
}

/** From domain aligned (relaxed, registrable) with a passing DKIM domain or a passing SPF domain. */
export function isFromAligned(auth: AuthFacts, fromDomain: string | null): boolean {
  if (!fromDomain) return false;
  if (auth.dkimPassDomains.includes(fromDomain)) return true;
  return auth.spf === "pass" && auth.spfMailFromDomain === fromDomain;
}

/** DESIGN.md §7.8: DMARC fail AND From not aligned AND no arc=pass (trusted header only). */
export function isSuspicious(auth: AuthFacts, fromDomain: string | null): boolean {
  return (
    auth.found && auth.dmarc === "fail" && !isFromAligned(auth, fromDomain) && auth.arc !== "pass"
  );
}

function parsePrecedence(v: string | null): HeaderFacts["precedence"] {
  const t = v?.trim().toLowerCase().split(/[\s;]/)[0];
  return t === "bulk" || t === "list" || t === "junk" ? t : null;
}

function parseAutoSubmitted(v: string | null): HeaderFacts["autoSubmitted"] {
  const t = v
    ?.trim()
    .toLowerCase()
    .split(/[\s;(]/)[0];
  return t === "auto-generated" || t === "auto-replied" || t === "auto-notified" ? t : null;
}

function parseListId(v: string | null): string | null {
  if (!v) return null;
  const inner = /<([^<>]{1,255})>/.exec(v)?.[1];
  const id = collapseWhitespace(inner ?? v).toLowerCase();
  return id.length > 0 ? safeSlice(id, 255) : null;
}

function bracketedAddressDomain(v: string | null): string | null {
  if (!v) return null;
  const inner = /<([^<>]{0,320})>/.exec(v)?.[1] ?? v;
  return domainOfAddress(inner.trim());
}

function mailingListSoftware(p: ParsedEmail): string | null {
  const h = p.headers;
  if (hasHeader(h, "x-mailman-version") || hasHeader(h, "x-mailman-rule-misses")) return "Mailman";
  if (hasHeader(h, "x-google-group-id") || hasHeader(h, "x-google-loop")) return "Google Groups";
  if (hasHeaderPrefix(h, "x-discourse-")) return "Discourse";
  if (hasHeader(h, "x-beenthere")) return "Mailing list";
  if (hasHeader(h, "x-listserver") || hasHeader(h, "x-listprocessor-version")) return "Listserv";
  const listId = firstHeader(h, "list-id")?.toLowerCase() ?? "";
  if (listId.includes("groups.io")) return "groups.io";
  if (listId.includes("googlegroups.com")) return "Google Groups";
  if (hasHeader(h, "mailing-list")) return "Mailing list";
  return null;
}

/** Derives `HeaderFacts` from a parsed message (DESIGN.md §7.2, §7.8; DESIGN-SCORE §9). */
export function analyzeHeaders(parsed: ParsedEmail, opts: AnalyzeHeadersOptions): HeaderFacts {
  const h = parsed.headers;
  const auth = parseAuthenticationResults(allHeaders(h, "authentication-results"));
  const signatures = parseDkimSignatures(allHeaders(h, "dkim-signature"));
  const listUnsubscribe = parseListUnsubscribe(firstHeader(h, "list-unsubscribe"));
  const oneClick = isOneClick(
    listUnsubscribe,
    firstHeader(h, "list-unsubscribe-post"),
    signatures,
    auth.dkimPassDomains,
  );

  const fromAddress = parsed.from?.address ?? null;
  const fromHost = domainOfAddress(fromAddress);
  const fromDomain = registrableDomain(fromHost) ?? fromHost;

  const feedbackRaw = firstHeader(h, "feedback-id");
  const feedbackId = feedbackRaw ? safeSlice(collapseWhitespace(feedbackRaw), 255) || null : null;
  const mailer = firstHeader(h, "x-mailer") ?? firstHeader(h, "user-agent");
  const returnPathDomain = bracketedAddressDomain(firstHeader(h, "return-path"));
  const messageIdDomain = bracketedAddressDomain(parsed.messageId);

  const domains: Array<{ host: string | null; weight: number }> = [
    { host: returnPathDomain, weight: 2 },
    { host: messageIdDomain, weight: 1 },
  ];
  for (const sig of signatures) domains.push({ host: sig.domain, weight: 2 });
  for (const uri of listUnsubscribe?.https ?? []) domains.push({ host: hostOfUrl(uri), weight: 2 });
  for (const uri of listUnsubscribe?.mailto ?? []) {
    domains.push({ host: domainOfAddress(uri.slice(7).split("?")[0] ?? ""), weight: 2 });
  }
  const esp = detectEsp({ headers: h, domains, feedbackId, mailer });

  const dkimSelectors = [
    ...new Set(signatures.map((s) => s.selector).filter((s): s is string => !!s)),
  ].slice(0, 10);
  // Klaviyo transactional/service streams sign with kt*/ks* selectors (RESEARCH-NOTES).
  const klaviyoTransactional =
    esp.platform === "Klaviyo" && dkimSelectors.some((s) => /^k[ts]\d+$/.test(s));

  const users = new Set(opts.userAddresses.map(canonicalMailbox));
  const recipients = [...parsed.to, ...parsed.cc];
  const deliveredByBcc =
    users.size > 0 && !recipients.some((r) => users.has(canonicalMailbox(r.address)));
  const fromSelf = fromAddress !== null && users.has(canonicalMailbox(fromAddress));

  return {
    listUnsubscribe,
    oneClick,
    listId: parseListId(firstHeader(h, "list-id")),
    feedbackId,
    precedence: parsePrecedence(firstHeader(h, "precedence")),
    autoSubmitted: parseAutoSubmitted(firstHeader(h, "auto-submitted")),
    auth,
    authResult: summarizeAuth(auth),
    suspicious: isSuspicious(auth, fromDomain),
    espPlatform: esp.platform,
    fromDomain,
    isNoReply: fromAddress !== null && isNoReplyLocalPart(localPartOf(fromAddress)),
    deliveredByBcc,
    isFreemailSender: fromDomain !== null && FREEMAIL_DOMAINS.has(fromDomain),
    fromSelf,
    dkimSelectors,
    espMta: esp.mta,
    espTransactional: esp.transactional || klaviyoTransactional,
    listPost: hasHeader(h, "list-post"),
    mailingListSoftware: mailingListSoftware(parsed),
  };
}
