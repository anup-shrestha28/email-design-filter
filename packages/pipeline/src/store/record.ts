/**
 * The complete set of values written for one stored email. Produced by the (pure) analysis step
 * and consumed by the (transactional) store step, so each side can be tested alone.
 */
import type { AuthResult, DealCandidate, EmailType, GmailCategory, Importance, TypeSource } from "@edf/core/types";

export type DesignSource = "none" | "static" | "template" | "render";

export interface SenderFacts {
  /** Lower-cased address. */
  address: string;
  displayName: string | null;
  /** Registrable domain. */
  domain: string;
  espPlatform: string | null;
  listUnsubscribe: { https: string[]; mailto: string[] } | null;
  oneClick: boolean;
  /** Small, content-free summary (trust state, dmarc) for the Senders page. */
  authSummary: Record<string, unknown>;
}

export interface AnalysisRecord {
  scoringVersion: string;
  rendererVersion: string | null;
  features: unknown;
  checks: unknown[];
  pillarScores: unknown;
  rawScore: number | null;
  caps: string[];
  confidence: number;
  trust: unknown;
  scoreSummary: unknown;
  aiReview: unknown | null;
  aiModel: string | null;
  renderRefEmailId: string | null;
  rendererHost: string | null;
  chromiumVersion: string | null;
  renderMs: number | null;
}

export interface EmailRecord {
  mailboxId: string;
  userId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  /** Message.historyId (uint64 decimal string). */
  historyId: string;
  receivedAt: Date;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  /** NULL for security-sensitive mail. */
  snippet: string | null;
  labelIds: string[];
  sizeBytes: number | null;
  htmlBytes: number | null;
  language: string | null;
  securitySensitive: boolean;
  isSubscription: boolean;
  subscriptionScore: number | null;
  primaryType: EmailType;
  subtype: string | null;
  secondaryTags: string[];
  typeConfidence: number | null;
  typeSource: TypeSource;
  importance: Importance;
  importanceScore: number;
  importanceReasons: string[];
  importanceExpiresAt: Date | null;
  listId: string | null;
  oneClickUnsubscribe: boolean;
  authResult: AuthResult;
  suspicious: boolean;
  espPlatform: string | null;
  trackerCount: number;
  utmCampaign: string | null;
  designStatus: "pending" | "done" | "failed" | "skipped" | "plain_text";
  designSource: DesignSource;
  designAiState: "pending" | "queued" | "done" | "from_template" | "flagged" | "failed" | "not_applicable";
  designScore: number | null;
  designBand: "excellent" | "good" | "needs_work" | "poor" | null;
  designCapped: boolean | null;
  designProvisional: boolean | null;
  designIssues: string[];
  designConfidence: "high" | "medium" | "low" | null;
  fontSource: DesignSource;
  fontFamilies: string[];
  usesWebFonts: boolean;
  deals: DealCandidate[];
  /** Text for search_tsv (subject + sender + excerpt; subject + sender only for security mail). Never stored. */
  searchText: string;
  sender: SenderFacts;
  /** Template identity (signed 64-bit simhash, decimal string), or null when not designable. */
  templateSimhash: string | null;
  analysis: AnalysisRecord | null;
}

/** Gmail label ids → the flag columns (DESIGN.md §5.6 step 5). */
export function labelColumns(labelIds: readonly string[]): {
  isUnread: boolean;
  isStarred: boolean;
  gmailImportant: boolean;
  inTrash: boolean;
  inSpam: boolean;
  gmailCategory: GmailCategory | null;
} {
  const has = (l: string) => labelIds.includes(l);
  const category: GmailCategory | null = has("CATEGORY_PROMOTIONS")
    ? "promotions"
    : has("CATEGORY_UPDATES")
      ? "updates"
      : has("CATEGORY_SOCIAL")
        ? "social"
        : has("CATEGORY_FORUMS")
          ? "forums"
          : has("CATEGORY_PERSONAL")
            ? "personal"
            : null;
  return {
    isUnread: has("UNREAD"),
    isStarred: has("STARRED"),
    gmailImportant: has("IMPORTANT"),
    inTrash: has("TRASH"),
    inSpam: has("SPAM"),
    gmailCategory: category,
  };
}

/** Apply a label delta (adds then removes), keeping order stable and unique. */
export function applyLabelDelta(labels: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const out = labels.filter((l) => !remove.includes(l));
  for (const l of add) if (!out.includes(l) && !remove.includes(l)) out.push(l);
  return out;
}
