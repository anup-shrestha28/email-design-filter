/**
 * The governor (FREE-TIER.md §8.1–8.3): turns metered usage into a global level (L0–L3, with
 * hysteresis) and per-resource actions. `computeGovernor` is pure; `loadUsageSnapshot` and
 * `runGovernor` do the I/O.
 *
 * Rules implemented (all thresholds come from the `BudgetProfile`):
 *  - Vercel and Sandbox: rolling 30-day usage × calibration factor (§8.1).
 *  - Inngest and Anthropic: month-to-date, plus a projection (MTD + days remaining × trailing
 *    7-day daily average) from day 7; before that a fixed pace budget (self-cap ÷ 30 × 1.5 per
 *    elapsed day) stands in for the projection.
 *  - Neon compute: actual billing-period CU-h only, against 50 / 60 / 80 (L1 / L2 / L3).
 *  - A projection can only raise L1 (or a resource's soft action); L2 and L3 need actual usage.
 *  - L1 at 80% of a shared resource's self-cap; L2 at the self-cap; L3 at the L3 thresholds
 *    (Vercel CPU, invocations, memory, FOT ≥ 70% of hard; Neon ≥ 80 CU-h; Inngest ≥ 40k).
 *  - Hysteresis: a level steps down one level only after 24 h with every resource below 80% of
 *    that level's threshold; the clock restarts after each step.
 *  - Sandbox, Anthropic and Neon storage only produce per-resource actions (§8.2 last line).
 *    Sandbox at its self-cap: samples off and only your on-demand renders; near its hard limit:
 *    static-only (§8.3).
 *  - Execution-rate tripwire (§4.2): more than 3× the plan's hourly Inngest executions within
 *    the last hour → continuation kicks off, at least L1, and an EXECUTION_TRIPWIRE alert. The
 *    ledger is daily, so the hour is measured against the samples of today's count kept in the
 *    state (one per governor run, the last TRIPWIRE_KEEP_MS of them).
 *  - External-load spikes (§8.4 item 5): a watched count more than 3× its 7-day baseline today →
 *    an EXTERNAL_LOAD_SPIKE alert (re-sent at most every 6 h by raiseAlert).
 */
import { sql, withSystem } from "@edf/db";
import { z } from "zod";
import {
  FREE_TIER_PROFILE,
  RESOURCES,
  type BudgetProfile,
  type ResourceCode,
  type ResourceSpec,
} from "./resources";
import {
  billingPeriodStart,
  calendarMonthStart,
  DAY_MS,
  daysElapsed,
  daysRemaining,
  nextPeriodStart,
  startOfUtcDay,
  utcDay,
} from "./time";

type Pool = Parameters<typeof withSystem>[0];

export type GovernorLevel = 0 | 1 | 2 | 3;

/** Per-resource and per-level behaviour switches (§8.2 table, §8.3 table). */
export interface GovernorActions {
  /** Background poll interval multiplier (L1: × 2, FREE-TIER §4.3). */
  pollMultiplier: 1 | 2;
  /** L2: background polling every 6 h. */
  backgroundPollHours: number | null;
  /** L1: stop the UI's sync-status polling. */
  syncStatusPollingOff: boolean;
  /** L2: friends' sync-on-open at most every N minutes (you: always). */
  friendsSyncOnOpenMinMinutes: number | null;
  /** Alert: "set TICK_EVERY=60 and redeploy" (L1, or Inngest soft). */
  recommendTick60: boolean;
  /** Inngest soft (or L3): no continuation kicks. */
  continuationKicksOff: boolean;
  /** Inngest at its self-cap: run the daily-cron Plan B (§4.9). */
  planB: boolean;
  /** L1: new backfills wait in the queue. */
  newBackfillsQueued: boolean;
  /** Inngest at its self-cap, or L3: no backfills at all. */
  noBackfills: boolean;
  /** L1, Sandbox soft, or Sandbox ≥ 55% of its hard limit: no fill renders. */
  fillRendersOff: boolean;
  /** L2, or Sandbox at its self-cap: planned renders off (your on-demand only; friends' too). */
  plannedRendersOff: boolean;
  /** Sandbox at its self-cap (or L2): no template samples. */
  samplesOff: boolean;
  /** Sandbox near its hard limit (or L3): static-only, no render VM is created at all. */
  rendersOff: boolean;
  /** Inngest soft: renders only in the nightly run. */
  rendersNightlyOnly: boolean;
  /** Sandbox soft: a friend's batch needs ≥ 10 emails (the 48 h rule is suspended). */
  friendsBatchRequireTen: boolean;
  /** FOT soft (or L3): friends' images are click-to-load. */
  friendsImagesClickToLoad: boolean;
  /** FOT at its self-cap (or L3): everyone's images are click-to-load. */
  imagesClickToLoad: boolean;
  /** L1: classification through Batch only. */
  classificationBatchOnly: boolean;
  /** Anthropic soft (80% of the app cap, actual or projected) or L2: automatic AI reviews off. */
  autoAiOff: boolean;
  /** Anthropic at the app cap, or L3: all AI off ("AI review pending"). */
  aiOff: boolean;
  /** Neon storage ≥ 250 MB: retention shortened by 30 days (minimum 30). */
  storageRetentionShortened: boolean;
  /** Neon storage ≥ 250 MB: compact features after 7 days. */
  featuresCompactAfterDays: number | null;
  /** Neon storage ≥ 300 MB: new emails stored without analysis rows or search text. */
  noAnalysisRows: boolean;
  /** Neon storage ≥ 350 MB: ingest paused (deletes keep working). */
  ingestPaused: boolean;
  /** Neon compute ≥ 50 CU-h: run maintenance inside a tick's wake. */
  maintenanceAlignedWithTick: boolean;
  /** L3: all background work off. */
  backgroundWorkOff: boolean;
  /** L3: on-demand features off (data stays readable; export/delete/disconnect still work). */
  onDemandOff: boolean;
  /** 70 lifetime Google accounts reached (alert). */
  googleAccountsAlert: boolean;
  /** 90 lifetime Google accounts: invites off. */
  invitesOff: boolean;
}

