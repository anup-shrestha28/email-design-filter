/**
 * The per-user `user_settings` row (role, import window, consent). Created by Better Auth's
 * `user.create.after` hook, which runs only after the user row has committed; if that hook fails
 * (a transient DB error), Better Auth never runs it again for the same user. So the session lookup
 * re-provisions a missing row with the same, idempotent statement instead of leaving the account
 * without settings for good (owner treated as friend, consent never recorded, Gmail never connectable).
 */
import "server-only";
import type { pg } from "@edf/db";

export type UserRole = "owner" | "friend";

/**
 * Create the row if it is missing and return the user's role. Must run inside a transaction whose
 * `app.user_id` is `user.id` (RLS). `claim_invite` is idempotent (it keeps the first `used_at`), so
 * this is safe to call again after a failed attempt; the audit entry is written only when the row is
 * actually created.
 */
export async function provisionUserSettings(client: pg.PoolClient, user: { id: string; email: string }): Promise<UserRole> {
  const claimed = await client.query<{ role: UserRole | null }>("SELECT claim_invite($1) AS role", [user.email]);
  const role: UserRole = claimed.rows[0]?.role ?? "friend";
  const inserted = await client.query<{ role: UserRole }>(
    `INSERT INTO user_settings (user_id, role, backfill_window_days) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING RETURNING role`,
    [user.id, role, role === "owner" ? 90 : 30],
  );
  if (inserted.rows[0]) {
    await client.query(`INSERT INTO audit_log (user_id, actor, action) VALUES ($1, 'user', 'account.created')`, [user.id]);
    return inserted.rows[0].role;
  }
  // Someone else created it first (a concurrent request): theirs wins.
  const existing = await client.query<{ role: UserRole }>("SELECT role FROM user_settings WHERE user_id = $1", [user.id]);
  return existing.rows[0]?.role ?? role;
}
