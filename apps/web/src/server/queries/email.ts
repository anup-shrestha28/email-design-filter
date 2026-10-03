/**
 * Email detail (DESIGN.md §9.5): classification, importance, trust, deals, the Design Score
 * (full result while features are kept, the saved summary after compaction — FREE-TIER.md §5.4),
 * the font profile (derived at read time, DESIGN.md §8.1) and signed viewer URLs (§9.3).
 */
import "server-only";
import { imagesClickToLoad } from "../image-switch";
import { sql } from "@edf/db";
import { raw } from "@edf/db";
import { withUser } from "@edf/db";
import { onDemandPausedReason, renderGovernorOf } from "@edf/budget";
import { effectiveImportance } from "@edf/core";
import type { EmailType, TrustBadge } from "@edf/core/types";
import {
  SCORING_VERSION,
  fontProfile,
  fontProfileFromSummary,
  scoreEmail,
  type DesignFeatures,
  type ScoreResult,
  type ScoreSummary,
} from "@edf/design";
import { verdictOf } from "@/lib/gallery";
import { GALLERY_SIGNALS } from "./gallery";
import { typeGroupOf } from "@/lib/types-display";
import { getPool } from "../db";
import { ON_DEMAND_LIMITS } from "../limits";
import { viewerUrls } from "../viewer-urls";
import { rendererSetUp } from "@/env";
import { RENDERER_NOT_SET_UP, RENDERS_SWITCHED_OFF, type DealView, type EmailDetail } from "./types";

interface DetailRow {
  id: string;
  user_id: string;
  subject: string | null;
  snippet: string | null;
  from_name: string | null;
  from_address: string | null;
  sender_id: string | null;
  sender_domain: string | null;
  list_unsubscribe: { https?: string[]; mailto?: string[] } | null;
  received_at: Date;
  mailbox_address: string;
  label_ids: string[];
  gmail_category: string | null;
  language: string | null;
  primary_type: EmailType;
  subtype: string | null;
  secondary_tags: string[];
  type_source: EmailDetail["classification"]["typeSource"];
  type_confidence: number | null;
  is_subscription: boolean;
  subscription_score: number | null;
  security_sensitive: boolean;
  suspicious: boolean;
  importance: EmailDetail["importance"]["level"];
  importance_score: number | null;
  importance_reasons: string[];
  auth_result: EmailDetail["auth"]["result"];
  esp_platform: string | null;
  one_click_unsubscribe: boolean;
  tracker_count: number;
  utm_campaign: string | null;
  design_status: EmailDetail["design"]["snapshot"]["status"];
  design_source: EmailDetail["design"]["snapshot"]["source"];
  design_ai_state: EmailDetail["design"]["snapshot"]["aiState"];
  design_score: number | null;
  design_band: EmailDetail["design"]["snapshot"]["band"];
  design_provisional: boolean | null;
  design_capped: boolean | null;
  design_issues: EmailDetail["design"]["snapshot"]["issues"];
  design_confidence: EmailDetail["design"]["snapshot"]["confidence"];
  font_source: "none" | "static" | "template" | "render";
  is_unread: boolean;
  opened_in_app_at: Date | null;
  done_at: Date | null;
  pinned_at: Date | null;
  // analysis
  scoring_version: string | null;
  features: DesignFeatures | null;
  score_summary: ScoreSummary | null;
  caps: string[] | null;
  coverage_confidence: number | null;
  /** The gallery's severe-problem facts (queries/gallery.ts GALLERY_SIGNALS). */
  signals: unknown;
  trust: TrustBadge | null;
  render_ref_email_id: string | null;
  analyzed_at: Date | null;
  ref_rendered_at: Date | null;
}

/** Why "Run AI review" is off for suspicious mail (`requestAnalyze` refuses it; DESIGN.md §7.8). */
const SUSPICIOUS_AI_REASON =
  "This email failed sender checks, so it is never sent to AI. Design analysis still works.";

