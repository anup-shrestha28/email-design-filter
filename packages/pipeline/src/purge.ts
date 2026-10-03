/**
 * Disconnect & deletion (FREE-TIER.md §4.9; DATA-MODEL.md §6). The user-facing step (revoke, null
 * tokens, mark disconnecting) happens synchronously in the Server Action; the bulk delete runs here,
 * resumable and bounded, from Inngest or the daily cron.
 */
import { withUser } from "@edf/db";
import { logOf, mailboxTag, type PipelineDeps } from "./deps";
import { deleteOrphanSendersAfterMailboxRemoved } from "./maintenance";

export interface DisconnectResult {
  revoked: boolean;
  alreadyInvalid: boolean;
  /**
   * The mailbox held a grant and Google did not confirm its revocation (the call failed, or the
   * key service refused the unwrap). The tokens are erased anyway, so the app can't retry: the
   * user has to be told to remove the access in their Google account themselves.
   */
  revokeFailed: boolean;
}

/**
 * Synchronous part: `/revoke` the grant (via the key service unwrap), then null every token column
 * and mark the mailbox `disconnecting`. A failed revoke never blocks the disconnect (deletion goes
 * ahead, FREE-TIER.md §4.9), but it is reported as `revokeFailed` so the UI never claims access
 * was revoked when it wasn't.
 */
export async function disconnectNow(deps: PipelineDeps, mb: { userId: string; mailboxId: string }): Promise<DisconnectResult> {
  let revoked = false;
  let alreadyInvalid = false;
  let revokeFailed: boolean;
  try {
    const r = await deps.tokens.revokeGrant(mb.userId, mb.mailboxId);
    revoked = r.revoked;
    alreadyInvalid = r.alreadyInvalid;
    // No stored tokens (never sealed, or already erased): the app holds no grant to revoke.
    revokeFailed = !r.revoked && !r.alreadyInvalid && r.reason !== "no_tokens";
  } catch {
    revoked = false;
    revokeFailed = true;
  }
  await withUser(deps.pool, mb.userId, async (_db, c) => {
    await c.query(
      `UPDATE mailbox SET refresh_token_enc = NULL, access_token_enc = NULL, dek_wrapped = NULL, access_token_expires_at = NULL,
              status = 'disconnecting', status_reason = 'user_request', sync_lease_until = NULL, updated_at = now()
       WHERE id = $1`,
      [mb.mailboxId],
    );
    await c.query(
      "INSERT INTO audit_log (user_id, actor, action, target, metadata) VALUES ($1, 'user', 'mailbox.disconnected', $2, $3)",
      [mb.userId, mb.mailboxId, JSON.stringify({ revoked, alreadyInvalid })],
    );
  });
  return { revoked, alreadyInvalid, revokeFailed };
}

/**
 * Bulk purge of one mailbox (5,000 emails per transaction), then the mailbox row (cascades to the
 * quota row, ledger and sync runs), then orphan senders/templates. Returns true when finished.
 */
export async function purgeMailbox(
  deps: PipelineDeps,
  mb: { userId: string; mailboxId: string },
  budgetMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (Date.now() > deadline) return false;
    const n = await withUser(deps.pool, mb.userId, async (_db, c) => {
      const r = await c.query(
        "DELETE FROM email WHERE id IN (SELECT id FROM email WHERE mailbox_id = $1 LIMIT 5000)",
        [mb.mailboxId],
      );
      return r.rowCount ?? 0;
    });
    if (n === 0) break;
  }
  await withUser(deps.pool, mb.userId, async (_db, c) => {
    await c.query("DELETE FROM mailbox WHERE id = $1", [mb.mailboxId]);
    await deleteOrphanSendersAfterMailboxRemoved(c, mb.userId);
    await c.query("INSERT INTO audit_log (user_id, actor, action, target) VALUES ($1, 'system', 'mailbox.purged', $2)", [mb.userId, mb.mailboxId]);
  });
  logOf(deps)("purge.mailbox_done", { mailbox: mailboxTag(mb.mailboxId) });
  return true;
}

/** Purge time for account deletion (a Server Action, ≤ 300 s on Vercel): mailboxes go in 5,000-email batches. */
const ACCOUNT_PURGE_BUDGET_MS = 90_000;
/**
 * `statement_timeout` for the final `DELETE FROM "user"`, whose cascade takes whatever the purge left
 * (the rest of a mailbox that didn't finish in the budget, and the per-user tables). The usual 25 s
 * would roll it back on a large leftover; 120 s still keeps the action (≤ 90 s purge + one ≤ 25 s
 * batch + 120 s) under the 300 s function limit. If it still times out, the purged batches stay
 * committed and the next attempt resumes from there, so repeated attempts always finish.
 */
const ACCOUNT_DELETE_TIMEOUT_S = 120;

/**
 * Delete the whole account: revoke + purge every mailbox, then the user row (cascades everything
 * else). `revokeFailed` when any mailbox's grant wasn't confirmed revoked (see `disconnectNow`):
 * the account is gone either way, so the user must be told to remove the access themselves.
 */
export async function deleteAccount(deps: PipelineDeps, userId: string): Promise<{ revokeFailed: boolean }> {
  let revokeFailed = false;
  const deadline = Date.now() + ACCOUNT_PURGE_BUDGET_MS;
  const mailboxes = await withUser(deps.pool, userId, async (_db, c) =>
    (await c.query<{ id: string; status: string }>("SELECT id, status FROM mailbox WHERE user_id = $1", [userId])).rows,
  );
  for (const m of mailboxes) {
    // A retried deletion only resumes the purge of mailboxes it already disconnected.
    if (m.status !== "disconnecting") {
      const r = await disconnectNow(deps, { userId, mailboxId: m.id });
      revokeFailed ||= r.revokeFailed;
    }
    await purgeMailbox(deps, { userId, mailboxId: m.id }, Math.max(0, deadline - Date.now()));
  }
  await withUser(deps.pool, userId, async (_db, c) => {
    await c.query("SELECT set_config('statement_timeout', $1, true)", [`${ACCOUNT_DELETE_TIMEOUT_S}s`]);
    // audit_log keeps a pseudonymous row (user_id is not a FK); written once, with the delete.
    await c.query("INSERT INTO audit_log (user_id, actor, action) VALUES ($1, 'user', 'account.deleted')", [userId]);
    // The pool's 30 s client-side query_timeout would give up first; pg reads a per-query override.
    const del = { text: `DELETE FROM "user" WHERE id = $1`, values: [userId], query_timeout: (ACCOUNT_DELETE_TIMEOUT_S + 10) * 1000 };
    await c.query(del);
  });
  return { revokeFailed };
}
