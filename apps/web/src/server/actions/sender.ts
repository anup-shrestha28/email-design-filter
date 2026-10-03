"use server";
/** Sender actions (DESIGN.md §9.5 Senders): mute, importance bias, "open unsubscribe page". */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, withUser, schema } from "@edf/db";
import { signOutLink } from "@edf/crypto";
import { getPool } from "../db";
import { outKeys } from "../keys";
import { requireUserOrThrow } from "../session";
import { fail, ok, toFailure, type ActionResult } from "./result";

const id = z.string().uuid();

/** Mute hides the sender's mail everywhere (denormalized onto email.sender_muted, bulk-updated). */
export async function setSenderMuted(senderId: string, muted: boolean): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ senderId: id, muted: z.boolean() }).parse({ senderId, muted });
    const pool = await getPool();
    await withUser(pool, user.userId, async (db) => {
      await db.update(schema.sender).set({ muted: input.muted, updatedAt: new Date() }).where(eq(schema.sender.id, input.senderId));
      await db.update(schema.email).set({ senderMuted: input.muted }).where(eq(schema.email.senderId, input.senderId));
    });
    revalidatePath("/senders");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

export async function setImportanceBias(senderId: string, bias: number): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ senderId: id, bias: z.number().int().min(-2).max(2) }).parse({ senderId, bias });
    const pool = await getPool();
    await withUser(pool, user.userId, (db) =>
      db.update(schema.sender).set({ userImportanceBias: input.bias, updatedAt: new Date() }).where(eq(schema.sender.id, input.senderId)),
    );
    revalidatePath("/senders");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}

/**
 * "Open unsubscribe page": records the click (for "unsubscribed but still sending") and returns a
 * session-bound /out interstitial URL. We never visit the link ourselves (DESIGN.md §11.6).
 */
export async function openUnsubscribe(senderId: string): Promise<ActionResult<{ url: string | null; mailto: string | null }>> {
  try {
    const user = await requireUserOrThrow();
    const input = id.parse(senderId);
    const pool = await getPool();
    const row = await withUser(pool, user.userId, async (db) => {
      const [s] = await db.select({ lu: schema.sender.listUnsubscribe }).from(schema.sender).where(eq(schema.sender.id, input));
      if (!s) return null;
      await db.update(schema.sender).set({ unsubscribedAt: new Date(), updatedAt: new Date() }).where(eq(schema.sender.id, input));
      return s;
    });
    if (!row) return fail("Sender not found.", "not_found");
    const https = row.lu?.https?.[0] ?? null;
    const mailto = row.lu?.mailto?.[0] ?? null;
    let url: string | null = null;
    if (https) {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const token = signOutLink(outKeys(), { sessionId: `u:${user.userId}`, url: https, exp });
      url = `/out?u=${encodeURIComponent(https)}&t=${encodeURIComponent(token)}`;
    }
    revalidatePath("/senders");
    return ok({ url, mailto });
  } catch (err) {
    return toFailure(err);
  }
}
