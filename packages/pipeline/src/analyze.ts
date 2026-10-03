/**
 * Analysis of one fetched message: PURE (no I/O). Given the parsed MIME, Gmail metadata and the
 * user/sender context looked up beforehand, decide skip vs store and build the complete
 * EmailRecord (DESIGN.md §5.5 steps 1–4, §7; FREE-TIER.md §4.6, §5.4).
 */
import {
  analyzeHeaders,
  buildSearchText,
  buildTrustBadge,
  classifyAutomated,
  classifyType,
  computeImportance,
  detectSecuritySensitive,
  extractContent,
  redactSensitive,
} from "@edf/core";
import type {
  ContentExtract,
  EmailType,
  GmailMessageMeta,
  HeaderFacts,
  LedgerSkipReason,
  ParsedEmail,
  SenderPrior,
  TrustBadge,
} from "@edf/core/types";
import {
  SCORING_VERSION,
  extractStaticDesign,
  fontProfile,
  inheritFromTemplate,
  scoreEmail,
  summarizeScore,
  templateMatch,
  type DesignFeatures,
  type ScoreResult,
} from "@edf/design";
import type { AnalysisRecord, EmailRecord } from "./store/record";

export const FEATURES_VERSION = 1;

/**
 * `design_ai_state` for analysed features (FREE-TIER.md §5.4): a review with an injection-pattern
 * hit or the model's own injection flag is "flagged" whatever its source (an inherited template
 * review keeps the sample's flags); otherwise "from_template" or "done" by source. Shared by
 * ingest (template inheritance) and `designColumnsFor` (render, template upgrade, AI result).
 */
export function designAiStateOf(ai: DesignFeatures["ai"]): EmailRecord["designAiState"] {
  if (!ai) return "pending";
  if (ai.injectionPatternHit || ai.flags.suspected_prompt_injection) return "flagged";
  return ai.source === "template" ? "from_template" : "done";
}

export interface TemplateContext {
  /** Cached LLM classification for (sender, template). */
  classification: { primaryType: EmailType; subtype: string | null } | null;
  /** The template's rendered sample, when it is < 60 days old and its features are kept. */
  exemplar: { emailId: string; renderedAt: Date; features: DesignFeatures } | null;
  /** Emails already seen for this template (for the "repeats" subscription signal). */
  seenCount: number;
}

export interface AnalyzeInput {
  parsed: ParsedEmail;
  meta: GmailMessageMeta;
  mailboxId: string;
  userId: string;
  /** Addresses of the user's connected mailboxes (lower-case). */
  userAddresses: string[];
  prior: SenderPrior | null;
  /** The user said mail from this sender is personal ("This is personal"). */
  senderBlockedPersonal: boolean;
  /** Result of the personal-override check (5-unit messages.list), when it was run. */
  priorContact: boolean | null;
  template: TemplateContext | null;
  now: Date;
}

export type AnalyzeResult =
  | { kind: "skip"; reason: LedgerSkipReason }
  | {
      kind: "store";
      record: EmailRecord;
      /** Classification left to Claude (type_source = 'pending'). */
      needsLlm: boolean;
      /** Ask for a Gmail "in:sent to:" check before trusting a personal/automated decision. */
      needsPriorContactCheck: boolean;
      score: ScoreResult | null;
    };

function skipByLabels(labels: readonly string[]): LedgerSkipReason | null {
  if (labels.includes("SENT")) return "sent";
  if (labels.includes("DRAFT")) return "draft";
  if (labels.includes("CHAT")) return "chat";
  if (labels.includes("SPAM")) return "spam";
  return null;
}

export interface Prepared {
  headers: HeaderFacts;
  content: ContentExtract;
  /** Lower-cased From address (sender key), or null. */
  fromAddress: string | null;
  /** Template identity for designable mail, else null. */
  simhash: string | null;
  /**
   * Static design extraction, memoised by `analyzeMessage`: the drain may analyse one message twice
   * (after a prior-contact check) and the extraction is the costly, input-only part.
   */
  staticDesign?: ReturnType<typeof extractStaticDesign>;
}

/**
 * Phase 1 (pure): label/self/auto-reply skips, header facts and content extraction — everything
 * needed to look up the sender prior and template context before classification.
 */
export function prepareMessage(
  parsed: ParsedEmail,
  meta: GmailMessageMeta,
  userAddresses: string[],
): { kind: "skip"; reason: LedgerSkipReason } | { kind: "ok"; prepared: Prepared } {
  const labelSkip = skipByLabels(meta.labelIds);
  if (labelSkip) return { kind: "skip", reason: labelSkip };
  const headers = analyzeHeaders(parsed, { userAddresses });
  if (headers.fromSelf) return { kind: "skip", reason: "sent" };
  if (headers.autoSubmitted === "auto-replied") return { kind: "skip", reason: "auto_reply" };
  const content = extractContent(parsed, { receivedAt: meta.internalDate, userAddresses, fromDomain: headers.fromDomain });
  return {
    kind: "ok",
    prepared: {
      headers,
      content,
      fromAddress: parsed.from?.address?.toLowerCase() ?? null,
      simhash: parsed.html ? content.simhash : null,
    },
  };
}

