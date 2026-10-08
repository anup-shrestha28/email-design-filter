import { describe, expect, it } from "vitest";
import {
  calendarMonthStart,
  computeGovernor,
  FREE_TIER_PROFILE,
  governorAlerts,
  parseGovernorState,
  RESOURCES as R,
  type GovernorInput,
  type GovernorLevel,
  type GovernorState,
} from "../src/index";

const NOW = new Date("2026-09-20T12:00:00Z"); // day 20 of a 30-day month: 10 days remain after today
const H = 3_600_000;

function input(
  o: {
    r30?: Record<string, number>;
    mtd?: Record<string, number>;
    bp?: Record<string, number>;
    w7?: Record<string, number>;
    neon?: number;
    storage?: number;
    calibration?: Record<string, number>;
    now?: Date;
    previous?: GovernorState | null;
    aiCapUsd?: number;
    aiReservedUsd?: number;
    googleAccounts?: number;
  } = {},
): GovernorInput {
  const now = o.now ?? NOW;
  return {
    usage: {
      rolling30d: o.r30 ?? {},
      monthToDate: o.mtd ?? {},
      trailing7dAvg: o.w7 ?? {},
      ...(o.bp ? { billingPeriodToDate: o.bp } : {}),
    },
    neonCuHoursMtd: o.neon ?? 0,
    neonStorageMb: o.storage ?? 50,
    calibration: o.calibration ?? { vercel_cpu: 1.5, sandbox_cpu: 1.0 },
    profile: FREE_TIER_PROFILE,
    now,
    periodStart: calendarMonthStart(now),
    previous: o.previous ?? null,
    aiCapUsd: o.aiCapUsd ?? 5,
    ...(o.aiReservedUsd !== undefined ? { aiReservedUsd: o.aiReservedUsd } : {}),
    ...(o.googleAccounts !== undefined ? { googleAccounts: o.googleAccounts } : {}),
  };
}

const level = (i: GovernorInput) => computeGovernor(i).level;

