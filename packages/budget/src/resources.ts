/**
 * Metered resources and the free-tier budget profile (FREE-TIER.md §1.3, §2, §7, §8).
 *
 * `BudgetProfile` is the seam that becomes "paid caps" later (FREE-TIER §12): the governor
 * reads every limit, window and threshold from the profile, never from constants.
 */

/**
 * Resource codes written to `usage_ledger.resource` (DB CHECK `^[a-z0-9_.:-]{1,64}$`).
 * Byte-denominated resources are stored in MB (decimal) so a day's amount stays far below
 * `add_usage`'s 1e9 ceiling.
 */
export const RESOURCES = {
  vercelCpuS: "vercel.cpu_s",
  vercelInvocations: "vercel.invocations",
  vercelMemGbh: "vercel.mem_gbh",
  vercelEdgeRequests: "vercel.edge_requests",
  /**
   * Fast Origin Transfer (§8.1): the exact image bytes edf-view reports serving (/api/view-stats)
   * plus the large function responses edf-app sees (view-source HTML, twice: edf-app → edf-view →
   * browser; exports). Image bytes edf-view never manages to report: the `vercel_fot` factor.
   */
  vercelFotMb: "vercel.fot_mb",
  vercelFdtMb: "vercel.fdt_mb",
  sandboxCpuS: "sandbox.cpu_s",
  sandboxCreations: "sandbox.creations",
  sandboxMemGbh: "sandbox.mem_gbh",
  /** Inngest executions = runs + steps (the number Inngest bills). */
  inngestExecutions: "inngest.executions",
  inngestRuns: "inngest.runs",
  inngestSteps: "inngest.steps",
  /** Derived from `neon_awake` (never written to usage_ledger). */
  neonCuH: "neon.cu_h",
  /** Derived from `pg_database_size()` (never written to usage_ledger). */
  neonStorageMb: "neon.storage_mb",
  /** Bytes Postgres sent to edf-app's pool connections (socket counters, `clientBytesReceived`). */
  neonTransferMb: "neon.transfer_mb",
  anthropicUsd: "anthropic.usd",
  gmailUnits: "gmail.units",
  /** Image and link URLs a view had to drop because the signers refused them (diagnostic, not governed). */
  viewUnsignableUrls: "view.unsignable_urls",
} as const;
export type ResourceCode = (typeof RESOURCES)[keyof typeof RESOURCES];

export const RESOURCE_CODE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/**
 * How the vendor counts (§1.3 rule 2): Vercel and Sandbox over a rolling 30 days; Inngest and
 * Anthropic per calendar month; Neon per billing period.
 */
export type UsageWindow = "rolling_30d" | "calendar_month" | "billing_period";

/** One governed resource. All thresholds are absolute, in the resource's unit. */
export interface ResourceSpec {
  code: ResourceCode;
  unit: string;
  window: UsageWindow;
  /** The vendor's hard limit. */
  hardLimit: number;
  /** Our self-cap (≈ 60% of the hard limit; 70% where a breach only pauses one feature). */
  selfCap: number;
  /** Soft threshold (80% of the self-cap by default): global L1 / per-resource "soft" actions. */
  soft: number;
  /**
   * True for the shared resources that drive global levels (§8.2: Vercel, Neon compute and
   * transfer, Inngest). Sandbox, Anthropic and Neon storage are never global (§8.2 last line).
   */
  global: boolean;
  /** Global L2 threshold (actual only); defaults to the self-cap. */
  l2?: number;
  /** Global L3 threshold (actual only), if this resource can freeze the app. */
  l3?: number;
  /** Month-to-date + trailing-7-day projection may raise L1/soft (§8.1; Inngest, Anthropic). */
  projection: boolean;
  /** `app_setting.calibration` key; governor usage = metered × factor (§8.1). */
  calibrationKey: string | null;
}

export interface BudgetProfile {
  name: string;
  /** Global and per-resource specs, except Anthropic (derived from G) and Neon storage. */
  resources: readonly ResourceSpec[];
  /** A level steps down only after this long below `clearFraction` of its threshold (§8.1). */
  hysteresis: { clearFraction: number; holdMs: number };
  /** Projection is used from this many elapsed days; before that, a pace budget (§8.1). */
  projection: { minDaysElapsed: number; earlyPaceMultiplier: number };
  /** Sandbox "fill" renders run only below this fraction of the Sandbox CPU hard limit (§5.3). */
  sandboxFillMaxFractionOfHard: number;
  /**
   * Past the self-cap only your on-demand renders run; at this fraction of any Sandbox hard limit
   * rendering stops entirely ("then static-only", §8.3), before the vendor pauses creation.
   */
  sandboxStaticOnlyFractionOfHard: number;
  /** Anthropic: app cap = capFractionOfG × G; soft at softFraction of that (§6.5). */
  anthropic: { capFractionOfG: number; softFraction: number };
  /** Neon storage actions in MB (§8.3). */
  neonStorageMb: {
    shortenRetention: number;
    noAnalysisRows: number;
    pauseIngest: number;
    hard: number;
  };
  /** Google lifetime accounts (§8.3). */
  googleAccounts: { alert: number; invitesOff: number; hard: number };
  /**
   * Default calibration factors (§8.1): Vercel CPU starts at 1.5, Sandbox at 1.0, Fast Origin
   * Transfer at 1.25 (served image bytes edf-view never manages to report, e.g. a failed report
   * with no later image request; packages/budget/DECISIONS.md). A key missing from
   * `app_setting.calibration` falls back to these (`calibrationFactor`).
   */
  defaultCalibration: Readonly<Record<string, number>>;
  /** Neon compute size and the scale-to-zero tail used by the pool-based estimate (§8.1). */
  neon: { computeUnits: number; idleTailMinutes: number };
  /** Vercel function memory (fixed at 2 GB on Hobby). */
  functionMemoryGb: number;
  /** Sandbox memory per vCPU. */
  sandboxMemoryGbPerVcpu: number;
}