export async function getEmailDetail(
  userId: string,
  emailId: string,
  role: "owner" | "friend",
): Promise<EmailDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(emailId)) return null;
  const pool = await getPool();
  const now = new Date();

  const data = await withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<DetailRow>(sql`
      SELECT e.id, e.user_id, e.subject, e.snippet, e.from_name, e.from_address::text AS from_address, e.sender_id,
             s.domain AS sender_domain, s.list_unsubscribe, e.received_at, m.email_address::text AS mailbox_address,
             e.label_ids, e.gmail_category, e.language, e.primary_type, e.subtype, e.secondary_tags, e.type_source,
             e.type_confidence, e.is_subscription, e.subscription_score, e.security_sensitive, e.suspicious,
             e.importance, e.importance_score, e.importance_reasons, e.auth_result, e.esp_platform,
             e.one_click_unsubscribe, e.tracker_count, e.utm_campaign, e.design_status, e.design_source,
             e.design_ai_state, e.design_score, e.design_band, e.design_provisional, e.design_capped, e.design_issues,
             e.design_confidence, e.font_source, e.is_unread, e.opened_in_app_at, e.done_at, e.pinned_at,
             a.scoring_version, a.features, a.score_summary, a.trust, a.render_ref_email_id, a.analyzed_at,
             a.caps, a.confidence::float8 AS coverage_confidence, ${GALLERY_SIGNALS} AS signals,
             ref.analyzed_at AS ref_rendered_at
      FROM email e
      JOIN mailbox m ON m.id = e.mailbox_id AND m.user_id = e.user_id
      LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      LEFT JOIN email_analysis a ON a.email_id = e.id AND a.user_id = e.user_id
      LEFT JOIN email_analysis ref ON ref.email_id = a.render_ref_email_id AND ref.user_id = e.user_id
      WHERE e.id = ${emailId} AND e.user_id = ${userId}`);
    const row = res.rows[0];
    if (!row) return null;
    const deals = await raw(db).execute<{
      id: string;
      kind: DealView["kind"];
      value: string | null;
      currency: string | null;
      is_up_to: boolean;
      min_spend: string | null;
      code: string | null;
      ends_at: Date | null;
      ends_at_confidence: number | null;
    }>(sql`SELECT id, kind, value, currency, is_up_to, min_spend, code, ends_at, ends_at_confidence
           FROM deal WHERE email_id = ${emailId} AND user_id = ${userId}
           ORDER BY ends_at NULLS LAST, kind`);
    const usage = await raw(db).execute<{ renders: string; reviews: string; queued: string }>(sql`
      SELECT count(*) FILTER (WHERE kind = 'on_demand' AND requested_at >= date_trunc('day', now()) AND error IS DISTINCT FROM 'interrupted') AS renders,
             count(*) FILTER (WHERE want_ai AND requested_at >= date_trunc('day', now()) AND error IS DISTINCT FROM 'interrupted') AS reviews,
             count(*) FILTER (WHERE email_id = ${emailId} AND state IN ('queued', 'running')) AS queued
      FROM render_request WHERE user_id = ${userId}`);
    // The governor, and the owner's emergency stop for renders (`kill.render`; the render step honours it too).
    const settings = await raw(db).execute<{
      governor: Parameters<typeof renderGovernorOf>[0] & Parameters<typeof imagesClickToLoad>[0];
      kill_render: unknown;
    }>(
      sql`SELECT (SELECT value FROM app_setting WHERE key = 'governor') AS governor,
                 (SELECT value FROM app_setting WHERE key = 'kill.render') AS kill_render`,
    );
    const s = settings.rows[0];
    return {
      row,
      deals: deals.rows,
      usage: usage.rows[0],
      governor: s?.governor ?? undefined,
      rendersKilled: s?.kill_render === true,
    };
  });
  if (!data) return null;
  const { row } = data;

  // Design result: recompute from stored features when they're current (pure function, < 5 ms).
  let result: ScoreResult | null = null;
  if (row.features && row.scoring_version === SCORING_VERSION) {
    try {
      result = scoreEmail(row.features, {
        primaryType: row.primary_type,
        isSubscription: row.is_subscription,
        typeConfidence: row.type_confidence,
        subject: row.subject,
        snippet: row.snippet,
        receivedAt: row.received_at,
        now,
        listUnsubscribeHttps: row.list_unsubscribe?.https ?? [],
        senderDomain: row.sender_domain,
        language: row.language,
      });
    } catch {
      result = null; // never break the page over a scoring edge case; the summary still renders
    }
  }
  let fonts: EmailDetail["fonts"] = null;
  try {
    if (row.features && row.font_source !== "none") {
      fonts = fontProfile(row.features.fonts, {
        source: row.font_source === "render" ? "render" : row.font_source,
      });
    } else if (row.score_summary?.fonts) {
      fonts = fontProfileFromSummary(row.score_summary.fonts);
    }
  } catch {
    fonts = null;
  }

  const eff =
    row.importance_score === null
      ? { level: row.importance, reasons: row.importance_reasons }
      : effectiveImportance({ score: row.importance_score, reasons: row.importance_reasons }, now);
  const limits = ON_DEMAND_LIMITS[role];
  const rendersToday = Number(data.usage?.renders ?? 0);
  const reviewsToday = Number(data.usage?.reviews ?? 0);
  // An AI review is an on-demand render too (FREE-TIER.md: "On demand ('Analyze this email' or 'Run
  // AI review')"; requestAnalyze checks both allowances), so it's available only while both have room.
  const rendersLeft = Math.max(0, limits.renders - rendersToday);
  const reviewsLeft = Math.min(rendersLeft, Math.max(0, limits.aiReviews - reviewsToday));
  const renderQueued = Number(data.usage?.queued ?? 0) > 0;
  const designable =
    !row.security_sensitive &&
    row.design_status !== "plain_text" &&
    row.design_status !== "skipped";
  // Paused only matters for an email that could be analysed at all (its own reason wins otherwise).
  const rendersPaused = !designable
    ? null
    : !rendererSetUp()
      ? RENDERER_NOT_SET_UP
      : data.rendersKilled
        ? RENDERS_SWITCHED_OFF
        : onDemandPausedReason(renderGovernorOf(data.governor), role);
  const dmarc = row.trust?.dmarc ?? null;

  return {
    id: row.id,
    subject: row.subject,
    snippet: row.security_sensitive ? null : row.snippet,
    fromName: row.from_name,
    fromAddress: row.from_address,
    senderId: row.sender_id,
    senderDomain: row.sender_domain,
    receivedAt: row.received_at.toISOString(),
    mailboxAddress: row.mailbox_address,
    labels: row.label_ids,
    gmailCategory: row.gmail_category,
    language: row.language,
    classification: {
      primaryType: row.primary_type,
      typeGroup: typeGroupOf(row.primary_type),
      subtype: row.subtype,
      secondaryTags: row.secondary_tags,
      typeSource: row.type_source,
      typeConfidence: row.type_confidence,
      isSubscription: row.is_subscription,
      subscriptionScore: row.subscription_score,
      securitySensitive: row.security_sensitive,
      suspicious: row.suspicious,
    },
    importance: {
      level: eff.level,
      score: row.importance_score,
      reasons: eff.reasons.filter((r) => !r.startsWith("boost:")),
    },
    trust: row.trust,
    auth: { result: row.auth_result, dmarc },
    espPlatform: row.esp_platform,
    deals: data.deals.map((d) => ({
      id: d.id,
      kind: d.kind,
      value: d.value === null ? null : Number(d.value),
      currency: d.currency,
      isUpTo: d.is_up_to,
      minSpend: d.min_spend === null ? null : Number(d.min_spend),
      code: d.code,
      endsAt: d.ends_at?.toISOString() ?? null,
      endsAtConfidence: d.ends_at_confidence,
    })),
    design: {
      snapshot: {
        status: row.design_status,
        source: row.design_source,
        aiState: row.design_ai_state,
        score: row.design_score,
        band: row.design_band,
        provisional: Boolean(row.design_provisional),
        capped: Boolean(row.design_capped),
        issues: row.design_issues,
        confidence: row.design_confidence,
      },
      // The gallery's Good / Okay / Bad word, from exactly the inputs the gallery query uses, so
      // the full analysis page never says "Needs work" where the gallery said "Bad design".
      verdict: verdictOf({
        score: row.design_score,
        band: row.design_band,
        capped: row.design_capped,
        provisional: row.design_provisional,
        caps: row.caps ?? [],
        issues: row.design_issues,
        source: row.design_source,
        coverageConfidence: row.coverage_confidence,
        signals: row.signals,
        // The type now, as the gallery reads it (its unsubscribe rule follows a corrected type).
        primaryType: row.primary_type,
      }),
      result,
      summary: row.score_summary,
      renderRef:
        row.render_ref_email_id && row.ref_rendered_at
          ? { emailId: row.render_ref_email_id, renderedAt: row.ref_rendered_at.toISOString() }
          : null,
      analyzedAt: row.analyzed_at?.toISOString() ?? null,
      // Kept in the summary after compaction empties `features` (migration 0016).
      layout: row.features?.render?.layout ?? row.score_summary?.layout ?? null,
    },
    fonts,
    viewer: viewerUrls(userId, row.id),
    imagesClickToLoad: imagesClickToLoad(data.governor, role),
    unsubscribe: {
      https: row.list_unsubscribe?.https?.[0] ?? null,
      mailto: row.list_unsubscribe?.mailto?.[0] ?? null,
      oneClick: row.one_click_unsubscribe,
    },
    state: {
      isUnread: row.is_unread,
      openedInAppAt: row.opened_in_app_at?.toISOString() ?? null,
      doneAt: row.done_at?.toISOString() ?? null,
      pinnedAt: row.pinned_at?.toISOString() ?? null,
    },
    actions: {
      canAnalyze: designable && !rendersPaused && !renderQueued && rendersLeft > 0,
      canRunAiReview:
        designable && !rendersPaused && !row.suspicious && !renderQueued && reviewsLeft > 0,
      analyzeRemainingToday: rendersLeft,
      aiReviewRemainingToday: reviewsLeft,
      renderQueued,
      reason: !designable
        ? row.security_sensitive
          ? "Security emails are never rendered or sent to AI."
          : "Plain-text emails have no design to analyse."
        : rendersPaused,
      aiReason: designable && row.suspicious ? SUSPICIOUS_AI_REASON : null,
      rendersPaused,
    },
    trackerCount: row.tracker_count,
    utmCampaign: row.utm_campaign,
  };
}
