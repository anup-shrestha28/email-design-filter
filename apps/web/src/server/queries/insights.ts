/** Insights (DESIGN.md §9.5): volume, senders, design distribution, fonts, tracking, cleanup. */
import "server-only";
import { sql } from "@edf/db";
import { raw } from "@edf/db";
import { withUser } from "@edf/db";
import type { EmailType, TypeGroup } from "@edf/core/types";
import type { DesignBand, DesignIssue } from "@edf/design/types";
import { typeGroupOf } from "@/lib/types-display";
import { getPool } from "../db";
import { listSenders } from "./senders";
import type { InsightsData } from "./types";

const BUCKETS: Array<{ label: string; lo: number; hi: number; band: DesignBand }> = [
  { label: "0–29", lo: 0, hi: 29, band: "poor" },
  { label: "30–49", lo: 30, hi: 49, band: "poor" },
  { label: "50–59", lo: 50, hi: 59, band: "needs_work" },
  { label: "60–69", lo: 60, hi: 69, band: "needs_work" },
  { label: "70–77", lo: 70, hi: 77, band: "good" },
  { label: "78–84", lo: 78, hi: 84, band: "good" },
  { label: "85–92", lo: 85, hi: 92, band: "excellent" },
  { label: "93–100", lo: 93, hi: 100, band: "excellent" },
];