describe("global levels (FREE-TIER §8.2)", () => {
  it("everything quiet → L0 with default behaviour", () => {
    const r = computeGovernor(input());
    expect(r.level).toBe(0);
    expect(r.triggers).toEqual([]);
    expect(r.actions).toMatchObject({
      pollMultiplier: 1,
      backgroundPollHours: null,
      fillRendersOff: false,
      autoAiOff: false,
      aiOff: false,
      imagesClickToLoad: false,
      friendsImagesClickToLoad: false,
      ingestPaused: false,
      recommendTick60: false,
    });
  });

  it.each([
    // [name, input, expected level]
    ["Vercel CPU below L1 (4,607 × 1.5)", input({ r30: { [R.vercelCpuS]: 4607 } }), 0],
    [
      "Vercel CPU at L1 6,912 (4,608 × 1.5 calibration)",
      input({ r30: { [R.vercelCpuS]: 4608 } }),
      1,
    ],
    ["Vercel CPU at the 8,640 self-cap → L2", input({ r30: { [R.vercelCpuS]: 5760 } }), 2],
    ["Vercel CPU at 70% of hard (10,080) → L3", input({ r30: { [R.vercelCpuS]: 6720 } }), 3],
    [
      "calibration 1.0 → 6,912 metered is L1",
      input({ r30: { [R.vercelCpuS]: 6912 }, calibration: { vercel_cpu: 1.0 } }),
      1,
    ],
    [
      "junk calibration falls back to 1.5",
      input({ r30: { [R.vercelCpuS]: 4608 }, calibration: { vercel_cpu: 0 } }),
      1,
    ],
    [
      "missing calibration falls back to 1.5",
      input({ r30: { [R.vercelCpuS]: 4608 }, calibration: {} }),
      1,
    ],
    ["invocations 480k → L1", input({ r30: { [R.vercelInvocations]: 480_000 } }), 1],
    ["invocations 600k → L2", input({ r30: { [R.vercelInvocations]: 600_000 } }), 2],
    ["invocations 700k → L3", input({ r30: { [R.vercelInvocations]: 700_000 } }), 3],
    ["memory 172.8 GB-h → L1", input({ r30: { [R.vercelMemGbh]: 172.8 } }), 1],
    ["memory 216 GB-h → L2", input({ r30: { [R.vercelMemGbh]: 216 } }), 2],
    ["memory 252 GB-h → L3", input({ r30: { [R.vercelMemGbh]: 252 } }), 3],
    ["edge requests 600k → L2", input({ r30: { [R.vercelEdgeRequests]: 600_000 } }), 2],
    ["edge requests have no L3", input({ r30: { [R.vercelEdgeRequests]: 999_999 } }), 2],
    // FOT is metered from edf-view's exact byte reports; the default `vercel_fot` factor 1.25
    // covers image bytes edf-view never manages to report (packages/budget/DECISIONS.md).
    ["FOT soft/cap are image actions only (5,599 × 1.25)", input({ r30: { [R.vercelFotMb]: 5599 } }), 0],
    ["FOT ≥ 70% of hard (7 GB = 5,600 × 1.25) → L3", input({ r30: { [R.vercelFotMb]: 5600 } }), 3],
    [
      "FOT calibration 1.0 → 6,999 metered is below L3",
      input({ r30: { [R.vercelFotMb]: 6999 }, calibration: { vercel_fot: 1.0 } }),
      0,
    ],
    [
      "FOT calibration 1.0 → 7,000 metered is L3",
      input({ r30: { [R.vercelFotMb]: 7000 }, calibration: { vercel_fot: 1.0 } }),
      3,
    ],
    [
      "a calibration setting without vercel_fot falls back to 1.25",
      input({ r30: { [R.vercelFotMb]: 5600 }, calibration: { vercel_cpu: 1.5, sandbox_cpu: 1.0 } }),
      3,
    ],
    [
      "junk vercel_fot calibration falls back to 1.25",
      input({ r30: { [R.vercelFotMb]: 5600 }, calibration: { vercel_fot: -1 } }),
      3,
    ],
    ["missing FOT calibration falls back to 1.25", input({ r30: { [R.vercelFotMb]: 5600 }, calibration: {} }), 3],
    ["Neon 49.9 CU-h → L0", input({ neon: 49.9 }), 0],
    ["Neon 50 CU-h → L1", input({ neon: 50 }), 1],
    ["Neon 60 CU-h → L2", input({ neon: 60 }), 2],
    ["Neon 80 CU-h → L3", input({ neon: 80 }), 3],
    ["Neon transfer 2.4 GB → L1", input({ bp: { [R.neonTransferMb]: 2400 } }), 1],
    ["Neon transfer 3 GB → L2", input({ bp: { [R.neonTransferMb]: 3000 } }), 2],
    ["Inngest 24k actual → L1", input({ mtd: { [R.inngestExecutions]: 24_000 } }), 1],
    ["Inngest 30k actual → L2", input({ mtd: { [R.inngestExecutions]: 30_000 } }), 2],
    ["Inngest 40k actual → L3", input({ mtd: { [R.inngestExecutions]: 40_000 } }), 3],
    ["the worst resource wins", input({ r30: { [R.vercelCpuS]: 4608 }, neon: 61 }), 2],
  ] as Array<[string, GovernorInput, GovernorLevel]>)("%s", (_name, i, expected) => {
    expect(level(i)).toBe(expected);
  });

  it("Sandbox, Anthropic and Neon storage never trigger global levels", () => {
    const r = computeGovernor(
      input({
        r30: { [R.sandboxCpuS]: 50_000, [R.sandboxCreations]: 9_000, [R.sandboxMemGbh]: 1_000 },
        mtd: { [R.anthropicUsd]: 50 },
        storage: 499,
        aiReservedUsd: 50,
      }),
    );
    expect(r.level).toBe(0);
    expect(r.actions).toMatchObject({
      samplesOff: true,
      fillRendersOff: true,
      plannedRendersOff: true,
      rendersOff: true,
      aiOff: true,
      ingestPaused: true,
      backgroundWorkOff: false,
      onDemandOff: false,
    });
  });
});

