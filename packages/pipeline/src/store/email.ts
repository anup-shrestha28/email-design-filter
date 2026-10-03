/**
 * Transactional store for one email (DESIGN.md §5.5 steps 5–6; DATA-MODEL.md §5). Must run inside
 * `withUser(pool, record.userId, …)`; one message = one transaction, so a failure never leaves a
 * half-written email and never affects other messages.
 */
import type { PoolClient } from "@edf/db";
import { applyLabelDelta, labelColumns, type AnalysisRecord, type EmailRecord } from "./record";

export interface StoreResult {
  emailId: string;
  senderId: string;
  templateId: string | null;
  /** True when this call created the email row (aggregates were incremented). */
  inserted: boolean;
  /** The template already had a rendered exemplar (template-level scoring is possible). */
  templateExemplar: { emailId: string; renderedAt: Date } | null;
  templateSeenCount: number;
}

const COVERAGE_RANK: Record<string, number> = { none: 0, static: 1, template: 2, render: 3 };

async function upsertSender(c: PoolClient, r: EmailRecord): Promise<{ id: string }> {
  const s = r.sender;
  const res = await c.query<{ id: string }>(
    `INSERT INTO sender (user_id, address, display_name, domain, esp_platform, first_seen_at, last_seen_at,
                         one_click_unsubscribe, list_unsubscribe, auth_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)
     ON CONFLICT (user_id, address) DO UPDATE SET
       display_name          = CASE WHEN EXCLUDED.last_seen_at >= sender.last_seen_at
                                    THEN coalesce(EXCLUDED.display_name, sender.display_name) ELSE sender.display_name END,
       esp_platform          = coalesce(EXCLUDED.esp_platform, sender.esp_platform),
       first_seen_at         = least(sender.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at          = greatest(sender.last_seen_at, EXCLUDED.last_seen_at),
       one_click_unsubscribe = CASE WHEN EXCLUDED.last_seen_at >= sender.last_seen_at
                                    THEN EXCLUDED.one_click_unsubscribe ELSE sender.one_click_unsubscribe END,
       list_unsubscribe      = CASE WHEN EXCLUDED.last_seen_at >= sender.last_seen_at
                                    THEN coalesce(EXCLUDED.list_unsubscribe, sender.list_unsubscribe) ELSE sender.list_unsubscribe END,
       auth_summary          = CASE WHEN EXCLUDED.last_seen_at >= sender.last_seen_at
                                    THEN EXCLUDED.auth_summary ELSE sender.auth_summary END,
       updated_at            = now()
     RETURNING id`,
    [
      r.userId,
      s.address,
      s.displayName,
      s.domain,
      s.espPlatform,
      r.receivedAt,
      s.oneClick,
      s.listUnsubscribe ? JSON.stringify(s.listUnsubscribe) : null,
      JSON.stringify(s.authSummary),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error("sender upsert returned no row");
  return row;
}

/** Template matching under a transaction-scoped advisory lock (works with Neon's pooler). */
async function matchTemplate(
  c: PoolClient,
  r: EmailRecord,
  senderId: string,
): Promise<{ id: string; exemplar: StoreResult["templateExemplar"]; seenCount: number } | null> {
  if (r.templateSimhash === null) return null;
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [senderId]);
  const found = await c.query<{ id: string; exemplar_email_id: string | null; exemplar_rendered_at: Date | null }>(
    `SELECT id, exemplar_email_id, exemplar_rendered_at FROM email_template
     WHERE sender_id = $1 AND bit_count((simhash # $2::bigint)::bit(64)) <= 3
     ORDER BY bit_count((simhash # $2::bigint)::bit(64)), last_seen_at DESC LIMIT 1`,
    [senderId, r.templateSimhash],
  );
  const hit = found.rows[0];
  if (hit) {
    return {
      id: hit.id,
      exemplar:
        hit.exemplar_email_id && hit.exemplar_rendered_at
          ? { emailId: hit.exemplar_email_id, renderedAt: hit.exemplar_rendered_at }
          : null,
      seenCount: 0, // filled after the email insert (counts only real inserts)
    };
  }
  const ins = await c.query<{ id: string }>(
    `INSERT INTO email_template (user_id, sender_id, simhash, first_seen_at, last_seen_at, email_count, seen_count)
     VALUES ($1, $2, $3::bigint, $4, $4, 0, 0)
     ON CONFLICT (sender_id, simhash) DO UPDATE SET last_seen_at = greatest(email_template.last_seen_at, EXCLUDED.last_seen_at)
     RETURNING id`,
    [r.userId, senderId, r.templateSimhash, r.receivedAt],
  );
  const row = ins.rows[0];
  if (!row) throw new Error("template insert returned no row");
  return { id: row.id, exemplar: null, seenCount: 0 };
}

export async function storeEmail(c: PoolClient, r: EmailRecord): Promise<StoreResult> {
  const stored = await ingest(c, r, false);
  if (!stored) throw new Error("storeEmail: nothing stored");
  return stored;
}

/**
 * The drain's store: like `storeEmail`, but only while the message is still in the ledger. Returns
 * null (and stores nothing) when a poll deleted its ledger row meanwhile, i.e. the message was
 * deleted in Gmail between the drain's fetch and this store.
 */
export async function storeQueuedEmail(c: PoolClient, r: EmailRecord): Promise<StoreResult | null> {
  return ingest(c, r, true);
}

async function ingest(c: PoolClient, r: EmailRecord, requireLedger: boolean): Promise<StoreResult | null> {
  // The ledger row is locked FIRST and held until commit. applyPollDelta takes the same lock before
  // it looks for the email row, stashes a label delta or deletes the message, so a poll running
  // alongside either finished before this read (its stash is applied below; a deletion leaves no
  // row) or waits and then sees the committed email (and updates it). Neither is ever lost.
  // A label change seen before the row existed is applied if it is newer (DESIGN.md §5.6 step 5).
  const ledger = await c.query<{ pending_label_delta: { add: string[]; remove: string[] } | null; delta_history_id: string | null }>(
    `SELECT pending_label_delta, delta_history_id::text FROM message_ledger
     WHERE mailbox_id = $1 AND provider_message_id = $2 FOR UPDATE`,
    [r.mailboxId, r.providerMessageId],
  );
  if (requireLedger && !ledger.rows[0]) return null;
  const sender = await upsertSender(c, r);
  const template = await matchTemplate(c, r, sender.id);

  let labels = r.labelIds;
  let historyId = r.historyId;
  const pend = ledger.rows[0];
  if (pend?.pending_label_delta && pend.delta_history_id && BigInt(pend.delta_history_id) > BigInt(r.historyId)) {
    labels = applyLabelDelta(labels, pend.pending_label_delta.add ?? [], pend.pending_label_delta.remove ?? []);
    historyId = pend.delta_history_id;
  }
  const flags = labelColumns(labels);

  // Race-safe upsert: an older fetch never overwrites a newer state; user corrections and app-local
  // triage state are never overwritten by a re-ingest.
  const res = await c.query<{ id: string; inserted: boolean }>(
    `INSERT INTO email AS e (
       user_id, mailbox_id, sender_id, template_id, provider_message_id, provider_thread_id, gmail_history_id,
       received_at, subject, from_address, from_name, snippet, label_ids, is_unread, is_starred, gmail_important,
       gmail_category, in_trash, in_spam, sender_muted, size_bytes, html_bytes, language, security_sensitive,
       is_subscription, subscription_score, primary_type, subtype, secondary_tags, type_confidence, type_source,
       importance, importance_score, importance_reasons, importance_expires_at, list_id, one_click_unsubscribe,
       auth_result, suspicious, esp_platform, tracker_count, utm_campaign, design_status, design_source,
       design_ai_state, design_score, design_band, design_capped, design_provisional, design_issues,
       design_confidence, font_source, font_families, uses_web_fonts, has_deal, deal_has_code, deal_ends_at, search_tsv)
     VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             (SELECT muted FROM sender WHERE id = $3),
             $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,
             $45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56, to_tsvector('simple', $57))
     ON CONFLICT (mailbox_id, provider_message_id) DO UPDATE SET
       sender_id = EXCLUDED.sender_id, template_id = EXCLUDED.template_id,
       provider_thread_id = EXCLUDED.provider_thread_id, gmail_history_id = EXCLUDED.gmail_history_id,
       received_at = EXCLUDED.received_at, subject = EXCLUDED.subject, from_address = EXCLUDED.from_address,
       from_name = EXCLUDED.from_name, snippet = EXCLUDED.snippet, label_ids = EXCLUDED.label_ids,
       is_unread = EXCLUDED.is_unread, is_starred = EXCLUDED.is_starred, gmail_important = EXCLUDED.gmail_important,
       gmail_category = EXCLUDED.gmail_category, in_trash = EXCLUDED.in_trash, in_spam = EXCLUDED.in_spam,
       size_bytes = EXCLUDED.size_bytes, html_bytes = EXCLUDED.html_bytes, language = EXCLUDED.language,
       security_sensitive = EXCLUDED.security_sensitive, is_subscription = EXCLUDED.is_subscription,
       subscription_score = EXCLUDED.subscription_score,
       primary_type   = CASE WHEN e.type_source = 'user' THEN e.primary_type ELSE EXCLUDED.primary_type END,
       subtype        = CASE WHEN e.type_source = 'user' THEN e.subtype ELSE EXCLUDED.subtype END,
       secondary_tags = EXCLUDED.secondary_tags,
       type_confidence= CASE WHEN e.type_source = 'user' THEN e.type_confidence ELSE EXCLUDED.type_confidence END,
       type_source    = CASE WHEN e.type_source = 'user' THEN e.type_source ELSE EXCLUDED.type_source END,
       importance = EXCLUDED.importance, importance_score = EXCLUDED.importance_score,
       importance_reasons = EXCLUDED.importance_reasons, importance_expires_at = EXCLUDED.importance_expires_at,
       list_id = EXCLUDED.list_id, one_click_unsubscribe = EXCLUDED.one_click_unsubscribe,
       auth_result = EXCLUDED.auth_result, suspicious = EXCLUDED.suspicious, esp_platform = EXCLUDED.esp_platform,
       tracker_count = EXCLUDED.tracker_count, utm_campaign = EXCLUDED.utm_campaign,
       has_deal = EXCLUDED.has_deal, deal_has_code = EXCLUDED.deal_has_code, deal_ends_at = EXCLUDED.deal_ends_at,
       -- An empty search text means "stored without analysis" (storage stage at 300 MB, FREE-TIER.md §8.3):
       -- a re-ingest then keeps the search text the email already has instead of wiping it.
       search_tsv = CASE WHEN $57 = '' THEN e.search_tsv ELSE EXCLUDED.search_tsv END, updated_at = now()
     WHERE e.gmail_history_id <= EXCLUDED.gmail_history_id
     RETURNING id, (xmax = 0) AS inserted`,
    [
      r.userId, r.mailboxId, sender.id, template?.id ?? null, r.providerMessageId, r.providerThreadId, historyId,
      r.receivedAt, r.subject, r.fromAddress, r.fromName, r.snippet, labels, flags.isUnread, flags.isStarred,
      flags.gmailImportant, flags.gmailCategory, flags.inTrash, flags.inSpam,
      r.sizeBytes, r.htmlBytes, r.language, r.securitySensitive, r.isSubscription,
      r.subscriptionScore === null ? null : Math.max(-32768, Math.min(32767, Math.round(r.subscriptionScore))),
      r.primaryType, r.subtype, r.secondaryTags, r.typeConfidence, r.typeSource, r.importance,
      Math.max(0, Math.min(100, Math.round(r.importanceScore))), r.importanceReasons, r.importanceExpiresAt, r.listId,
      r.oneClickUnsubscribe, r.authResult, r.suspicious, r.espPlatform, Math.min(32767, r.trackerCount), r.utmCampaign,
      r.designStatus, r.designSource, r.designAiState, r.designScore, r.designBand, r.designCapped, r.designProvisional,
      r.designIssues, r.designConfidence, r.fontSource, r.fontFamilies.slice(0, 12), r.usesWebFonts,
      r.deals.length > 0, r.deals.some((d) => d.code !== null), latestDealEnd(r), r.searchText.slice(0, 4000),
    ],
  );

  let emailId: string;
  let inserted: boolean;
  const row = res.rows[0];
  if (row) {
    emailId = row.id;
    inserted = row.inserted;
  } else {
    // The stored row is newer (a later history id already applied): keep it, but still finish the ledger.
    const existing = await c.query<{ id: string }>(
      "SELECT id FROM email WHERE mailbox_id = $1 AND provider_message_id = $2",
      [r.mailboxId, r.providerMessageId],
    );
    const ex = existing.rows[0];
    if (!ex) throw new Error("email upsert conflict without an existing row");
    emailId = ex.id;
    inserted = false;
  }

  let templateSeenCount = 0;
  if (inserted) {
    await c.query(
      `UPDATE sender SET email_count = email_count + 1,
              unread_count = unread_count + $2::int,
              type_distribution = jsonb_set(type_distribution, ARRAY[$3::text],
                to_jsonb(coalesce((type_distribution->>$3)::int, 0) + 1)),
              updated_at = now()
       WHERE id = $1`,
      [sender.id, flags.isUnread ? 1 : 0, r.primaryType],
    );
    if (template) {
      const t = await c.query<{ seen_count: number }>(
        `UPDATE email_template SET email_count = email_count + 1, seen_count = seen_count + 1,
                last_seen_at = greatest(last_seen_at, $2) WHERE id = $1 RETURNING seen_count`,
        [template.id, r.receivedAt],
      );
      templateSeenCount = t.rows[0]?.seen_count ?? 0;
    }
  }

  // Deals: replace-set semantics with the dedupe key (LLM-verified deals are kept).
  await c.query("DELETE FROM deal WHERE email_id = $1 AND source <> 'llm'", [emailId]);
  for (const d of r.deals) {
    await c.query(
      `INSERT INTO deal (email_id, user_id, sender_id, kind, value, currency, is_up_to, min_spend, code, starts_at,
                         ends_at, ends_at_confidence, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT ON CONSTRAINT deal_dedupe DO NOTHING`,
      [
        emailId, r.userId, sender.id, d.kind, d.value, d.currency, d.isUpTo, d.minSpend, d.code?.slice(0, 64) ?? null,
        d.startsAt, d.endsAt, d.endsAtConfidence, d.source,
      ],
    );
  }

  if (r.analysis) await upsertAnalysis(c, emailId, r, false);

  await c.query(
    `UPDATE message_ledger SET state = 'stored', reason = NULL, pending_label_delta = NULL, delta_history_id = NULL,
            attempts = 0, next_attempt_at = NULL, updated_at = now()
     WHERE mailbox_id = $1 AND provider_message_id = $2`,
    [r.mailboxId, r.providerMessageId],
  );

  return {
    emailId,
    senderId: sender.id,
    templateId: template?.id ?? null,
    inserted,
    templateExemplar: template?.exemplar ?? null,
    templateSeenCount,
  };
}

function latestDealEnd(r: EmailRecord): Date | null {
  let latest: Date | null = null;
  for (const d of r.deals) if (d.endsAt && (!latest || d.endsAt > latest)) latest = d.endsAt;
  return latest;
}

export type DesignColumns = Pick<
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
>;

/**
 * Save an analysis produced after ingest (own render, template upgrade, AI review) together with
 * the denormalized design columns. `force` allows replacing a higher coverage (on-demand re-render).
 */
export async function saveAnalysis(
  c: PoolClient,
  p: { emailId: string; userId: string; analysis: AnalysisRecord; design: DesignColumns; force?: boolean },
): Promise<boolean> {
  const r = { userId: p.userId, analysis: p.analysis, ...p.design } as EmailRecord;
  return upsertAnalysis(c, p.emailId, r, p.force ?? false);
}

/**
 * Never downgrade an analysis: a render beats a template inheritance, which beats static checks.
 * The trust badge is built only at ingest (analyze.ts); a later render, template upgrade or AI
 * review has none (`trust: null`) and keeps the stored badge, like `ai_review`.
 */
async function upsertAnalysis(c: PoolClient, emailId: string, r: EmailRecord, force = false): Promise<boolean> {
  const a = r.analysis;
  if (!a) return false;
  const current = await c.query<{ design_source: string }>("SELECT design_source FROM email WHERE id = $1", [emailId]);
  const existingRank = COVERAGE_RANK[current.rows[0]?.design_source ?? "none"] ?? 0;
  const newRank = COVERAGE_RANK[r.designSource] ?? 0;
  const hasAnalysis = await c.query("SELECT 1 FROM email_analysis WHERE email_id = $1", [emailId]);
  if (!force && hasAnalysis.rowCount && newRank < existingRank) {
    // A re-ingest still restores a badge an older build overwrote with JSON null (only ingest builds it).
    if (a.trust) {
      await c.query(
        "UPDATE email_analysis SET trust = $2 WHERE email_id = $1 AND (trust IS NULL OR jsonb_typeof(trust) = 'null')",
        [emailId, JSON.stringify(a.trust)],
      );
    }
    return false;
  }
  await c.query(
    `INSERT INTO email_analysis (email_id, user_id, scoring_version, renderer_version, features, checks, pillar_scores,
       raw_score, caps, confidence, ai_review, ai_model, trust, score_summary, render_ref_email_id, renderer_host,
       chromium_version, render_ms, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
     ON CONFLICT (email_id) DO UPDATE SET
       scoring_version = EXCLUDED.scoring_version, renderer_version = EXCLUDED.renderer_version,
       features = EXCLUDED.features, checks = EXCLUDED.checks, pillar_scores = EXCLUDED.pillar_scores,
       raw_score = EXCLUDED.raw_score, caps = EXCLUDED.caps, confidence = EXCLUDED.confidence,
       ai_review = coalesce(EXCLUDED.ai_review, email_analysis.ai_review),
       ai_model = coalesce(EXCLUDED.ai_model, email_analysis.ai_model),
       trust = coalesce(EXCLUDED.trust, email_analysis.trust), score_summary = EXCLUDED.score_summary,
       render_ref_email_id = EXCLUDED.render_ref_email_id, renderer_host = EXCLUDED.renderer_host,
       chromium_version = EXCLUDED.chromium_version, render_ms = EXCLUDED.render_ms,
       features_compacted_at = NULL, analyzed_at = now()`,
    [
      emailId, r.userId, a.scoringVersion, a.rendererVersion, JSON.stringify(a.features), JSON.stringify(a.checks),
      JSON.stringify(a.pillarScores), a.rawScore, a.caps, a.confidence, a.aiReview ? JSON.stringify(a.aiReview) : null,
      a.aiModel, a.trust ? JSON.stringify(a.trust) : null, JSON.stringify(a.scoreSummary), a.renderRefEmailId, a.rendererHost,
      a.chromiumVersion, a.renderMs,
    ],
  );
  // Design columns follow the analysis (email upsert above leaves them alone on conflict).
  await c.query(
    `UPDATE email SET design_status = $2, design_source = $3, design_ai_state = $4, design_score = $5, design_band = $6,
            design_capped = $7, design_provisional = $8, design_issues = $9, design_confidence = $10,
            font_source = $11, font_families = $12, uses_web_fonts = $13, updated_at = now()
     WHERE id = $1`,
    [
      emailId, r.designStatus, r.designSource, r.designAiState, r.designScore, r.designBand, r.designCapped,
      r.designProvisional, r.designIssues, r.designConfidence, r.fontSource, r.fontFamilies.slice(0, 12), r.usesWebFonts,
    ],
  );
  return true;
}
