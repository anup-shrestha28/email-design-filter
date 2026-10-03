/** Senders page and sender profile (DESIGN.md §9.5). */
import "server-only";
import { sql, type SQL } from "@edf/db";
import { raw } from "@edf/db";
import { withUser } from "@edf/db";
import type { EmailType, TypeGroup } from "@edf/core/types";
import { typeGroupOf } from "@/lib/types-display";
import { getPool } from "../db";
import { INBOX_COLUMNS, toInboxItem, type InboxRow } from "./inbox";
import type { FrequencyBand, SenderProfile, SenderRow } from "./types";

interface SenderDbRow {
  id: string;
  display_name: string | null;
  address: string;
  domain: string;
  email_count: number;
  unread_count: number;
  emails_per_week: number | null;
  frequency_band: FrequencyBand | null;
  read_rate_60d: number | null;
  avg_design_score: number | null;
  one_click_unsubscribe: boolean | null;
  has_unsubscribe: boolean;
  auth_summary: { trust?: SenderRow["trustState"] } | null;
  primary_type: EmailType | null;
  type_override: EmailType | null;
  first_seen_at: Date;
  last_seen_at: Date;
  seen_before_window: boolean | null;
  muted: boolean;
  user_importance_bias: number;
  unsubscribed_at: Date | null;
  still_sending: boolean;
  top_fonts: string[] | null;
}

const SENDER_COLUMNS = sql`
  s.id, s.display_name, s.address::text AS address, s.domain, s.email_count, s.unread_count, s.emails_per_week,
  s.frequency_band, s.read_rate_60d, s.avg_design_score, s.one_click_unsubscribe,
  (s.list_unsubscribe IS NOT NULL AND (jsonb_array_length(coalesce(s.list_unsubscribe->'https', '[]')) > 0
    OR jsonb_array_length(coalesce(s.list_unsubscribe->'mailto', '[]')) > 0)) AS has_unsubscribe,
  s.auth_summary, s.primary_type, s.type_override, s.first_seen_at, s.last_seen_at, s.seen_before_window, s.muted,
  s.user_importance_bias, s.unsubscribed_at,
  (s.unsubscribed_at IS NOT NULL AND s.last_seen_at > s.unsubscribed_at + interval '3 days') AS still_sending,
  (SELECT array_agg(f ORDER BY n DESC) FROM (
     SELECT f, count(*) AS n FROM email e2, unnest(e2.font_families) f
     WHERE e2.sender_id = s.id AND e2.user_id = s.user_id GROUP BY f ORDER BY n DESC LIMIT 3) t) AS top_fonts`;

function toSenderRow(r: SenderDbRow): SenderRow {
  return {
    id: r.id,
    displayName: r.display_name,
    address: r.address,
    domain: r.domain,
    emailCount: r.email_count,
    unreadCount: r.unread_count,
    emailsPerWeek: r.emails_per_week,
    frequencyBand: r.frequency_band,
    readRate60d: r.read_rate_60d,
    avgDesignScore: r.avg_design_score === null ? null : Math.round(r.avg_design_score),
    oneClickUnsubscribe: r.one_click_unsubscribe,
    hasUnsubscribe: r.has_unsubscribe,
    trustState: r.auth_summary?.trust ?? null,
    primaryType: r.type_override ?? r.primary_type,
    firstSeenAt: r.first_seen_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    isNew: r.first_seen_at.getTime() > Date.now() - 14 * 86_400_000 && r.seen_before_window !== true,
    muted: r.muted,
    importanceBias: r.user_importance_bias,
    unsubscribedAt: r.unsubscribed_at?.toISOString() ?? null,
    stillSending: r.still_sending,
    topFonts: r.top_fonts ?? [],
  };
}

export type SenderSort = "volume" | "recent" | "name" | "read_rate" | "design";
export type SenderFilter = "all" | "new" | "muted" | "still_sending" | "never_opened" | "no_unsubscribe";