/** Phase 2 (pure): classification, importance, trust and design; returns skip or the record to store. */
export function analyzeMessage(input: AnalyzeInput, preparedIn?: Prepared): AnalyzeResult {
  const { parsed, meta, now } = input;
  let prepared = preparedIn;
  if (!prepared) {
    const p = prepareMessage(parsed, meta, input.userAddresses);
    if (p.kind === "skip") return p;
    prepared = p.prepared;
  }
  const { headers, content } = prepared;
  const receivedAt = meta.internalDate;
  const automated = classifyAutomated({
    parsed,
    headers,
    content,
    labelIds: meta.labelIds,
    priorContact: input.priorContact,
    senderTemplateRepeats: (input.template?.seenCount ?? 0) >= 1,
  });
  if (input.senderBlockedPersonal) return { kind: "skip", reason: "personal" };
  if (!automated.automated) {
    return { kind: "skip", reason: automated.skipReason ?? "personal" };
  }

  const security = detectSecuritySensitive({ parsed, content, headers });
  const type = classifyType({
    parsed,
    headers,
    content,
    labelIds: meta.labelIds,
    security,
    prior: input.prior,
    templateClassification: input.template?.classification ?? null,
  });
  const importance = computeImportance({
    primaryType: type.primaryType,
    subtype: type.subtype,
    typeSource: type.typeSource,
    securitySensitive: security.securitySensitive,
    suspicious: headers.suspicious,
    authResult: headers.authResult,
    labelIds: meta.labelIds,
    receivedAt,
    now,
    deals: content.deals,
    deadlineAt: content.deadlineAt,
    prior: input.prior,
  });

  const sensitive = security.securitySensitive;
  const subject = parsed.subject === null ? null : sensitive ? redactSensitive(parsed.subject) : parsed.subject;
  const fromAddress = parsed.from?.address ?? null;
  const fromName = parsed.from?.name ?? null;
  const trust: TrustBadge = buildTrustBadge({
    headers,
    content,
    isSubscription: automated.isSubscription,
    primaryType: type.primaryType,
    visibleUnsubscribe: content.hasUnsubscribeLink,
  });

  // ── design (never for security-sensitive or plain-text mail) ──
  let design: Pick<
    EmailRecord,
    | "designStatus"
    | "designSource"
    | "designAiState"
    | "designScore"
    | "designBand"
    | "designCapped"
    | "designProvisional"
    | "designIssues"
    | "designConfidence"
    | "fontSource"
    | "fontFamilies"
    | "usesWebFonts"
  > = {
    designStatus: sensitive ? "skipped" : parsed.html ? "pending" : "plain_text",
    designSource: "none",
    designAiState: "not_applicable",
    designScore: null,
    designBand: null,
    designCapped: null,
    designProvisional: null,
    designIssues: [],
    designConfidence: null,
    fontSource: "none",
    fontFamilies: [],
    usesWebFonts: false,
  };
  let analysis: AnalysisRecord | null = null;
  let score: ScoreResult | null = null;
  let simhash: string | null = null;

  if (!sensitive && parsed.html) {
    simhash = content.simhash;
    // Depends only on the message (same `prepared` → same input), so a second analysis reuses it.
    const extracted = (prepared.staticDesign ??= extractStaticDesign(parsed.html, {
      htmlBytes: parsed.htmlBytes,
      subject: parsed.subject,
      listUnsubscribeHttps: headers.listUnsubscribe?.https ?? [],
      senderDomain: headers.fromDomain,
      language: content.language,
    }));
    let features: DesignFeatures = {
      v: FEATURES_VERSION,
      static: extracted.static,
      render: null,
      renderSource: "none",
      renderRef: null,
      fonts: extracted.fonts,
      ai: null,
    };
    const ex = input.template?.exemplar;
    if (ex && now.getTime() - ex.renderedAt.getTime() < 60 * 86_400_000 && templateMatch(ex.features, features)) {
      features = inheritFromTemplate(ex.features, { static: extracted.static, fonts: extracted.fonts }, {
        emailId: ex.emailId,
        renderedAt: ex.renderedAt.toISOString(),
      });
    }
    score = scoreEmail(features, {
      primaryType: type.primaryType,
      isSubscription: automated.isSubscription,
      typeConfidence: type.typeConfidence,
      subject: parsed.subject,
      snippet: meta.snippet,
      receivedAt,
      now,
      listUnsubscribeHttps: headers.listUnsubscribe?.https ?? [],
      senderDomain: headers.fromDomain,
      language: content.language,
    });
    const coverage = features.renderSource === "template" ? "template" : "static";
    const profile = fontProfile(features.fonts, { source: coverage });
    design = {
      designStatus: "done",
      designSource: coverage,
      designAiState: coverage === "template" ? designAiStateOf(features.ai) : "pending",
      designScore: score.score,
      designBand: score.band,
      designCapped: score.score === null ? null : score.capped,
      designProvisional: score.score === null ? null : score.provisional,
      designIssues: score.issues,
      designConfidence: score.score === null ? null : score.confidenceBand,
      fontSource: coverage,
      fontFamilies: profile.fontFamilies.slice(0, 12),
      usesWebFonts: profile.usesWebFonts,
    };
    analysis = {
      scoringVersion: SCORING_VERSION,
      rendererVersion: null,
      features,
      checks: score.checks,
      pillarScores: score.pillars,
      rawScore: score.raw,
      caps: score.caps,
      confidence: score.confidence,
      trust,
      scoreSummary: summarizeScore(score, profile, features.render ?? null),
      aiReview: features.ai,
      aiModel: features.ai?.model ?? null,
      renderRefEmailId: features.renderRef?.emailId ?? null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    };
  } else if (!sensitive) {
    // Plain text: keep the trust badge for the Senders page and the detail view.
    analysis = null;
  }

  const record: EmailRecord = {
    mailboxId: input.mailboxId,
    userId: input.userId,
    providerMessageId: meta.id,
    providerThreadId: meta.threadId,
    historyId: meta.historyId,
    receivedAt,
    subject,
    fromAddress,
    fromName,
    snippet: sensitive ? null : meta.snippet,
    labelIds: meta.labelIds,
    sizeBytes: meta.sizeEstimate,
    htmlBytes: parsed.html ? parsed.htmlBytes : null,
    language: content.language,
    securitySensitive: sensitive,
    isSubscription: automated.isSubscription,
    subscriptionScore: automated.subscriptionScore,
    primaryType: type.primaryType,
    subtype: type.subtype,
    secondaryTags: type.secondaryTags,
    typeConfidence: type.typeConfidence,
    typeSource: type.typeSource,
    importance: importance.level,
    importanceScore: importance.score,
    importanceReasons: importance.reasons,
    importanceExpiresAt: importance.expiresAt,
    listId: headers.listId,
    oneClickUnsubscribe: headers.oneClick,
    authResult: headers.authResult,
    suspicious: headers.suspicious,
    espPlatform: headers.espPlatform,
    trackerCount: sensitive ? 0 : content.tracking.pixelCount,
    utmCampaign: sensitive ? null : content.tracking.utmCampaign,
    ...design,
    deals: sensitive ? [] : content.deals,
    searchText: buildSearchText({
      subject,
      fromName,
      fromAddress,
      excerpt: sensitive ? "" : content.visibleText,
      securitySensitive: sensitive,
    }),
    sender: {
      address: (fromAddress ?? "unknown@invalid").toLowerCase(),
      displayName: fromName,
      domain: headers.fromDomain ?? (fromAddress?.split("@")[1] ?? "invalid"),
      espPlatform: headers.espPlatform,
      listUnsubscribe: headers.listUnsubscribe,
      oneClick: headers.oneClick,
      authSummary: { trust: trust.state, dmarc: trust.dmarc, oneClick: trust.oneClick },
    },
    templateSimhash: simhash,
    analysis: analysis ?? (sensitive || !parsed.html ? plainAnalysis(trust) : null),
  };
  return {
    kind: "store",
    record,
    needsLlm: type.needsLlm,
    needsPriorContactCheck: automated.needsPriorContactCheck && input.priorContact === null,
    score,
  };
}

