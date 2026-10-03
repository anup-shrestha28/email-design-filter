import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMeter,
  DAY_MS,
  loadUsageSnapshot,
  RESOURCES as R,
  runGovernor,
  startOfUtcDay,
  utcDay,
} from "../src/index";
import { HAS_DB } from "./env";
import { appPool, ownerPool, type Pool } from "./helpers";

describe.skipIf(!HAS_DB)("loadUsageSnapshot / runGovernor against Postgres", () => {
  let pool: Pool;
  let owner: Pool;
  const now = new Date();
  const day = (offset: number) => utcDay(startOfUtcDay(now).getTime() + offset * DAY_MS);

  beforeAll(() => {
    // These meters stand in for production's: record every platform (EDF_METER_LOCAL=1, as when
    // testing the governor locally; meter-platforms.test.ts covers the local default).
    vi.stubEnv("EDF_METER_LOCAL", "1");
    pool = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool?.end();
    await owner?.end();
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM usage_ledger");
    await owner.query("DELETE FROM neon_awake");
    await owner.query("DELETE FROM llm_budget_global");
    await owner.query("DELETE FROM oauth_subject_seen");
    await owner.query(
      `UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`,
    );
    await owner.query(
      `UPDATE app_setting SET value = '{"vercel_cpu":1.5,"sandbox_cpu":1.0}' WHERE key = 'calibration'`,
    );
    await owner.query(`UPDATE app_setting SET value = 'null' WHERE key = 'neon.period_start'`);
    await owner.query(`UPDATE app_setting SET value = '5' WHERE key = 'ai.cap_usd'`);
  });

  const addUsage = (d: string, resource: string, amount: number) =>
    pool.query("SELECT add_usage($1::date, $2, $3::numeric)", [d, resource, amount]);

  it("sums the rolling 30 days (today and 29 days back), month-to-date and the trailing 7-day average", async () => {
    await addUsage(day(0), R.vercelCpuS, 100);
    await addUsage(day(-29), R.vercelCpuS, 10);
    await addUsage(day(-30), R.vercelCpuS, 99_999); // outside the rolling window
    await addUsage(day(-1), R.inngestExecutions, 700);
    await addUsage(day(-7), R.inngestExecutions, 700);
    await addUsage(day(-8), R.inngestExecutions, 7_000); // outside the trailing week
    await addUsage(day(0), R.inngestExecutions, 50); // today is excluded from the average
    await pool.query("SELECT mark_neon_awake($1::date, $2::int[])", [
      day(0),
      Array.from({ length: 120 }, (_, i) => i),
    ]);

    const s = await loadUsageSnapshot(pool, now);
    expect(s.usage.rolling30d[R.vercelCpuS]).toBe(110);
    expect(s.usage.trailing7dAvg[R.inngestExecutions]).toBe(200);
    const monthStart = utcDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const expectedMtd = [day(0), day(-1), day(-7), day(-8)]
      .filter((d) => d >= monthStart)
      .reduce(
        (n, d) => n + ({ [day(0)]: 50, [day(-1)]: 700, [day(-7)]: 700, [day(-8)]: 7000 }[d] ?? 0),
        0,
      );
    expect(s.usage.monthToDate[R.inngestExecutions]).toBe(expectedMtd);
    expect(s.neonAwakeMinutes).toBe(120);
    expect(s.neonCuHoursMtd).toBe(0.5);
    expect(s.neonStorageMb).toBeGreaterThan(1);
    expect(s.calibration).toEqual({ vercel_cpu: 1.5, sandbox_cpu: 1 });
    expect(s.aiCapUsd).toBe(5);
    expect(s.previous).toEqual({ level: 0, since: null, triggers: [], belowSince: null });
  });

  it("honours the recorded Neon billing-period anchor", async () => {
    await owner.query(
      `UPDATE app_setting SET value = to_jsonb($1::text) WHERE key = 'neon.period_start'`,
      [day(-3)],
    );
    await pool.query("SELECT mark_neon_awake($1::date, $2::int[])", [day(-4), [1, 2, 3]]);
    await pool.query("SELECT mark_neon_awake($1::date, $2::int[])", [day(-2), [1, 2]]);
    const s = await loadUsageSnapshot(pool, now);
    expect(utcDay(s.neonPeriodStart)).toBe(day(-3));
    expect(s.neonAwakeMinutes).toBe(2);
  });

  it("runGovernor persists the state and alerts on transitions only", async () => {
    await addUsage(day(0), R.vercelCpuS, 5000); // × 1.5 = 7,500 ≥ 6,912 → L1
    const first = await runGovernor(pool, now);
    expect(first.persisted).toBe(true);
    expect(first.result.level).toBe(1);
    expect(first.result.triggers).toEqual(["vercel.cpu_s:L1"]);
    expect(first.alerts).toEqual(["governor_level_1", "set_tick_every_60"]);
    const stored = (
      await pool.query<{ value: { level: number; actions: { pollMultiplier: number } } }>(
        "SELECT value FROM app_setting WHERE key = 'governor'",
      )
    ).rows[0]?.value;
    expect(stored?.level).toBe(1);
    expect(stored?.actions.pollMultiplier).toBe(2);

    const second = await runGovernor(pool, new Date(now.getTime() + 60_000));
    expect(second.result.level).toBe(1);
    expect(second.result.changed).toBe(false);
    expect(second.alerts).toEqual([]);
  });

  it("metered Fast Origin Transfer reaches the FOT caps and L3, × the 1.25 default calibration", async () => {
    // app_setting.calibration (beforeEach) has no vercel_fot key: the governor falls back to the
    // profile default, 1.25 (counts edf-view can lose between reports; DECISIONS.md).
    const snapshot = await loadUsageSnapshot(pool, now);
    expect(snapshot.calibration.vercel_fot).toBeUndefined();
    const meter = createMeter({ pool });
    // 3.8 GB of served image bytes + 200 MB of view HTML = 4,000 MB metered → 5,000 MB governed:
    // past the soft level (4,800), under the self-cap (6,000).
    for (let i = 0; i < 1_900; i++) meter.recordOriginBytes(2_000_000);
    meter.recordOriginBytes(200_000_000);
    await meter.flush();
    const soft = await runGovernor(pool, now);
    expect(soft.result.level).toBe(0);
    expect(soft.result.actions).toMatchObject({ friendsImagesClickToLoad: true, imagesClickToLoad: false });

    // 5,700 MB metered: under L3 (7,000) as metered, 7,125 MB × 1.25 → L3.
    for (let i = 0; i < 850; i++) meter.recordOriginBytes(2_000_000);
    await meter.flush();
    const frozen = await runGovernor(pool, now);
    const fot = (r: typeof frozen) => r.result.resources.find((x) => x.code === R.vercelFotMb);
    expect(fot(frozen)?.value).toBeCloseTo(5_700 * 1.25, 6);
    expect(frozen.result.level).toBe(3);
    expect(frozen.result.triggers).toContain("vercel.fot_mb:L3");
    expect(frozen.result.actions.imagesClickToLoad).toBe(true);

    // A measured factor in the setting replaces the default: 5,700 × 1.0 asks for no level (the
    // stored L3 then steps down only through hysteresis).
    await owner.query(
      `UPDATE app_setting SET value = '{"vercel_cpu":1.5,"sandbox_cpu":1.0,"vercel_fot":1.0}' WHERE key = 'calibration'`,
    );
    const measured = await runGovernor(pool, now);
    expect(fot(measured)?.value).toBeCloseTo(5_700, 6);
    expect(fot(measured)?.level).toBe(0);
  });

  it("Neon transfer metered from the pool reaches the global levels", async () => {
    const meter = createMeter({ pool });
    meter.recordNeonTransferBytes(2_500_000_000); // 2.5 GB ≥ 80% of the 3 GB self-cap
    await meter.flush();
    const r = await runGovernor(pool, now);
    expect(r.result.level).toBe(1);
    expect(r.result.triggers).toEqual(["neon.transfer_mb:L1"]);
  });

  it("counts AI reservations and lifetime Google accounts", async () => {
    const month = utcDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await owner.query(
      "INSERT INTO llm_budget_global (period, reserved_usd, cap_usd) VALUES ($1::date, 4.5, 4.5)",
      [month],
    );
    for (let i = 0; i < 70; i++) {
      await pool.query("INSERT INTO oauth_subject_seen (sub_hash) VALUES ($1)", [
        i.toString(16).padStart(64, "0"),
      ]);
    }
    const r = await runGovernor(pool, now);
    expect(r.snapshot.aiReservedUsd).toBe(4.5);
    expect(r.snapshot.googleAccounts).toBe(70);
    expect(r.result.level).toBe(0);
    expect(r.result.actions).toMatchObject({
      aiOff: true,
      autoAiOff: true,
      googleAccountsAlert: true,
      invitesOff: false,
    });
    expect(r.alerts.sort()).toEqual([
      "ai_auto_reviews_off",
      "ai_budget_exhausted",
      "google_accounts_70",
    ]);
  });

  it("concurrent runs serialise on the state row", async () => {
    await addUsage(day(0), R.vercelCpuS, 6000); // 9,000 → L2
    const results = await Promise.all([runGovernor(pool, now), runGovernor(pool, now)]);
    const levelAlerts = results
      .flatMap((r) => r.alerts)
      .filter((a) => a.startsWith("governor_level_"));
    expect(levelAlerts).toEqual(["governor_level_2"]); // exactly one run saw the transition
  });
});
