/**
 * The owner's System page (FREE-TIER.md §8.3 "Your System page shows"): every resource against its
 * self-cap and hard limit, the governor level, heartbeats, failing mailboxes, AI spend, recent error
 * codes, kill switches and the Google lifetime-account counter. Read-only (never persists the
 * governor — the tick and the daily cron do that). Owner only: the page calls requireOwner(), and the
 * aggregate counts come from system_overview(), which re-checks the owner role in the database.
 */
import "server-only";
import { withSystem, withUser } from "@edf/db";
import { FREE_TIER_PROFILE, computeGovernor, loadUsageSnapshot, type ResourceStatus } from "@edf/budget";
import { env } from "@/env";
import { getPool } from "../db";
import type { ResourceRow, SystemStatus } from "./types";

const LABELS: Record<string, string> = {
  "vercel.cpu_s": "Vercel Active CPU",
  "vercel.invocations": "Vercel invocations",
  "vercel.mem_gbh": "Vercel provisioned memory",
  "vercel.edge_requests": "Vercel edge requests",
  "vercel.fot_mb": "Vercel Fast Origin Transfer",
  "vercel.fdt_mb": "Vercel Fast Data Transfer",
  "sandbox.cpu_s": "Sandbox CPU (renders)",
  "sandbox.creations": "Sandbox creations",
  "sandbox.mem_gbh": "Sandbox memory",
  "inngest.executions": "Inngest executions",
  "neon.cu_h": "Neon compute",
  "neon.storage_mb": "Neon storage",
  "neon.transfer_mb": "Neon network transfer",
  "anthropic.usd": "Claude (Opus 5) spend",
  "gmail.units": "Gmail API units",
};

function windowOf(code: string): ResourceRow["window"] {
  if (code === "neon.storage_mb") return "now";
  if (code === "anthropic.usd") return "month"; // derived from G, not in the profile list
  const spec = FREE_TIER_PROFILE.resources.find((r) => r.code === code);
  if (!spec) return "now";
  return spec.window === "calendar_month" ? "month" : spec.window === "billing_period" ? "billing_period" : "rolling_30d";
}

function toRow(r: ResourceStatus): ResourceRow {
  return {
    key: r.code,
    label: LABELS[r.code] ?? r.code,
    unit: r.unit,
    used: Math.round(r.value * 100) / 100,
    selfCap: r.selfCap,
    hardLimit: r.hardLimit,
    window: windowOf(r.code),
    ratio: r.selfCap > 0 ? r.value / r.selfCap : 0,
  };
}

export async function getSystemStatus(ownerId: string): Promise<SystemStatus> {
  const pool = await getPool();
  const now = new Date();
  const snapshot = await loadUsageSnapshot(pool, now);
  // Live view of every resource; the level the system is *acting on* is the persisted one below.
  const gov = computeGovernor({ ...snapshot, profile: FREE_TIER_PROFILE, now });

  const overview = await withUser(pool, ownerId, async (_db, c) => {
    const r = await c.query<{
      users: number;
      mailboxes_total: number;
      mailboxes_active: number;
      mailboxes_needs_reauth: number;
      mailboxes_backfilling: number;
      ledger_failed: string;
      ledger_pending: string;
    }>("SELECT * FROM system_overview()");
    return r.rows[0]!;
  });

  const db = await withSystem(pool, async (_db, c) => {
    const state = await c.query<{
      last_tick_at: Date | null;
      last_maintenance_at: Date | null;
      last_render_batch_at: Date | null;
      last_cron_at: Date | null;
      inngest_paused: boolean;
    }>("SELECT last_tick_at, last_maintenance_at, last_render_batch_at, last_cron_at, inngest_paused FROM system_state");
    const settings = await c.query<{ key: string; value: unknown }>("SELECT key, value FROM app_setting");
    const errors = await c.query<{ code: string; job: string; n: string; last_at: Date }>(
      `SELECT code, job, count(*) AS n, max(at) AS last_at FROM app_error
       WHERE at > now() - interval '7 days' GROUP BY code, job ORDER BY max(at) DESC LIMIT 20`,
    );
    // edf-keys reports `alert_unconfigured` in its audit counts when it can't open GitHub alert issues.
    const keysAlert = await c.query<{ n: string }>(
      "SELECT coalesce(sum(amount), 0) AS n FROM usage_ledger WHERE resource = 'keys.alert_unconfigured' AND day >= current_date - 1",
    );
    return { state: state.rows[0], settings: settings.rows, errors: errors.rows, keysAlertUnconfigured: Number(keysAlert.rows[0]?.n ?? 0) > 0 };
  });

  const setting = (k: string) => db.settings.find((s) => s.key === k)?.value;
  const aiPaused = setting("ai.paused") as { paused?: boolean; reason?: string | null } | undefined;
  const persisted = setting("governor") as { level?: number; since?: string | null; triggers?: string[] } | undefined;
  const killSwitches: Record<string, boolean> = {};
  for (const s of db.settings) if (s.key.startsWith("kill.")) killSwitches[s.key.slice(5)] = s.value === true;
  const level = (Number(persisted?.level ?? gov.level) || 0) as 0 | 1 | 2 | 3;
  const warnings: SystemStatus["warnings"] = [];
  if (db.keysAlertUnconfigured) {
    warnings.push({
      code: "KEYS_ALERT_UNCONFIGURED",
      message: "The key service can't open GitHub alert issues. Set KEYS_ALERT_TOKEN and GITHUB_ALERT_REPO on the keys project and redeploy it.",
    });
  }
  if (snapshot.googleAccounts >= 70) {
    warnings.push({
      code: "GOOGLE_ACCOUNTS_HIGH",
      message: `${snapshot.googleAccounts} of Google's 100 lifetime accounts for an unverified app are used. New invites stop at 90.`,
    });
  }

  return {
    governor: {
      level,
      triggers: persisted?.triggers ?? gov.triggers,
      since: persisted?.since ?? gov.since,
      recommendTick60: gov.actions.recommendTick60,
    },
    resources: gov.resources.map(toRow),
    heartbeats: {
      lastTickAt: db.state?.last_tick_at?.toISOString() ?? null,
      lastMaintenanceAt: db.state?.last_maintenance_at?.toISOString() ?? null,
      lastRenderBatchAt: db.state?.last_render_batch_at?.toISOString() ?? null,
      lastCronAt: db.state?.last_cron_at?.toISOString() ?? null,
      inngestPaused: Boolean(db.state?.inngest_paused),
      tickEvery: env().TICK_EVERY === "60" ? 60 : 30,
    },
    mailboxes: {
      total: overview.mailboxes_total,
      active: overview.mailboxes_active,
      needsReauth: overview.mailboxes_needs_reauth,
      backfilling: overview.mailboxes_backfilling,
      failingLedgerRows: Number(overview.ledger_failed),
      pendingLedgerRows: Number(overview.ledger_pending),
    },
    ai: {
      reservedUsd: Math.round(snapshot.aiReservedUsd * 100) / 100,
      capUsd: Math.round(0.9 * snapshot.aiCapUsd * 100) / 100, // the app stops at 0.9 × G (llmCaps globalCap)
      paused: Boolean(aiPaused?.paused),
      pausedReason: aiPaused?.reason ?? null,
    },
    errors: db.errors.map((e) => ({ code: e.code, job: e.job, count: Number(e.n), lastAt: e.last_at.toISOString() })),
    googleAccounts: { used: snapshot.googleAccounts, alertAt: 70, stopAt: 90, limit: 100 },
    killSwitches,
    users: overview.users,
    warnings,
  };
}
