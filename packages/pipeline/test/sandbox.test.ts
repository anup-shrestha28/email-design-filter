/**
 * Sandbox metering from API listings (FREE-TIER.md §5.1 "Metering"): every finished VM is counted
 * exactly once across repeated sweeps, amounts land in usage_ledger on the right UTC days.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg } from "@edf/db";
import { sweepAndMeterSandboxes } from "../src/sandbox";
import type { PipelineDeps, SandboxSweepLike } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

describe.skipIf(!HAS_DB)("sandbox sweep metering", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  const usage = async (day: string) => {
    const r = await pool.query<{ resource: string; amount: string }>(
      "SELECT resource, amount FROM usage_ledger WHERE day = $1 AND resource LIKE 'sandbox.%'",
      [day],
    );
    return Object.fromEntries(r.rows.map((x) => [x.resource, Number(x.amount)]));
  };

  it("meters each finished VM once, including VMs orphaned by failed steps", async () => {
    // An isolated day far in the future so other suites never collide.
    const t = (hhmmss: string) => new Date(`2031-06-01T${hhmmss}Z`);
    let listing: SandboxSweepLike = {
      stopped: ["orphan-1"],
      stopFailed: [],
      finished: [
        { name: "vm-a", createdAt: t("10:00:00"), stoppedAt: t("10:02:00"), vcpus: 2 }, // 120 s × 2
        { name: "vm-b", createdAt: t("11:00:00"), stoppedAt: t("11:00:30"), vcpus: 2 }, // 30 s × 2
      ],
    };
    const calls: Array<{ now: Date; since: Date }> = [];
    const now = t("12:00:00");
    const deps = {
      pool,
      tickEvery: 30,
      governorLevel: async () => 0,
      tokens: null,
      now: () => now,
      sweepSandboxes: async (o: { now: Date; since: Date }) => {
        calls.push(o);
        return listing;
      },
    } as unknown as PipelineDeps;

    const first = await sweepAndMeterSandboxes(deps);
    expect(first).toEqual({ stopped: 1, stopFailed: 0, metered: 2, vcpuSeconds: 300 });
    expect(calls[0]!.since.getTime()).toBe(now.getTime() - 48 * 3_600_000);
    const u1 = await usage("2031-06-01");
    expect(u1["sandbox.cpu_s"]).toBeCloseTo(300, 3);
    expect(u1["sandbox.creations"]).toBe(2);
    expect(u1["sandbox.mem_gbh"]).toBeCloseTo((300 * 2) / 3600, 4); // 2 GB per vCPU

    // The next tick lists the same VMs plus the orphan it stopped (now finished): only the orphan counts.
    listing = {
      stopped: [],
      stopFailed: [],
      finished: [...listing.finished, { name: "orphan-1", createdAt: t("09:00:00"), stoppedAt: t("12:00:05"), vcpus: 2 }],
    };
    const second = await sweepAndMeterSandboxes(deps);
    expect(second).toMatchObject({ metered: 1, vcpuSeconds: 2 * 10805 });
    const u2 = await usage("2031-06-01");
    expect(u2["sandbox.cpu_s"]).toBeCloseTo(300 + 2 * 10805, 3);
    expect(u2["sandbox.creations"]).toBe(3);

    // A third identical sweep meters nothing.
    expect(await sweepAndMeterSandboxes(deps)).toMatchObject({ metered: 0, vcpuSeconds: 0 });
    expect((await usage("2031-06-01"))["sandbox.creations"]).toBe(3);
  });

  it("is a no-op without the Sandbox renderer", async () => {
    const deps = { pool, tickEvery: 30, governorLevel: async () => 0, tokens: null } as unknown as PipelineDeps;
    expect(await sweepAndMeterSandboxes(deps)).toEqual({ skipped: "no_sandbox" });
  });
});
