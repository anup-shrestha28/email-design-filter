import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, drainCheckouts, recordCheckout, withSystem } from "@edf/db";
import {
  clientBytesReceived,
  createMeter,
  FLUSH_CUTOFF_MS,
  FLUSH_RESERVE_MS,
  flushNeonAwake,
  RESOURCES as R,
  sampleProcessCpuSeconds,
  utcDay,
} from "../src/index";
import { appRwUrl, HAS_DB } from "./env";
import { appPool, ownerPool, type Pool } from "./helpers";

describe.skipIf(!HAS_DB)("metering (FREE-TIER §8.1) against Postgres", () => {
  let pool: Pool;
  let owner: Pool;

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
  });

  const ledger = async (): Promise<Record<string, number>> => {
    const { rows } = await pool.query<{ resource: string; amount: string }>(
      "SELECT resource, sum(amount) AS amount FROM usage_ledger GROUP BY resource",
    );
    return Object.fromEntries(rows.map((r) => [r.resource, Number(r.amount)]));
  };

  it("withMeter(step) records CPU, GB-h and one invocation, and flushes at the end", async () => {
    const meter = createMeter({ pool, sampleCpuSeconds: () => 0.25 });
    const out = await meter.withMeter("step", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 42;
    });
    expect(out).toBe(42);
    const l = await ledger();
    expect(l[R.vercelCpuS]).toBe(0.25);
    expect(l[R.vercelInvocations]).toBe(1);
    expect(l[R.vercelMemGbh]).toBeGreaterThan((0.04 / 3600) * 2);
    expect(l[R.vercelMemGbh]).toBeLessThan((5 / 3600) * 2);
    expect(meter.pending().size).toBe(0);
  });

  it("records usage even when the wrapped function throws", async () => {
    const meter = createMeter({ pool, sampleCpuSeconds: () => 0.1 });
    await expect(meter.withMeter("step", () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect((await ledger())[R.vercelInvocations]).toBe(1);
  });

  it("UI traffic flushes at most every 60 s per instance, the first time at once", async () => {
    let t = 1_000_000;
    const meter = createMeter({ pool, now: () => t, sampleCpuSeconds: () => 0.01 });
    // A fresh instance may serve one request and be reaped: its first request is written.
    await meter.withMeter("route", () => "a");
    expect((await ledger())[R.vercelInvocations]).toBe(1);
    t += 30_000;
    await meter.withMeter("route", () => "b");
    await meter.withMeter("action", () => "c");
    expect((await ledger())[R.vercelInvocations]).toBe(1);
    expect(meter.pending().get(`${utcDay(t)} ${R.vercelInvocations}`)).toBe(2);
    t += 30_000;
    await meter.withMeter("route", () => "d");
    expect((await ledger())[R.vercelInvocations]).toBe(4);
  });

  it("UI flushes wait for an awake database, run deferred, and book unwrapped CPU and checkouts", async () => {
    drainCheckouts();
    let awake = false;
    const deferred: Array<() => Promise<void>> = [];
    const meter = createMeter({
      pool,
      sampleCpuSeconds: () => 0.5,
      canFlush: () => awake,
      defer: (task) => deferred.push(task),
      neonAwake: true,
    });
    await meter.withMeter("route", () => "a");
    expect(deferred).toHaveLength(1); // never inline: the response isn't held up
    await deferred[0]!();
    expect(await ledger()).toEqual({}); // database asleep: metering must not wake it
    awake = true;
    recordCheckout(Date.parse(`${utcDay(new Date())}T00:20:00Z`)); // a page's checkout, no wrapper
    await meter.maybeFlush(); // e.g. scheduled by that checkout
    const l = await ledger();
    expect(l[R.vercelInvocations]).toBe(1);
    expect(l[R.vercelCpuS]).toBe(1); // the route's sample + the process CPU since (pages, framework)
    const { rows } = await pool.query<{ bits: number }>(
      "SELECT bit_count(minutes)::int AS bits FROM neon_awake WHERE day = $1::date",
      [utcDay(new Date())],
    );
    expect(rows[0]?.bits).toBeGreaterThanOrEqual(6);
  });

  it("what arrives inside the interval is written when it ends (one trailing flush), and the wait is booked", async () => {
    let t = 1_000_000;
    const deferred: Array<() => Promise<void>> = [];
    const sleeps: number[] = [];
    const meter = createMeter({
      pool,
      now: () => t,
      sampleCpuSeconds: () => 0,
      defer: (task) => deferred.push(task),
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await meter.withMeter("route", () => "a");
    await deferred.shift()!(); // the first flush, at once
    t += 20_000;
    await meter.withMeter("route", () => "b");
    await meter.withMeter("action", () => "c");
    // No further request reaches this instance (it may be reaped): the burst must not wait for one.
    for (const task of deferred.splice(0)) await task();
    expect(sleeps).toEqual([40_000]); // one wait per instance, until the minute ends
    const l = await ledger();
    expect(l[R.vercelInvocations]).toBe(3);
    expect(l[R.vercelMemGbh]).toBeGreaterThanOrEqual((40 / 3600) * 2); // after() kept it up
    // A flush's own leftovers (no request) never keep the instance up.
    meter.add(R.neonTransferMb, 0.01);
    t += 1_000;
    await meter.maybeFlush();
    expect(sleeps).toHaveLength(1);
  });

  it("a trailing wait never outlives its invocation: it ends the reserve before the deadline and writes then", async () => {
    let t = 1_000_000;
    let deadline: number | undefined = Number.POSITIVE_INFINITY;
    const deferred: Array<() => Promise<void>> = [];
    const sleeps: number[] = [];
    const meter = createMeter({
      pool,
      now: () => t,
      sampleCpuSeconds: () => 0,
      defer: (task) => deferred.push(task),
      deadline: () => deadline,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await meter.withMeter("route", () => "a");
    await deferred.shift()!(); // the first flush, at once
    t += 5_000;
    deadline = t + 30_000; // a view-source request (maxDuration 30 s)
    await meter.withMeter("route", () => "b");
    await deferred.shift()!();
    expect(sleeps).toEqual([30_000 - FLUSH_RESERVE_MS]); // not until the minute ends (55 s)
    expect(t).toBeLessThanOrEqual(deadline - FLUSH_RESERVE_MS);
    expect((await ledger())[R.vercelInvocations]).toBe(2); // written early, inside the minute

    // Too little time left to wait or write, or no deadline known: the next flush writes it.
    t += 1_000;
    deadline = t + FLUSH_RESERVE_MS - 1;
    await meter.withMeter("route", () => "c");
    await deferred.shift()!();
    deadline = undefined;
    await meter.withMeter("route", () => "d");
    await deferred.shift()!();
    expect(sleeps).toHaveLength(1);
    t += 60_000;
    deadline = t + 1_000; // an overdue interval flush with the reserve gone doesn't start either
    await meter.maybeFlush();
    expect((await ledger())[R.vercelInvocations]).toBe(2);
    deadline = undefined;
    await meter.maybeFlush();
    expect((await ledger())[R.vercelInvocations]).toBe(4);
  });

  it("a write the database stalls stops holding its invocation just before the deadline, and still lands", async () => {
    let t = 1_000_000;
    let deadline = Number.POSITIVE_INFINITY;
    const deferred: Array<() => Promise<void>> = [];
    const meter = createMeter({
      pool,
      now: () => t,
      sampleCpuSeconds: () => 0,
      defer: (task) => deferred.push(task),
      deadline: () => deadline,
      sleep: async (ms) => {
        t += ms + FLUSH_RESERVE_MS - FLUSH_CUTOFF_MS - 300; // the timer fired late: 300 ms to the cutoff
      },
    });
    await meter.withMeter("route", () => "a");
    await deferred.shift()!(); // the first flush, at once
    // Another transaction holds the row the next write updates (a stalled database).
    const lock = await owner.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM usage_ledger WHERE resource = $1 FOR UPDATE", [R.vercelInvocations]);
    const unlocked = new Promise((r) => setTimeout(r, 1_500)).then(() => lock.query("ROLLBACK"));
    try {
      t += 5_000;
      deadline = t + 30_000;
      await meter.withMeter("route", () => "b");
      const t0 = performance.now();
      await deferred.shift()!(); // the trailing wait, then a write that blocks on the lock
      const took = performance.now() - t0;
      expect(took).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(1_000); // released at the cutoff, not when the lock goes
    } finally {
      await unlocked;
      lock.release();
    }
    await meter.flush(); // waits for the abandoned write
    expect((await ledger())[R.vercelInvocations]).toBe(2);
  });

  it("keeps amounts buffered when a flush fails", async () => {
    const dead = createPool({ connectionString: appRwUrl(), max: 1 });
    await dead.end();
    const meter = createMeter({ pool: dead, sampleCpuSeconds: () => 1 });
    meter.recordGmailUnits(20);
    await expect(meter.flush()).rejects.toThrow();
    expect([...meter.pending().values()]).toEqual([20]);
    await meter.withMeter("step", () => undefined); // swallowed failure, still buffered
    expect(meter.pending().size).toBe(4);
  });

  it("records Sandbox, Inngest, LLM, image bytes and Gmail units; splits huge amounts for add_usage", async () => {
    const meter = createMeter({ pool });
    meter.recordSandboxUsage({
      createdAt: new Date(Date.now() - 100_000),
      stoppedAt: new Date(),
      vcpus: 2,
    });
    meter.recordInngest(3, 7);
    meter.recordLlmUsd(0.0428);
    meter.recordLlmUsd(0.0001);
    meter.recordImageBytes(1_500_000);
    meter.recordOriginBytes(250_000);
    meter.recordNeonTransferBytes(3_000_000);
    meter.recordGmailUnits(2_500_000_000);
    await meter.flush();
    const l = await ledger();
    expect(l[R.sandboxCpuS]).toBeCloseTo(200, 1);
    expect(l[R.sandboxCreations]).toBe(1);
    expect(l[R.sandboxMemGbh]).toBeCloseTo((2 * 2 * 100) / 3600, 4);
    expect(l[R.inngestExecutions]).toBe(10);
    expect(l[R.inngestRuns]).toBe(3);
    expect(l[R.inngestSteps]).toBe(7);
    expect(l[R.anthropicUsd]).toBeCloseTo(0.0429, 6);
    expect(l[R.vercelFotMb]).toBe(1.75);
    expect(l[R.neonTransferMb]).toBe(3);
    expect(l[R.gmailUnits]).toBe(2_500_000_000);
    expect(() =>
      meter.recordSandboxUsage({
        createdAt: new Date(),
        stoppedAt: new Date(Date.now() - 1),
        vcpus: 2,
      }),
    ).toThrow(RangeError);
    expect(() => meter.add("Bad Code", 1)).toThrow(RangeError);
    expect(() => meter.add(R.gmailUnits, -1)).toThrow(RangeError);
  });

  it("clientBytesReceived counts what Postgres sent each pooled connection, once", async () => {
    const one = createPool({ connectionString: appRwUrl(), max: 1 });
    try {
      let total = 0;
      one.on("release", (_err: Error | undefined, client: object) => {
        total += clientBytesReceived(client);
      });
      await withSystem(one, (_db, c) => c.query("SELECT 1"));
      const small = total;
      expect(small).toBeGreaterThan(0);
      await withSystem(one, (_db, c) => c.query("SELECT repeat('x', 200000)"));
      expect(total - small).toBeGreaterThan(200_000);
      expect(total - small).toBeLessThan(260_000);
      expect(clientBytesReceived({})).toBe(0);
    } finally {
      await one.end();
    }
  });

  it("rounds amounts up to micro-units (never under-counts)", async () => {
    const meter = createMeter({ pool });
    meter.add(R.vercelCpuS, 0.0000001);
    await meter.flush();
    expect((await ledger())[R.vercelCpuS]).toBe(0.000001);
    expect(meter.pending().size).toBe(0);
    meter.add(R.vercelCpuS, 0.0000012);
    await meter.flush();
    expect((await ledger())[R.vercelCpuS]).toBe(0.000003);
  });

  it("concurrent flushes don't double-count", async () => {
    const meter = createMeter({ pool });
    meter.recordGmailUnits(5);
    await Promise.all([meter.flush(), meter.flush(), meter.flush()]);
    expect((await ledger())[R.gmailUnits]).toBe(5);
  });

  it("the process CPU sampler measures real work and never double-counts", () => {
    sampleProcessCpuSeconds();
    const until = performance.now() + 60;
    let x = 0;
    while (performance.now() < until) x += Math.sqrt(x + 1);
    const a = sampleProcessCpuSeconds();
    const b = sampleProcessCpuSeconds();
    expect(a).toBeGreaterThan(0.02);
    expect(b).toBeLessThan(a);
    expect(x).toBeGreaterThan(0);
  });

  it("flushNeonAwake ORs checkout minutes (+5 min tail) into neon_awake", async () => {
    const t = Date.parse(`${utcDay(new Date())}T00:10:30Z`);
    recordCheckout(t);
    recordCheckout(t + 60_000);
    const n = await flushNeonAwake(pool);
    expect(n).toBeGreaterThanOrEqual(7);
    const { rows } = await pool.query<{ bits: number; m10: string; m16: string; m17: string }>(
      `SELECT bit_count(minutes)::int AS bits, substring(minutes::text, 11, 1) AS m10,
              substring(minutes::text, 17, 1) AS m16, substring(minutes::text, 18, 1) AS m17
         FROM neon_awake WHERE day = $1::date`,
      [utcDay(new Date())],
    );
    expect(rows[0]?.m10).toBe("1");
    expect(rows[0]?.m16).toBe("1"); // minute 11 + 5-minute tail
    expect(rows[0]?.bits).toBeGreaterThanOrEqual(7);
    expect(await flushNeonAwake(pool)).toBeGreaterThanOrEqual(1); // the flush's own checkout is counted next time
  });
});
