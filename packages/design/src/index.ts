/**
 * `@edf/design` — the Email Design Score engine (DESIGN-SCORE.md v1.1 + FREE-TIER.md §5).
 * Pure TypeScript, no network, deterministic.
 */
export * from "./types";

// Versions and constants
export { SCORING_VERSION, FEATURES_VERSION, METHODOLOGY_VERSION } from "./version";
export * from "./constants";

// Feature schemas (validate untrusted features with `.safeParse`)
export { staticDesignFeaturesSchema, COMPAT_FEATURES, type CompatFeature } from "./features/static";
export {
  renderFeaturesSchema,
  contrastGroupSchema,
  primaryCtaSchema,
  TEXT_ROLES,
  RENDER_PASSES,
  type ContrastGroup,
  type PrimaryCta,
  type TextRole,
} from "./features/render";
export {
  fontFeaturesSchema,
  fontsStaticSchema,
  usedFontsSchema,
  type FontsStatic,
  type UsedFonts,
  type UsedStack,
  type FontDeclaration,
} from "./features/fonts";

// Static extraction (ingest)
export { extractStaticDesign, type StaticContext, type StaticExtraction } from "./static/extract";

// Font engine (DESIGN.md §8.1)
export {
  fontProfile,
  fontSummary,
  fontProfileFromSummary,
  fontCardLines,
  webFontCompat,
  type WebFontCompat,
} from "./fonts/profile";
export {
  analyzeStack,
  parseFamilyList,
  NO_FONT_SET,
  SYSTEM_UI,
  DEFAULT_SENTINEL,
} from "./fonts/normalize";
export { CLIENT_RULES, CLIENT_TABLE_VERSION, resolveStack } from "./fonts/clients";
export { CATALOG_VERSION, lookupFamily, metricGroup, looseKey, matchKey } from "./fonts/catalog";

// Scoring
export {
  scoreEmail,
  scoreEmailDetailed,
  bandOf,
  confidenceBandOf,
  isProvisional,
  CHECK_FUNCTIONS,
} from "./scoring/score";
export {
  summarizeScore,
  summaryLayout,
  summarySignals,
  buildDesignFeatures,
  inheritFromTemplate,
  templateMatch,
  templateMatchDetails,
  type TemplateMatchDetails,
} from "./scoring/summary";
export {
  CHECKS,
  PILLAR_META,
  AI_MAX_POINTS,
  WEIGHTS_VERSION,
  CONFIDENCE_VERSION,
  type CheckDef,
  type CheckGroup,
} from "./scoring/weights";
export { CAP_LIMITS, CAP_ISSUE } from "./scoring/caps";
export {
  excellenceGate,
  EXCELLENCE_CEILING,
  HEADLINE_CREDIT_MIN,
  PHONE_PROBLEM_SHARE,
  type ExcellenceGate,
  type ExcellenceMiss,
} from "./scoring/excellence";
export { footerApplies, ACTION_TYPES } from "./scoring/applicability";
export { staticChips } from "./scoring/chips";

// AI review (the pipeline makes the calls)
export {
  AI_MODEL,
  AI_REGIONS,
  AI_OUTPUT_JSON_SCHEMA,
  AI_OUTPUT_CONFIG,
  AI_MAX_TOKENS,
  aiReviewOutputSchema,
  parseReviewOutput,
  toAiReview,
  sanitizeJsonSchema,
  type AiReviewOutput,
} from "./ai/schema";
export { REVIEW_SYSTEM_PROMPT, PROMPT_HASH } from "./ai/prompt";
export {
  buildReviewUserContent,
  sniffImageType,
  type ReviewInput,
  type ReviewContentBlock,
  type ImageBlock,
  type TextBlock,
} from "./ai/content";
export {
  stripEvidence,
  prescanInjection,
  applyAiGuards,
  hierarchyProxies,
  type GuardResult,
  type CrossCheck,
} from "./ai/guards";

// Renderer HTML preparation (also available as `@edf/design/render-kit`)
export {
  stampByteOffsets,
  prepareRenderDocument,
  RenderInputError,
  MAX_DOM_NODES,
  MAX_HTML_BYTES,
} from "./render-kit/html";