describe("projection only raises L1 (FREE-TIER §8.1)", () => {
  it("Inngest: MTD + days remaining × trailing 7-day average ≥ 80% of the self-cap → L1 (projected)", () => {
    const r = computeGovernor(
      input({ mtd: { [R.inngestExecutions]: 15_000 }, w7: { [R.inngestExecutions]: 1_000 } }),
    );
    expect(r.level).toBe(1);
    expect(r.triggers).toEqual(["inngest.executions:L1:projected"]);
    const inngest = r.resources.find((x) => x.code === R.inngestExecutions);
    expect(inngest?.projected).toBe(25_000);
    expect(r.actions).toMatchObject({
      recommendTick60: true,
      rendersNightlyOnly: true,
      continuationKicksOff: true,
      planB: false,
    });
  });

  it("a projection far above the self-cap still only gives L1", () => {
    const r = computeGovernor(
      input({ mtd: { [R.inngestExecutions]: 20_000 }, w7: { [R.inngestExecutions]: 5_000 } }),
    );
    expect(r.resources.find((x) => x.code === R.inngestExecutions)?.projected).toBe(70_000);
    expect(r.level).toBe(1);
  });

  it("before day 7 a pace budget (self-cap ÷ 30 × 1.5 per day) stands in for the projection", () => {
    const day3 = new Date("2026-09-03T08:00:00Z");
    // pace budget on day 3 = 3 × 1,000 × 1.5 = 4,500
    expect(
      level(
        input({
          now: day3,
          mtd: { [R.inngestExecutions]: 4_400 },
          w7: { [R.inngestExecutions]: 9_999 },
        }),
      ),
    ).toBe(0);
    const r = computeGovernor(input({ now: day3, mtd: { [R.inngestExecutions]: 4_600 } }));
    expect(r.level).toBe(1);
    expect(r.resources.find((x) => x.code === R.inngestExecutions)).toMatchObject({
      projected: null,
      paceBudget: 4_500,
      projectedSoft: true,
    });
    expect(level(input({ now: day3, mtd: { [R.inngestExecutions]: 31_000 } }))).toBe(2); // actual still counts
  });

  it("Anthropic: soft (80% of 0.9 × G) actual or projected turns automatic reviews off; the cap turns AI off", () => {
    expect(computeGovernor(input({ mtd: { [R.anthropicUsd]: 3.6 } })).actions).toMatchObject({
      autoAiOff: true,
      aiOff: false,
    });
    expect(computeGovernor(input({ mtd: { [R.anthropicUsd]: 4.5 } })).actions).toMatchObject({
      autoAiOff: true,
      aiOff: true,
    });
    // Reservations (incl. in-flight calls) count as actual spend.
    expect(
      computeGovernor(input({ mtd: { [R.anthropicUsd]: 1 }, aiReservedUsd: 4.5 })).actions.aiOff,
    ).toBe(true);
    // Projection: 2.50 + 10 × 0.12 = 3.70 ≥ 3.60.
    const p = computeGovernor(
      input({ mtd: { [R.anthropicUsd]: 2.5 }, w7: { [R.anthropicUsd]: 0.12 } }),
    );
    expect(p.actions).toMatchObject({ autoAiOff: true, aiOff: false });
    expect(p.level).toBe(0);
    // G scales the cap: at G = 10 the app stops at 9.
    expect(
      computeGovernor(input({ aiCapUsd: 10, mtd: { [R.anthropicUsd]: 8.9 } })).actions.aiOff,
    ).toBe(false);
  });
});

