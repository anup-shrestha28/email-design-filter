/**
 * Data export (FREE-TIER.md §10 "Export"; Google API ToS §5d): the user's data as gzipped JSONL pages
 * of ≤ 4 MB that the browser downloads one after another — no Blob storage. Page 0 carries the
 * account-level records; later pages carry emails (metadata, classification, scores — never bodies,
 * never tokens) keyed by an opaque cursor.
 */
import "server-only";
import { gzipSync } from "node:zlib";
import { withUser } from "@edf/db";
import { getPool } from "./db";

const MAX_PAGE_BYTES = 3_800_000; // uncompressed budget per page, safely under 4 MB compressed or not
const EMAILS_PER_QUERY = 500;

export interface ExportPage {
  body: Buffer;
  nextCursor: string | null;
  page: number;
}

function line(kind: string, data: unknown): string {
  return `${JSON.stringify({ kind, data })}\n`;
}

export async function buildExportPage(userId: string, cursor: string | null): Promise<ExportPage> {
  const pool = await getPool();
  const parts: string[] = [];
  let size = 0;
  const push = (s: string) => {
    parts.push(s);
    size += Buffer.byteLength(s);
  };
  let next: string | null = null;
  let pageNo = 0;

  await withUser(pool, userId, async (_db, c) => {
    if (!cursor) {
      push(line("export", { version: 1, generatedAt: new Date().toISOString(), note: "Email bodies are never stored, so they are not part of this export." }));
      const settings = await c.query(
        "SELECT timezone, role, load_images_for_analysis, link_check_opt_in, backfill_window_days, ai_processing_consent_at, created_at FROM user_settings WHERE user_id = $1",
        [userId],
      );
      push(line("settings", settings.rows[0] ?? null));
      const mailboxes = await c.query(
        `SELECT id, provider, email_address::text AS email_address, status, status_reason, last_synced_at, backfill_state, created_at
         FROM mailbox WHERE user_id = $1`,
        [userId],
      );
      for (const m of mailboxes.rows) push(line("mailbox", m));
      const senders = await c.query(
        `SELECT id, address::text AS address, display_name, domain, email_count, frequency_band, read_rate_60d, avg_design_score,
                type_override, muted, user_importance_bias, unsubscribed_at, first_seen_at, last_seen_at
         FROM sender WHERE user_id = $1 ORDER BY id`,
        [userId],
      );
      for (const s of senders.rows) push(line("sender", s));
      const feedback = await c.query("SELECT email_id, sender_id, field, old_value, new_value, created_at FROM user_feedback WHERE user_id = $1", [userId]);
      for (const f of feedback.rows) push(line("feedback", f));
      const views = await c.query("SELECT name, filters, sort, position, created_at FROM saved_view WHERE user_id = $1", [userId]);
      for (const v of views.rows) push(line("saved_view", v));
      const audit = await c.query("SELECT actor, action, target, created_at FROM audit_log WHERE user_id = $1 ORDER BY id", [userId]);
      for (const a of audit.rows) push(line("audit", a));
    }
    let after = cursor ?? "00000000-0000-0000-0000-000000000000";
    pageNo = cursor ? 1 : 0;
    for (;;) {
      const rows = await c.query<{ id: string; [k: string]: unknown }>(
        `SELECT e.id, e.received_at, e.subject, e.from_address::text AS from_address, e.from_name, e.snippet, e.label_ids,
                e.primary_type, e.subtype, e.type_source, e.is_subscription, e.importance, e.importance_reasons,
                e.design_status, e.design_source, e.design_score, e.design_band, e.design_issues, e.font_families,
                e.has_deal, e.deal_ends_at, e.opened_in_app_at, e.done_at, e.pinned_at,
                a.scoring_version, a.score_summary, a.trust,
                (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'value', d.value, 'currency', d.currency,
                        'code', d.code, 'ends_at', d.ends_at)), '[]'::jsonb) FROM deal d WHERE d.email_id = e.id) AS deals
         FROM email e LEFT JOIN email_analysis a ON a.email_id = e.id
         WHERE e.user_id = $1 AND e.id > $2::uuid ORDER BY e.id LIMIT $3`,
        [userId, after, EMAILS_PER_QUERY],
      );
      if (rows.rows.length === 0) {
        next = null;
        return;
      }
      for (const r of rows.rows) {
        const s = line("email", r);
        if (size + Buffer.byteLength(s) > MAX_PAGE_BYTES && size > 0) {
          next = after; // resume after the last email written
          return;
        }
        push(s);
        after = r.id;
      }
      if (rows.rows.length < EMAILS_PER_QUERY) {
        next = null;
        return;
      }
    }
  });
  return { body: gzipSync(Buffer.from(parts.join(""))), nextCursor: next, page: pageNo };
}
