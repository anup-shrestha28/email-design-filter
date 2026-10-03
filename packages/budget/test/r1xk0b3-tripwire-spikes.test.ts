/**
 * R1-22: the execution-rate tripwire (FREE-TIER.md §4.2: more than 3× the plan's executions in an
 * hour → kicks stop, the governor raises L1, an alert goes out) and the external-load spike check
 * (§8.4 item 5: a watched count above 3× its 7-day baseline → alert) existed only as alert codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calendarMonthStart,
  computeGovernor,
  runGovernor,
  utcDay,
  FREE_TIER_PROFILE,
  governorAlerts,
  parseGovernorState,
  RESOURCES as R,
  type GovernorInput,
  type GovernorState,
} from "../src/index";
import { HAS_DB } from "./env";
import { appPool, ownerPool, type Pool } from "./helpers";

const NOW = new Date("2026-09-20T12:00:00Z");
const H = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
// Plan: the 30,000 self-cap over 30 days = 41.67 an hour; the wire trips above 125 in an hour.

function input(o: { today?: Record<string, number>; w7?: Record<string, number>; previous?: GovernorState | null; now?: Date } = {}): GovernorInput {
  const now = o.now ?? NOW;
  return {
    usage: { rolling30d: {}, monthToDate: {}, trailing7dAvg: o.w7 ?? {}, ...(o.today ? { today: o.today } : {}) },
    neonCuHoursMtd: 0,
    neonStorageMb: 50,
    calibration: {},
    profile: FREE_TIER_PROFILE,
    now,
    periodStart: calendarMonthStart(now),
    previous: o.previous ?? null,
  };
}

type Sample = NonNullable<GovernorState["executions"]>[number];
const quiet = (...samples: Sample[]): GovernorState => ({
  level: 0,
  since: null,
  triggers: [],
  belowSince: null,
  executions: samples,
});

describe("execution-rate tripwire (§4.2)", () => {
  it("fires when an hour holds more than 3× the plan: L1, kicks off, EXECUTION_TRIPWIRE", () => {
    const prev = quiet({ at: at(-H).toISOString(), day: "2026-09-20", count: 100 });
    const r = computeGovernor(input({ today: { [R.inngestExecutions]: 100 + 200 }, previous: prev }));
    expect(r.executionTripwire).toBe(true);
    expect(r.level).toBe(1);
    expect(r.triggers).toContain(`${R.inngestExecutions}:L1:tripwire`);
    expect(r.actions.continuationKicksOff).toBe(true);
    expect(governorAlerts(prev, r)).toContain("EXECUTION_TRIPWIRE");
    expect(r.state.tripwireAt).toBe(NOW.toISOString());
  });

  it("stays quiet at the plan's pace, and a short window gets a full hour's allowance", () => {
    const hour = quiet({ at: at(-H).toISOString(), day: "2026-09-20", count: 100 });
    expect(computeGovernor(input({ today: { [R.inngestExecutions]: 100 + 120 }, previous: hour })).executionTripwire).toBe(false);
    const half = quiet({ at: at(-H / 2).toISOString(), day: "2026-09-20", count: 100 });
    const r = computeGovernor(input({ today: { [R.inngestExecutions]: 100 + 120 }, previous: half }));
    expect(r.executionTripwire).toBe(false);
    expect(r.actions.continuationKicksOff).toBe(false);
    expect(governorAlerts(half, r)).not.toContain("EXECUTION_TRIPWIRE");
    // The half-hour-old sample is kept (with this run's), so the next run measures the whole hour.
    expect(r.state.executions).toEqual([...half.executions!, { at: NOW.toISOString(), day: "2026-09-20", count: 220 }]);
  });

  it("measures a full hour across two half-hour ticks", () => {
    const t0 = computeGovernor(input({ today: { [R.inngestExecutions]: 50 }, now: at(-H) }));
    const s0 = parseGovernorState(JSON.parse(JSON.stringify(t0.state)));
    const t1 = computeGovernor(input({ today: { [R.inngestExecutions]: 120 }, now: at(-H / 2), previous: s0 }));
    expect(t1.executionTripwire).toBe(false); // 70 in 30 min is under an hour's 125
    const s1 = parseGovernorState(JSON.parse(JSON.stringify(t1.state)));
    const t2 = computeGovernor(input({ today: { [R.inngestExecutions]: 190 }, previous: s1 }));
    expect(t2.executionTripwire).toBe(true); // 140 in the hour
  });

  it("catches a burst split across a sample boundary (100 + 100 in adjacent half-hours)", () => {
    let prev: GovernorState | null = null;
    const counts = [1_000, 1_020, 1_120, 1_220]; // -90 min, -60, -30, now: 20, then 100 + 100
    const fired: boolean[] = [];
    counts.forEach((count, i) => {
      const r = computeGovernor(input({ today: { [R.inngestExecutions]: count }, now: at((i - 3) * (H / 2)), previous: prev }));
      fired.push(r.executionTripwireFired);
      prev = parseGovernorState(JSON.parse(JSON.stringify(r.state)));
    });
    expect(fired).toEqual([false, false, false, true]); // 200 in the last hour
  });

  it("an ordinary day stays quiet: 48 half-hour ticks at 60 an hour, and hourly ticks too", () => {
    for (const step of [H / 2, H]) {
      let prev: GovernorState | null = null;
      let count = 0;
      for (let i = 0; i < (48 * H) / 2 / step; i++) {
        count += 60 * (step / H);
        const now = new Date(Date.UTC(2026, 8, 20, 0) + i * step);
        const r = computeGovernor(input({ today: { [R.inngestExecutions]: count }, now, previous: prev }));
        expect(r.executionTripwire).toBe(false);
        expect(r.state.executions!.length).toBeLessThanOrEqual(7);
        prev = parseGovernorState(JSON.parse(JSON.stringify(r.state)));
      }
    }
  });

  it("with hourly ticks a runaway of 400 an hour trips at the next tick", () => {
    const t0 = computeGovernor(input({ today: { [R.inngestExecutions]: 30 }, now: at(-H) }));
    const t1 = computeGovernor(input({ today: { [R.inngestExecutions]: 430 }, previous: parseGovernorState(JSON.parse(JSON.stringify(t0.state))) }));
    expect(t1.executionTripwireFired).toBe(true);
  });

  it("reads a stored single sample as a one-sample list", () => {
    const legacy = parseGovernorState({ level: 0, executions: { at: at(-H).toISOString(), day: "2026-09-20", count: 10 } });
    expect(legacy?.executions).toEqual([{ at: at(-H).toISOString(), day: "2026-09-20", count: 10 }]);
    expect(computeGovernor(input({ today: { [R.inngestExecutions]: 300 }, previous: legacy })).executionTripwireFired).toBe(true);
  });

  it("holds kicks off for an hour after firing, then releases them", () => {
    const fired = quiet({ at: at(-10 * 60_000).toISOString(), day: "2026-09-20", count: 500 });
    fired.tripwireAt = at(-30 * 60_000).toISOString();
    expect(computeGovernor(input({ today: { [R.inngestExecutions]: 505 }, previous: fired })).actions.continuationKicksOff).toBe(true);
    fired.tripwireAt = at(-61 * 60_000).toISOString();
    expect(computeGovernor(input({ today: { [R.inngestExecutions]: 505 }, previous: fired })).actions.continuationKicksOff).toBe(false);
  });
});

describe("external-load spikes (§8.4 item 5)", () => {
  it("alerts when a watched count passes 3× its 7-day baseline today", () => {
    const r = computeGovernor(input({ today: { [R.vercelInvocations]: 9_500 }, w7: { [R.vercelInvocations]: 3_000 } }));
    expect(r.externalLoadSpikes).toEqual([R.vercelInvocations]);
    expect(governorAlerts(null, r)).toContain("EXTERNAL_LOAD_SPIKE");
  });

  it("stays quiet under 3× the baseline, and a quiet week's floor absorbs an ordinary day", () => {
    const under = computeGovernor(input({ today: { [R.vercelInvocations]: 8_000, "view.img_requests": 5_000 }, w7: { [R.vercelInvocations]: 3_000, "view.img_requests": 2_000 } }));
    expect(under.externalLoadSpikes).toEqual([]);
    const quietWeek = computeGovernor(input({ today: { "view.view_requests": 900 }, w7: { "view.view_requests": 2 } }));
    expect(quietWeek.externalLoadSpikes).toEqual([]);
    const flood = computeGovernor(input({ today: { "view.view_requests": 3_100 }, w7: { "view.view_requests": 2 } }));
    expect(flood.externalLoadSpikes).toEqual(["view.view_requests"]);
    expect(governorAlerts(null, under)).not.toContain("EXTERNAL_LOAD_SPIKE");
  });
});

describe.skipIf(!HAS_DB)("runGovernor feeds today's counts to the tripwire and the spike check", () => {
  let pool: Pool;
  let owner: Pool;
  beforeAll(() => {
    pool = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM usage_ledger");
    await owner?.query(`UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`);
    await pool?.end();
    await owner?.end();
  });

  it("samples today's executions, then trips on the next run an hour later; spikes alert from the ledger", async () => {
    await owner.query("DELETE FROM usage_ledger");
    await owner.query(`UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`);
    // 10:00 UTC today, so "an hour later" stays on the same UTC day.
    const now = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 10));
    const add = (resource: string, amount: number, d = utcDay(now)) =>
      pool.query("SELECT add_usage($1::date, $2, $3::numeric)", [d, resource, amount]);
    await add(R.inngestExecutions, 40);
    const first = await runGovernor(pool, now);
    expect(first.result.state.executions).toEqual([{ at: now.toISOString(), day: utcDay(now), count: 40 }]);
    expect(first.alerts).not.toContain("EXECUTION_TRIPWIRE");

    await add(R.inngestExecutions, 400);
    await add(R.vercelInvocations, 10_000);
    const later = await runGovernor(pool, new Date(now.getTime() + H));
    expect(later.result.executionTripwire).toBe(true);
    expect(later.alerts).toEqual(expect.arrayContaining(["EXECUTION_TRIPWIRE", "EXTERNAL_LOAD_SPIKE"]));
    const stored = (await owner.query<{ value: GovernorState }>("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]!.value;
    expect(stored.level).toBe(1);
    expect(stored.tripwireAt).toBeTruthy();
  });
});
