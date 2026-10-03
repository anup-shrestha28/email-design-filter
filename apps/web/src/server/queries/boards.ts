/**
 * Boards (migration 0018): a user's own collections of saved designs. Read inside the user's
 * RLS-scoped transaction, so only their own boards and saves are ever visible. A board's count is
 * the designs the gallery shows for it (`/gallery?board=<id>`): its saves that are still in the
 * gallery (lib/gallery.ts baseConditions), so the two numbers always agree.
 */
import "server-only";
import { raw, sql, withUser } from "@edf/db";
import { getPool } from "../db";
import { baseConditions } from "./gallery";

/** The most boards one user can make (also the picker's list length). */
export const MAX_BOARDS = 100;
/** A board name's length limit (the database checks 1–60 after trimming). */
export const BOARD_NAME_MAX = 60;

export interface BoardSummary {
  id: string;
  name: string;
  /** Saved designs the gallery shows for this board. */
  count: number;
  updatedAt: string;
  /** The last few saved designs' senders, newest first (the board tile's faces). */
  recent: Array<{ name: string; domain: string | null }>;
}

/** One board in the Save picker: whether this email is saved in it. */
export interface BoardChoice {
  id: string;
  name: string;
  count: number;
  saved: boolean;
}

const SENDER_NAME = sql`coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(e.from_name), ''), s.domain, e.from_address::text)`;

/** Every board of the user, most recently changed first. */
export async function listBoards(userId: string): Promise<BoardSummary[]> {
  const pool = await getPool();
  const listed = sql.join(baseConditions(userId), sql` AND `);
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<{
      id: string;
      name: string;
      updated_at: Date;
      n: string;
      recent: Array<{ name: string; domain: string | null }> | null;
    }>(sql`
      SELECT b.id, b.name, b.updated_at,
             (SELECT count(*) FROM board_item bi JOIN email e ON e.id = bi.email_id AND e.user_id = bi.user_id
              WHERE bi.board_id = b.id AND ${listed}) AS n,
             (SELECT json_agg(json_build_object('name', r.name, 'domain', r.domain) ORDER BY r.added_at DESC)
              FROM (SELECT ${SENDER_NAME} AS name, s.domain, bi.added_at
                    FROM board_item bi
                    JOIN email e ON e.id = bi.email_id AND e.user_id = bi.user_id
                    LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
                    WHERE bi.board_id = b.id AND ${listed}
                    ORDER BY bi.added_at DESC LIMIT 4) r) AS recent
      FROM board b
      WHERE b.user_id = ${userId}
      ORDER BY b.updated_at DESC, b.id`);
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      count: Number(r.n),
      updatedAt: new Date(r.updated_at).toISOString(),
      recent: r.recent ?? [],
    }));
  });
}

/** The Save picker's list for one email: every board, most recently changed first. */
export async function boardChoices(userId: string, emailId: string): Promise<BoardChoice[]> {
  const pool = await getPool();
  const listed = sql.join(baseConditions(userId), sql` AND `);
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<{ id: string; name: string; n: string; saved: boolean }>(sql`
      SELECT b.id, b.name,
             (SELECT count(*) FROM board_item bi JOIN email e ON e.id = bi.email_id AND e.user_id = bi.user_id
              WHERE bi.board_id = b.id AND ${listed}) AS n,
             EXISTS (SELECT 1 FROM board_item bi WHERE bi.board_id = b.id AND bi.email_id = ${emailId}::uuid) AS saved
      FROM board b
      WHERE b.user_id = ${userId}
      ORDER BY b.updated_at DESC, b.id
      LIMIT ${MAX_BOARDS}::int`);
    return res.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.n), saved: r.saved }));
  });
}
