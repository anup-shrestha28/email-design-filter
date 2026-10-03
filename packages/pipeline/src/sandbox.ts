/**
 * Sandbox orphan sweep + metering (FREE-TIER.md §5.1 "Metering"), run by every tick when the
 * renderer is the Vercel Sandbox:
 *  - stops render VMs older than 250 s (a live render's own timeout is ≤ 245 s, so none is killed);
 *  - meters every finished VM on the account exactly once, from the Sandbox API's created/stopped
 *    timestamps, so a VM left behind by a failed step is still counted. The dedupe row
 *    (`sandbox_metered`) and its `usage_ledger` amounts commit in one transaction.
 * Until calibrated, usage is `vCPUs × wall seconds` (a conservative upper bound).
 */
import { withSystem } from "@edf/db";
import { FREE_TIER_PROFILE, RESOURCES, utcDay } from "@edf/budget";
import { logOf, nowOf, type PipelineDeps } from "./deps";

/** How far back the sweep lists VMs; anything older was metered by an earlier tick. */
export const SANDBOX_SWEEP_LOOKBACK_MS = 48 * 3_600_000;

export interface SandboxMeterResult {
  stopped: number;
  stopFailed: number;
  metered: number;
  vcpuSeconds: number;
}

export async function sweepAndMeterSandboxes(deps: PipelineDeps): Promise<SandboxMeterResult | { skipped: string }> {
  if (!deps.sweepSandboxes) return { skipped: "no_sandbox" };
  const now = nowOf(deps);
  const sweep = await deps.sweepSandboxes({ now, since: new Date(now.getTime() - SANDBOX_SWEEP_LOOKBACK_MS) });

  const finished = sweep.finished.filter(
    (f) => f.name.length > 0 && f.name.length <= 200 && Number.isFinite(f.createdAt.getTime()) && Number.isFinite(f.stoppedAt.getTime()),
  );
  let metered = 0;
  let vcpuSeconds = 0;
  if (finished.length > 0) {
    await withSystem(deps.pool, async (_db, c) => {
      const fresh = await c.query<{ name: string }>(
        `INSERT INTO sandbox_metered (name, created_at)
         SELECT * FROM unnest($1::text[], $2::timestamptz[])
         ON CONFLICT (name) DO NOTHING RETURNING name`,
        [finished.map((f) => f.name), finished.map((f) => f.createdAt)],
      );
      const isFresh = new Set(fresh.rows.map((r) => r.name));
      const sums = new Map<string, number>(); // "day resource" → amount
      const add = (resource: string, amount: number, at: Date) => {
        const key = `${utcDay(at)} ${resource}`;
        sums.set(key, (sums.get(key) ?? 0) + amount);
      };
      for (const f of finished) {
        if (!isFresh.has(f.name)) continue;
        const secs = Math.max(0, (f.stoppedAt.getTime() - f.createdAt.getTime()) / 1000);
        const vcpus = Number.isInteger(f.vcpus) && f.vcpus >= 1 && f.vcpus <= 64 ? f.vcpus : 2;
        add(RESOURCES.sandboxCpuS, vcpus * secs, f.stoppedAt);
        add(RESOURCES.sandboxMemGbh, (vcpus * FREE_TIER_PROFILE.sandboxMemoryGbPerVcpu * secs) / 3600, f.stoppedAt);
        add(RESOURCES.sandboxCreations, 1, f.createdAt);
        metered++;
        vcpuSeconds += vcpus * secs;
      }
      for (const [key, amount] of sums) {
        const [day, resource] = key.split(" ") as [string, string];
        await c.query("SELECT add_usage($1::date, $2::text, $3::numeric)", [day, resource, amount]);
      }
    });
  }

  const out: SandboxMeterResult = { stopped: sweep.stopped.length, stopFailed: sweep.stopFailed.length, metered, vcpuSeconds: Math.round(vcpuSeconds) };
  if (out.stopped > 0 || out.stopFailed > 0 || out.metered > 0) logOf(deps)("sandbox.sweep", { ...out });
  return out;
}
