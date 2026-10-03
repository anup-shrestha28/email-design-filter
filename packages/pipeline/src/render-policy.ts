/**
 * Fresh renders (FREE-TIER.md §5.1 "Batching rule", §5.3 "Fresh", §5.5): the owner's new mail that
 * has no score yet — no own render and no template-level score (design_source 'static') — gets its
 * own render soon after it arrives, instead of waiting for the nightly batch. Pure: the planner
 * (render-plan.ts), the render step (render.ts) and the tick use these rules.
 *
 * A fresh batch is a "fill" render run early (§5.3 priority 4, render_request kind 'fill', no new
 * kind): it renders under exactly the switches fill does and stops with them.
 *  - Only while the governor allows fill: not at L1+ / the Sandbox soft cap / ≥ 55% of the Sandbox
 *    hard limit (`fillRendersOff`), not with planned renders off (L2, Sandbox self-cap), not while
 *    renders are nightly-only (Inngest soft cap), and never once renders are stopped (L3, the
 *    Sandbox static-only stage, `kill.render`).
 *  - The owner only, and only while they use the app (active in the last 30 minutes): a render
 *    nobody is waiting for can wait for the night, where one VM amortises its boot over the batch.
 *    Friends keep the nightly batching rule (≥ 10 queued, or the oldest ≥ 48 h): §5.5 gives a
 *    friend ≈ 20–105 own renders a month (conservative) and ≈ 60–300 (expected), which a daily
 *    early VM each would outrun.
 *  - One VM per batch (§5.1), at most one fill batch every 15 minutes and at most 8 fill batches
 *    (the nightly one included) per rolling 24 h. The record is the fill rows a batch inserts (their
 *    requested_at): a fresh batch takes no queued fill (render.ts workKinds), so one that renders
 *    fill always inserts rows. None is planned while no renderer is set up (nothing would render).
 *  - Their own Sandbox allowance: FRESH_CPU_S_PER_30_DAYS. They are extra renders, not the nightly
 *    fill run early: the nightly batch finishes ≈ 20 of the owner's emails a night while ≈ 35
 *    designable ones arrive a day (FREE-TIER §7), so uncapped they would add ≈ 15 renders a day,
 *    ≈ 450 a month: +3,150 (expected, 7 CPU-s each) to +7,650 (conservative, 17) Sandbox CPU-s, up
 *    to 77% of the 9,900 CPU-s fill window everyone's nightly fill shares — enough for the owner's
 *    fresh renders alone to switch fill off for friends. Each fresh batch records its share of its
 *    VM's vCPU × wall seconds (usage_ledger `render.fresh_cpu_s`, render.ts), read back × the
 *    `sandbox_cpu` calibration factor like the governor's Sandbox CPU; a batch starts only while a
 *    whole batch (FRESH_BATCH_MAX_CPU_S) still fits, so the allowance is never overrun. Used up:
 *    new mail waits for the nightly batch, as before (the gallery says so).
 *  - Each email gets at most one fresh try (no render request of any kind before, within the
 *    48-hour window): a render that failed (or was deferred) goes back to the queue as fill, which
 *    only the nightly run picks — never the next fresh batch.
 */
import { rendersStopped, type RenderGovernor } from "@edf/budget";

/** New mail counts as fresh for this long after it was received. */
export const FRESH_WINDOW_HOURS = 48;
/** The owner used the app this recently (user_settings.last_active_at, written ≤ every 10 min). */
export const FRESH_ACTIVE_MINUTES = 30;
/** At most one fill batch per user this often (fresh or nightly). */
export const FRESH_MIN_GAP_MINUTES = 15;
/** Fill batches per user per rolling 24 h, the nightly one included. */
export const FILL_BATCHES_PER_DAY = 8;
/**
 * Fresh batches' own Sandbox allowance per rolling 30 days, in Sandbox CPU-s as the governor counts
 * them (vCPUs × VM wall seconds × the `sandbox_cpu` calibration factor): 2,520 = 20% of the 12,600
 * self-cap, 14% of the 18,000 hard limit, a quarter of the 9,900 CPU-s fill window (55% of the hard
 * limit). About 120 fresh renders a month (conservative: ≈ 21 CPU-s each in batches of ~3 with their
 * VM boot) to 260 (expected: ≈ 10); FREE-TIER.md §5.5.
 */
