/**
 * One gallery design's saved design checklist (score_summary.checklist) for the detail view's "How
 * we judged this" panel (lib/gallery-evidence.ts) — the same stored value the gallery list reads
 * for the verdict (queries/gallery.ts). Read-only.
 *
 * Only the caller's own designs, and only ones the gallery lists (never security-sensitive,
 * plain-text or hidden mail): an explicit `user_id` predicate inside withUser (RLS is the backstop),
 * so another user's id simply finds nothing.
 */
import "server-only";
import { raw, sql, withUser } from "@edf/db";
import { getPool } from "../db";
import { baseConditions } from "./gallery";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The saved checklist of one of the caller's gallery designs: `{ checklist }` (null when it has
 * none), or null when the design isn't theirs, isn't in the gallery, or `emailId` isn't an id.
 */
export async function galleryEvidenceInput(
  userId: string,
  emailId: string,
): Promise<{ checklist: unknown } | null> {
  if (typeof emailId !== "string" || !UUID_RE.test(emailId)) return null;
  const pool = await getPool();
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<{ checklist: unknown }>(sql`
      SELECT a.score_summary -> 'checklist' AS checklist
      FROM email e
      LEFT JOIN email_analysis a ON a.email_id = e.id AND a.user_id = e.user_id
      -- The gallery's own rows (the caller's, never hidden, security or plain-text mail).
      WHERE e.id = ${emailId}::uuid AND ${sql.join(baseConditions(userId), sql` AND `)}`);
    const row = res.rows[0];
    return row ? { checklist: row.checklist ?? null } : null;
  });
}
