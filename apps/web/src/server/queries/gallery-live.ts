/**
 * The live gallery's check (components/gallery/live-updates.tsx): a compact "stamp" of what the
 * user's gallery shows, cheap enough to ask for about once a minute while the gallery is in use.
 *
 * One pass over the user's own designs (the same rows the gallery lists, every filter off; RLS and
 * the user_id condition scope it to the user), one index-only lookup for the latest analysis save
 * (email_analysis_compaction, a backward scan: one row), and a scan of render_request for its latest
 * change (no (user_id, updated_at) index: the table stays small because finished rows are purged
 * after 7 days — ≈ 1,300 rows, 25 buffer hits today; FREE-TIER.md §4.4). On the real account (625
 * designs): ≈ 3.5 ms, 163 buffer hits. Timestamps travel as Postgres text, microseconds included, so
 * "newer than" never counts the newest design itself.
 *
 * Only when the stamp moved does the check also count the view's own new designs (the page's
 * filters and search, the gallery's own WHERE), so "3 new designs" is exact for what's on screen.
 */
import "server-only";
import { raw, sql, withUser } from "@edf/db";
import type { GalleryParams } from "@/lib/gallery";
import type { GalleryStamp, ViewChange } from "@/lib/gallery-live";
import { requestTimeZone } from "@/lib/request-context";
import { getPool } from "../db";
import { GALLERY_VIEW_JOIN, galleryViewConditions } from "./gallery";

export interface StampResult {
  stamp: GalleryStamp;
  /** The governor has UI polling off (L1+, FREE-TIER.md §8.2): the page stops checking. */
  pollingOff: boolean;
}

interface StampRow {
  total: number;
  newest: string | null;
  scored: number;
  typing: number;
  analyzed_at: string | null;
  render_at: string | null;
  governor: { level?: number; actions?: { syncStatusPollingOff?: boolean } } | null;
}

/** The user's gallery stamp and whether live checks are allowed right now. */
export async function galleryStamp(userId: string): Promise<StampResult> {
  const pool = await getPool();
  return withUser(pool, userId, async (db) => {
    const r = (
      await raw(db).execute<StampRow>(sql`
        SELECT g.total, g.newest, g.scored, g.typing,
               (SELECT max(a.analyzed_at)::text FROM email_analysis a
                 WHERE a.user_id = ${userId} AND a.features IS NOT NULL) AS analyzed_at,
               (SELECT max(q.updated_at)::text FROM render_request q WHERE q.user_id = ${userId}) AS render_at,
               (SELECT value FROM app_setting WHERE key = 'governor') AS governor
        FROM (
          SELECT count(*)::int AS total, max(e.created_at)::text AS newest,
                 count(*) FILTER (WHERE e.design_score IS NOT NULL)::int AS scored,
                 count(*) FILTER (WHERE e.type_source = 'pending')::int AS typing
          FROM email e
          WHERE e.user_id = ${userId} AND NOT e.is_hidden AND NOT e.security_sensitive
            AND e.design_status NOT IN ('plain_text', 'skipped')
        ) g`)
    ).rows[0];
    const level = Number(r?.governor?.level ?? 0) || 0;
    return {
      stamp: {
        total: Number(r?.total ?? 0),
        newest: r?.newest ?? null,
        scored: Number(r?.scored ?? 0),
        typing: Number(r?.typing ?? 0),
        analyzedAt: r?.analyzed_at ?? null,
        renderAt: r?.render_at ?? null,
      },
      // The same rule as the sync-status polling (queries/account.ts getSyncStatus).
      pollingOff: r?.governor?.actions?.syncStatusPollingOff === true || level >= 1,
    };
  });
}

/**
 * In the view `params` shows (its filters and search), against the stamp `since` the page was
 * rendered with: how many designs there are now, how many of them arrived after it, and how many
 * that were already there got a new analysis (a score) since.
 */
export async function galleryViewChange(
  userId: string,
  params: GalleryParams,
  since: Pick<GalleryStamp, "newest" | "analyzedAt">,
): Promise<ViewChange> {
  const pool = await getPool();
  // The page's own zone, so a "Pick dates" view counts the same days the page shows.
  const where = galleryViewConditions(userId, params, await requestTimeZone(userId));
  const isNew =
    since.newest === null ? sql`true` : sql`e.created_at > ${since.newest}::timestamptz`;
  const rescored =
    since.analyzedAt === null
      ? sql`a.analyzed_at IS NOT NULL`
      : sql`a.analyzed_at > ${since.analyzedAt}::timestamptz`;
  return withUser(pool, userId, async (db) => {
    const r = (
      await raw(db).execute<ViewChange>(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE ${isNew})::int AS added,
               count(*) FILTER (WHERE NOT (${isNew}) AND ${rescored})::int AS rescored
        FROM email e ${GALLERY_VIEW_JOIN}
        WHERE ${sql.join(where, sql` AND `)}`)
    ).rows[0];
    return {
      total: Number(r?.total ?? 0),
      added: Number(r?.added ?? 0),
      rescored: Number(r?.rescored ?? 0),
    };
  });
}
