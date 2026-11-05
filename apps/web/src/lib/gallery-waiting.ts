/**
 * When an unchecked design will get its score and design checklist — decided from the real render queue and the
 * governor's switches, never guessed (client-safe and pure; the query that feeds it is
 * server/queries/gallery-waiting.ts, the words are lib/gallery-copy.ts `waitingCopy`).
 *
 * It mirrors the render planner (@edf/pipeline render-plan.ts, render-policy.ts, render.ts
 * pickWork; FREE-TIER.md §5.1, §5.3, §8.2–8.3):
 *  - scoring    a render request is running, or an on-demand one is queued (it gets a VM now)
 *  - soon       the owner's new mail (≤ 48 h, never tried) that the next fresh batch takes: the
 *               tick starts one within ~30 minutes (an hour with hourly ticks) while fill is allowed
 *               and fresh renders' own monthly allowance still has room for a batch
 *  - scheduled  the nightly batch (04:30 UTC) takes it: the owner's mail that is still within 14
 *               days at that time, while fill is allowed, among the ~20 a batch finishes (queued
 *               work first, then newest first)
 *  - retry      as `scheduled`, after its last render failed (the nightly fill tries it again)
 *  - queued     in line with no time we can promise: past the nightly batch's room, or a friend's
 *               mail (their batch needs ≥ 10 waiting or the oldest ≥ 48 h)
 *  - paused     the governor has these renders off (free-tier limits), or background jobs are
 *               paused (Inngest's free quota, FREE-TIER.md §4.9)
 *  - off        the owner switched renders off (`kill.render`), or no renderer is set up
 *  - manual     older than 14 days by the next nightly run: never rendered on its own; "Analyze
 *               this email" scores it
 *  - failed     as `manual`, after its last render failed
 *  - stored     saved without its analysis while storage was nearly full (Neon ≥ 300 MB): only
 *               "Analyze this email" scores it
 *  - unscorable rendered, but there wasn't enough to measure for a score (no render gives one)
 *  - mailbox    its Gmail account is disconnected (the render step can't fetch it)
 *
 * A design scored before the checklist existed (2026-11-05) and since compacted has a score but no
 * checklist (`recheck`): the nightly fill re-checks it after its regular candidates, newest first
 * (@edf/pipeline render-policy.ts RECHECK_CANDIDATE_SQL), at any age — `scheduled` while it is
 * among the batch's ~20, `queued` past that or for a friend, `failed` after a failed re-check
 * (tried again a week later, or now with "Analyze this email").
 *
 * The nightly check of each user's newest emails (render-policy.ts NEWEST_PER_NIGHT, 2026-11-06)
 * also runs while the governor has the other planned renders off (L1, L2), for friends too: a
 * candidate (`newestAhead`: its place among the user's newest unchecked gallery emails) within the
 * night's number is `scheduled`; past it, `later` ("newer emails are checked first") unless another
 * render takes it sooner. Not at L3 or with the Sandbox's own allowance tight (`newestChecksOff`).
 */

export type WaitingState =
  | "scoring"
  | "soon"
  | "scheduled"
  | "retry"
  | "queued"
  | "paused"
  | "off"
  | "manual"
  | "failed"
  | "stored"
  | "unscorable"
  | "mailbox"
  | "later";

export interface Waiting {
  state: WaitingState;
  /** `scheduled`, `retry`: when the nightly render batch starts (ISO). */
  at?: string;
}

/** The render planner's numbers (checked against @edf/pipeline's by the tests). */
export const RENDER_SCHEDULE = {
  /** render-policy.ts FRESH_WINDOW_HOURS */
  freshWindowHours: 48,
  /** render-policy.ts FILL_WINDOW_DAYS */
  fillWindowDays: 14,
  /** render-policy.ts FILL_BATCHES_PER_DAY */
  fillBatchesPerDay: 8,
  /** render-policy.ts RENDER_BATCH_CAPACITY */
  batchCapacity: 20,
  /** render-policy.ts NIGHTLY_RENDER_UTC (the render-batch cron) */
  nightlyUtc: { hour: 4, minute: 30 },
  /** render-policy.ts FRESH_CPU_S_PER_30_DAYS (fresh batches' own Sandbox allowance) */
  freshCpuSPer30Days: 2_520,
  /** render-policy.ts FRESH_BATCH_MAX_CPU_S (a batch starts only while this much is left) */
  freshBatchMaxCpuS: 500,
  /** render-policy.ts FRESH_CPU_RESOURCE (the usage_ledger row the allowance is read from) */
  freshCpuResource: "render.fresh_cpu_s",
  /** render-policy.ts NEWEST_PER_NIGHT (each user's newest emails checked a night) */
  newestPerNight: 10,
} as const;