const soft = (selfCap: number) => selfCap * 0.8;

/** The free-tier profile (FREE-TIER.md §2, §7, §8). */
export const FREE_TIER_PROFILE: BudgetProfile = {
  name: "free",
  resources: [
    // Vercel Hobby, rolling 30 days, shared by the three projects (§2).
    {
      code: RESOURCES.vercelCpuS,
      unit: "CPU-s",
      window: "rolling_30d",
      hardLimit: 14_400,
      selfCap: 8_640,
      soft: 6_912,
      global: true,
      l3: 10_080,
      projection: false,
      calibrationKey: "vercel_cpu",
    },
    {
      code: RESOURCES.vercelInvocations,
      unit: "invocations",
      window: "rolling_30d",
      hardLimit: 1_000_000,
      selfCap: 600_000,
      soft: soft(600_000),
      global: true,
      l3: 700_000,
      projection: false,
      calibrationKey: "vercel_invocations",
    },
    {
      code: RESOURCES.vercelMemGbh,
      unit: "GB-h",
      window: "rolling_30d",
      hardLimit: 360,
      selfCap: 216,
      soft: soft(216),
      global: true,
      l3: 252,
      projection: false,
      calibrationKey: "vercel_mem",
    },
    {
      code: RESOURCES.vercelEdgeRequests,
      unit: "requests",
      window: "rolling_30d",
      hardLimit: 1_000_000,
      selfCap: 600_000,
      soft: soft(600_000),
      global: true,
      projection: false,
      calibrationKey: "vercel_edge",
    },
    // FOT: its own image actions at soft/cap (§8.3); L3 at 70% of the hard limit (§8.2).
    {
      code: RESOURCES.vercelFotMb,
      unit: "MB",
      window: "rolling_30d",
      hardLimit: 10_000,
      selfCap: 6_000,
      soft: soft(6_000),
      global: false,
      l3: 7_000,
      projection: false,
      calibrationKey: "vercel_fot",
    },
    {
      code: RESOURCES.vercelFdtMb,
      unit: "MB",
      window: "rolling_30d",
      hardLimit: 100_000,
      selfCap: 60_000,
      soft: soft(60_000),
      global: false,
      projection: false,
      calibrationKey: "vercel_fdt",
    },
    // Vercel Sandbox: its own allowance; only creation pauses, so 70% self-caps (§2).
    {
      code: RESOURCES.sandboxCpuS,
      unit: "CPU-s",
      window: "rolling_30d",
      hardLimit: 18_000,
      selfCap: 12_600,
      soft: soft(12_600),
      global: false,
      projection: false,
      calibrationKey: "sandbox_cpu",
    },
    {
      code: RESOURCES.sandboxCreations,
      unit: "sandboxes",
      window: "rolling_30d",
      hardLimit: 5_000,
      selfCap: 3_000,
      soft: soft(3_000),
      global: false,
      projection: false,
      calibrationKey: null,
    },
    {
      code: RESOURCES.sandboxMemGbh,
      unit: "GB-h",
      window: "rolling_30d",
      hardLimit: 420,
      selfCap: 294,
      soft: soft(294),
      global: false,
      projection: false,
      calibrationKey: "sandbox_mem",
    },
    // Inngest Free: calendar month; self-cap 30k, L3 at 40k actual (§4.7, §8.2).
    {
      code: RESOURCES.inngestExecutions,
      unit: "executions",
      window: "calendar_month",
      hardLimit: 50_000,
      selfCap: 30_000,
      soft: soft(30_000),
      global: true,
      l3: 40_000,
      projection: true,
      calibrationKey: "inngest",
    },
    // Neon Free: billing period; compute uses fixed actual thresholds 50/60/80 CU-h (§8.1).
    {
      code: RESOURCES.neonCuH,
      unit: "CU-h",
      window: "billing_period",
      hardLimit: 100,
      selfCap: 60,
      soft: 50,
      l2: 60,
      l3: 80,
      global: true,
      projection: false,
      calibrationKey: "neon_cu",
    },
    {
      code: RESOURCES.neonTransferMb,
      unit: "MB",
      window: "billing_period",
      hardLimit: 5_000,
      selfCap: 3_000,
      soft: soft(3_000),
      global: true,
      projection: false,
      calibrationKey: "neon_transfer",
    },
  ],
  hysteresis: { clearFraction: 0.8, holdMs: 24 * 3_600_000 },
  projection: { minDaysElapsed: 7, earlyPaceMultiplier: 1.5 },
  sandboxFillMaxFractionOfHard: 0.55,
  sandboxStaticOnlyFractionOfHard: 0.9,
  anthropic: { capFractionOfG: 0.9, softFraction: 0.8 },
  neonStorageMb: { shortenRetention: 250, noAnalysisRows: 300, pauseIngest: 350, hard: 500 },
  googleAccounts: { alert: 70, invitesOff: 90, hard: 100 },
  defaultCalibration: { vercel_cpu: 1.5, sandbox_cpu: 1.0, vercel_fot: 1.25 },
  neon: { computeUnits: 0.25, idleTailMinutes: 5 },
  functionMemoryGb: 2,
  sandboxMemoryGbPerVcpu: 2,
};

export function resourceSpec(profile: BudgetProfile, code: ResourceCode): ResourceSpec | undefined {
  return profile.resources.find((r) => r.code === code);
}
