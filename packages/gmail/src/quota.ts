/**
 * The per-mailbox Gmail quota bucket (DESIGN.md §5.2, DATA-MODEL.md §3 `gmail_quota`).
 * Every Gmail call site reserves its units here first. Capacity 5,500 units, refill
 * 5,500 units/min (Gmail's limit is 6,000/min per user). Background work keeps a 1,000-unit
 * floor in reserve so the viewer never sees 429s; the viewer's floor is 0.
 *
 * Call inside a short `withUser` transaction of its own, never around the Gmail request.
 */
import { sql, type Db } from "@edf/db";

export const QUOTA_CAPACITY = 5500;
export const QUOTA_REFILL_PER_MINUTE = 5500;
/** Floor for background work (sync, backfill, drain, render refetch). */
export const FLOOR_BACKGROUND = 1000;
/** Floor for the interactive viewer. */
export const FLOOR_VIEWER = 0;

export type QuotaReservation = { ok: true; tokensLeft: number } | { ok: false; waitMs: number };

/**
 * Create the mailbox's bucket row if missing (full bucket). The tenant comes from the mailbox
 * row itself, so this works under RLS inside `withUser`.
 */
export async function ensureQuotaRow(db: Db, mailboxId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO gmail_quota (mailbox_id, user_id)
    SELECT m.id, m.user_id FROM mailbox m WHERE m.id = ${mailboxId}::uuid
    ON CONFLICT (mailbox_id) DO NOTHING`);
}

/**
 * Reserve `units` from the bucket, keeping `floor` in reserve — DESIGN.md §5.2's UPDATE exactly
 * (parameters are cast only so Postgres can type them). On failure returns the computed wait
 * until `units + floor` will be available (for `RetryAfterError`).
 */
export async function reserveQuota(
  db: Db,
  p: { mailboxId: string; units: number; floor: number },
): Promise<QuotaReservation> {
  const { mailboxId, units, floor } = p;
  if (!Number.isInteger(units) || units <= 0)
    throw new RangeError("reserveQuota: units must be a positive integer");
  if (!Number.isInteger(floor) || floor < 0)
    throw new RangeError("reserveQuota: floor must be a non-negative integer");
  if (units + floor > QUOTA_CAPACITY)
    throw new RangeError("reserveQuota: units + floor exceed the bucket capacity");

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await db.execute<{ tokens: number }>(sql`
      UPDATE gmail_quota
         SET tokens = LEAST(5500, tokens + EXTRACT(EPOCH FROM now() - updated_at) * 5500/60) - ${units}::double precision,
             updated_at = now()
       WHERE mailbox_id = ${mailboxId}::uuid
         AND LEAST(5500, tokens + EXTRACT(EPOCH FROM now() - updated_at) * 5500/60) >= ${units}::double precision + ${floor}::double precision
      RETURNING tokens`);
    const hit = res.rows[0];
    if (hit) return { ok: true, tokensLeft: Number(hit.tokens) };

    const cur = await db.execute<{ avail: number | string }>(sql`
      SELECT LEAST(5500, tokens + EXTRACT(EPOCH FROM now() - updated_at) * 5500/60)::double precision AS avail
        FROM gmail_quota WHERE mailbox_id = ${mailboxId}::uuid`);
    const row = cur.rows[0];
    if (row) return { ok: false, waitMs: quotaWaitMs(Number(row.avail), units, floor) };
    await ensureQuotaRow(db, mailboxId);
  }
  throw new Error("reserveQuota: mailbox not found");
}

/** Milliseconds until `units + floor` tokens are available at the refill rate (≥ 1). */
export function quotaWaitMs(available: number, units: number, floor: number): number {
  const missing = units + floor - (Number.isFinite(available) ? available : 0);
  if (missing <= 0) return 1;
  return Math.max(1, Math.ceil((missing / (QUOTA_REFILL_PER_MINUTE / 60)) * 1000));
}
