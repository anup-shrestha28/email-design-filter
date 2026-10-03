/**
 * The meter records a platform's usage only where it is real (platform.ts; DECISIONS.md "Local
 * development"): under `pnpm dev` the Vercel, Neon and Inngest amounts never enter the buffer (so
 * never the ledger or `neon_awake`, never the governor), while app-level usage still does;
 * `EDF_METER_LOCAL=1` and Vercel meter everything, as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drainCheckouts, recordCheckout } from "@edf/db";
import {
  ALL_PLATFORMS,
  createMeter,
  flushNeonAwake,
  platformMetering,
  RESOURCES as R,
  type Meter,
  type PlatformMetering,
} from "../src/index";
import { HAS_DB } from "./env";
import { appPool, ownerPool, type Pool } from "./helpers";

/** `pnpm dev`: local Postgres, the Inngest Dev Server, not on Vercel. */
const LOCAL = platformMetering({
  DATABASE_URL: "postgres://app_rw:pw@localhost:5433/edf",
  INNGEST_DEV: "1",
});

/** One of every kind of usage: route traffic, FOT, Neon transfer, Inngest, and app-level amounts. */
async function useEverything(meter: Meter): Promise<void> {
  await meter.withMeter("route", () => 1);
  meter.recordOriginBytes(5_000_000);
  meter.recordNeonTransferBytes(1_000_000);
  meter.recordInngest(1, 2);
  meter.recordSandboxUsage({
    createdAt: new Date(Date.now() - 10_000),
    stoppedAt: new Date(),
    vcpus: 2,
  });
  meter.recordLlmUsd(0.25);
  meter.recordGmailUnits(5);
  meter.add(R.viewUnsignableUrls, 3);
}

const codes = (meter: Meter) =>
  [...new Set([...meter.pending().keys()].map((k) => k.split(" ")[1]))].sort();
const APP_LEVEL = [
  R.anthropicUsd,
  R.gmailUnits,
  R.sandboxCpuS,
  R.sandboxCreations,
  R.sandboxMemGbh,
  R.viewUnsignableUrls,
].sort();
const PLATFORM = [
  R.inngestExecutions,
  R.inngestRuns,
  R.inngestSteps,
  R.neonTransferMb,
  R.vercelCpuS,
  R.vercelFotMb,
  R.vercelInvocations,
  R.vercelMemGbh,
];

describe("which usage the meter records", () => {
  afterEach(() => vi.unstubAllEnvs());
  // canFlush: false keeps everything in the buffer (no database here).
  const meterWith = (platforms?: PlatformMetering) =>
    createMeter({
      pool: undefined as never,
      canFlush: () => false,
      sampleCpuSeconds: () => 1,
      ...(platforms ? { platforms } : {}),
    });

  it("pnpm dev: no Vercel, Neon or Inngest amount enters the buffer; app-level usage does", async () => {
    const meter = meterWith(LOCAL);
    await useEverything(meter);
    expect(codes(meter)).toEqual(APP_LEVEL);
    // Bad amounts are refused the same way whether or not they are recorded.
    expect(() => meter.recordOriginBytes(-1)).toThrow(RangeError);
    expect(() => meter.add(R.vercelCpuS, Number.NaN)).toThrow(RangeError);
  });

  it("EDF_METER_LOCAL=1 or Vercel: every amount is recorded, as before", async () => {
    const meter = meterWith(ALL_PLATFORMS);
    await useEverything(meter);
    expect(codes(meter)).toEqual([...APP_LEVEL, ...PLATFORM].sort());
    const fot = [...meter.pending()].find(([k]) => k.endsWith(` ${R.vercelFotMb}`))?.[1];
    expect(fot).toBe(5);
  });

  it("by default the meter follows the environment: local default, the opt-in, Vercel", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("EDF_METER_LOCAL", undefined);
    vi.stubEnv("INNGEST_DEV", "1");
    vi.stubEnv("DATABASE_URL", "postgres://app_rw:pw@localhost:5433/edf");
    const local = meterWith();
    await useEverything(local);
    expect(codes(local)).toEqual(APP_LEVEL);

    vi.stubEnv("EDF_METER_LOCAL", "1");
    const optIn = meterWith();
    await useEverything(optIn);
    expect(codes(optIn)).toEqual([...APP_LEVEL, ...PLATFORM].sort());

    vi.stubEnv("EDF_METER_LOCAL", undefined);
    vi.stubEnv("VERCEL", "1");
    const vercel = meterWith();
    await useEverything(vercel);
    expect(codes(vercel)).toEqual([...APP_LEVEL, ...PLATFORM].sort());
  });
});

describe.skipIf(!HAS_DB)("what reaches the database", () => {
  let pool: Pool;
  let owner: Pool;

  beforeAll(() => {
    pool = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM usage_ledger");
    await owner.query("DELETE FROM neon_awake");
    drainCheckouts();
  });
  afterEach(() => vi.unstubAllEnvs());

  const ledger = async (): Promise<Record<string, number>> => {
    const { rows } = await pool.query<{ resource: string; amount: string }>(
      "SELECT resource, sum(amount) AS amount FROM usage_ledger GROUP BY resource",
    );
    return Object.fromEntries(rows.map((r) => [r.resource, Number(r.amount)]));
  };
  const awakeMinutes = async () =>
    (
      await pool.query<{ n: number }>(
        "SELECT coalesce(sum(bit_count(minutes)), 0)::int AS n FROM neon_awake",
      )
    ).rows[0]?.n;

  /** A UI flush (with the pool's checkouts), an Inngest step, then the step's own neon_awake flush. */
  async function run(platforms: PlatformMetering): Promise<void> {
    const meter = createMeter({ pool, platforms, neonAwake: true, sampleCpuSeconds: () => 0.5 });
    recordCheckout(Date.now());
    meter.add(R.viewUnsignableUrls, 2);
    meter.recordNeonTransferBytes(3_000_000);
    await meter.maybeFlush(); // a fresh instance's first UI flush: buffer, CPU and neon_awake
    meter.recordInngest(1, 1);
    await meter.withMeter("step", async () => (await pool.query("SELECT 1")).rowCount);
    recordCheckout(Date.now());
    await flushNeonAwake(pool, undefined, platforms);
  }

  it("pnpm dev: only app-level rows; no platform rows and no Neon awake minutes", async () => {
    await run(LOCAL);
    expect(await ledger()).toEqual({ [R.viewUnsignableUrls]: 2 });
    expect(await awakeMinutes()).toBe(0);
    expect(drainCheckouts()).toEqual([]); // dropped, not held for a later write
    // The default reads the environment: the step and cron call sites pass nothing.
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("EDF_METER_LOCAL", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://app_rw:pw@localhost:5433/edf");
    recordCheckout(Date.now());
    expect(await flushNeonAwake(pool)).toBe(0);
    expect(await awakeMinutes()).toBe(0);
  });

  it("EDF_METER_LOCAL=1 or Vercel: every platform row and the awake minutes are written", async () => {
    await run(ALL_PLATFORMS);
    const l = await ledger();
    expect(l[R.viewUnsignableUrls]).toBe(2);
    expect(l[R.vercelCpuS]).toBe(1); // the UI flush's sample and the step's
    expect(l[R.vercelInvocations]).toBe(1);
    expect(l[R.inngestExecutions]).toBe(2);
    expect(l[R.neonTransferMb]).toBeGreaterThanOrEqual(3);
    expect(await awakeMinutes()).toBeGreaterThanOrEqual(6); // a minute + the 5-minute tail
  });
});