/** Persisted in `app_setting.governor`. */
export interface GovernorState {
  level: GovernorLevel;
  /** ISO time the current level was entered. */
  since: string | null;
  triggers: string[];
  /** ISO time since which every resource has been below 80% of the current level's thresholds. */
  belowSince: string | null;
  actions?: GovernorActions;
  computedAt?: string;
  /** Today's Inngest executions at each recent governor run, oldest first (the tripwire's window, §4.2). */
  executions?: ExecutionSample[];
  /** ISO time the execution-rate tripwire last fired (it holds for TRIPWIRE_HOLD_MS). */
  tripwireAt?: string | null;
}

export interface ExecutionSample {
  /** ISO time of the sample. */
  at: string;
  /** UTC day ("YYYY-MM-DD") the count belongs to. */
  day: string;
  count: number;
}

export interface UsageSums {
  /** Sum over the last 30 UTC days including today, per resource code. */
  rolling30d: Readonly<Record<string, number>>;
  /** Sum since the calendar month start. */
  monthToDate: Readonly<Record<string, number>>;
  /** Sum since the Neon billing-period start (defaults to `monthToDate`). */
  billingPeriodToDate?: Readonly<Record<string, number>>;
  /** Mean daily amount over the 7 complete days before today. */
  trailing7dAvg: Readonly<Record<string, number>>;
  /** Sum for today (UTC) so far: the tripwire's and the spike check's input. */
  today?: Readonly<Record<string, number>>;
}

export interface GovernorInput {
  usage: UsageSums;
  /** Pool-based Neon compute estimate for the billing period so far (§8.1). */
  neonCuHoursMtd: number;
  neonStorageMb: number;
  /** `app_setting.calibration`; missing keys fall back to the profile defaults. */
  calibration: Readonly<Record<string, number>>;
  profile: BudgetProfile;
  now: Date;
  /** Start of the calendar month (Inngest and Anthropic windows). */
  periodStart: Date;
  previous: GovernorState | null;
  /** G, the Console's monthly spend limit (`app_setting.ai.cap_usd`). Default 5. */
  aiCapUsd?: number;
  /** `llm_budget_global.reserved_usd` for the month (reservations include in-flight calls). */
  aiReservedUsd?: number;
  /** Lifetime Google accounts that granted the connector (`oauth_subject_seen`). */
  googleAccounts?: number;
}

export interface ResourceStatus {
  code: ResourceCode;
  unit: string;
  /** Calibrated actual usage in the resource's window. */
  value: number;
  /** Projected month total (monthly resources from day 7), else null. */
  projected: number | null;
  /** Before day 7: the pace budget that stands in for the projection. */
  paceBudget: number | null;
  selfCap: number;
  hardLimit: number;
  soft: number;
  softReached: boolean;
  capReached: boolean;
  /** Soft threshold reached only by projection / pace. */
  projectedSoft: boolean;
  /** Level this resource asks for (0 for per-resource-only resources below L3). */
  level: GovernorLevel;
}

export interface GovernorResult {
  level: GovernorLevel;
  /** Level before hysteresis. */
  rawLevel: GovernorLevel;
  triggers: string[];
  since: string | null;
  belowSince: string | null;
  actions: GovernorActions;
  /** Level or actions differ from `previous`. */
  changed: boolean;
  resources: ResourceStatus[];
  neonStorageMb: number;
  /** The value to persist in `app_setting.governor`. */
  state: GovernorState;
  /** The execution-rate tripwire is holding (fired within TRIPWIRE_HOLD_MS). */
  executionTripwire: boolean;
  /** The tripwire fired on this computation (alert once). */
  executionTripwireFired: boolean;
  /** Watched external-load counts above 3× their 7-day baseline today (§8.4 item 5). */
  externalLoadSpikes: string[];
}

