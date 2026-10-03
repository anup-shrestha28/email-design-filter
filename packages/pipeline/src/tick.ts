/**
 * Pieces of the `pipeline-tick` function (FREE-TIER.md §4.2) and sync-on-open (§4.4), as plain
 * functions so Inngest steps, the daily cron (Plan B) and Server Actions can all call them.
 */
import { withSystem, withUser } from "@edf/db";
import { effectiveImportance, importanceLevel } from "@edf/core";
import { drain, type DrainResult } from "./drain";
import { pollMailbox } from "./poll";
import { logOf, type PipelineDeps } from "./deps";

export const DRAIN_STEP = { budgetMs: 200_000, maxRows: 750 } as const;
export const MAX_DRAIN_STEPS = 5;
export const CONTINUATION_KICKS_PER_HOUR = 6;

export type Heartbeat = "last_tick_at" | "last_maintenance_at" | "last_render_batch_at" | "last_cron_at";

export async function heartbeat(deps: PipelineDeps, field: Heartbeat): Promise<void> {
  // `field` is a closed union, never user input; the successful tick also clears inngest_paused.
  const clear = field === "last_tick_at" ? ", inngest_paused = false" : "";
  await withSystem(deps.pool, (_db, c) => c.query(`UPDATE system_state SET ${field} = now()${clear}, updated_at = now()`));
}

export async function drainEligibleCount(deps: PipelineDeps): Promise<number> {
  return withSystem(deps.pool, async (_db, c) => Number((await c.query<{ n: string }>("SELECT count_drain_eligible() AS n")).rows[0]?.n ?? 0));
}

export async function drainStep(deps: PipelineDeps): Promise<DrainResult> {
  return drain(deps, { budgetMs: DRAIN_STEP.budgetMs, maxRows: DRAIN_STEP.maxRows });
}

/** The governor's `continuationKicksOff` (Inngest soft, or L3; FREE-TIER.md §8.3), from `app_setting`. */
async function continuationKicksOff(deps: PipelineDeps): Promise<boolean> {
  return withSystem(deps.pool, async (_db, c) => {
    const r = await c.query<{ value: { level?: number; actions?: { continuationKicksOff?: boolean } } | null }>(
      "SELECT value FROM app_setting WHERE key = 'governor'",
    );
    const v = r.rows[0]?.value;
    return Number(v?.level ?? 0) >= 3 || v?.actions?.continuationKicksOff === true;
  });
}

/**
 * Continuation kick (§4.2): only if this run drained ≥ 1 row AND eligible rows remain, capped at 6
 * per hour globally (counted in system_state), and never while the governor has kicks off (Inngest
 * soft or L3, §8.3: the backlog then waits for the next scheduled tick). Returns true when a kick
 * should be sent.
 */
export async function takeContinuationKick(deps: PipelineDeps, drainedRows: number): Promise<boolean> {
  if (drainedRows < 1) return false;
  if ((await drainEligibleCount(deps)) === 0) return false;
  if (await continuationKicksOff(deps)) return false;
  return withSystem(deps.pool, async (_db, c) => {
    const r = await c.query<{ ok: boolean }>(
      `UPDATE system_state SET
         kick_count = CASE WHEN kick_window_start IS NULL OR kick_window_start < now() - interval '1 hour' THEN 1 ELSE kick_count + 1 END,
         kick_window_start = CASE WHEN kick_window_start IS NULL OR kick_window_start < now() - interval '1 hour' THEN now() ELSE kick_window_start END,
         updated_at = now()
       WHERE kick_window_start IS NULL OR kick_window_start < now() - interval '1 hour' OR kick_count < $1
       RETURNING true AS ok`,
      [CONTINUATION_KICKS_PER_HOUR],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Materialise lapsed time-bound importance boosts (OTP 1 h, deal ≤ 48 h, shipping 14 d). Touches only
 * rows whose boost expired (index-driven), so the tick stays cheap; readers already compute the
 * effective value from the reason codes.
 */
export async function sweepImportance(deps: PipelineDeps, limit = 500): Promise<number> {
  const rows = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ email_id: string; user_id: string }>("SELECT * FROM list_importance_expired($1)", [limit])).rows,
  );
  const byUser = new Map<string, string[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.email_id]);
  let updated = 0;
  const now = new Date();
  for (const [userId, ids] of byUser) {
    updated += await withUser(deps.pool, userId, async (_db, c) => {
      const cur = await c.query<{ id: string; importance_score: number | null; importance_reasons: string[] }>(
        "SELECT id, importance_score, importance_reasons FROM email WHERE id = ANY($1::uuid[])",
        [ids],
      );
      let n = 0;
      for (const e of cur.rows) {
        const eff = effectiveImportance({ score: e.importance_score ?? 0, reasons: e.importance_reasons }, now);
        const remaining = eff.reasons.filter((r) => r.startsWith("boost:"));
        const nextExpiry = remaining
          .map((r) => Number(r.split(":")[3]))
          .filter((x) => Number.isFinite(x) && x * 1000 > now.getTime())
          .sort((a, b) => a - b)[0];
        await c.query(
          `UPDATE email SET importance_score = $2, importance = $3, importance_reasons = $4, importance_expires_at = $5, updated_at = now()
           WHERE id = $1`,
          [e.id, eff.score, importanceLevel(eff.score), eff.reasons, nextExpiry ? new Date(nextExpiry * 1000) : null],
        );
        n++;
      }
      return n;
    });
  }
  return updated;
}