describe("per-resource actions (FREE-TIER §8.3)", () => {
  it.each([
    [
      "Sandbox ≥ 55% of hard: fill off only",
      { r30: { [R.sandboxCpuS]: 9_900 } },
      { fillRendersOff: true, friendsBatchRequireTen: false, samplesOff: false },
    ],
    [
      "Sandbox soft: fill off, friends need ≥ 10",
      { r30: { [R.sandboxCpuS]: 10_080 } },
      { fillRendersOff: true, friendsBatchRequireTen: true, samplesOff: false },
    ],
    [
      "Sandbox CPU at self-cap: samples off, your on-demand only",
      { r30: { [R.sandboxCpuS]: 12_600 } },
      { samplesOff: true, plannedRendersOff: true, rendersOff: false },
    ],
    [
      "Sandbox creations at self-cap: samples off, your on-demand only",
      { r30: { [R.sandboxCreations]: 3_000 } },
      { samplesOff: true, plannedRendersOff: true, rendersOff: false },
    ],
    [
      "Sandbox CPU just below 90% of hard: your on-demand still renders",
      { r30: { [R.sandboxCpuS]: 16_199 } },
      { plannedRendersOff: true, rendersOff: false },
    ],
    [
      "Sandbox CPU at 90% of hard: static-only",
      { r30: { [R.sandboxCpuS]: 16_200 } },
      { plannedRendersOff: true, rendersOff: true },
    ],
    [
      "Sandbox memory at 90% of hard: static-only",
      { r30: { [R.sandboxMemGbh]: 378 } },
      { rendersOff: true },
    ],
    [
      "FOT soft (3,840 metered × 1.25 = 4,800): friends' images click-to-load",
      { r30: { [R.vercelFotMb]: 3_840 } },
      { friendsImagesClickToLoad: true, imagesClickToLoad: false },
    ],
    [
      "FOT self-cap (4,800 metered × 1.25 = 6,000): everyone's images click-to-load",
      { r30: { [R.vercelFotMb]: 4_800 } },
      { friendsImagesClickToLoad: true, imagesClickToLoad: true },
    ],
    [
      "Inngest self-cap: Plan B and no backfills",
      { mtd: { [R.inngestExecutions]: 30_000 } },
      { planB: true, noBackfills: true },
    ],
    [
      "Neon 50 CU-h: maintenance aligned with a tick",
      { neon: 50 },
      { maintenanceAlignedWithTick: true },
    ],
    [
      "storage 250 MB",
      { storage: 250 },
      {
        storageRetentionShortened: true,
        featuresCompactAfterDays: 7,
        noAnalysisRows: false,
        ingestPaused: false,
      },
    ],
    ["storage 300 MB", { storage: 300 }, { noAnalysisRows: true, ingestPaused: false }],
    [
      "storage 350 MB: ingest paused",
      { storage: 350 },
      { noAnalysisRows: true, ingestPaused: true },
    ],
    [
      "70 Google accounts: alert",
      { googleAccounts: 70 },
      { googleAccountsAlert: true, invitesOff: false },
    ],
    [
      "90 Google accounts: invites off",
      { googleAccounts: 90 },
      { googleAccountsAlert: true, invitesOff: true },
    ],
  ] as const)("%s", (_name, o, expected) => {
    expect(computeGovernor(input(o)).actions).toMatchObject(expected);
  });

  it("level behaviours accumulate: L1 ⊂ L2 ⊂ L3", () => {
    const l1 = computeGovernor(input({ neon: 50 })).actions;
    expect(l1).toMatchObject({
      pollMultiplier: 2,
      recommendTick60: true,
      fillRendersOff: true,
      newBackfillsQueued: true,
      // Pictures stay on under CPU/Neon pressure; only FOT (or L3) turns them off.
      friendsImagesClickToLoad: false,
      imagesClickToLoad: false,
      syncStatusPollingOff: true,
      classificationBatchOnly: true,
      backgroundPollHours: null,
      autoAiOff: false,
    });
    const l2 = computeGovernor(input({ neon: 60 })).actions;
    expect(l2).toMatchObject({
      backgroundPollHours: 6,
      friendsSyncOnOpenMinMinutes: 120,
      plannedRendersOff: true,
      samplesOff: true,
      autoAiOff: true,
      imagesClickToLoad: false,
      friendsImagesClickToLoad: false,
      pollMultiplier: 2,
      aiOff: false,
      backgroundWorkOff: false,
      rendersOff: false,
    });
    const l3 = computeGovernor(input({ neon: 80 })).actions;
    expect(l3).toMatchObject({
      backgroundWorkOff: true,
      onDemandOff: true,
      rendersOff: true,
      aiOff: true,
      noBackfills: true,
      continuationKicksOff: true,
      imagesClickToLoad: true,
      friendsImagesClickToLoad: true,
    });
  });
});

