"use server";
/**
 * Email triage and corrections (DESIGN.md §9.3, §7.3). Gmail stays read-only: triage state is
 * app-local. Every action: Zod input, session, RLS-scoped transaction (ownership by construction).
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { onDemandPausedReason, renderGovernorOf } from "@edf/budget";
import { and, eq, sql, withUser, schema } from "@edf/db";
import { EMAIL_TYPES } from "@edf/core/types";
// Not the @edf/pipeline barrel: the Analyze action stays light (maintenance.ts has no runtime imports).
import { STALE_RENDER_MINUTES } from "@edf/pipeline/maintenance";
import { getPool } from "../db";
import { requireUserOrThrow } from "../session";
import { ON_DEMAND_LIMITS } from "../limits";
import { requestRender } from "../pipeline-client";
import { rendererSetUp } from "@/env";
import { RENDERER_NOT_SET_UP, RENDERS_SWITCHED_OFF, type AnalyzeOutcome } from "../queries/types";
import { fail, ok, toFailure, type ActionResult } from "./result";

const id = z.string().uuid();

export async function setDone(emailId: string, done: boolean): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ emailId: id, done: z.boolean() }).parse({ emailId, done });
    const pool = await getPool();
    await withUser(pool, user.userId, (db) =>
      db.update(schema.email)
        .set({ doneAt: input.done ? new Date() : null, updatedAt: new Date() })
        .where(eq(schema.email.id, input.emailId)),
    );
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

export async function setPinned(emailId: string, pinned: boolean): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ emailId: id, pinned: z.boolean() }).parse({ emailId, pinned });
    const pool = await getPool();
    await withUser(pool, user.userId, (db) =>
      db.update(schema.email)
        .set({ pinnedAt: input.pinned ? new Date() : null, updatedAt: new Date() })
        .where(eq(schema.email.id, input.emailId)),
    );
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

/** Opening an email in the app counts toward engagement (read = Gmail read OR opened in app). */
export async function markOpened(emailId: string): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = id.parse(emailId);
    const pool = await getPool();
    await withUser(pool, user.userId, (db) =>
      db.update(schema.email)
        .set({ openedInAppAt: new Date() })
        .where(and(eq(schema.email.id, input), sql`${schema.email.openedInAppAt} IS NULL`)),
    );
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

/**
 * "Analyze this email": queue an on-demand render (you ≤ 5/day, friends ≤ 1/day). While the
 * governor has this user's renders paused (FREE-TIER.md §8.2–8.3), the owner has them switched off,
 * or no renderer is set up (RENDERER=off, or the Sandbox without its snapshot), nothing is queued
 * and the result says why, so a request never waits silently for a VM that won't start (and the
 * tick never keeps starting render runs for it).
 */
export async function requestAnalyze(emailId: string, withAi = false): Promise<ActionResult<AnalyzeOutcome>> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ emailId: id, withAi: z.boolean() }).parse({ emailId, withAi });
    const pool = await getPool();
    const limits = ON_DEMAND_LIMITS[user.role];
    const result = await withUser(pool, user.userId, async (_db, client) => {
      const e = await client.query<{ security_sensitive: boolean; design_status: string; suspicious: boolean }>(
        "SELECT security_sensitive, design_status, suspicious FROM email WHERE id = $1",
        [input.emailId],
      );
      const row = e.rows[0];
      if (!row) return "not_found" as const;
      if (row.security_sensitive || row.design_status === "plain_text" || row.design_status === "skipped") return "not_designable" as const;
      if (input.withAi && row.suspicious) return "not_designable" as const;
      const gov = await client.query<{ key: string; value: unknown }>("SELECT key, value FROM app_setting WHERE key IN ('governor', 'kill.render')");
      const setting = (k: string) => gov.rows.find((r) => r.key === k)?.value;
      // No renderer, then the owner's emergency stop (`kill.render`): the render step would refuse
      // the request anyway (with no renderer it would stay queued for good).
      const paused = !rendererSetUp()
        ? RENDERER_NOT_SET_UP
        : setting("kill.render") === true
          ? RENDERS_SWITCHED_OFF
          : onDemandPausedReason(renderGovernorOf(setting("governor") as Parameters<typeof renderGovernorOf>[0]), user.role);
      if (paused) return { paused };
      // Inngest soft cap (FREE-TIER.md §8.3): renders only in the nightly run. The request is still
      // queued (the nightly run picks it up), but no render/requested event starts a run now.
      const nightlyOnly = (setting("governor") as { actions?: { rendersNightlyOnly?: boolean } } | undefined)?.actions?.rendersNightlyOnly === true;
      // One request per user at a time from here to commit, so parallel requests for different
      // emails can't all pass the count below before any of them inserts (READ COMMITTED: the
      // count after the lock sees what the previous holder committed).
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`render_request:${user.userId}`]);
      // A request a killed render step interrupted doesn't use up the day's allowance.
      const usage = await client.query<{ renders: string; reviews: string }>(
        `SELECT count(*) FILTER (WHERE kind = 'on_demand') AS renders, count(*) FILTER (WHERE want_ai) AS reviews
         FROM render_request WHERE requested_at >= date_trunc('day', now()) AND error IS DISTINCT FROM 'interrupted'`,
      );
      const u = usage.rows[0];
      if (Number(u?.renders ?? 0) >= limits.renders) return "limit" as const;
      if (input.withAi && Number(u?.reviews ?? 0) >= limits.aiReviews) return "limit" as const;
      // A request a killed render step left 'running' (never picked again) goes back to the queue.
      // An active request this click turns into an on-demand render or AI review (a queued sample,
      // a re-queued fill, yesterday's render without AI) becomes today's request: dated now and
      // without an earlier 'interrupted' error, so it counts toward today's allowance like a new
      // one. A repeat click that changes nothing keeps its date. A request a render is working on
      // right now (running, not stale) is left alone: that render already chose its options (without
      // AI, say) and marks the row done, so an upgrade written onto it would use up today's allowance
      // for a review that never runs (only a page loaded before the render started can click here).
      await client.query(
        `INSERT INTO render_request (user_id, email_id, kind, want_ai) VALUES ($1, $2, 'on_demand', $3)
         ON CONFLICT (email_id) WHERE state IN ('queued', 'running') DO UPDATE SET want_ai = render_request.want_ai OR EXCLUDED.want_ai, kind = 'on_demand',
           state = CASE WHEN render_request.state = 'running' AND render_request.updated_at < now() - make_interval(mins => $4)
                        THEN 'queued' ELSE render_request.state END,
           requested_at = CASE WHEN render_request.kind <> 'on_demand' OR (EXCLUDED.want_ai AND NOT render_request.want_ai)
                               THEN now() ELSE render_request.requested_at END,
           error = CASE WHEN render_request.kind <> 'on_demand' OR (EXCLUDED.want_ai AND NOT render_request.want_ai)
                        THEN NULL ELSE render_request.error END
         WHERE render_request.state = 'queued' OR render_request.updated_at < now() - make_interval(mins => $4)`,
        [user.userId, input.emailId, input.withAi, STALE_RENDER_MINUTES],
      );
      return nightlyOnly ? ("queued_nightly" as const) : ("queued" as const);
    });
    if (result === "not_found") return fail("Email not found.", "not_found");
    if (result === "not_designable") return fail("This email can't be analysed.", "invalid");
    if (result === "limit") return fail("You've reached today's limit. It resets at midnight UTC.", "limit");
    if (typeof result === "object") return ok({ status: "paused", reason: result.paused });
    if (result === "queued") await requestRender(user.userId);
    revalidatePath(`/email/${input.emailId}`);
    return ok({ status: "queued" });
  } catch (err) {
    return toFailure(err);
  }
}

