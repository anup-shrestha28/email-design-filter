/**
 * Which users get a render VM now, with which options (FREE-TIER.md §5.1 batching rule, §5.3
 * priorities, §8.3 governor actions):
 *  - on-demand requests get their own VM immediately (render/requested);
 *  - the nightly run renders the owner's batch, and a friend's only when their queue has ≥ 10 emails
 *    or the oldest item is ≥ 48 h old (≥ 10 only while the Sandbox is at its soft cap);
 *  - planned renders off at L2 or the Sandbox self-cap (the owner's on-demand only, on every
 *    trigger), fill off at L1/Sandbox soft, samples off at the Sandbox cap, nothing at L3 or the
 *    Sandbox static-only stage, AI per the AI budget;
 *  - renders only in the nightly run at the Inngest soft cap (`rendersNightlyOnly`): an on-demand
 *    trigger plans nothing, and queued on-demand requests wait for the nightly run;
 *  - the on-demand trigger (render/requested: a click, or the tick) also plans fresh batches: the
 *    owner's new mail without a score, rendered soon after it arrives under the fill switches, a
 *    rate limit, a daily cap and their own monthly Sandbox allowance (render-policy.ts).
 * `gateRenderOptions` re-applies the same switches when a VM is about to start (the plan can be
 * minutes old by then).
 */
import {
  calibrationFactor,
  FREE_TIER_PROFILE,
  onDemandPausedReason,
  renderGovernorOf,
  rendersStopped,
  RESOURCES,
  resourceSpec,
  type RenderGovernor,
} from "@edf/budget";
import { withSystem, withUser } from "@edf/db";
import { aiState } from "./ai";
import { reapStaleRenderRequests } from "./maintenance";
import type { PipelineDeps } from "./deps";
import type { RenderOptions } from "./render";
import {
  FRESH_ACTIVE_MINUTES,
  FRESH_CANDIDATE_SQL,
  FRESH_CPU_RESOURCE,
  freshDue,
  freshRendersAllowed,
  type FreshRow,
} from "./render-policy";

export { onDemandPausedReason, renderGovernorOf, type RenderGovernor };

export interface RenderPlanItem {
  userId: string;
  options: RenderOptions;
}

type Role = "owner" | "friend";

interface DueRow {
  user_id: string;
  queued_count: string;
  on_demand_count: string;
  oldest_at: Date;
}

interface UserRow {
  user_id: string;
  role: Role;
  mailboxes: number;
  last_active_at?: Date | null;
}

/**
 * The governor's render switches, with the owner's `kill.render` emergency stop folded in as
 * `rendersOff` (no VM at all, planned or on-demand), so every render gate honours it.
 */
export async function readRenderGovernor(deps: PipelineDeps): Promise<RenderGovernor> {
  return withSystem(deps.pool, async (_db, c) => {
    const r = await c.query<{ key: string; value: unknown }>("SELECT key, value FROM app_setting WHERE key IN ('governor', 'kill.render')");
    const v = new Map(r.rows.map((x) => [x.key, x.value]));
    const gov = renderGovernorOf(v.get("governor") as Parameters<typeof renderGovernorOf>[0]);
    return v.get("kill.render") === true ? { ...gov, actions: { ...gov.actions, rendersOff: true } } : gov;
  });
}

/**
 * One user's options under the current governor actions, or null when no VM may be created for
 * them: nothing at L3 / static-only; only the owner's on-demand at L2 / the Sandbox self-cap.
 */
export function gateRenderOptions(gov: RenderGovernor, role: Role | null, opts: RenderOptions): RenderOptions | null {
  if (rendersStopped(gov)) return null;
  const a = gov.actions;
  // A fresh batch is a daytime render: none while renders are nightly-only (Inngest soft cap).
  if (opts.fresh && (a as { rendersNightlyOnly?: boolean }).rendersNightlyOnly === true) return null;
  let o: RenderOptions = { ...opts };
  if (a.plannedRendersOff) {
    if (role !== "owner") return null;
    o = { ...o, onDemandOnly: true, fillAllowed: false, samplesAllowed: false, aiSamplesAllowed: false };
  }
  if (a.fillRendersOff) o.fillAllowed = false;
  if (a.samplesOff) o.samplesAllowed = false;
  if (a.autoAiOff || a.aiOff) o.aiSamplesAllowed = false;
  if (a.aiOff) o.aiRealtimeAllowed = false;
  return o;
}

/** `gateRenderOptions` with the governor and the user's role read now (the render step's check). */
export async function currentRenderOptions(deps: PipelineDeps, userId: string, opts: RenderOptions): Promise<RenderOptions | null> {
  const gov = await readRenderGovernor(deps);
  if (rendersStopped(gov)) return null;
  const role = await withUser(deps.pool, userId, async (_db, c) =>
    (await c.query<{ role: Role }>("SELECT role FROM user_settings WHERE user_id = $1", [userId])).rows[0]?.role ?? null,
  );
  return gateRenderOptions(gov, role, opts);
}

