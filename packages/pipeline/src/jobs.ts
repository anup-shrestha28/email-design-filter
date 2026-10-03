/**
 * Job bodies for daily maintenance and the daily cron's Plan B (FREE-TIER.md §4.7, §4.9), as plain
 * functions with explicit time budgets. They never throw on known vendor outages: they return a
 * summary with `skipped` and write one `app_error` row (§4.2 "No Inngest function ever throws").
 */
import { withSystem, withUser, isDatabaseUnavailable } from "@edf/db";
import { releaseBatch } from "./ai";
import { raiseAlert } from "./alerts";
import { logOf, type PipelineDeps } from "./deps";
import { drain } from "./drain";
import {
  applyRetention,
  compactFeatures,
  deleteOrphanSenders,
  queueTemplateSamples,
  reapStaleRenderRequests,
  recomputeSenderAggregates,
  redriveFailed,
  retentionFor,
} from "./maintenance";
import { pollDueMailboxes, errorCode } from "./poll";
import { purgeMailbox } from "./purge";
import { sweepAndMeterSandboxes } from "./sandbox";
import { heartbeat } from "./tick";

export async function recordAppError(deps: PipelineDeps, job: string, err: unknown, detail?: string): Promise<void> {
  await withSystem(deps.pool, (_db, c) =>
    c.query("INSERT INTO app_error (job, code, detail_code) VALUES ($1, $2, $3)", [job, errorCode(err), detail ?? null]),
  ).catch(() => {});
}

/** Finish pending disconnects and purge mailboxes stuck in needs_reauth for 30+ days. */
export async function runPurges(deps: PipelineDeps, budgetMs: number): Promise<{ purged: number; pending: number }> {
  const deadline = Date.now() + budgetMs;
  const due = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ mailbox_id: string; user_id: string; status: string }>("SELECT * FROM list_mailboxes_for_purge(100)")).rows,
  );
  let purged = 0;
  for (const m of due) {
    if (Date.now() > deadline) break;
    if (m.status === "needs_reauth") {
      // Tokens are already invalid; null them and mark disconnecting before the bulk delete.
      await withUser(deps.pool, m.user_id, (_db, c) =>
        c.query(
          `UPDATE mailbox SET status = 'disconnecting', status_reason = 'reauth_expired', refresh_token_enc = NULL,
                  access_token_enc = NULL, dek_wrapped = NULL WHERE id = $1`,
          [m.mailbox_id],
        ),
      );
    }
    const done = await purgeMailbox(deps, { userId: m.user_id, mailboxId: m.mailbox_id }, Math.max(1_000, deadline - Date.now()));
    if (done) purged++;
  }
  return { purged, pending: due.length - purged };
}

export interface MaintenanceSummary {
  users: number;
  retention: number;
  compacted: number;
  redriven: number;
  samplesQueued: number;
  staleConnecting: number;
  system: Record<string, number>;
  skipped: string | null;
}

/** Per-user maintenance for every user, then system-table retention. Idempotent and resumable. */
export async function runMaintenance(
  deps: PipelineDeps,
  opts: { budgetMs: number; storageL1?: boolean; storageL2?: boolean },
): Promise<MaintenanceSummary> {
  const deadline = Date.now() + opts.budgetMs;
  const out: MaintenanceSummary = { users: 0, retention: 0, compacted: 0, redriven: 0, samplesQueued: 0, staleConnecting: 0, system: {}, skipped: null };
  try {
    const users = await withSystem(deps.pool, async (_db, c) =>
      (await c.query<{ user_id: string; role: "owner" | "friend"; mailboxes: number }>("SELECT * FROM list_active_users()")).rows,
    );
    const activeUsers = users.filter((u) => u.mailboxes > 0).length;
    for (const u of users) {
      if (Date.now() > deadline - 5_000) break;
      const policy = retentionFor(u.role, { activeUsers, storageL1: Boolean(opts.storageL1), storageL2: Boolean(opts.storageL2) });
      await withUser(deps.pool, u.user_id, async (_db, c) => {
        out.retention += await applyRetention(c, u.user_id, policy);
        out.compacted += await compactFeatures(c, u.user_id, policy.featureDays);
        out.redriven += await redriveFailed(c, u.user_id);
        await recomputeSenderAggregates(c, u.user_id);
        await deleteOrphanSenders(c, u.user_id);
        await reapStaleRenderRequests(c, u.user_id); // also when no render batch runs for this user
        out.samplesQueued += await queueTemplateSamples(c, u.user_id, u.role === "owner" ? 30 : 10);
        // A connect that never finished (tokens never sealed) is removed after a day.
        const stale = await c.query(
          "DELETE FROM mailbox WHERE user_id = $1 AND status = 'connecting' AND created_at < now() - interval '1 day'",
          [u.user_id],
        );
        out.staleConnecting += stale.rowCount ?? 0;
      });
      out.users++;
    }
    out.system = await withSystem(deps.pool, async (_db, c) => {
      const r = await c.query<{ r: Record<string, number> }>("SELECT purge_system_rows() AS r");
      return { ...(r.rows[0]?.r ?? {}) };
    });
    // AI reservations stuck in 'submitting' for > 24 h are released (FREE-TIER.md §5.1 step 7): each
    // unsettled item is settled at 0 (so its reservation is freed), then the batch is marked 'failed'.
    const stuck = await withSystem(deps.pool, async (_db, c) =>
      (await c.query<{ id: string }>(
        "SELECT id FROM ai_batch WHERE state = 'submitting' AND created_at < now() - interval '24 hours' ORDER BY created_at LIMIT 100",
      )).rows,
    );
    out.system.stuck_batches = 0;
    out.system.stuck_items_released = 0;
    for (const b of stuck) {
      if (Date.now() > deadline) break;
      out.system.stuck_items_released += await releaseBatch(deps, b.id);
      out.system.stuck_batches++;
    }
    await heartbeat(deps, "last_maintenance_at");
  } catch (err) {
    if (!isDatabaseUnavailable(err)) throw err;
    out.skipped = "database_unavailable";
    await recordAppError(deps, "maintenance", err);
  }
  logOf(deps)("maintenance.done", { users: out.users, retention: out.retention, compacted: out.compacted, skipped: out.skipped });
  return out;
}

