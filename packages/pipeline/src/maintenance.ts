/**
 * Per-user maintenance, run daily (FREE-TIER.md §4.7 daily-maintenance, §5.4 compaction, §10
 * retention; DESIGN.md §5.7 sender aggregates). Every function runs inside `withUser` and is
 * idempotent and bounded, so a timeout just means the next run continues.
 */
import type { PoolClient } from "@edf/db";

export interface RetentionPolicy {
  /** Email metadata retention in days (owner 365 (180 at 20 users); friends 90 / 60 / 30). */
  emailDays: number;
  /** Full features kept this many days, then compacted to the summary (owner 30, friends 14). */
  featureDays: number;
}

export function retentionFor(role: "owner" | "friend", opts: { activeUsers: number; storageL2: boolean; storageL1: boolean }): RetentionPolicy {
  let emailDays = role === "owner" ? (opts.activeUsers >= 20 ? 180 : 365) : opts.activeUsers > 10 ? 60 : 90;
  if (role === "friend" && opts.storageL2) emailDays = 30;
  if (opts.storageL1) emailDays = Math.max(30, emailDays - 30); // Neon storage soft action (FREE-TIER §8.3)
  let featureDays = role === "owner" ? 30 : 14;
  if (opts.storageL1) featureDays = 7;
  return { emailDays, featureDays };
}

/** Delete emails older than the retention window (cascades to analysis, deals, feedback). */
export async function applyRetention(c: PoolClient, userId: string, policy: RetentionPolicy, batch = 5000): Promise<number> {
  const r = await c.query(
    `DELETE FROM email WHERE id IN (
       SELECT id FROM email WHERE user_id = $1 AND received_at < now() - make_interval(days => $2)
       ORDER BY received_at LIMIT $3)`,
    [userId, policy.emailDays, batch],
  );
  return r.rowCount ?? 0;
}

/**
 * Compact old features to the score summary. Exempt: each template's current exemplar while its
 * render is < 60 days old (template-level scores and fonts inherit from it). A summary saved before
 * the engine wrote `signals` gets them from the checks first (migration 0015 summary_signals), so
 * the gallery verdict that reads them never changes when the checks go; likewise `layout` from the
 * render (migrations 0016 / 0017 summary_layout), so the gallery keeps showing the email full length
 * and cropped to its visible content. An older summary layout (saved before the render measured the
 * content extent) gets the keys it lacks from the features; the keys it has are kept.
 */
export async function compactFeatures(c: PoolClient, userId: string, featureDays: number, batch = 2000): Promise<number> {
  const r = await c.query(
    `UPDATE email_analysis a SET features = NULL, checks = '[]', features_compacted_at = now(),
       score_summary = CASE
         WHEN jsonb_typeof(a.score_summary) = 'object' THEN a.score_summary
           || CASE WHEN jsonb_typeof(a.score_summary -> 'signals') IS DISTINCT FROM 'object'
                THEN jsonb_build_object('signals', public.summary_signals(a.checks)) ELSE '{}'::jsonb END
           || CASE WHEN public.summary_layout(a.features) IS NOT NULL
                THEN jsonb_build_object('layout', public.summary_layout(a.features)
                       || CASE WHEN jsonb_typeof(a.score_summary -> 'layout') = 'object'
                               THEN a.score_summary -> 'layout' ELSE '{}'::jsonb END)
                ELSE '{}'::jsonb END
         ELSE a.score_summary END
     WHERE a.email_id IN (
       SELECT a2.email_id FROM email_analysis a2
       WHERE a2.user_id = $1 AND a2.features IS NOT NULL AND a2.analyzed_at < now() - make_interval(days => $2)
         AND NOT EXISTS (
           SELECT 1 FROM email_template t
           WHERE t.user_id = a2.user_id AND t.exemplar_email_id = a2.email_id
             AND t.exemplar_rendered_at > now() - interval '60 days')
       LIMIT $3)`,
    [userId, featureDays, batch],
  );
  return r.rowCount ?? 0;
}

/** `failed` ledger rows are re-driven once a day for 7 days before they become final (FREE-TIER §4.6). */
export async function redriveFailed(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query(
    `UPDATE message_ledger SET state = 'pending', attempts = 4, next_attempt_at = NULL, updated_at = now()
     WHERE user_id = $1 AND state = 'failed' AND created_at > now() - interval '7 days'
       AND updated_at < now() - interval '20 hours'`,
    [userId],
  );
  return r.rowCount ?? 0;
}

/**
 * Recompute sender aggregates from the emails themselves (nightly; the ingest path only increments).
 * read = read in Gmail OR opened in the app (DESIGN.md §7.5).
 */