/** The first nightly render run strictly after `ms` (render-policy.ts nextNightlyAfter). */
export function nextNightlyRun(ms: number): number {
  const d = new Date(ms);
  const { hour, minute } = RENDER_SCHEDULE.nightlyUtc;
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  return at > ms ? at : at + 86_400_000;
}

/** The governor's render switches as stored in `app_setting.governor` (missing = off). */
export interface RenderSwitches {
  level?: number;
  actions?: {
    rendersOff?: boolean;
    plannedRendersOff?: boolean;
    fillRendersOff?: boolean;
    samplesOff?: boolean;
    rendersNightlyOnly?: boolean;
    /** The nightly check of each user's newest emails is off (missing = on, as every switch). */
    newestChecksOff?: boolean;
  };
}

export interface WaitingInput {
  now: number;
  role: "owner" | "friend";
  governor: RenderSwitches | null;
  /** `app_setting` kill.render is on. */
  rendersKilled: boolean;
  /** Background jobs are paused or down (system_state.inngest_paused): no render runs until they're back. */
  jobsPaused?: boolean;
  /** No renderer is set up (RENDERER=off, or the Sandbox snapshot isn't configured): nothing renders. */
  rendererOff?: boolean;
  user: {
    /** Fill batches (nightly + fresh) started in the last 24 h. */
    fillBatches24h: number;
    /**
     * Fresh renders' own allowance used in the rolling 30 days (calibrated Sandbox CPU-s, as
     * render-plan.ts freshCpuUsed reads it); absent: none used.
     */
    freshCpuS30d?: number;
    queued: { onDemand: number; exemplar: number; fill: number };
  };
  item: {
    receivedAt: string;
    /** email.design_status ('pending' = stored without analysis in storage-saver mode). */
    designStatus: string;
    /** email.design_source ('render': it has its own render, so another one gives the same result). */
    designSource?: string;
    /** Its latest render request (kept 7 days) failed. */
    lastFailed?: boolean;
    /** Its mailbox is connected (GalleryItem.previewable). */
    mailboxActive: boolean;
    /** Its queued or running render request. */
    request: { kind: "on_demand" | "exemplar" | "fill"; state: "queued" | "running" } | null;
    /** Queued requests a batch picks before this one's (queued requests only). */
    queuedAhead: number | null;
    /** It had a render request before (any state): a fresh batch never tries it again. */
    everRequested: boolean;
    /** Fresh candidates newer than it (≤ 48 h old items only). */
    freshAhead: number | null;
    /**
     * Nightly fill candidates the batch takes before it: newer ones (≤ 14 days old items), or, for
     * a re-check, every regular one plus the newer re-check candidates.
     */
    fillAhead: number | null;
    /** Scored, but without a design checklist of the current version: a re-check (file comment). */
    recheck?: boolean;
    /**
     * A newest-check candidate (render-policy.ts NEWEST_CANDIDATE_SQL): how many of the user's
     * candidates are newer. null / absent = not a candidate.
     */
    newestAhead?: number | null;
  };
}

const HOUR = 3_600_000;

/** When `input.item` will be scored (see the file comment). */
export function waitingFor(input: WaitingInput): Waiting {
  const { now, role, user, item } = input;
  const level = Number(input.governor?.level ?? 0) || 0;
  const a = input.governor?.actions ?? {};
  if (input.rendersKilled || input.rendererOff === true) return { state: "off" };
  if (level >= 3 || a.rendersOff === true) return { state: "paused" };
  if (!item.mailboxActive) return { state: "mailbox" };
  // Every render runs in a background job; while those are paused nothing is scored.
  if (input.jobsPaused === true && item.request?.state !== "running") return { state: "paused" };

  const owner = role === "owner";
  const planned = a.plannedRendersOff !== true;
  const cap = RENDER_SCHEDULE.batchCapacity;
  const nightlyAt = nextNightlyRun(now);
  const nightly: Waiting = {
    state: item.lastFailed === true ? "retry" : "scheduled",
    at: new Date(nightlyAt).toISOString(),
  };
  const req = item.request;

  if (req?.state === "running") return { state: "scoring" };
  // Fill only takes analysed mail: one stored without its analysis is scored on demand only.
  if (item.designStatus === "pending" && req?.state !== "queued") return { state: "stored" };

  const other = waitingOtherwise(input, nightly, nightlyAt);
  // The nightly check of the user's newest emails, right after the batch's queued requests (a
  // candidate's own queued request can only be a deferred fill, which comes along with it). A
  // render that comes sooner (a running one, the next fresh batch) is said first.
  const newest =
    a.newestChecksOff !== true && typeof item.newestAhead === "number" ? item.newestAhead : null;
  if (newest === null || other.state === "scoring" || other.state === "soon") return other;
  const queuedFirst = !planned
    ? owner
      ? user.queued.onDemand
      : 0
    : user.queued.onDemand +
      (a.samplesOff === true ? 0 : user.queued.exemplar) +
      (a.fillRendersOff === true ? 0 : user.queued.fill);
  if (newest < RENDER_SCHEDULE.newestPerNight && queuedFirst + newest < cap) return nightly;
  // Past the night's number: it waits its turn behind newer mail, unless the nightly fill takes it.
  if (other.state === "scheduled" || other.state === "retry") return other;
  return { state: "later" };
}