export const FRESH_CPU_S_PER_30_DAYS = 2_520;
/** vCPUs of a render VM (@edf/render SANDBOX_VCPUS; apps/web tests check they match). */
export const RENDER_VM_VCPUS = 2;
/** The most one fresh batch can use: its VM's vCPUs × 250 s (every tick stops a render VM older than that, §5.1). */
export const FRESH_BATCH_MAX_CPU_S = RENDER_VM_VCPUS * 250;
/** usage_ledger resource: each fresh batch's share of its VM's vCPU × wall seconds (render.ts). */
export const FRESH_CPU_RESOURCE = "render.fresh_cpu_s";

/** Whether the fresh allowance still has room for a whole batch (so one never overruns it). */
export function freshAllowanceLeft(usedCpuS: number): boolean {
  return usedCpuS + FRESH_BATCH_MAX_CPU_S <= FRESH_CPU_S_PER_30_DAYS;
}

/** Fill (nightly and fresh) only renders mail received in the last 14 days (§5.3). */
export const FILL_WINDOW_DAYS = 14;
/**
 * Emails one render step reliably finishes: it picks ≤ 25 (render.ts MAX_EMAILS_PER_BATCH) and
 * prepares one per ~9 s while 30 s of its 230 s budget remain (≈ 22). The UI's "when will it be
 * scored" forecast uses this.
 */
export const RENDER_BATCH_CAPACITY = 20;

/** The nightly render batch (render-batch's cron `TZ=UTC 30 4 * * *`). */
export const NIGHTLY_RENDER_UTC = { hour: 4, minute: 30 } as const;

/** The first nightly run time strictly after `ms`. */
export function nextNightlyAfter(ms: number): number {
  const d = new Date(ms);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), NIGHTLY_RENDER_UTC.hour, NIGHTLY_RENDER_UTC.minute);
  return at > ms ? at : at + 86_400_000;
}

/** Whether the governor lets fresh batches run at all (the fill switches, plus nightly-only). */
export function freshRendersAllowed(gov: RenderGovernor): boolean {
  if (rendersStopped(gov)) return false;
  const a = gov.actions as RenderGovernor["actions"] & { rendersNightlyOnly?: boolean };
  return a.plannedRendersOff !== true && a.fillRendersOff !== true && a.rendersNightlyOnly !== true;
}

/** One user's fresh-render state (render-plan.ts `freshRows`). */
export interface FreshRow {
  user_id: string;
  role: "owner" | "friend";
  last_active_at: Date | null;
  /** Fresh emails waiting for their first render (FRESH_CANDIDATE_SQL). */
  candidates: number;
  /** When the user's last fill batch started (its fill requests' requested_at). */
  last_fill_at: Date | null;
  /** Fill batches started in the last 24 h. */
  fill_batches_24h: number;
  /** The fresh allowance used in the rolling 30 days (FRESH_CPU_S_PER_30_DAYS; calibrated Sandbox CPU-s). */
  fresh_cpu_s_30d: number;
}

/** Whether `row` gets a fresh batch now (the governor is checked separately: freshRendersAllowed). */
export function freshDue(row: FreshRow, now: number): boolean {
  if (row.role !== "owner" || row.candidates < 1) return false;
  const active = row.last_active_at ? new Date(row.last_active_at).getTime() : Number.NEGATIVE_INFINITY;
  if (now - active > FRESH_ACTIVE_MINUTES * 60_000) return false;
  const last = row.last_fill_at ? new Date(row.last_fill_at).getTime() : Number.NEGATIVE_INFINITY;
  if (now - last < FRESH_MIN_GAP_MINUTES * 60_000) return false;
  if (!freshAllowanceLeft(row.fresh_cpu_s_30d)) return false;
  return row.fill_batches_24h < FILL_BATCHES_PER_DAY;
}

/**
 * A fresh-render candidate (`email e` of the user in the transaction): received in the last 48 h,
 * designed but only statically checked (no own render, no template-level score), listed in the
 * gallery, in an active mailbox (the render step refetches from it), and never requested before.
 */
export const FRESH_CANDIDATE_SQL = `e.received_at > now() - make_interval(hours => ${FRESH_WINDOW_HOURS})
  AND e.design_status = 'done' AND e.design_source = 'static'
  AND NOT e.security_sensitive AND NOT e.is_hidden
  AND EXISTS (SELECT 1 FROM mailbox m WHERE m.id = e.mailbox_id AND m.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM render_request r WHERE r.email_id = e.id)`;