export interface CronSummary {
  purges: { purged: number; pending: number } | null;
  maintenance: MaintenanceSummary | null;
  watchdog: { stale: string[]; ranPoll: boolean; drained: number };
}

/**
 * The daily Vercel cron (FREE-TIER.md §4.9): 270 s budget — privacy work first (purges, then
 * maintenance, ≤ 120 s), then the governor, then the watchdog, which alerts and runs poll + drain
 * inline when Inngest looks stalled.
 */
export async function runDailyCron(
  deps: PipelineDeps,
  opts: { governor?: () => Promise<unknown>; budgetMs?: number } = {},
): Promise<CronSummary> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 270_000;
  const left = () => budget - (Date.now() - started);
  const out: CronSummary = { purges: null, maintenance: null, watchdog: { stale: [], ranPoll: false, drained: 0 } };
  await heartbeat(deps, "last_cron_at");

  out.purges = await runPurges(deps, 60_000).catch(async (err) => {
    await recordAppError(deps, "cron.purges", err);
    return null;
  });
  out.maintenance = await runMaintenance(deps, { budgetMs: Math.max(10_000, Math.min(60_000, left() - 150_000)) }).catch(async (err) => {
    await recordAppError(deps, "cron.maintenance", err);
    return null;
  });
  if (opts.governor) await opts.governor().catch((err: unknown) => recordAppError(deps, "cron.governor", err));

  const state = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ last_tick_at: Date | null; last_maintenance_at: Date | null; last_render_batch_at: Date | null; inngest_paused: boolean }>(
      "SELECT last_tick_at, last_maintenance_at, last_render_batch_at, inngest_paused FROM system_state",
    )).rows[0],
  );
  const now = Date.now();
  const hours = (d: Date | null | undefined) => (d ? (now - d.getTime()) / 3_600_000 : Infinity);
  if (hours(state?.last_tick_at) > 3) out.watchdog.stale.push("STALE_TICK");
  if (hours(state?.last_maintenance_at) > 36) out.watchdog.stale.push("STALE_MAINTENANCE");
  if (hours(state?.last_render_batch_at) > 36) out.watchdog.stale.push("STALE_RENDER_BATCH");
  if (state?.inngest_paused) out.watchdog.stale.push("INNGEST_PAUSED");
  if (out.watchdog.stale.includes("STALE_TICK")) {
    // Plan B for the tick's Sandbox sweep: stop orphaned VMs and meter finished ones (§5.1).
    await sweepAndMeterSandboxes(deps).catch((err: unknown) => recordAppError(deps, "cron.sandbox_sweep", err));
  }
  const alerts = deps.alerts ?? { token: undefined, repo: undefined };
  for (const code of out.watchdog.stale) {
    await raiseAlert(deps.pool, alerts, code as Parameters<typeof raiseAlert>[2]);
  }
  if (out.watchdog.stale.includes("STALE_TICK") || out.watchdog.stale.includes("INNGEST_PAUSED")) {
    // Plan B: keep mail flowing with the remaining budget.
    if (left() > 40_000) {
      await pollDueMailboxes(deps, Math.min(60_000, left() - 30_000)).catch((err: unknown) => recordAppError(deps, "cron.poll", err));
      out.watchdog.ranPoll = true;
    }
    if (left() > 30_000) {
      const d = await drain(deps, { budgetMs: left() - 20_000, maxRows: 750 }).catch(async (err: unknown) => {
        await recordAppError(deps, "cron.drain", err);
        return null;
      });
      out.watchdog.drained = d ? d.stored + d.skipped : 0;
    }
  }
  return out;
}
