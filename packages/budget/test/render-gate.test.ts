/**
 * The governor's Sandbox actions reach the render paths that create VMs (FREE-TIER §5.3, §8.3):
 * at the self-cap only the owner's on-demand renders run (friends' on-demand and queued work
 * don't), and near the hard limit nothing renders at all. Uses @edf/pipeline's planner directly.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withUser } from "@edf/db";
import {
  gateRenderOptions,
  planFrom,
  type RenderGovernor,
} from "../../pipeline/src/render-plan";
import { renderForUser, workKinds, type RenderOptions } from "../../pipeline/src/render";
import type { PipelineDeps } from "../../pipeline/src/deps";
import { calendarMonthStart, computeGovernor, FREE_TIER_PROFILE, RESOURCES as R } from "../src/index";
import { HAS_DB } from "./env";
import { appPool, ownerPool, type Pool } from "./helpers";

const NOW = new Date("2026-09-20T12:00:00Z");

function governorFor(r30: Record<string, number>): RenderGovernor {
  const g = computeGovernor({
    usage: { rolling30d: r30, monthToDate: {}, trailing7dAvg: {} },
    neonCuHoursMtd: 0,
    neonStorageMb: 50,
    calibration: {},
    profile: FREE_TIER_PROFILE,
    now: NOW,
    periodStart: calendarMonthStart(NOW),
    previous: null,
  });
  return { level: g.level, actions: g.actions };
}

const users = [
  { user_id: "owner", role: "owner" as const, mailboxes: 1 },
  { user_id: "f1", role: "friend" as const, mailboxes: 1 },
  { user_id: "f2", role: "friend" as const, mailboxes: 1 },
];
const old = new Date(NOW.getTime() - 72 * 3_600_000);
const due = [
  { user_id: "owner", queued_count: "3", on_demand_count: "1", oldest_at: old },
  { user_id: "f1", queued_count: "12", on_demand_count: "1", oldest_at: old },
  { user_id: "f2", queued_count: "1", on_demand_count: "1", oldest_at: old },
];
const plan = (gov: RenderGovernor, trigger: "nightly" | "on_demand") =>
  planFrom({ trigger, gov, aiPaused: false, due, users, now: NOW.getTime() });
const full: RenderOptions = { fillAllowed: true, samplesAllowed: true, aiSamplesAllowed: true, aiRealtimeAllowed: true };

describe("Sandbox actions in the render planner", () => {
  it("below the caps everyone with work gets a VM", () => {
    const gov = governorFor({});
    expect(plan(gov, "on_demand").map((p) => p.userId)).toEqual(["owner", "f1", "f2"]);
    expect(plan(gov, "nightly").map((p) => p.userId)).toEqual(["owner", "f1", "f2"]);
  });

  it("at the Sandbox self-cap only the owner's on-demand renders, on every trigger", () => {
    const gov = governorFor({ [R.sandboxCpuS]: 13_000 });
    expect(gov.level).toBe(0);
    for (const trigger of ["on_demand", "nightly"] as const) {
      const p = plan(gov, trigger);
      expect(p.map((x) => x.userId)).toEqual(["owner"]);
      expect(p[0]?.options).toMatchObject({ onDemandOnly: true, fillAllowed: false, samplesAllowed: false });
    }
    expect(gateRenderOptions(gov, "friend", full)).toBeNull();
    expect(gateRenderOptions(gov, "owner", full)).toMatchObject({ onDemandOnly: true, fillAllowed: false, samplesAllowed: false });
  });

  it("at 90% of a Sandbox hard limit nothing renders (static-only)", () => {
    for (const r30 of [{ [R.sandboxCpuS]: 16_200 }, { [R.sandboxCreations]: 4_500 }] as Array<Record<string, number>>) {
      const gov = governorFor(r30);
      expect(gov.level).toBe(0);
      expect(plan(gov, "on_demand")).toEqual([]);
      expect(plan(gov, "nightly")).toEqual([]);
      expect(gateRenderOptions(gov, "owner", full)).toBeNull();
    }
  });

  it("queued fill requests wait while fill is off", () => {
    const gov = governorFor({ [R.sandboxCpuS]: 10_080 }); // Sandbox soft: fill off
    const opts = plan(gov, "nightly").find((p) => p.userId === "owner")?.options;
    expect(opts?.fillAllowed).toBe(false);
    expect(workKinds(opts!)).not.toContain("fill");
    expect(workKinds(full)).toEqual(["on_demand", "exemplar", "fill"]);
  });
});

describe.skipIf(!HAS_DB)("renderForUser re-checks the governor before starting a VM", () => {
  let pool: Pool;
  let owner: Pool;
  const calls: number[] = [];
  let deps: PipelineDeps;

  beforeAll(() => {
    pool = appPool();
    owner = ownerPool();
    deps = {
      pool,
      tokens: {} as PipelineDeps["tokens"],
      tickEvery: 60,
      governorLevel: async () => 0,
      renderer: {
        host: "test",
        renderBatch: async () => {
          calls.push(1);
          return [];
        },
      },
    };
  });
  afterAll(async () => {
    await owner.query(
      `UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`,
    );
    await pool?.end();
    await owner?.end();
  });
  beforeEach(() => {
    calls.length = 0;
  });

  async function user(role: "owner" | "friend"): Promise<string> {
    const id = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await owner.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'T', $2, true)`, [id, `${id}@example.com`]);
    await withUser(pool, id, (_db, c) => c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, $2)", [id, role]));
    return id;
  }

  async function setGovernor(gov: RenderGovernor): Promise<void> {
    await owner.query("UPDATE app_setting SET value = $1::jsonb WHERE key = 'governor'", [JSON.stringify(gov)]);
  }

  it("a friend's planned batch is skipped once the Sandbox reached its self-cap", async () => {
    const friend = await user("friend");
    await setGovernor(governorFor({ [R.sandboxCpuS]: 13_000 }));
    const r = await renderForUser(deps, friend, full);
    expect(r.skipped).toBe("governor");
    expect(calls).toEqual([]);
  });

  it("static-only stops even the owner's on-demand", async () => {
    const me = await user("owner");
    await setGovernor(governorFor({ [R.sandboxCpuS]: 16_200 }));
    expect((await renderForUser(deps, me, { ...full, onDemandOnly: true })).skipped).toBe("governor");
    await setGovernor(governorFor({ [R.sandboxCpuS]: 13_000 }));
    expect((await renderForUser(deps, me, { ...full, onDemandOnly: true })).skipped).toBeNull();
  });
});