export async function listSenders(
  userId: string,
  opts: { sort?: SenderSort; filter?: SenderFilter; search?: string; limit?: number } = {},
): Promise<SenderRow[]> {
  const pool = await getPool();
  const where: SQL[] = [sql`s.user_id = ${userId}`, sql`s.email_count > 0`];
  switch (opts.filter) {
    case "new":
      where.push(sql`s.first_seen_at > now() - interval '14 days' AND s.seen_before_window IS NOT TRUE`);
      break;
    case "muted":
      where.push(sql`s.muted`);
      break;
    case "still_sending":
      where.push(sql`s.unsubscribed_at IS NOT NULL AND s.last_seen_at > s.unsubscribed_at + interval '3 days'`);
      break;
    case "never_opened":
      where.push(sql`s.email_count >= 5 AND coalesce(s.read_rate_60d, 0) < 0.1`);
      break;
    case "no_unsubscribe":
      where.push(sql`s.list_unsubscribe IS NULL`);
      break;
    default:
      break;
  }
  const q = (opts.search ?? "").trim().slice(0, 100);
  if (q) where.push(sql`s.id IN (SELECT id FROM search_senders(${q}, 50))`);
  const order = {
    volume: sql`s.email_count DESC, s.last_seen_at DESC`,
    recent: sql`s.last_seen_at DESC`,
    name: sql`lower(coalesce(s.display_name, s.address::text)) ASC`,
    read_rate: sql`s.read_rate_60d DESC NULLS LAST, s.email_count DESC`,
    design: sql`s.avg_design_score DESC NULLS LAST, s.email_count DESC`,
  }[opts.sort ?? "volume"];
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<SenderDbRow>(sql`
      SELECT ${SENDER_COLUMNS} FROM sender s
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY ${order} LIMIT ${Math.min(opts.limit ?? 500, 1000)}`);
    return res.rows.map(toSenderRow);
  });
}

export async function getSenderProfile(userId: string, senderId: string): Promise<SenderProfile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(senderId)) return null;
  const pool = await getPool();
  return withUser(pool, userId, async (db) => {
    const s = await raw(db).execute<SenderDbRow>(sql`SELECT ${SENDER_COLUMNS} FROM sender s WHERE s.id = ${senderId} AND s.user_id = ${userId}`);
    const row = s.rows[0];
    if (!row) return null;
    const trend = await raw(db).execute<{ month: string; avg: number | null; n: string }>(sql`
      SELECT to_char(date_trunc('month', received_at), 'YYYY-MM') AS month, avg(design_score)::float8 AS avg, count(*) AS n
      FROM email WHERE user_id = ${userId} AND sender_id = ${senderId} AND received_at > now() - interval '365 days'
      GROUP BY 1 ORDER BY 1`);
    const fonts = await raw(db).execute<{ family: string; n: string }>(sql`
      SELECT f AS family, count(*) AS n FROM email e, unnest(e.font_families) f
      WHERE e.user_id = ${userId} AND e.sender_id = ${senderId} AND e.received_at > now() - interval '90 days'
      GROUP BY f ORDER BY n DESC LIMIT 10`);
    const types = await raw(db).execute<{ primary_type: EmailType; n: string }>(sql`
      SELECT primary_type, count(*) AS n FROM email WHERE user_id = ${userId} AND sender_id = ${senderId} GROUP BY 1`);
    const templates = await raw(db).execute<{
      id: string; email_count: number; first_seen_at: Date; last_seen_at: Date; exemplar_email_id: string | null;
      exemplar_rendered_at: Date | null; ai_reviewed_at: Date | null;
    }>(sql`
      SELECT id, email_count, first_seen_at, last_seen_at, exemplar_email_id, exemplar_rendered_at, ai_reviewed_at
      FROM email_template WHERE user_id = ${userId} AND sender_id = ${senderId}
      ORDER BY last_seen_at DESC LIMIT 20`);
    const recent = await raw(db).execute<InboxRow>(sql`
      SELECT ${INBOX_COLUMNS} FROM email e LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      WHERE e.user_id = ${userId} AND e.sender_id = ${senderId}
      ORDER BY e.received_at DESC, e.id DESC LIMIT 20`);

    const byGroup = new Map<TypeGroup, number>();
    for (const t of types.rows) byGroup.set(typeGroupOf(t.primary_type), (byGroup.get(typeGroupOf(t.primary_type)) ?? 0) + Number(t.n));
    const now = new Date();
    return {
      sender: toSenderRow(row),
      designTrend: trend.rows.map((t) => ({
        month: t.month,
        avgScore: t.avg === null ? null : Math.round(t.avg),
        count: Number(t.n),
      })),
      fonts: fonts.rows.map((f) => ({ family: f.family, emails: Number(f.n) })),
      typeMix: [...byGroup.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count),
      templates: templates.rows.map((t) => ({
        id: t.id,
        emailCount: t.email_count,
        firstSeenAt: t.first_seen_at.toISOString(),
        lastSeenAt: t.last_seen_at.toISOString(),
        exemplarEmailId: t.exemplar_email_id,
        exemplarRenderedAt: t.exemplar_rendered_at?.toISOString() ?? null,
        aiReviewed: t.ai_reviewed_at !== null,
      })),
      recentEmails: recent.rows.map((r) => toInboxItem(r, now)),
    };
  });
}