export async function recomputeSenderAggregates(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query(
    `WITH stats AS (
       SELECT e.sender_id,
              count(*)                                                        AS email_count,
              count(*) FILTER (WHERE e.is_unread AND e.opened_in_app_at IS NULL) AS unread_count,
              count(*) FILTER (WHERE e.received_at > now() - interval '28 days') / 4.0 AS per_week,
              count(*) FILTER (WHERE e.received_at > now() - interval '60 days') AS n60,
              count(*) FILTER (WHERE e.received_at > now() - interval '60 days'
                                 AND (NOT e.is_unread OR e.opened_in_app_at IS NOT NULL)) AS read60,
              avg(e.design_score) FILTER (WHERE e.received_at > now() - interval '90 days'
                                            AND e.design_provisional IS NOT TRUE) AS avg_score
       FROM email e
       WHERE e.user_id = $1 AND e.sender_id IS NOT NULL
       GROUP BY e.sender_id
     ), dist AS (
       SELECT sender_id, jsonb_object_agg(primary_type, n) AS d,
              (array_agg(primary_type ORDER BY n DESC))[1] AS top_type, max(n)::float / sum(n) AS top_share, sum(n) AS total
       FROM (SELECT sender_id, primary_type, count(*) AS n FROM email WHERE user_id = $1 AND sender_id IS NOT NULL
             GROUP BY sender_id, primary_type) x
       GROUP BY sender_id
     )
     UPDATE sender s SET
       email_count = st.email_count,
       unread_count = st.unread_count,
       emails_per_week = st.per_week,
       frequency_band = CASE WHEN st.per_week >= 5 THEN 'daily' WHEN st.per_week >= 2 THEN 'several_weekly'
                             WHEN st.per_week >= 0.75 THEN 'weekly' WHEN st.per_week >= 0.2 THEN 'monthly' ELSE 'rare' END,
       read_rate_60d = CASE WHEN st.n60 > 0 THEN st.read60::real / st.n60 ELSE NULL END,
       avg_design_score = st.avg_score,
       type_distribution = coalesce(d.d, '{}'::jsonb),
       primary_type = CASE WHEN d.total >= 5 AND d.top_share >= 0.8 THEN d.top_type ELSE NULL END,
       updated_at = now()
     FROM stats st LEFT JOIN dist d ON d.sender_id = st.sender_id
     WHERE s.id = st.sender_id AND s.user_id = $1`,
    [userId],
  );
  // Senders whose emails are all gone keep their last aggregates (see deleteOrphanSenders).
  return r.rowCount ?? 0;
}

/**
 * Remove senders (and their templates) left with no emails (DATA-MODEL.md §6 purge step 3).
 * The nightly run keeps senders that carry the user's choices — muted, a type override, an
 * importance bias, an unsubscribe, or feedback about the sender — because a sender's emails also
 * go through retention and Gmail deletions, and its next email must still find those choices.
 * Removing the user's last mailbox passes `keepPreferences: false` (only 'personal' marks survive
 * there; see `deleteOrphanSendersAfterMailboxRemoved`).
 */
export async function deleteOrphanSenders(c: PoolClient, userId: string, opts: { keepPreferences?: boolean } = {}): Promise<number> {
  const keep = opts.keepPreferences ?? true;
  const r = await c.query(
    `DELETE FROM sender s WHERE s.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM email e WHERE e.user_id = s.user_id AND e.sender_id = s.id)
       AND s.type_override IS DISTINCT FROM 'personal'
       AND (NOT $2 OR (NOT s.muted AND s.type_override IS NULL AND s.user_importance_bias = 0 AND s.unsubscribed_at IS NULL
                       AND NOT EXISTS (SELECT 1 FROM user_feedback f WHERE f.user_id = s.user_id AND f.sender_id = s.id)))`,
    [userId, keep],
  );
  return r.rowCount ?? 0;
}

/**
 * Orphan-sender cleanup after one of the user's mailboxes was removed (disconnect purge, or the
 * mailbox claimed by another account). The user's choices go only with their last mailbox: senders
 * are per user, not per mailbox, so while another mailbox remains, a muted sender whose mail was
 * already gone may still be writing to it and must stay muted.
 */
export async function deleteOrphanSendersAfterMailboxRemoved(c: PoolClient, userId: string): Promise<number> {
  const others = await c.query("SELECT 1 FROM mailbox WHERE user_id = $1 LIMIT 1", [userId]);
  return deleteOrphanSenders(c, userId, { keepPreferences: (others.rowCount ?? 0) > 0 });
}

/** A render request 'running' longer than any render step can run was left by a killed step. */
export const STALE_RENDER_MINUTES = 15;

/**
 * Put render requests left 'running' by a step that was killed (time limit, crash, deploy) back in
 * the queue, or fail them, with the same rule as a failed attempt: samples and fill are retried up to
 * 3 attempts, on-demand requests fail (the user can ask again). Otherwise such a row would block its
 * email for good (one active request per email).
 */
export async function reapStaleRenderRequests(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query(
    `UPDATE render_request SET state = CASE WHEN kind <> 'on_demand' AND attempts < 3 THEN 'queued' ELSE 'failed' END,
            error = 'interrupted', updated_at = now()
     WHERE user_id = $1 AND state = 'running' AND updated_at < now() - make_interval(mins => $2)`,
    [userId, STALE_RENDER_MINUTES],
  );
  return r.rowCount ?? 0;
}

/**
 * Queue template samples (FREE-TIER.md §5.3 priorities 2–3): templates with mail in the last 14 days
 * and no sample render in the last 60 days; the sample is the most recent designable email.
 */
export async function queueTemplateSamples(c: PoolClient, userId: string, limit: number): Promise<number> {
  const r = await c.query(
    `INSERT INTO render_request (user_id, email_id, kind)
     SELECT $1, pick.id, 'exemplar' FROM email_template t
     CROSS JOIN LATERAL (
       SELECT e.id FROM email e
       WHERE e.user_id = t.user_id AND e.template_id = t.id AND e.design_status = 'done'
         AND e.design_source IN ('static', 'template') AND NOT e.security_sensitive AND NOT e.is_hidden
       ORDER BY e.received_at DESC LIMIT 1
     ) pick
     WHERE t.user_id = $1 AND t.last_seen_at > now() - interval '14 days'
       AND (t.exemplar_rendered_at IS NULL OR t.exemplar_rendered_at < now() - interval '60 days')
     ORDER BY t.email_count DESC
     LIMIT $2
     ON CONFLICT (email_id) WHERE state IN ('queued', 'running') DO NOTHING`,
    [userId, limit],
  );
  return r.rowCount ?? 0;
}
