"use server";
/**
 * Settings, consent, invites, sync-on-open, export, disconnect and account deletion
 * (DESIGN.md §4.3, §9.5, §11.3; FREE-TIER.md §4.4, §4.9, §9.4). Sensitive actions require a
 * fresh session (≤ 10 minutes).
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, withUser, schema } from "@edf/db";
import { signInvite } from "@edf/crypto";
import { env } from "@/env";
import { getPool } from "../db";
import { inviteKeys } from "../keys";
import { requireFreshSession, requireUserOrThrow } from "../session";
import { deleteAccountNow, disconnectMailboxNow, syncOnOpen, type SyncOnOpenResult } from "../mailbox-ops";
import { fail, ok, toFailure, type ActionResult } from "./result";

const settingsSchema = z
  .object({
    timezone: z.string().min(1).max(64).refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }),
    loadImagesForAnalysis: z.boolean(),
    linkCheckOptIn: z.boolean(),
    backfillWindowDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
  })
  .partial();

export async function updateSettings(input: z.input<typeof settingsSchema>): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const values = settingsSchema.parse(input);
    // Friends get 30 days; 180 days only for the owner (FREE-TIER.md §4.5). L0 and ≤ 5 active users are
    // checked at admission (admitBackfill), which imports 90 days instead while there are more users.
    if (values.backfillWindowDays && user.role !== "owner" && values.backfillWindowDays !== 30) {
      return fail("Import window is 30 days for invited accounts.", "invalid");
    }
    const pool = await getPool();
    await withUser(pool, user.userId, (db) =>
      db.update(schema.userSettings).set({ ...values, updatedAt: new Date() }).where(eq(schema.userSettings.userId, user.userId)),
    );
    revalidatePath("/settings");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

/** The in-app disclosure checkbox, immediately before the Google redirect (FREE-TIER.md §9.4). */
export async function acceptDisclosure(): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const pool = await getPool();
    await withUser(pool, user.userId, async (db) => {
      await db
        .update(schema.userSettings)
        .set({ aiProcessingConsentAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.userSettings.userId, user.userId));
      await db.insert(schema.auditLog).values({ userId: user.userId, actor: "user", action: "disclosure.accepted" });
    });
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

/** Sync when the app is opened (FREE-TIER.md §4.4). Throttled in Postgres; never throws to the UI. */
export async function syncNow(): Promise<ActionResult<SyncOnOpenResult>> {
  try {
    const user = await requireUserOrThrow();
    const r = await syncOnOpen(user);
    return ok(r);
  } catch (err) {
    return toFailure(err);
  }
}

// ───────────────────────── invites (owner only) ─────────────────────────

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export async function addInvite(email: string): Promise<ActionResult<{ link: string }>> {
  try {
    const user = await requireUserOrThrow();
    if (user.role !== "owner") return fail("Only the owner can invite people.", "unauthorized");
    const addr = emailSchema.parse(email);
    const pool = await getPool();
    const { used, enabled } = await withUser(pool, user.userId, async (_db, c) => {
      const n = await c.query<{ n: string }>("SELECT count(*) AS n FROM oauth_subject_seen");
      const s = await c.query<{ value: unknown }>("SELECT value FROM app_setting WHERE key = 'invites.enabled'");
      return { used: Number(n.rows[0]?.n ?? 0), enabled: s.rows[0]?.value !== false };
    });
    // The owner's switch (`app_setting` invites.enabled = false): no new invites until it is back on.
    if (!enabled) return fail("Invites are switched off right now.", "limit");
    // The unverified app's 100-account lifetime cap: invites stop at 90 (FREE-TIER.md §8.3).
    if (used >= 90) return fail("Invites are paused: the Google account limit is nearly reached.", "limit");
    await withUser(pool, user.userId, async (db, c) => {
      await c.query("SELECT add_invite($1, 'friend')", [addr]);
      await db.insert(schema.auditLog).values({ userId: user.userId, actor: "user", action: "invite.created" });
    });
    const exp = Math.floor(Date.now() / 1000) + 14 * 86_400;
    const token = signInvite(inviteKeys(), { email: addr, exp });
    revalidatePath("/settings");
    return ok({ link: `${env().APP_ORIGIN.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}` });
  } catch (err) {
    return toFailure(err);
  }
}

export async function removeInvite(email: string): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    if (user.role !== "owner") return fail("Only the owner can manage invites.", "unauthorized");
    const addr = emailSchema.parse(email);
    const pool = await getPool();
    const friendIds = await withUser(pool, user.userId, async (_db, c) => {
      const r = await c.query<{ removed: boolean }>("SELECT remove_invite($1) AS removed", [addr]);
      if (!r.rows[0]?.removed) return [];
      const u = await c.query<{ id: string }>('SELECT id FROM "user" WHERE lower(email) = $1', [addr]);
      return u.rows.map((row) => row.id).filter((id) => id !== user.userId);
    });
    // A joined friend loses more than sign-in: their mailboxes stop being polled and processed
    // (DESIGN.md §11.8). Paused, not deleted: if the owner invites them again, they sign in and
    // reconnect to resume (the reconnect sets the mailbox active again). Only active mailboxes:
    // needs_reauth ones are not polled anyway, and leaving them as they are keeps them in the
    // automatic 30-day purge (list_mailboxes_for_purge), which skips paused mailboxes.
    for (const friendId of friendIds) {
      await withUser(pool, friendId, (_db, c) =>
        c.query(
          `UPDATE mailbox SET status = 'paused', status_reason = 'invite_removed', updated_at = now()
           WHERE user_id = $1 AND status = 'active'
             AND EXISTS (SELECT 1 FROM user_settings us WHERE us.user_id = $1 AND us.role <> 'owner')`,
          [friendId],
        ),
      );
    }
    revalidatePath("/settings");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

// ───────────────────────── disconnect & delete (fresh session) ─────────────────────────

/**
 * Disconnect never depends on Inngest (FREE-TIER.md §4.9): revoke synchronously, null the tokens,
 * mark disconnecting, then emit the bulk-delete event (the daily cron finishes it if Inngest can't).
 * `data.revokeFailed` when Google didn't confirm removing the access: the tokens are gone either
 * way, so only the user can remove the grant now (the card tells them where).
 */
export async function disconnectMailbox(mailboxId: string): Promise<ActionResult<{ revokeFailed: true } | undefined>> {
  try {
    const user = await requireFreshSession();
    const id = z.string().uuid().parse(mailboxId);
    const { revokeFailed } = await disconnectMailboxNow(user, id);
    revalidatePath("/settings");
    return revokeFailed ? ok({ revokeFailed: true as const }) : ok();
  } catch (err) {
    return toFailure(err);
  }
}

/** `data.revokeFailed` as for `disconnectMailbox`: the account is deleted, but Google didn't confirm removing some access. */
export async function deleteAccount(confirmEmail: string): Promise<ActionResult<{ revokeFailed: true } | undefined>> {
  try {
    const user = await requireFreshSession();
    if (emailSchema.parse(confirmEmail) !== user.email.toLowerCase()) {
      return fail("Type your account email to confirm.", "invalid");
    }
    const { revokeFailed } = await deleteAccountNow(user);
    return revokeFailed ? ok({ revokeFailed: true as const }) : ok();
  } catch (err) {
    return toFailure(err);
  }
}
