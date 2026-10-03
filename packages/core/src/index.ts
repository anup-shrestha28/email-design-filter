/**
 * @edf/core — the ingest core: MIME parsing, header analysis, content extraction,
 * classification, importance, deals, tracking, trust badge, search text, the image/tracking
 * policy and the LLM-classification request pieces (DESIGN.md §5–§7, FREE-TIER.md §4.6).
 * Everything is pure and synchronous except `parseMime`; nothing touches the network.
 */
export * from "./types";

// MIME
export { MIME_LIMITS, MimeParseError, parseMime } from "./mime/parse";
export type { MimeParseErrorCode, ParseMimeOptions } from "./mime/parse";

// Headers
export { analyzeHeaders, isFromAligned, isSuspicious, summarizeAuth } from "./headers/analyze";
export type { AnalyzeHeadersOptions } from "./headers/analyze";
export { parseAuthenticationResults, TRUSTED_AUTHSERV_ID } from "./headers/auth-results";
export { parseDkimSignature } from "./headers/dkim";
export type { DkimSignatureInfo } from "./headers/dkim";
export { isOneClick, ONE_CLICK_POST_VALUE, parseListUnsubscribe } from "./headers/list-unsubscribe";
export { NEWSLETTER_PLATFORMS } from "./headers/esp";
export { canonicalMailbox, FREEMAIL_DOMAINS, isNoReplyLocalPart } from "./headers/lists";

// Content
export {
  extractContent,
  MAX_EXTRACT_HTML_CHARS,
  MAX_VISIBLE_TEXT,
  normalizeCtaLabel,
} from "./content/extract";
export type { ExtractContentOptions } from "./content/extract";
export {
  extractDeals,
  looksLikeReferenceNumber,
  parseAmount,
  resolveCurrency,
} from "./content/deals";
export { countWords, detectLanguage } from "./content/language";
export { hasPostalAddress } from "./content/postal";

// Classification
export {
  AUTOMATED_THRESHOLD,
  classifyAutomated,
  decideSubscription,
  SUBSCRIPTION_THRESHOLD,
  SUBSCRIPTION_WEIGHTS,
} from "./classify/automated";
export type { ClassifyAutomatedInput } from "./classify/automated";
export { detectSecuritySensitive } from "./classify/security";
export type { SecurityInput } from "./classify/security";
export { classifyType, CONFIDENT, PRIOR_MIN_EMAILS, PRIOR_MIN_SHARE } from "./classify/type";
export type { ClassifyTypeInput } from "./classify/type";
export {
  computeImportance,
  effectiveImportance,
  HIGH_THRESHOLD,
  importanceLevel,
  LOW_THRESHOLD,
} from "./classify/importance";
export { buildTrustBadge } from "./classify/trust";
export type { TrustBadgeInput } from "./classify/trust";
export { isTokenBearingUrl, redactSensitive } from "./classify/redact";
export { buildSearchText, MAX_SEARCH_TEXT } from "./classify/search";
export type { SearchTextInput } from "./classify/search";
export {
  ALL_SUBTYPES,
  buildClassifyUserContent,
  LLM_CLASSIFY_MAX_TOKENS,
  LLM_CLASSIFY_MODEL,
  LLM_CLASSIFY_SYSTEM_PROMPT,
  LLM_MAX_VISIBLE_TEXT,
  LlmEligibilityError,
  llmClassificationJsonSchema,
  llmClassificationSchema,
  llmTypeNeedsDmarc,
  parseLlmClassification,
} from "./classify/llm";
export type { ClassifyUserContentInput } from "./classify/llm";

// Policy (also available as "@edf/core/policy")
export {
  extractImageRefs,
  imageFetchDecision,
  imagesAllowedFor,
  isClickTrackerHost,
  isClickTrackingUrl,
  isPerRecipientUrl,
  isPixelPath,
  isTrackerHost,
  isTrackingPixel,
  looksLikeRecipientToken,
} from "./policy";
export type { ImageAttrs, ImageDecision, ImageRef } from "./policy";

// Utilities useful to the pipeline (template matching)
export { simhash64, simhashDistance } from "./util/hash";
export { registrableDomain } from "./util/domain";