/** Executions in an hour above this multiple of the plan's hourly pace trip the wire (§4.2). */
export const TRIPWIRE_MULTIPLIER = 3;
/**
 * "The plan" for the tripwire: the Inngest self-cap (30,000) spread evenly over a 30-day month,
 * ≈ 42 an hour, so the wire trips above ≈ 125 executions in an hour. Not the ≈ 9–10k expected
 * month (§4.7, ≈ 14 an hour → ≈ 42): a legitimate busy hour already goes past that (two ticks and
 * the 6 capped continuation kicks at up to 8 executions each ≈ 64, plus an import's 6–20 list
 * steps and a render batch's per-user steps), and a tripwire that fires on normal work would stop
 * the kicks the drain needs. A runaway (a kick loop, a retry storm) passes 125 within the hour.
 */
export const TRIPWIRE_PLAN_PER_MONTH = 30_000;
/** Kicks stay off (and the tripwire keeps asking for L1) this long after it fired. */
export const TRIPWIRE_HOLD_MS = 3_600_000;
/** Samples of today's count are kept this long (3 h: an hourly tick still finds one ≥ 1 h old). */
export const TRIPWIRE_KEEP_MS = 3 * 3_600_000;
/** At most this many samples are stored (the tick, kicks and the daily cron all run the governor). */
const TRIPWIRE_MAX_SAMPLES = 48;
const HOUR_MS = 3_600_000;

/**
 * The execution-rate tripwire (FREE-TIER.md §4.2), measured at each governor run against every
 * stored sample of today's Inngest count from the last TRIPWIRE_KEEP_MS: the executions since a
 * sample may not exceed 3 × the plan's hourly pace (TRIPWIRE_PLAN_PER_MONTH) × max(1, hours
 * since it). So the last hour is always covered at tick granularity, whatever the burst's shape:
 * a sample ≈ 1 h old measures the last hour, and a newer one catches a burst early, held to a full
 * hour's allowance so a short window can't trip it on a normal tick. Across UTC midnight only
 * today's count is known, which can only under-count. With no sample yet (a first run) it can't fire.
 */
export function executionTripwire(
  planPerMonth: number,
  todayCount: number | undefined,
  previous: GovernorState | null,
  now: Date,
): { fired: boolean; holding: boolean; samples: ExecutionSample[]; tripwireAt: string | null } {
  const prevAt = previous?.tripwireAt ? Date.parse(previous.tripwireAt) : Number.NaN;
  const heldFrom = Number.isNaN(prevAt) ? null : prevAt;
  const t = now.getTime();
  const kept = (previous?.executions ?? []).filter((x) => {
    const a = Date.parse(x.at);
    return !Number.isNaN(a) && a <= t && t - a <= TRIPWIRE_KEEP_MS;
  });
  if (todayCount === undefined || !(planPerMonth > 0)) {
    const holding = heldFrom !== null && t - heldFrom < TRIPWIRE_HOLD_MS;
    return { fired: false, holding, samples: kept, tripwireAt: previous?.tripwireAt ?? null };
  }
  const day = utcDay(now);
  const count = num(todayCount);
  const hourly = TRIPWIRE_MULTIPLIER * (planPerMonth / (30 * 24));
  const fired = kept.some((x) => {
    const ran = x.day === day ? count - num(x.count) : count;
    return ran > hourly * Math.max(1, (t - Date.parse(x.at)) / HOUR_MS);
  });
  const samples = [...kept, { at: now.toISOString(), day, count }].slice(-TRIPWIRE_MAX_SAMPLES);
  const tripwireAt = fired ? now.toISOString() : (previous?.tripwireAt ?? null);
  const holding = fired || (heldFrom !== null && t - heldFrom < TRIPWIRE_HOLD_MS);
  return { fired, holding, samples, tripwireAt };
}

/**
 * Counts watched for external-load spikes (FREE-TIER.md §8.4 item 5): edf-app's metered
 * invocations, the metered Fast Origin Transfer (the exact image bytes edf-view reports serving
 * plus view-source HTML, uncalibrated) and the /v and /img requests edf-view reports. Each has a
 * daily floor under its baseline, so a quiet week (a baseline near 0) doesn't turn an ordinary
 * day into an alert. The floors are sized for gallery browsing (30 cards a page, each 1 /v + at
 * most 20 /img in "card" mode — 6.5 on average, measured on all 618 real cards on 2026-09-30, so
 * ≈ 195 /img a page, ≤ 600 for a page of image-heavy digests — and ≈ 0.38 MB of images and HTML,
 * ≈ 11.4 MB a page; FREE-TIER.md §8.4): the alert (3× the floor) fires past ≈ 100 first-view pages
 * of /v, ≈ 60 of /img (≈ 20 of worst-case digests) or ≈ 260 of transfer in one day — well above
 * what the owner and a few friends browse, far below a flood.
 */