export async function getInsights(userId: string, rangeDays = 90): Promise<InsightsData> {
  const days = [30, 90, 180, 365].includes(rangeDays) ? rangeDays : 90;
  const pool = await getPool();
  const since = sql`now() - ${`${days} days`}::interval`;

  const data = await withUser(pool, userId, async (db) => {
    const totals = await raw(db).execute<{ emails: string; senders: string; subs: string; designed: string; avg: number | null }>(sql`
      SELECT count(*) AS emails, count(DISTINCT sender_id) AS senders, count(*) FILTER (WHERE is_subscription) AS subs,
             count(*) FILTER (WHERE design_score IS NOT NULL) AS designed, avg(design_score)::float8 AS avg
      FROM email WHERE user_id = ${userId} AND NOT is_hidden AND received_at > ${since}`);
    const weekly = await raw(db).execute<{ week: string; primary_type: EmailType; n: string }>(sql`
      SELECT to_char(date_trunc('week', received_at), 'YYYY-MM-DD') AS week, primary_type, count(*) AS n
      FROM email WHERE user_id = ${userId} AND NOT is_hidden AND received_at > ${since}
      GROUP BY 1, 2 ORDER BY 1`);
    const top = await raw(db).execute<{ id: string; name: string; n: string; rr: number | null }>(sql`
      SELECT s.id, coalesce(s.display_name, s.address::text) AS name, count(*) AS n, s.read_rate_60d AS rr
      FROM email e JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      WHERE e.user_id = ${userId} AND NOT e.is_hidden AND e.received_at > ${since}
      GROUP BY s.id ORDER BY n DESC LIMIT 10`);
    const spikes = await raw(db).execute<{ id: string; name: string; last7: string; prior: string }>(sql`
      SELECT s.id, coalesce(s.display_name, s.address::text) AS name,
             count(*) FILTER (WHERE e.received_at > now() - interval '7 days') AS last7,
             count(*) FILTER (WHERE e.received_at <= now() - interval '7 days' AND e.received_at > now() - interval '35 days') AS prior
      FROM email e JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      WHERE e.user_id = ${userId} AND NOT e.is_hidden AND e.received_at > now() - interval '35 days'
      GROUP BY s.id
      HAVING count(*) FILTER (WHERE e.received_at > now() - interval '7 days') >= 4
         AND count(*) FILTER (WHERE e.received_at > now() - interval '7 days')
             >= 2 * greatest(1, count(*) FILTER (WHERE e.received_at <= now() - interval '7 days' AND e.received_at > now() - interval '35 days') / 4.0)
      ORDER BY last7 DESC LIMIT 8`);
    const dist = await raw(db).execute<{ score: number; n: string }>(sql`
      SELECT design_score AS score, count(*) AS n FROM email
      WHERE user_id = ${userId} AND NOT is_hidden AND received_at > ${since} AND design_score IS NOT NULL
        AND design_provisional IS NOT TRUE
      GROUP BY 1`);
    const bands = await raw(db).execute<{ band: string; n: string }>(sql`
      SELECT CASE WHEN design_provisional THEN 'provisional'
                  WHEN design_band IS NULL THEN 'not_analysed' ELSE design_band END AS band, count(*) AS n
      FROM email WHERE user_id = ${userId} AND NOT is_hidden AND received_at > ${since}
        AND design_status NOT IN ('plain_text', 'skipped')
      GROUP BY 1`);
    const senderScores = await raw(db).execute<{ id: string; name: string; avg: number; n: string }>(sql`
      SELECT s.id, coalesce(s.display_name, s.address::text) AS name, avg(e.design_score)::float8 AS avg, count(*) AS n
      FROM email e JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      WHERE e.user_id = ${userId} AND NOT e.is_hidden AND e.received_at > ${since} AND e.design_score IS NOT NULL AND e.design_provisional IS NOT TRUE
      GROUP BY s.id HAVING count(*) >= 3`);
    const issues = await raw(db).execute<{ issue: DesignIssue; n: string }>(sql`
      SELECT i AS issue, count(*) AS n FROM email e, unnest(e.design_issues) i
      WHERE e.user_id = ${userId} AND NOT e.is_hidden AND e.received_at > ${since} GROUP BY 1 ORDER BY n DESC`);
    const fonts = await raw(db).execute<{ family: string; n: string }>(sql`
      SELECT f AS family, count(*) AS n FROM email e, unnest(e.font_families) f
      WHERE e.user_id = ${userId} AND NOT e.is_hidden AND e.received_at > ${since}
      GROUP BY f ORDER BY n DESC LIMIT 15`);
    const web = await raw(db).execute<{ web: string; sys: string }>(sql`
      SELECT count(*) FILTER (WHERE uses_web_fonts) AS web,
             count(*) FILTER (WHERE NOT uses_web_fonts AND cardinality(font_families) > 0) AS sys
      FROM email WHERE user_id = ${userId} AND NOT is_hidden AND received_at > ${since}`);
    const tracking = await raw(db).execute<{ with_px: string; total: string }>(sql`
      SELECT count(*) FILTER (WHERE tracker_count > 0) AS with_px, count(*) AS total
      FROM email WHERE user_id = ${userId} AND NOT is_hidden AND received_at > ${since} AND NOT security_sensitive`);
    return { totals, weekly, top, spikes, dist, bands, senderScores, issues, fonts, web, tracking };
  });

  const byWeek = new Map<string, Partial<Record<TypeGroup, number>>>();
  const mix = new Map<TypeGroup, number>();
  for (const r of data.weekly.rows) {
    const g = typeGroupOf(r.primary_type);
    const row = byWeek.get(r.week) ?? {};
    row[g] = (row[g] ?? 0) + Number(r.n);
    byWeek.set(r.week, row);
    mix.set(g, (mix.get(g) ?? 0) + Number(r.n));
  }
  const bucketCounts = BUCKETS.map((b) => ({
    bucket: b.label,
    band: b.band,
    count: data.dist.rows.filter((r) => r.score >= b.lo && r.score <= b.hi).reduce((a, r) => a + Number(r.n), 0),
  }));
  const scored = data.senderScores.rows.map((r) => ({ id: r.id, name: r.name, avgScore: Math.round(r.avg), emails: Number(r.n) }));
  const t = data.totals.rows[0];
  const tr = data.tracking.rows[0];
  const total = Number(tr?.total ?? 0);
  const withPx = Number(tr?.with_px ?? 0);
  const cleanup = await listSenders(userId, { filter: "never_opened", sort: "volume", limit: 10 });

  return {
    rangeDays: days,
    totals: {
      emails: Number(t?.emails ?? 0),
      senders: Number(t?.senders ?? 0),
      subscriptions: Number(t?.subs ?? 0),
      designed: Number(t?.designed ?? 0),
      avgScore: t?.avg === null || t?.avg === undefined ? null : Math.round(t.avg),
    },
    volumeByWeek: [...byWeek.entries()].map(([week, groups]) => ({ week, ...groups })),
    typeMix: [...mix.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count),
    topSenders: data.top.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.n), readRate: r.rr })),
    frequencySpikes: data.spikes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      last7: Number(r.last7),
      prior28Weekly: Math.round((Number(r.prior) / 4) * 10) / 10,
    })),
    designDistribution: bucketCounts,
    bandShare: data.bands.rows.map((r) => ({ band: r.band as InsightsData["bandShare"][number]["band"], count: Number(r.n) })),
    bestSenders: [...scored].sort((a, b) => b.avgScore - a.avgScore).slice(0, 5),
    worstSenders: [...scored].sort((a, b) => a.avgScore - b.avgScore).slice(0, 5),
    topIssues: data.issues.rows.map((r) => ({ issue: r.issue, count: Number(r.n) })),
    fonts: data.fonts.rows.map((r) => ({ family: r.family, emails: Number(r.n) })),
    webVsSystem: { webFontEmails: Number(data.web.rows[0]?.web ?? 0), systemOnlyEmails: Number(data.web.rows[0]?.sys ?? 0) },
    tracking: { emailsWithPixels: withPx, total, share: total ? withPx / total : 0 },
    cleanupCandidates: cleanup,
  };
}