/**
 * The record as stored while Neon storage is at the governor's `noAnalysisRows` stage (≥ 300 MB,
 * FREE-TIER.md §8.3): no analysis row and no search text, and the design columns back to "not
 * analysed" (a score without its analysis would have nothing behind it on the email page).
 */
export function withoutAnalysisRows(record: EmailRecord): EmailRecord {
  return {
    ...record,
    analysis: null,
    searchText: "",
    designStatus: record.designStatus === "done" ? "pending" : record.designStatus,
    designSource: "none",
    designAiState: "not_applicable",
    designScore: null,
    designBand: null,
    designCapped: null,
    designProvisional: null,
    designIssues: [],
    designConfidence: null,
    fontSource: "none",
    fontFamilies: [],
    usesWebFonts: false,
  };
}

/** Security-sensitive and plain-text mail keep only the trust badge (no design analysis). */
function plainAnalysis(trust: TrustBadge): AnalysisRecord {
  return {
    scoringVersion: SCORING_VERSION,
    rendererVersion: null,
    features: null,
    checks: [],
    pillarScores: [],
    rawScore: null,
    caps: [],
    confidence: 0,
    trust,
    scoreSummary: null,
    aiReview: null,
    aiModel: null,
    renderRefEmailId: null,
    rendererHost: null,
    chromiumVersion: null,
    renderMs: null,
  };
}