export const SPIKE_WATCH: Readonly<Record<string, number>> = {
  [RESOURCES.vercelInvocations]: 2_000,
  [RESOURCES.vercelFotMb]: 1_000,
  "view.view_requests": 1_000,
  "view.img_requests": 4_000,
};
export const SPIKE_MULTIPLIER = 3;

/** Watched counts whose amount today exceeds 3× their 7-day baseline (or floor). */
export function externalLoadSpikes(usage: UsageSums): string[] {
  const today = usage.today;
  if (!today) return [];
  return Object.entries(SPIKE_WATCH)
    .filter(([code, floor]) => num(today[code]) > SPIKE_MULTIPLIER * Math.max(num(usage.trailing7dAvg[code]), floor))
    .map(([code]) => code);
}

const LEVELS: readonly GovernorLevel[] = [0, 1, 2, 3];

/** A resource's calibration factor (§8.1): the measured setting when sane, else the profile default. */
export function calibrationFactor(
  profile: BudgetProfile,
  calibration: Readonly<Record<string, number>>,
  key: string | null,
): number {
  if (!key) return 1;
  const fallback = profile.defaultCalibration[key] ?? 1;
  const v = calibration[key];
  // Reject junk so a bad setting can't disable a cap; any sane measured factor is accepted.
  return typeof v === "number" && Number.isFinite(v) && v >= 0.25 && v <= 10 ? v : fallback;
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

interface Evaluated extends ResourceStatus {
  spec: ResourceSpec;
  thresholds: Partial<Record<1 | 2 | 3, number>>;
}

function evaluate(spec: ResourceSpec, input: GovernorInput, overrideValue?: number): Evaluated {
  const { usage, profile, now, periodStart } = input;
  const f = calibrationFactor(profile, input.calibration, spec.calibrationKey);
  let raw: number;
  if (spec.window === "rolling_30d") raw = num(usage.rolling30d[spec.code]);
  else if (spec.window === "calendar_month") raw = num(usage.monthToDate[spec.code]);
  else
    raw =
      spec.code === RESOURCES.neonCuH
        ? num(input.neonCuHoursMtd)
        : num((usage.billingPeriodToDate ?? usage.monthToDate)[spec.code]);
  const value = overrideValue !== undefined ? Math.max(raw * f, overrideValue) : raw * f;

  let projected: number | null = null;
  let paceBudget: number | null = null;
  let projectedSoft = false;
  if (spec.projection) {
    const elapsed = daysElapsed(periodStart, now);
    if (elapsed >= profile.projection.minDaysElapsed) {
      const end = nextPeriodStart(periodStart, periodStart.getUTCDate());
      projected =
        value + daysRemaining(periodStart, end, now) * num(usage.trailing7dAvg[spec.code]) * f;
      projectedSoft = projected >= spec.soft;
    } else {
      paceBudget = elapsed * (spec.selfCap / 30) * profile.projection.earlyPaceMultiplier;
      projectedSoft = value >= paceBudget;
    }
  }

  const thresholds: Partial<Record<1 | 2 | 3, number>> = {};
  if (spec.global) {
    thresholds[1] = spec.soft;
    thresholds[2] = spec.l2 ?? spec.selfCap;
  }
  if (spec.l3 !== undefined) thresholds[3] = spec.l3;

  let level: GovernorLevel = 0;
  if (thresholds[3] !== undefined && value >= thresholds[3]) level = 3;
  else if (thresholds[2] !== undefined && value >= thresholds[2]) level = 2;
  else if (thresholds[1] !== undefined && (value >= thresholds[1] || projectedSoft)) level = 1;

  return {
    spec,
    thresholds,
    code: spec.code,
    unit: spec.unit,
    value,
    projected,
    paceBudget,
    selfCap: spec.selfCap,
    hardLimit: spec.hardLimit,
    soft: spec.soft,
    softReached: value >= spec.soft,
    capReached: value >= spec.selfCap,
    projectedSoft: projectedSoft && value < spec.soft,
    level,
  };
}

/** Every resource is below `clearFraction` of its threshold for `level` (projections included for L1). */
function clearOf(
  level: GovernorLevel,
  evals: readonly Evaluated[],
  profile: BudgetProfile,
): boolean {
  if (level === 0) return true;
  const k = profile.hysteresis.clearFraction;
  for (const e of evals) {
    const t = e.thresholds[level];
    if (t === undefined) continue;
    if (e.value >= k * t) return false;
    if (level === 1) {
      if (e.projected !== null && e.projected >= k * t) return false;
      if (e.paceBudget !== null && e.value >= k * e.paceBudget) return false;
    }
  }
  return true;
}

function actionsFor(
  level: GovernorLevel,
  r: {
    fotSoft: boolean;
    fotCap: boolean;
    inngestSoft: boolean;
    executionTripwire: boolean;
    inngestCap: boolean;
    sandboxSoft: boolean;
    sandboxCap: boolean;
    sandboxFillLimit: boolean;
    sandboxStaticOnly: boolean;
    aiSoft: boolean;
    aiCap: boolean;
    storageMb: number;
    neonL1: boolean;
    googleAccounts: number;
  },
  profile: BudgetProfile,
): GovernorActions {
  const s = profile.neonStorageMb;
  const L1 = level >= 1;
  const L2 = level >= 2;
  const L3 = level >= 3;
  return {
    pollMultiplier: L1 ? 2 : 1,
    backgroundPollHours: L2 ? 6 : null,
    syncStatusPollingOff: L1,
    friendsSyncOnOpenMinMinutes: L2 ? 120 : null,
    recommendTick60: L1 || r.inngestSoft,
    continuationKicksOff: r.inngestSoft || r.executionTripwire || L3,
    planB: r.inngestCap,
    newBackfillsQueued: L1,
    noBackfills: r.inngestCap || L3,
    fillRendersOff: L1 || r.sandboxSoft || r.sandboxFillLimit,
    plannedRendersOff: L2 || r.sandboxCap,
    samplesOff: r.sandboxCap || L2,
    rendersOff: r.sandboxStaticOnly || L3,
    rendersNightlyOnly: r.inngestSoft,
    friendsBatchRequireTen: r.sandboxSoft,
    // Pictures are the gallery itself, and they cost Fast Origin Transfer, not much else (edf-view
    // shrinks each once a week; the CDN and browsers keep it). So only FOT (or the L3 freeze)
    // turns them off; CPU or Neon pressure (L1/L2) cuts background work instead. Until 2026-10-08
    // any L1 turned friends' pictures off and any L2 everyone's: a CPU L2 left the whole gallery
    // as alt text while FOT stood at 15%.
    friendsImagesClickToLoad: r.fotSoft || L3,
    imagesClickToLoad: r.fotCap || L3,
    classificationBatchOnly: L1,
    autoAiOff: r.aiSoft || L2,
    aiOff: r.aiCap || L3,
    storageRetentionShortened: r.storageMb >= s.shortenRetention,
    featuresCompactAfterDays: r.storageMb >= s.shortenRetention ? 7 : null,
    noAnalysisRows: r.storageMb >= s.noAnalysisRows,
    ingestPaused: r.storageMb >= s.pauseIngest,
    maintenanceAlignedWithTick: r.neonL1,
    backgroundWorkOff: L3,
    onDemandOff: L3,
    googleAccountsAlert: r.googleAccounts >= profile.googleAccounts.alert,
    invitesOff: r.googleAccounts >= profile.googleAccounts.invitesOff,
  };
}

export function sameActions(
  a: GovernorActions | undefined,
  b: GovernorActions | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    (Object.keys(a) as Array<keyof GovernorActions>).every((k) => a[k] === b[k]) &&
    Object.keys(b).length === Object.keys(a).length
  );
}