/** waitingFor without the newest check: the queued request, the recheck, fill and fresh rules. */
function waitingOtherwise(input: WaitingInput, nightly: Waiting, nightlyAt: number): Waiting {
  const { now, role, user, item } = input;
  const a = input.governor?.actions ?? {};
  const owner = role === "owner";
  const planned = a.plannedRendersOff !== true;
  const nightlyOnly = a.rendersNightlyOnly === true;
  const cap = RENDER_SCHEDULE.batchCapacity;
  const req = item.request;
  if (req?.state === "queued") {
    if (req.kind === "on_demand") {
      // At L2 / the Sandbox self-cap only the owner's on-demand renders run; nightly-only waits for 04:30.
      if (!planned && !owner) return { state: "paused" };
      return nightlyOnly ? nightly : { state: "scoring" };
    }
    if (!planned) return { state: "paused" };
    if (req.kind === "fill" && a.fillRendersOff === true) return { state: "paused" };
    if (req.kind === "exemplar" && a.samplesOff === true) return { state: "paused" };
    if (!owner) return { state: "queued" };
    return (item.queuedAhead ?? 0) < cap ? nightly : { state: "queued" };
  }
  // Nothing requested now. A re-check: the nightly fill's last candidates, at any age.
  if (item.recheck === true && item.designStatus === "done") {
    if (item.lastFailed === true) return !planned && !owner ? { state: "paused" } : { state: "failed" };
    if (!planned || a.fillRendersOff === true) return { state: "paused" };
    if (!owner) return { state: "queued" };
    const ahead =
      user.queued.onDemand + (a.samplesOff === true ? 0 : user.queued.exemplar) + user.queued.fill;
    return ahead + (item.fillAhead ?? 0) < cap ? nightly : { state: "queued" };
  }
  // Rendered already (or not analysable) and still no score: another render measures the same, so
  // none comes on its own.
  if (item.designStatus !== "done" || item.designSource === "render") return { state: "unscorable" };

  // Only fill renders it on its own, and only mail still within 14 days when the nightly run takes
  // it (a fresh batch, sooner, only takes mail ≤ 48 h old). Past that only "Analyze this email"
  // scores it — which works for the owner even while planned renders are off (L2), not for a friend.
  if (!(nightlyAt - Date.parse(item.receivedAt) < RENDER_SCHEDULE.fillWindowDays * 24 * HOUR)) {
    if (!planned && !owner) return { state: "paused" };
    return { state: item.lastFailed === true ? "failed" : "manual" };
  }
  if (!planned || a.fillRendersOff === true) return { state: "paused" };
  if (!owner) return { state: "queued" };

  const age = now - Date.parse(item.receivedAt);
  // Fresh batches the day's cap and the monthly allowance still allow (a batch starts only while a
  // whole one fits the allowance: render-policy.ts freshAllowanceLeft).
  const allowanceBatches = Math.floor(
    (RENDER_SCHEDULE.freshCpuSPer30Days - (user.freshCpuS30d ?? 0)) / RENDER_SCHEDULE.freshBatchMaxCpuS,
  );
  const batchesLeft = Math.min(RENDER_SCHEDULE.fillBatchesPerDay - user.fillBatches24h, allowanceBatches);
  if (
    age <= RENDER_SCHEDULE.freshWindowHours * HOUR &&
    !item.everRequested &&
    !nightlyOnly &&
    batchesLeft > 0
  ) {
    // A fresh batch takes queued on-demand work first (never queued fill), then the newest fresh mail.
    const ahead = user.queued.onDemand + (item.freshAhead ?? 0);
    if (ahead < cap * Math.min(2, batchesLeft)) return { state: "soon" };
  }
  const queued =
    user.queued.onDemand + (a.samplesOff === true ? 0 : user.queued.exemplar) + user.queued.fill;
  return queued + (item.fillAhead ?? 0) < cap ? nightly : { state: "queued" };
}
