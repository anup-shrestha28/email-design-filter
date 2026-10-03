/**
 * Mailbox operations that span Gmail, the key service and the database: sync-on-open, disconnect
 * and account deletion (FREE-TIER.md §4.4, §4.9; DATA-MODEL.md §6).
 */
import "server-only";
import { withUser } from "@edf/db";
import { deleteAccount, disconnectNow, syncOnOpen as pipelineSyncOnOpen } from "@edf/pipeline";
import { getPool } from "./db";
import { emit, kickAfterSync } from "./pipeline-client";
import { pipelineDeps } from "./pipeline-deps";
import type { SessionUser } from "./session";

const ACTIVE_WRITE_EVERY_MS = 10 * 60 * 1000;

/** Record that the user opened the app (throttled write) — drives the poll cadence (FREE-TIER.md §4.3). */
async function touchActive(user: SessionUser): Promise<void> {
  const pool = await getPool();
  await withUser(pool, user.userId, (_db, c) =>
    c.query(
      `UPDATE user_settings SET last_active_at = now()
       WHERE user_id = $1 AND (last_active_at IS NULL OR last_active_at < now() - make_interval(secs => $2))`,
      [user.userId, ACTIVE_WRITE_EVERY_MS / 1000],
    ),
  );
}

export interface SyncOnOpenResult {
  newMessages: number;
  syncing: boolean;
  /**
   * The governor is at L1 or above (FREE-TIER.md §8.2): the page's timers stop (the background sync
   * and the live gallery's checks), the same rule as getSyncStatus's `pollingOff`.
   */
  pollingOff: boolean;
}

export async function syncOnOpen(user: SessionUser): Promise<SyncOnOpenResult> {
  await touchActive(user);
  let deps;
  try {
    deps = await pipelineDeps();
  } catch {
    return { newMessages: 0, syncing: false, pollingOff: false };
  }
  const r = await pipelineSyncOnOpen(deps, { userId: user.userId, role: user.role });
  if (r.newMessages > 0) await kickAfterSync(user.userId);
  const level = await deps.governorLevel().catch(() => 0);
  return { newMessages: r.newMessages + r.inlineDrained, syncing: r.syncing, pollingOff: level >= 1 };
}

/** Disconnects now; `revokeFailed` → Google didn't confirm removing the app's access (tell the user). */
export async function disconnectMailboxNow(user: SessionUser, mailboxId: string): Promise<{ revokeFailed: boolean }> {
  const deps = await pipelineDeps();
  const owned = await withUser(deps.pool, user.userId, async (_db, c) =>
    Boolean((await c.query("SELECT 1 FROM mailbox WHERE id = $1", [mailboxId])).rowCount),
  );
  if (!owned) throw new Error("Mailbox not found");
  const r = await disconnectNow(deps, { userId: user.userId, mailboxId });
  // The bulk delete runs in the background; the daily cron finishes it if Inngest can't.
  await emit({ name: "mailbox/disconnected", data: { mailboxId, userId: user.userId } }, `disconnected-${mailboxId}`);
  return { revokeFailed: r.revokeFailed };
}

/** Deletes the account now; `revokeFailed` → some mailbox's Google access wasn't confirmed removed. */
export async function deleteAccountNow(user: SessionUser): Promise<{ revokeFailed: boolean }> {
  const deps = await pipelineDeps();
  return deleteAccount(deps, user.userId);
}