/** Pure governor computation (FREE-TIER.md §8.1–8.3). */
export function computeGovernor(input: GovernorInput): GovernorResult {
  const { profile, now, previous } = input;
  const nowIso = now.toISOString();
  const evals = profile.resources.map((spec) => evaluate(spec, input));

  // Anthropic: app cap = 0.9 × G; the actual is the larger of settled usage and reservations.
  const G =
    typeof input.aiCapUsd === "number" && Number.isFinite(input.aiCapUsd) && input.aiCapUsd >= 0
      ? input.aiCapUsd
      : 5;
  const aiCap = profile.anthropic.capFractionOfG * G;
  const aiSpec: ResourceSpec = {
    code: RESOURCES.anthropicUsd,
    unit: "USD",
    window: "calendar_month",
    hardLimit: G,
    selfCap: aiCap,
    soft: profile.anthropic.softFraction * aiCap,
    global: false,
    projection: true,
    calibrationKey: "anthropic",
  };
  const ai = evaluate(aiSpec, input, num(input.aiReservedUsd));

  const byCode = new Map(evals.map((e) => [e.code, e]));
  const get = (c: ResourceCode) => byCode.get(c);
  const sandbox = [
    get(RESOURCES.sandboxCpuS),
    get(RESOURCES.sandboxCreations),
    get(RESOURCES.sandboxMemGbh),
  ].filter((e): e is Evaluated => e !== undefined);
  const sandboxCpu = get(RESOURCES.sandboxCpuS);
  const fot = get(RESOURCES.vercelFotMb);
  const inngest = get(RESOURCES.inngestExecutions);
  const neon = get(RESOURCES.neonCuH);

  // Raw global level: the max any resource asks for.
  let rawLevel: GovernorLevel = 0;
  const rawTriggers: string[] = [];
  for (const e of evals) {
    if (e.level === 0) continue;
    rawLevel = Math.max(rawLevel, e.level) as GovernorLevel;
    rawTriggers.push(
      `${e.code}:L${e.level}${e.level === 1 && e.projectedSoft ? ":projected" : ""}`,
    );
  }

  const wire = executionTripwire(
    TRIPWIRE_PLAN_PER_MONTH,
    input.usage.today?.[RESOURCES.inngestExecutions],
    previous,
    now,
  );
  if (wire.holding) {
    rawLevel = Math.max(rawLevel, 1) as GovernorLevel;
    rawTriggers.push(`${RESOURCES.inngestExecutions}:L1:tripwire`);
  }

  // Hysteresis (§8.1): step down one level only after holdMs below clearFraction of its thresholds.
  const prevLevel: GovernorLevel = previous && LEVELS.includes(previous.level) ? previous.level : 0;
  let level: GovernorLevel;
  let since: string | null;
  let belowSince: string | null;
  let triggers: string[];
  if (rawLevel >= prevLevel) {
    level = rawLevel;
    since = rawLevel > prevLevel || !previous?.since ? nowIso : previous.since;
    belowSince = null;
    triggers = rawTriggers;
  } else if (!clearOf(prevLevel, evals, profile)) {
    level = prevLevel;
    since = previous?.since ?? nowIso;
    belowSince = null;
    triggers = [...new Set([...(previous?.triggers ?? []), ...rawTriggers])];
  } else {
    const start = previous?.belowSince ? Date.parse(previous.belowSince) : Number.NaN;
    const clearSince = Number.isNaN(start) ? now.getTime() : Math.min(start, now.getTime());
    if (now.getTime() - clearSince >= profile.hysteresis.holdMs) {
      level = Math.max(rawLevel, prevLevel - 1) as GovernorLevel;
      since = nowIso;
      belowSince = level > rawLevel && clearOf(level, evals, profile) ? nowIso : null;
      triggers =
        level === rawLevel
          ? rawTriggers
          : [...new Set([...(previous?.triggers ?? []), ...rawTriggers])];
    } else {
      level = prevLevel;
      since = previous?.since ?? nowIso;
      belowSince = new Date(clearSince).toISOString();
      triggers = [...new Set([...(previous?.triggers ?? []), ...rawTriggers])];
    }
  }

  const storageMb = num(input.neonStorageMb);
  const actions = actionsFor(
    level,
    {
      fotSoft: fot?.softReached ?? false,
      fotCap: fot?.capReached ?? false,
      inngestSoft: (inngest?.softReached ?? false) || (inngest?.projectedSoft ?? false),
      executionTripwire: wire.holding,
      inngestCap: inngest?.capReached ?? false,
      sandboxSoft: sandbox.some((e) => e.softReached),
      sandboxCap: sandbox.some((e) => e.capReached),
      sandboxFillLimit: sandboxCpu
        ? sandboxCpu.value >= profile.sandboxFillMaxFractionOfHard * sandboxCpu.hardLimit
        : false,
      sandboxStaticOnly: sandbox.some(
        (e) => e.value >= profile.sandboxStaticOnlyFractionOfHard * e.hardLimit,
      ),
      aiSoft: ai.softReached || ai.projectedSoft,
      aiCap: ai.capReached,
      storageMb,
      neonL1: neon ? neon.value >= neon.soft : false,
      googleAccounts: num(input.googleAccounts),
    },
    profile,
  );

  const strip = ({ spec: _s, thresholds: _t, ...rest }: Evaluated): ResourceStatus => rest;
  const state: GovernorState = {
    level,
    since,
    triggers,
    belowSince,
    actions,
    computedAt: nowIso,
    ...(wire.samples.length > 0 ? { executions: wire.samples } : {}),
    ...(wire.tripwireAt ? { tripwireAt: wire.tripwireAt } : {}),
  };
  return {
    level,
    rawLevel,
    triggers,
    since,
    belowSince,
    actions,
    changed: level !== prevLevel || !sameActions(actions, previous?.actions),
    resources: [...evals.map(strip), strip(ai)],
    neonStorageMb: storageMb,
    state,
    executionTripwire: wire.holding,
    executionTripwireFired: wire.fired,
    externalLoadSpikes: externalLoadSpikes(input.usage),
  };
}