describe("hysteresis (FREE-TIER §8.1)", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const prev = (lvl: GovernorLevel, belowSince: string | null = null): GovernorState => ({
    level: lvl,
    since: at(-72 * H),
    triggers: ["neon.cu_h:L" + lvl],
    belowSince,
  });

  it("raises immediately", () => {
    const r = computeGovernor(input({ neon: 80, previous: prev(0) }));
    expect(r.level).toBe(3);
    expect(r.since).toBe(NOW.toISOString());
    expect(r.changed).toBe(true);
  });

  it("holds while any resource is ≥ 80% of the current level's threshold", () => {
    const r = computeGovernor(input({ neon: 55, previous: prev(2, at(-48 * H)) })); // 55 ≥ 0.8 × 60
    expect(r.level).toBe(2);
    expect(r.rawLevel).toBe(1);
    expect(r.belowSince).toBeNull(); // the clock restarts
    expect(r.since).toBe(at(-72 * H));
  });

  it("starts the 24 h clock once everything is below 80%", () => {
    const r = computeGovernor(input({ neon: 40, previous: prev(2) }));
    expect(r.level).toBe(2);
    expect(r.belowSince).toBe(NOW.toISOString());
    expect(r.changed).toBe(true); // actions were absent in `previous`
  });

  it("keeps the level for less than 24 h below", () => {
    const r = computeGovernor(input({ neon: 40, previous: prev(2, at(-23 * H)) }));
    expect(r.level).toBe(2);
    expect(r.belowSince).toBe(at(-23 * H));
  });

  it("steps down exactly one level after 24 h below, then needs another 24 h", () => {
    const r = computeGovernor(input({ neon: 40, previous: prev(2, at(-24 * H)) }));
    expect(r.rawLevel).toBe(0);
    expect(r.level).toBe(1);
    expect(r.since).toBe(NOW.toISOString());
    expect(r.belowSince).toBeNull(); // 40 is not below 80% of the L1 threshold (40)

    const r2 = computeGovernor(input({ neon: 30, previous: prev(2, at(-30 * H)) }));
    expect(r2.level).toBe(1);
    expect(r2.belowSince).toBe(NOW.toISOString()); // already below 80% of L1 → new clock starts now

    const r3 = computeGovernor(input({ neon: 30, previous: prev(1, at(-24 * H)) }));
    expect(r3.level).toBe(0);
  });

  it("a projection keeps L1 from clearing", () => {
    const r = computeGovernor(
      input({
        mtd: { [R.inngestExecutions]: 12_000 },
        w7: { [R.inngestExecutions]: 800 },
        previous: prev(1, at(-48 * H)),
      }),
    ); // projected 20,000 ≥ 0.8 × 24,000
    expect(r.rawLevel).toBe(0);
    expect(r.level).toBe(1);
    expect(r.belowSince).toBeNull();
  });

  it("reports changed=false when level and actions are unchanged (even after a JSON round-trip)", () => {
    const first = computeGovernor(input({ neon: 50 }));
    const stored = parseGovernorState(
      JSON.parse(
        JSON.stringify({
          ...first.state,
          actions: Object.fromEntries(Object.entries(first.state.actions ?? {}).reverse()),
        }),
      ),
    );
    const again = computeGovernor(input({ neon: 50, previous: stored }));
    expect(again.changed).toBe(false);
    expect(governorAlerts(stored, again)).toEqual([]);
  });

  it("parses the seeded state and rejects junk", () => {
    expect(parseGovernorState({ level: 0, since: null, triggers: [], belowSince: null })).toEqual({
      level: 0,
      since: null,
      triggers: [],
      belowSince: null,
    });
    expect(parseGovernorState({ level: 7 })).toBeNull();
    expect(parseGovernorState("nope")).toBeNull();
  });

  it("emits alert codes on transitions only", () => {
    const r = computeGovernor(
      input({ neon: 60, storage: 360, googleAccounts: 71, mtd: { [R.anthropicUsd]: 5 } }),
    );
    expect(governorAlerts(null, r).sort()).toEqual(
      [
        "ai_auto_reviews_off",
        "ai_budget_exhausted",
        "governor_level_2",
        "google_accounts_70",
        "neon_storage_ingest_paused",
        "set_tick_every_60",
      ].sort(),
    );
    const recovered = computeGovernor(
      input({ previous: { ...r.state, level: 1, belowSince: at(-25 * H) } }),
    );
    expect(governorAlerts({ ...r.state, level: 1 }, recovered)).toEqual(["governor_level_0"]);
  });
});