export interface SyncOnOpenResult {
  newMessages: number;
  syncing: boolean;
  /** An inline drain ran because Inngest is paused (FREE-TIER.md §4.4). */
  inlineDrained: number;
}

/**
 * A tick older than this means Inngest is paused or down (FREE-TIER.md §4.9), even when its
 * `send()` still succeeds: functions auto-paused after repeated failures, or runs stopped at the
 * monthly quota, still accept events.
 */
export const STALE_TICK_MINUTES = 90;

/**
 * Whether Inngest counts as paused: `inngest_paused` (a send failed with a quota/paused error), or
 * the last tick is more than 90 minutes old (never ticked counts too, as for the cron's watchdog),
 * which also sets the flag. The next successful tick clears it (`heartbeat`).
 */
export async function inngestPaused(deps: PipelineDeps): Promise<boolean> {
  return withSystem(deps.pool, async (_db, c) => {
    const stale = await c.query(
      `UPDATE system_state SET inngest_paused = true, updated_at = now()
       WHERE NOT inngest_paused AND (last_tick_at IS NULL OR last_tick_at < now() - make_interval(mins => $1))`,
      [STALE_TICK_MINUTES],
    );
    if ((stale.rowCount ?? 0) > 0) return true;
    return Boolean((await c.query<{ p: boolean }>("SELECT inngest_paused AS p FROM system_state")).rows[0]?.p);
  });
}

/**
 * Sync when the app is opened: ≤ 2 history pages per mailbox if last synced > 2 min ago (friends every
 * 2 h at governor L2); an inline drain (≤ 20 s) only while Inngest is paused.
 */
export async function syncOnOpen(
  deps: PipelineDeps,
  user: { userId: string; role: "owner" | "friend" },
): Promise<SyncOnOpenResult> {
  const level = await deps.governorLevel();
  if (level >= 3) return { newMessages: 0, syncing: false, inlineDrained: 0 };
  const minMinutes = user.role === "friend" && level >= 2 ? 120 : 2;
  const due = await withUser(deps.pool, user.userId, async (_db, c) =>
    (
      await c.query<{ id: string }>(
        `SELECT id FROM mailbox WHERE user_id = $1 AND status = 'active'
           AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => $2))`,
        [user.userId, minMinutes],
      )
    ).rows,
  );
  let inserted = 0;
  for (const m of due) {
    try {
      const r = await pollMailbox(deps, { mailboxId: m.id, userId: user.userId }, { maxPages: 2, budgetMs: 8_000, source: "sync" });
      if (r.kind === "polled") inserted += r.inserted;
      if (r.kind === "resync") inserted += r.listed;
    } catch (err) {
      logOf(deps)("sync_on_open.error", { code: err instanceof Error ? err.name : "unknown" });
    }
  }
  const paused = await inngestPaused(deps);
  let inlineDrained = 0;
  if (paused) {
    const d = await drain(deps, { budgetMs: 20_000, maxRows: 100, userId: user.userId, concurrency: 2 });
    inlineDrained = d.stored + d.skipped;
  }
  const pending = await withUser(deps.pool, user.userId, async (_db, c) =>
    Number(
      (await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM message_ledger WHERE user_id = $1 AND state IN ('pending', 'pending_full')",
        [user.userId],
      )).rows[0]?.n ?? 0,
    ),
  );
  return { newMessages: inserted, syncing: pending > 0, inlineDrained };
}