/** The plan itself, from the governor, the AI state and the render queue (pure). */
export function planFrom(input: {
  trigger: "nightly" | "on_demand";
  gov: RenderGovernor;
  aiPaused: boolean;
  due: readonly DueRow[];
  users: readonly UserRow[];
  /** The users' fresh-render state (on-demand trigger only; see `freshRows`). */
  fresh?: readonly FreshRow[];
  now: number;
}): RenderPlanItem[] {
  const { gov, due, users } = input;
  const actions = gov.actions;
  if (rendersStopped(gov)) return [];
  const aiRealtimeAllowed = !input.aiPaused && !actions.aiOff;
  const aiSamplesAllowed = aiRealtimeAllowed && !actions.autoAiOff;
  const roleOf = new Map(users.map((u) => [u.user_id, u.role]));
  const planned = !actions.plannedRendersOff;
  const plan: RenderPlanItem[] = [];
  const onDemandOnly: RenderOptions = { onDemandOnly: true, fillAllowed: false, samplesAllowed: false, aiSamplesAllowed: false, aiRealtimeAllowed };

  if (input.trigger === "on_demand") {
    // Inngest soft cap (FREE-TIER.md §8.3): renders only in the nightly run, which picks these up.
    // (`rendersNightlyOnly` is stored with the other switches; RenderGovernorActions doesn't list it.)
    if ((actions as { rendersNightlyOnly?: boolean }).rendersNightlyOnly === true) return plan;
    for (const d of due) {
      if (Number(d.on_demand_count) === 0) continue;
      if (!planned && roleOf.get(d.user_id) !== "owner") continue;
      plan.push({ userId: d.user_id, options: onDemandOnly });
    }
    // Fresh batches (render-policy.ts): the same VM also takes the user's queued on-demand work.
    if (freshRendersAllowed(gov)) {
      const fresh: RenderOptions = { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false, aiRealtimeAllowed };
      for (const f of input.fresh ?? []) {
        if (!freshDue(f, input.now)) continue;
        const at = plan.findIndex((p) => p.userId === f.user_id);
        if (at >= 0) plan[at] = { userId: f.user_id, options: fresh };
        else plan.push({ userId: f.user_id, options: fresh });
      }
    }
    return plan;
  }

  const full: RenderOptions = {
    fillAllowed: planned && !actions.fillRendersOff,
    samplesAllowed: planned && !actions.samplesOff,
    aiSamplesAllowed,
    aiRealtimeAllowed,
  };
  const dueBy = new Map(due.map((d) => [d.user_id, d]));
  // The owner first (reserved share), then friends that meet the batching rule.
  const ordered = [...users].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0));
  for (const u of ordered) {
    if (u.mailboxes === 0) continue;
    const d = dueBy.get(u.user_id);
    const queued = Number(d?.queued_count ?? 0);
    const onDemand = Number(d?.on_demand_count ?? 0);
    const oldestHours = d ? (input.now - new Date(d.oldest_at).getTime()) / 3_600_000 : 0;
    if (!planned) {
      if (u.role === "owner" && onDemand > 0) plan.push({ userId: u.user_id, options: onDemandOnly });
      continue;
    }
    if (u.role === "owner") {
      if (queued > 0 || full.fillAllowed) plan.push({ userId: u.user_id, options: full });
    } else {
      const meetsRule = actions.friendsBatchRequireTen ? queued >= 10 : queued >= 10 || (queued > 0 && oldestHours >= 48);
      if (meetsRule) plan.push({ userId: u.user_id, options: full });
      else if (onDemand > 0) plan.push({ userId: u.user_id, options: onDemandOnly });
    }
  }
  return plan;
}

export async function planRenders(deps: PipelineDeps, trigger: "nightly" | "on_demand"): Promise<RenderPlanItem[]> {
  // No renderer (RENDERER=off, or the Sandbox snapshot not set up yet): nothing can render, so no
  // user is planned (each would cost a render step that only reports "renderer_unavailable").
  if (!deps.renderer) return [];
  const gov = await readRenderGovernor(deps);
  if (rendersStopped(gov)) return [];
  const ai = await aiState(deps);
  const users = await withSystem(deps.pool, async (_db, c) => (await c.query<UserRow>("SELECT * FROM list_active_users()")).rows);
  // Requests a killed step left 'running' go back to the queue first, so they count as due here
  // (pickWork only reaps for users who are planned; a friend whose only request is stuck would wait).
  for (const u of users) {
    await withUser(deps.pool, u.user_id, (_db, c) => reapStaleRenderRequests(c, u.user_id));
  }
  const due = await withSystem(deps.pool, async (_db, c) => (await c.query<DueRow>("SELECT * FROM list_render_due(100)")).rows);
  const now = Date.now();
  const fresh = trigger === "on_demand" && freshRendersAllowed(gov) ? await freshRows(deps, users, now) : [];
  return planFrom({ trigger, gov, aiPaused: ai.paused, due, users, fresh, now });
}