// ───────────────────────── I/O ─────────────────────────

const actionsSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.null()]));
const sampleSchema = z.object({ at: z.string(), day: z.string(), count: z.number() });
const stateSchema = z.object({
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  since: z.string().nullable().optional(),
  triggers: z.array(z.string()).optional(),
  belowSince: z.string().nullable().optional(),
  actions: actionsSchema.optional(),
  // One sample per run; a single object is read as a one-sample list.
  executions: z
    .union([z.array(sampleSchema), sampleSchema.transform((x) => [x])])
    .optional(),
  tripwireAt: z.string().nullable().optional(),
});

/** Parse a stored governor state; anything unreadable is treated as "no previous state". */
export function parseGovernorState(value: unknown): GovernorState | null {
  const p = stateSchema.safeParse(value);
  if (!p.success) return null;
  return {
    level: p.data.level,
    since: p.data.since ?? null,
    triggers: p.data.triggers ?? [],
    belowSince: p.data.belowSince ?? null,
    ...(p.data.actions ? { actions: p.data.actions as unknown as GovernorActions } : {}),
    ...(p.data.executions ? { executions: p.data.executions } : {}),
    ...(p.data.tripwireAt ? { tripwireAt: p.data.tripwireAt } : {}),
  };
}

export interface UsageSnapshot {
  now: Date;
  usage: Required<UsageSums>;
  neonCuHoursMtd: number;
  neonAwakeMinutes: number;
  neonStorageMb: number;
  calibration: Record<string, number>;
  aiCapUsd: number;
  aiReservedUsd: number;
  googleAccounts: number;
  periodStart: Date;
  neonPeriodStart: Date;
  previous: GovernorState | null;
}