const typeSchema = z.enum(EMAIL_TYPES);

/** "Correct this": fix the type; optionally always classify this sender that way (DESIGN.md §7.3). */
export async function correctType(emailId: string, primaryType: string, applyToSender: boolean): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ emailId: id, primaryType: typeSchema, applyToSender: z.boolean() }).parse({ emailId, primaryType, applyToSender });
    const pool = await getPool();
    await withUser(pool, user.userId, async (db) => {
      const [row] = await db
        .select({ senderId: schema.email.senderId, old: schema.email.primaryType })
        .from(schema.email)
        .where(eq(schema.email.id, input.emailId));
      if (!row) return;
      await db
        .update(schema.email)
        .set({ primaryType: input.primaryType, typeSource: "user", typeConfidence: 1, updatedAt: new Date() })
        .where(eq(schema.email.id, input.emailId));
      await db.insert(schema.userFeedback).values({
        userId: user.userId,
        emailId: input.emailId,
        senderId: row.senderId,
        field: "primary_type",
        oldValue: row.old,
        newValue: input.primaryType,
      });
      if (input.applyToSender && row.senderId) {
        await db.update(schema.sender).set({ typeOverride: input.primaryType, updatedAt: new Date() }).where(eq(schema.sender.id, row.senderId));
        await db
          .update(schema.email)
          .set({ primaryType: input.primaryType, typeSource: "user", updatedAt: new Date() })
          .where(and(eq(schema.email.senderId, row.senderId), sql`${schema.email.typeSource} <> 'user'`));
      }
    });
    revalidatePath("/inbox");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

/** "This is personal": hard-delete the email and stop storing mail from this sender (DESIGN.md §7.2). */
export async function markPersonal(emailId: string): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = id.parse(emailId);
    const pool = await getPool();
    await withUser(pool, user.userId, async (db) => {
      const [row] = await db
        .select({ senderId: schema.email.senderId, mailboxId: schema.email.mailboxId, pmid: schema.email.providerMessageId })
        .from(schema.email)
        .where(eq(schema.email.id, input));
      if (!row) return;
      await db.insert(schema.userFeedback).values({ userId: user.userId, senderId: row.senderId, field: "is_personal", newValue: "true" });
      if (row.senderId) {
        await db.update(schema.sender).set({ typeOverride: "personal", muted: true, updatedAt: new Date() }).where(eq(schema.sender.id, row.senderId));
        await db.delete(schema.email).where(eq(schema.email.senderId, row.senderId));
      } else {
        await db.delete(schema.email).where(eq(schema.email.id, input));
      }
      await db
        .update(schema.messageLedger)
        .set({ state: "skipped", reason: "personal", updatedAt: new Date() })
        .where(and(eq(schema.messageLedger.mailboxId, row.mailboxId), eq(schema.messageLedger.providerMessageId, row.pmid)));
    });
    revalidatePath("/inbox");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}
