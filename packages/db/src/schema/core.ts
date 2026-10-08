/**
 * Tenant tables (RLS-forced) and the global invite table — mirrors migrations/0002_core.sql.
 * The SQL migrations are the source of truth; `test/schema-drift.test.ts` fails if this file
 * and the database disagree on any table, column, type or nullability.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, citext, tsvector } from "./types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);

export const betaAllowlist = pgTable("beta_allowlist", {
  email: citext("email").primaryKey(),
  role: text("role").$type<"owner" | "friend">().notNull().default("friend"),
  invitedBy: text("invited_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  usedAt: ts("used_at"),
});

export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  role: text("role").$type<"owner" | "friend">().notNull().default("friend"),
  timezone: text("timezone").notNull().default("UTC"),
  aiProcessingConsentAt: ts("ai_processing_consent_at"),
  loadImagesForAnalysis: boolean("load_images_for_analysis").notNull().default(true),
  linkCheckOptIn: boolean("link_check_opt_in").notNull().default(false),
  screenshotRetentionDays: integer("screenshot_retention_days").notNull().default(30),
  backfillWindowDays: integer("backfill_window_days").$type<30 | 90 | 180>().notNull().default(90),
  digestFrequency: text("digest_frequency").notNull().default("daily"),
  lastActiveAt: ts("last_active_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type MailboxStatus = "connecting" | "active" | "needs_reauth" | "paused" | "disconnecting";
export type BackfillState = "pending" | "running" | "done" | "failed";

export const mailbox = pgTable("mailbox", {
  id: id(),
  userId: text("user_id").notNull(),
  provider: text("provider").$type<"gmail" | "outlook">().notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  emailAddress: citext("email_address").notNull(),
  status: text("status").$type<MailboxStatus>().notNull().default("connecting"),
  statusReason: text("status_reason"),
  grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'`),
  dekWrapped: bytea("dek_wrapped"),
  kekVersion: text("kek_version").notNull().default("keys:v1"),
  kmsKeyName: text("kms_key_name"),
  refreshTokenEnc: bytea("refresh_token_enc"),
  accessTokenEnc: bytea("access_token_enc"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshLeaseUntil: ts("refresh_lease_until"),
  /** uint64 cursor as a decimal string; compare in SQL only. */
  historyId: numeric("history_id", { precision: 20, scale: 0 }),
  resyncPending: boolean("resync_pending").notNull().default(false),
  pollIncomplete: boolean("poll_incomplete").notNull().default(false),
  nextPollAt: ts("next_poll_at"),
  syncLeaseUntil: ts("sync_lease_until"),
  watchExpiresAt: ts("watch_expires_at"),
  lastPushAt: ts("last_push_at"),
  lastSyncedAt: ts("last_synced_at"),
  needsReauthSince: ts("needs_reauth_since"),
  backfillState: text("backfill_state").$type<BackfillState>().notNull().default("pending"),
  backfillGeneration: integer("backfill_generation").notNull().default(0),
  backfillRequestedAt: ts("backfill_requested_at"),
  backfillProgress: jsonb("backfill_progress").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const gmailQuota = pgTable("gmail_quota", {
  mailboxId: uuid("mailbox_id").primaryKey(),
  userId: text("user_id").notNull(),
  tokens: real("tokens").notNull().default(5500),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type FrequencyBand = "daily" | "several_weekly" | "weekly" | "monthly" | "rare";

export const sender = pgTable("sender", {
  id: id(),
  userId: text("user_id").notNull(),
  address: citext("address").notNull(),
  displayName: text("display_name"),
  domain: text("domain").notNull(),
  espPlatform: text("esp_platform"),
  espMta: text("esp_mta"),
  firstSeenAt: ts("first_seen_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  seenBeforeWindow: boolean("seen_before_window"),
  emailCount: integer("email_count").notNull().default(0),
  unreadCount: integer("unread_count").notNull().default(0),
  emailsPerWeek: real("emails_per_week"),
  frequencyBand: text("frequency_band").$type<FrequencyBand>(),
  readRate60d: real("read_rate_60d"),
  typeDistribution: jsonb("type_distribution").$type<Record<string, number>>().notNull().default({}),
  primaryType: text("primary_type"),
  typeOverride: text("type_override"),
  oneClickUnsubscribe: boolean("one_click_unsubscribe"),
  listUnsubscribe: jsonb("list_unsubscribe").$type<{ https: string[]; mailto: string[] }>(),
  unsubscribedAt: ts("unsubscribed_at"),
  authSummary: jsonb("auth_summary").$type<Record<string, unknown>>(),
  avgDesignScore: real("avg_design_score"),
  brandProfile: jsonb("brand_profile").$type<Record<string, unknown>>(),
  userImportanceBias: smallint("user_importance_bias").notNull().default(0),
  muted: boolean("muted").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const emailTemplate = pgTable("email_template", {
  id: id(),
  userId: text("user_id").notNull(),
  senderId: uuid("sender_id").notNull(),
  /** Signed 64-bit simhash as a JS bigint. */
  simhash: bigint("simhash", { mode: "bigint" }).notNull(),
  firstSeenAt: ts("first_seen_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  emailCount: integer("email_count").notNull().default(1),
  seenCount: integer("seen_count").notNull().default(1),
  aiReview: jsonb("ai_review").$type<unknown>(),
  aiModel: text("ai_model"),
  aiReviewedAt: ts("ai_reviewed_at"),
  aiSourceEmailId: uuid("ai_source_email_id"),
  exemplarEmailId: uuid("exemplar_email_id"),
  exemplarRenderedAt: ts("exemplar_rendered_at"),
  classification: jsonb("classification").$type<unknown>(),
  classifiedBy: text("classified_by"),
  classifiedAt: ts("classified_at"),
});

export type DesignStatus = "pending" | "done" | "failed" | "skipped" | "plain_text";
export type DesignSource = "none" | "static" | "template" | "render";
export type DesignAiState =
  | "pending"
  | "queued"
  | "done"
  | "from_template"
  | "flagged"
  | "failed"
  | "not_applicable";

export const email = pgTable("email", {
  id: id(),
  userId: text("user_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull(),
  senderId: uuid("sender_id"),
  templateId: uuid("template_id"),
  providerMessageId: text("provider_message_id").notNull(),
  providerThreadId: text("provider_thread_id"),
  gmailHistoryId: numeric("gmail_history_id", { precision: 20, scale: 0 }).notNull(),
  receivedAt: ts("received_at").notNull(),
  subject: text("subject"),
  fromAddress: citext("from_address"),
  fromName: text("from_name"),
  snippet: text("snippet"),
  labelIds: text("label_ids").array().notNull().default(sql`'{}'`),
  isUnread: boolean("is_unread").notNull().default(true),
  openedInAppAt: ts("opened_in_app_at"),
  doneAt: ts("done_at"),
  pinnedAt: ts("pinned_at"),
  isStarred: boolean("is_starred").notNull().default(false),
  gmailImportant: boolean("gmail_important").notNull().default(false),
  gmailCategory: text("gmail_category").$type<
    "promotions" | "updates" | "social" | "forums" | "personal"
  >(),
  inTrash: boolean("in_trash").notNull().default(false),
  inSpam: boolean("in_spam").notNull().default(false),
  senderMuted: boolean("sender_muted").notNull().default(false),
  isHidden: boolean("is_hidden").generatedAlwaysAs(sql`(in_trash OR in_spam OR sender_muted)`),
  sizeBytes: integer("size_bytes"),
  htmlBytes: integer("html_bytes"),
  language: text("language"),
  securitySensitive: boolean("security_sensitive").notNull().default(false),
  isSubscription: boolean("is_subscription").notNull(),
  subscriptionScore: smallint("subscription_score"),
  primaryType: text("primary_type").notNull(),
  subtype: text("subtype"),
  secondaryTags: text("secondary_tags").array().notNull().default(sql`'{}'`),
  typeConfidence: real("type_confidence"),
  typeSource: text("type_source")
    .$type<"rule" | "sender_prior" | "template_cache" | "llm" | "user" | "pending">()
    .notNull(),
  importance: text("importance").$type<"high" | "normal" | "low">().notNull().default("normal"),
  importanceScore: smallint("importance_score"),
  importanceReasons: text("importance_reasons").array().notNull().default(sql`'{}'`),
  importanceExpiresAt: ts("importance_expires_at"),
  listId: text("list_id"),
  oneClickUnsubscribe: boolean("one_click_unsubscribe").notNull().default(false),
  authResult: text("auth_result").$type<"pass" | "fail" | "none" | "unknown">().notNull().default("unknown"),
  suspicious: boolean("suspicious").notNull().default(false),
  espPlatform: text("esp_platform"),
  trackerCount: smallint("tracker_count").notNull().default(0),
  utmCampaign: text("utm_campaign"),
  designStatus: text("design_status").$type<DesignStatus>().notNull().default("pending"),
  designSource: text("design_source").$type<DesignSource>().notNull().default("none"),
  designAiState: text("design_ai_state").$type<DesignAiState>().notNull().default("pending"),
  designScore: smallint("design_score"),
  designBand: text("design_band").$type<"excellent" | "good" | "needs_work" | "poor">(),
  designCapped: boolean("design_capped"),
  designProvisional: boolean("design_provisional"),
  designIssues: text("design_issues").array().notNull().default(sql`'{}'`),
  designConfidence: text("design_confidence").$type<"high" | "medium" | "low">(),
  fontSource: text("font_source").$type<DesignSource>().notNull().default("none"),
  fontFamilies: text("font_families").array().notNull().default(sql`'{}'`),
  usesWebFonts: boolean("uses_web_fonts").notNull().default(false),
  hasDeal: boolean("has_deal").notNull().default(false),
  dealHasCode: boolean("deal_has_code").notNull().default(false),
  dealEndsAt: ts("deal_ends_at"),
  searchTsv: tsvector("search_tsv").notNull().default(sql`''::tsvector`),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const emailAnalysis = pgTable("email_analysis", {
  emailId: uuid("email_id").primaryKey(),
  userId: text("user_id").notNull(),
  scoringVersion: text("scoring_version").notNull(),
  rendererVersion: text("renderer_version"),
  features: jsonb("features").$type<unknown>(),
  checks: jsonb("checks").$type<unknown[]>().notNull(),
  pillarScores: jsonb("pillar_scores").$type<unknown>().notNull(),
  rawScore: real("raw_score"),
  caps: text("caps").array().notNull().default(sql`'{}'`),
  confidence: real("confidence").notNull(),
  aiReview: jsonb("ai_review").$type<unknown>(),
  aiModel: text("ai_model"),
  trust: jsonb("trust").$type<unknown>(),
  scoreSummary: jsonb("score_summary").$type<unknown>(),
  featuresCompactedAt: ts("features_compacted_at"),
  renderRefEmailId: uuid("render_ref_email_id"),
  rendererHost: text("renderer_host"),
  chromiumVersion: text("chromium_version"),
  screenshotKeys: jsonb("screenshot_keys").$type<Record<string, string>>(),
  screenshotsFullUntil: ts("screenshots_full_until"),
  renderMs: integer("render_ms"),
  error: text("error"),
  analyzedAt: ts("analyzed_at").notNull().defaultNow(),
});

export const deal = pgTable("deal", {
  id: id(),
  emailId: uuid("email_id").notNull(),
  userId: text("user_id").notNull(),
  senderId: uuid("sender_id"),
  kind: text("kind")
    .$type<"percent_off" | "amount_off" | "bogo" | "free_shipping" | "gift" | "other">()
    .notNull(),
  value: numeric("value", { precision: 10, scale: 2, mode: "number" }),
  currency: text("currency"),
  isUpTo: boolean("is_up_to").notNull().default(false),
  minSpend: numeric("min_spend", { precision: 10, scale: 2, mode: "number" }),
  code: text("code"),
  startsAt: ts("starts_at"),
  endsAt: ts("ends_at"),
  endsAtConfidence: real("ends_at_confidence"),
  source: text("source").$type<"jsonld" | "regex" | "llm">().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type LedgerState = "pending" | "pending_full" | "stored" | "skipped" | "failed";
export type LedgerSource = "backfill" | "sync" | "resync" | "reconcile";

export const messageLedger = pgTable(
  "message_ledger",
  {
    mailboxId: uuid("mailbox_id").notNull(),
    userId: text("user_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    state: text("state").$type<LedgerState>().notNull(),
    reason: text("reason"),
    source: text("source").$type<LedgerSource>().notNull(),
    attempts: smallint("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    pendingLabelDelta: jsonb("pending_label_delta").$type<{
      add: string[];
      remove: string[];
    }>(),
    deltaHistoryId: numeric("delta_history_id", { precision: 20, scale: 0 }),
    classifierVersion: text("classifier_version"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.providerMessageId] })],
);

export const syncRun = pgTable("sync_run", {
  id: id(),
  userId: text("user_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull(),
  kind: text("kind").$type<"backfill" | "incremental" | "reconcile" | "resync">().notNull(),
  status: text("status").$type<"running" | "done" | "failed" | "cancelled">().notNull(),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  workflowRunId: text("workflow_run_id"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

export const savedView = pgTable("saved_view", {
  id: id(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  sort: text("sort").notNull().default("received_desc"),
  position: integer("position").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** A user's own collection of saved designs (0018). Names are unique per user, ignoring case. */
export const board = pgTable("board", {
  id: id(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** One saved design in one board; goes with its email and with its board (0018). */
export const boardItem = pgTable(
  "board_item",
  {
    boardId: uuid("board_id").notNull(),
    userId: text("user_id").notNull(),
    emailId: uuid("email_id").notNull(),
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.emailId] })],
);

/** A finished gallery card, reused while its key matches (0019; apps/web server/view-source.ts). */
export const cardViewCache = pgTable(
  "card_view_cache",
  {
    emailId: uuid("email_id").notNull(),
    userId: text("user_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    html: text("html").notNull(),
    height: integer("height").notNull(),
    imageBytesMinted: bigint("image_bytes_minted", { mode: "number" }).notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.emailId, t.userId] })],
);

export const userFeedback = pgTable("user_feedback", {
  id: id(),
  userId: text("user_id").notNull(),
  emailId: uuid("email_id"),
  senderId: uuid("sender_id"),
  field: text("field")
    .$type<"primary_type" | "importance" | "is_subscription" | "is_personal" | "design_disagree">()
    .notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const reviewShare = pgTable("review_share", {
  emailId: uuid("email_id").primaryKey(),
  userId: text("user_id").notNull(),
  reason: text("reason").$type<"design_disagree" | "support">().notNull(),
  sharedAt: ts("shared_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

export const llmUsage = pgTable("llm_usage", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  purpose: text("purpose")
    .$type<"classify" | "design_review" | "copy_review" | "deal_verify">()
    .notNull(),
  model: text("model").notNull(),
  batch: boolean("batch").notNull().default(false),
  requests: integer("requests").notNull().default(0),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
});

export const llmBudget = pgTable(
  "llm_budget",
  {
    userId: text("user_id").notNull(),
    scope: text("scope").$type<"day" | "month">().notNull(),
    day: date("day", { mode: "string" }).notNull(),
    reservedUsd: numeric("reserved_usd", { precision: 10, scale: 4, mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope, t.day] })],
);

export const dataRequest = pgTable("data_request", {
  id: id(),
  userId: text("user_id").notNull(),
  kind: text("kind").$type<"export" | "delete_account" | "disconnect_purge">().notNull(),
  status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
  resultBlobKey: text("result_blob_key"),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
});

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id"),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const blobGc = pgTable("blob_gc", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id").notNull(),
  pathname: text("pathname").notNull(),
  enqueuedAt: ts("enqueued_at").notNull().defaultNow(),
});

export type RenderKind = "on_demand" | "exemplar" | "fill";
export type RenderState = "queued" | "running" | "done" | "failed";

export const renderRequest = pgTable("render_request", {
  id: id(),
  userId: text("user_id").notNull(),
  emailId: uuid("email_id").notNull(),
  kind: text("kind").$type<RenderKind>().notNull(),
  state: text("state").$type<RenderState>().notNull().default("queued"),
  wantAi: boolean("want_ai").notNull().default(false),
  attempts: smallint("attempts").notNull().default(0),
  error: text("error"),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const aiBatchItem = pgTable("ai_batch_item", {
  customId: text("custom_id").primaryKey(),
  batchId: uuid("batch_id").notNull(),
  userId: text("user_id").notNull(),
  /** NULL once the email is deleted: the item stays so it is still settled (0011). */
  emailId: uuid("email_id"),
  templateId: uuid("template_id"),
  purpose: text("purpose").$type<"design_review" | "classify">().notNull(),
  reservedUsd: numeric("reserved_usd", { precision: 10, scale: 4, mode: "number" }).notNull().default(0),
  settledUsd: numeric("settled_usd", { precision: 10, scale: 4, mode: "number" }),
  /** UTC day of the reservation; settle_llm settles against it (0009). */
  reservedDay: date("reserved_day", { mode: "string" }).notNull(),
  /** Design review: the submit-time injection pre-scan of subject + visible text hit (0014). */
  injectionHit: boolean("injection_hit").notNull().default(false),
});