const calibrationSchema = z.record(z.string(), z.number());

/**
 * Load everything the governor needs in one read-only transaction: usage sums from
 * `usage_ledger`, awake minutes from `neon_awake`, `pg_database_size()`, AI reservations,
 * lifetime Google accounts and the relevant `app_setting` rows.
 */
export async function loadUsageSnapshot(
  pool: Pool,
  now: Date = new Date(),
  profile: BudgetProfile = FREE_TIER_PROFILE,
): Promise<UsageSnapshot> {
  return withSystem(pool, async (_db, client) => {
    const settings = new Map<string, unknown>(
      (
        await client.query<{ key: string; value: unknown }>(
          "SELECT key, value FROM app_setting WHERE key = ANY($1::text[])",
          [["calibration", "neon.period_start", "ai.cap_usd", "governor"]],
        )
      ).rows.map((r) => [r.key, r.value]),
    );
    const cal = calibrationSchema.safeParse(settings.get("calibration"));
    const calibration = cal.success ? cal.data : {};
    const anchor = settings.get("neon.period_start");
    const periodStart = calendarMonthStart(now);
    const neonPeriodStart = billingPeriodStart(typeof anchor === "string" ? anchor : null, now);
    const capRaw = settings.get("ai.cap_usd");
    const capNum =
      typeof capRaw === "number"
        ? capRaw
        : typeof capRaw === "string"
          ? Number(capRaw)
          : Number.NaN;
    const aiCapUsd = Number.isFinite(capNum) && capNum >= 0 ? capNum : 5;

    const today = utcDay(now);
    const rolling = utcDay(startOfUtcDay(now).getTime() - 29 * DAY_MS);
    const weekAgo = utcDay(startOfUtcDay(now).getTime() - 7 * DAY_MS);
    const month = utcDay(periodStart);
    const neonStart = utcDay(neonPeriodStart);
    const earliest = [rolling, month, neonStart, weekAgo].sort()[0] as string;
    const sums = await client.query<{
      resource: string;
      rolling: string | null;
      mtd: string | null;
      bp: string | null;
      w7: string | null;
      today: string | null;
    }>(
      `SELECT resource,
              sum(amount) FILTER (WHERE day >= $2::date) AS rolling,
              sum(amount) FILTER (WHERE day >= $3::date) AS mtd,
              sum(amount) FILTER (WHERE day >= $4::date) AS bp,
              sum(amount) FILTER (WHERE day >= $5::date AND day < $1::date) AS w7,
              sum(amount) FILTER (WHERE day = $1::date) AS today
         FROM usage_ledger
        WHERE day >= $6::date AND day <= $1::date
        GROUP BY resource`,
      [today, rolling, month, neonStart, weekAgo, earliest],
    );
    const usage: Required<UsageSums> = {
      rolling30d: {},
      monthToDate: {},
      billingPeriodToDate: {},
      trailing7dAvg: {},
      today: {},
    };
    const r30 = usage.rolling30d as Record<string, number>;
    const mtd = usage.monthToDate as Record<string, number>;
    const bp = usage.billingPeriodToDate as Record<string, number>;
    const w7 = usage.trailing7dAvg as Record<string, number>;
    const td = usage.today as Record<string, number>;
    for (const row of sums.rows) {
      r30[row.resource] = Number(row.rolling ?? 0);
      mtd[row.resource] = Number(row.mtd ?? 0);
      bp[row.resource] = Number(row.bp ?? 0);
      w7[row.resource] = Number(row.w7 ?? 0) / 7;
      td[row.resource] = Number(row.today ?? 0);
    }

    const awake = await client.query<{ minutes: string }>(
      "SELECT coalesce(sum(bit_count(minutes)), 0)::bigint AS minutes FROM neon_awake WHERE day >= $1::date AND day <= $2::date",
      [neonStart, today],
    );
    const neonAwakeMinutes = Number(awake.rows[0]?.minutes ?? 0);
    const size = await client.query<{ bytes: string }>(
      "SELECT pg_database_size(current_database())::bigint AS bytes",
    );
    const reserved = await client.query<{ usd: string | null }>(
      "SELECT reserved_usd AS usd FROM llm_budget_global WHERE period = $1::date",
      [month],
    );
    const accounts = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM oauth_subject_seen",
    );

    return {
      now,
      usage,
      neonCuHoursMtd: (neonAwakeMinutes / 60) * profile.neon.computeUnits,
      neonAwakeMinutes,
      // Decimal MB (bytes / 1e6) reaches each threshold earlier than MiB would.
      neonStorageMb: Number(size.rows[0]?.bytes ?? 0) / 1e6,
      calibration,
      aiCapUsd,
      aiReservedUsd: Number(reserved.rows[0]?.usd ?? 0),
      googleAccounts: Number(accounts.rows[0]?.n ?? 0),
      periodStart,
      neonPeriodStart,
      previous: parseGovernorState(settings.get("governor")),
    };
  });
}