/**
 * The fresh allowance used in the rolling 30 days (render-policy.ts FRESH_CPU_S_PER_30_DAYS): the
 * VM time fresh batches recorded, × the `sandbox_cpu` calibration factor, as the governor counts
 * Sandbox CPU.
 */
export async function freshCpuUsed(deps: PipelineDeps): Promise<number> {
  return withSystem(deps.pool, async (_db, c) => {
    const r = await c.query<{ n: string | number | null; cal: unknown }>(
      `SELECT (SELECT sum(amount) FROM usage_ledger WHERE resource = $1 AND day > current_date - 30) AS n,
              (SELECT value FROM app_setting WHERE key = 'calibration') AS cal`,
      [FRESH_CPU_RESOURCE],
    );
    const cal = r.rows[0]?.cal;
    const factor = calibrationFactor(
      FREE_TIER_PROFILE,
      cal && typeof cal === "object" ? (cal as Record<string, number>) : {},
      resourceSpec(FREE_TIER_PROFILE, RESOURCES.sandboxCpuS)?.calibrationKey ?? null,
    );
    return Number(r.rows[0]?.n ?? 0) * factor;
  });
}

/**
 * The fresh-render state of the users who could get a fresh batch: owners with a mailbox who used
 * the app in the last FRESH_ACTIVE_MINUTES (one small query each, scoped to the user by RLS, plus
 * one read of the fresh allowance when there is any such owner).
 */
export async function freshRows(deps: PipelineDeps, users: readonly UserRow[], now: number): Promise<FreshRow[]> {
  const out: FreshRow[] = [];
  let used: number | null = null;
  for (const u of users) {
    const active = u.last_active_at ? new Date(u.last_active_at).getTime() : Number.NEGATIVE_INFINITY;
    if (u.role !== "owner" || u.mailboxes === 0 || now - active > FRESH_ACTIVE_MINUTES * 60_000) continue;
    used ??= await freshCpuUsed(deps);
    const r = await withUser(deps.pool, u.user_id, async (_db, c) =>
      (
        await c.query<{ candidates: number; last_fill_at: Date | null; fill_batches_24h: number }>(
          `SELECT (SELECT count(*)::int FROM email e WHERE e.user_id = $1 AND ${FRESH_CANDIDATE_SQL}) AS candidates,
                  max(r.requested_at) AS last_fill_at,
                  count(DISTINCT r.requested_at) FILTER (WHERE r.requested_at > now() - interval '24 hours')::int AS fill_batches_24h
           FROM render_request r WHERE r.user_id = $1 AND r.kind = 'fill'`,
          [u.user_id],
        )
      ).rows[0],
    );
    out.push({
      user_id: u.user_id,
      role: u.role,
      last_active_at: u.last_active_at ?? null,
      candidates: Number(r?.candidates ?? 0),
      last_fill_at: r?.last_fill_at ?? null,
      fill_batches_24h: Number(r?.fill_batches_24h ?? 0),
      fresh_cpu_s_30d: used,
    });
  }
  return out;
}

/**
 * Whether a fresh batch is due now: the tick's check after its drain stored new mail (FREE-TIER.md
 * §4.2). The tick then sends `render/requested`; a render run already active drops it (singleton
 * skip) but plans fresh work in its next round, and a later tick sends it again.
 */
export async function freshRenderDue(deps: PipelineDeps): Promise<boolean> {
  // Nothing can render (see planRenders): no event, no render run.
  if (!deps.renderer) return false;
  const gov = await readRenderGovernor(deps);
  if (!freshRendersAllowed(gov)) return false;
  const users = await withSystem(deps.pool, async (_db, c) => (await c.query<UserRow>("SELECT * FROM list_active_users()")).rows);
  const now = Date.now();
  return (await freshRows(deps, users, now)).some((f) => freshDue(f, now));
}

/**
 * Whether queued on-demand requests would get a VM from a render run now. The tick's safety net
 * (FREE-TIER.md §4.7): a `render/requested` event sent while a render run is active is dropped by
 * its singleton, and one that arrives as the run finishes would otherwise wait for the nightly run.
 */
export async function onDemandRenderDue(deps: PipelineDeps): Promise<boolean> {
  // Nothing can render (see planRenders): a queued request waits for a renderer instead of starting
  // a render run on every tick (the render step would leave it queued, so it would stay "due").
  if (!deps.renderer) return false;
  const queued = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ x: boolean }>("SELECT EXISTS (SELECT 1 FROM list_render_due(100) WHERE on_demand_count > 0) AS x")).rows[0]?.x === true,
  );
  if (!queued) return false;
  return (await planRenders(deps, "on_demand")).length > 0;
}