/**
 * Alert codes (codes only, never content) worth an out-of-band alert (§8.5): transitions, the
 * tripwire firing, and external-load spikes while they last (raiseAlert re-sends a code at most
 * every 6 h).
 */
export function governorAlerts(previous: GovernorState | null, result: GovernorResult): string[] {
  const alerts: string[] = [];
  const prevLevel = previous?.level ?? 0;
  if (result.level !== prevLevel) alerts.push(`governor_level_${result.level}`);
  const was = previous?.actions;
  const rose = (k: keyof GovernorActions) => result.actions[k] === true && was?.[k] !== true;
  if (rose("recommendTick60")) alerts.push("set_tick_every_60");
  if (rose("planB")) alerts.push("inngest_plan_b");
  if (rose("autoAiOff")) alerts.push("ai_auto_reviews_off");
  if (rose("aiOff")) alerts.push("ai_budget_exhausted");
  if (rose("ingestPaused")) alerts.push("neon_storage_ingest_paused");
  if (rose("googleAccountsAlert")) alerts.push("google_accounts_70");
  if (rose("invitesOff")) alerts.push("google_accounts_90");
  if (result.executionTripwireFired) alerts.push("EXECUTION_TRIPWIRE");
  if (result.externalLoadSpikes.length > 0) alerts.push("EXTERNAL_LOAD_SPIKE");
  return alerts;
}

/**
 * Load, compute and persist `app_setting.governor` (the tick and the daily cron call this).
 * The state row is locked (`FOR UPDATE`) only for the pure computation, so concurrent runs
 * serialise instead of losing each other's hysteresis clock. No HTTP happens inside.
 */
export async function runGovernor(
  pool: Pool,
  now: Date = new Date(),
  profile: BudgetProfile = FREE_TIER_PROFILE,
): Promise<{
  result: GovernorResult;
  alerts: string[];
  snapshot: UsageSnapshot;
  persisted: boolean;
}> {
  const snapshot = await loadUsageSnapshot(pool, now, profile);
  return withSystem(pool, async (db) => {
    const locked = await db.execute<{ value: unknown }>(
      sql`SELECT value FROM app_setting WHERE key = 'governor' FOR UPDATE`,
    );
    const previous = parseGovernorState(locked.rows[0]?.value);
    const result = computeGovernor({
      usage: snapshot.usage,
      neonCuHoursMtd: snapshot.neonCuHoursMtd,
      neonStorageMb: snapshot.neonStorageMb,
      calibration: snapshot.calibration,
      profile,
      now,
      periodStart: snapshot.periodStart,
      previous,
      aiCapUsd: snapshot.aiCapUsd,
      aiReservedUsd: snapshot.aiReservedUsd,
      googleAccounts: snapshot.googleAccounts,
    });
    const upd = await db.execute(
      sql`UPDATE app_setting SET value = ${JSON.stringify(result.state)}::jsonb, updated_at = now() WHERE key = 'governor'`,
    );
    return {
      result,
      alerts: governorAlerts(previous, result),
      snapshot,
      persisted: (upd.rowCount ?? 0) > 0,
    };
  });
}
