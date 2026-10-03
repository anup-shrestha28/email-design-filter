/**
 * Self-metering (FREE-TIER.md §8.1): usage is buffered in memory and added to
 * `usage_ledger(day, resource, amount)` through the `add_usage()` definer function, one
 * transaction per flush, rows in a fixed order (no deadlocks between concurrent flushers).
 *
 *  - `withMeter(kind, fn)`: Active CPU from `process.cpuUsage()` deltas (user + system), wall
 *    time × 2 GB → GB-h, +1 invocation. Steps flush when they finish; UI traffic (routes and
 *    Server Actions) flushes at most every 60 s per instance (the first one at once: an instance
 *    may serve a single request and be reaped), only while `canFlush()` says the database is
 *    already awake, optionally after the response (`defer`), and books the process CPU since the
 *    last sample plus the pool's checkouts (`neonAwake`) with it. With `defer`, what arrives
 *    inside the interval is written when it ends (a trailing flush, whose wait is booked as GB-h),
 *    so an instance reaped after a burst doesn't lose the burst; but a deferred flush never
 *    outlives the invocation that runs it (`deadline`): the wait ends early enough to write
 *    before the deadline, without that much time left the amounts wait for the next flush, and a
 *    write the database stalls stops being awaited just before the deadline.
 *  - Fast Origin Transfer (MB) = large function responses edf-app sends (`recordOriginBytes`);
 *    viewer image bytes are added straight to the ledger from edf-view's exact reports (apps/web
 *    service-counts.ts), not through this buffer. Neon network transfer (MB) = bytes the database
 *    sent to the pool's sockets (`clientBytesReceived`).
 *  - CPU is sampled process-wide: each wrapper exit records the process CPU used since the
 *    previous sample, so concurrent requests in one Fluid instance are never double-counted
 *    and CPU spent between wrappers (framework work, cold-start init) is still counted.
 *  - A failed flush keeps its amounts buffered (under-counting is how budgets get overspent).
 *  - Amounts are rounded *up* to 6 decimals (numeric(18,6)), so rounding never under-counts.
 *  - Platform usage is recorded only where it is real (`platforms`, platform.ts): under `pnpm dev`
 *    the `vercel.*`, `neon.*` (and `neon_awake`) and Inngest Dev Server `inngest.*` amounts are
 *    dropped, unless `EDF_METER_LOCAL=1`. On Vercel everything is metered (and in any production
 *    build whose database isn't on this machine, even if `VERCEL` is missing).
 */
import { awakeMinutesByDay, drainCheckouts, recordCheckout, withSystem } from "@edf/db";
import { isMetered, platformMetering, type PlatformMetering } from "./platform";
import { FREE_TIER_PROFILE, RESOURCE_CODE_PATTERN, RESOURCES } from "./resources";
import { utcDay } from "./time";

type Pool = Parameters<typeof withSystem>[0];

/** `step` = Inngest step or cron job (flush at the end); `route`/`action` = UI traffic. */
export type MeterKind = "step" | "route" | "action";

const ADD_USAGE_MAX = 1e9;
/** Time a deferred flush keeps for its own write before the invocation's deadline (a new connection may take 10 s). */
export const FLUSH_RESERVE_MS = 10_000;
/**
 * A write that is still running this long before the deadline stops holding its invocation (a
 * stalled database could outlast the reserve); it finishes if the instance lives on.
 */
export const FLUSH_CUTOFF_MS = 1_000;

// ───────────────────────── process-wide CPU sampler ─────────────────────────

let lastCpuMicros = 0; // 0 ⇒ the first sample includes all CPU since process start (cold start)

/** Seconds of process CPU (user + system) since the previous sample. */
export function sampleProcessCpuSeconds(): number {
  const u = process.cpuUsage();
  const total = u.user + u.system;
  const delta = Math.max(0, total - lastCpuMicros);
  lastCpuMicros = Math.max(lastCpuMicros, total);
  return delta / 1e6;
}

export interface MeterOptions {
  pool: Pool;
  now?: () => number;
  /** UI traffic flush interval. Default 60 s (§8.1). */
  flushIntervalMs?: number;
  /** Function memory in GB (2 on Hobby). */
  memoryGb?: number;
  /** CPU source (tests). Defaults to the process-wide sampler. */
  sampleCpuSeconds?: () => number;
  /**
   * UI flushes run only while this is true (e.g. the database was used moments ago), so a
   * metering write never wakes Neon by itself. Steps and explicit `flush()` ignore it.
   */
  canFlush?: () => boolean;
  /** How UI flushes run, e.g. Next's `after()` so they never delay a response. Default: awaited. */
  defer?: (task: () => Promise<void>) => void;
  /** UI flushes also write the pool's recorded checkouts to `neon_awake` (`flushNeonAwake`). */
  neonAwake?: boolean;
  /** How a deferred UI flush waits for the end of the interval (tests). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When the invocation running a deferred UI flush must be done (ms, `now()`'s clock; undefined:
   * unknown). The platform cancels `after()` work past it and records a timeout, so the trailing
   * wait ends `FLUSH_RESERVE_MS` before it (and is skipped when the deadline is unknown), no
   * other write starts with less than that left, and a write still running `FLUSH_CUTOFF_MS`
   * before it stops being awaited. Default: no deadline.
   */
  deadline?: () => number | undefined;
  /**
   * The platforms whose resources this meter records (`vercel.*`, `neon.*` with `neon_awake`,
   * `inngest.*`); amounts of the others are dropped. Default: `platformMetering()`, i.e. from
   * this process's environment (all of them on Vercel, in a hosted production build, or with
   * `EDF_METER_LOCAL=1`).
   */
  platforms?: PlatformMetering;
}

export interface SandboxUsage {
  /** From the Sandbox API (not our clock), so orphaned VMs count too (§5.1 "Metering"). */
  createdAt: Date;
  stoppedAt: Date;
  vcpus: number;
  /** Count one creation (default true). */
  countCreation?: boolean;
}

export interface Meter {
  withMeter<T>(kind: MeterKind, fn: () => Promise<T> | T): Promise<T>;
  /** Add `amount` of `resource` on the UTC day of `at` (default now). */
  add(resource: string, amount: number, at?: Date): void;
  /** vCPU × wall seconds (the conservative upper bound until calibrated), GB-h and a creation. */
  recordSandboxUsage(u: SandboxUsage): void;
  /** Inngest middleware: +1 per run, +1 per step. */
  recordInngest(runs: number, steps: number): void;
  /** An Anthropic response priced from its `usage` (see `costFromUsage`). */
  recordLlmUsd(usd: number): void;
  /**
   * Image bytes as Fast Origin Transfer. edf-app no longer calls it for minted image tokens (their
   * allowances are an upper bound, not metered); viewer images are metered from edf-view's exact
   * byte reports (packages/budget/DECISIONS.md, "Fast Origin Transfer").
   */
  recordImageBytes(maxBytes: number): void;
  /** Response bytes a function sent out through Vercel's CDN (Fast Origin Transfer). */
  recordOriginBytes(bytes: number): void;
  /** Bytes the database sent to this instance (Neon network transfer). */
  recordNeonTransferBytes(bytes: number): void;
  recordGmailUnits(units: number): void;
  /** Write the buffer now. Throws on failure (the amounts stay buffered). */
  flush(): Promise<void>;
  /**
   * Flush if the UI interval has passed and `canFlush()` allows it, with the process CPU used
   * since the last sample (work outside any wrapper: pages, framework) and, with `neonAwake`, the
   * pool's checkouts. Inside the interval, with `defer`, one call per instance waits for its end
   * (or until `FLUSH_RESERVE_MS` before its invocation's `deadline`, and then writes early) and
   * tries again (the trailing flush); the others return. Never throws.
   */
  maybeFlush(): Promise<void>;
  /** Buffered amounts keyed `"YYYY-MM-DD resource"` (tests, diagnostics). */
  pending(): ReadonlyMap<string, number>;
}

export function createMeter(opts: MeterOptions): Meter {
  const now = opts.now ?? Date.now;
  const interval = opts.flushIntervalMs ?? 60_000;
  const memoryGb = opts.memoryGb ?? FREE_TIER_PROFILE.functionMemoryGb;
  const cpu = opts.sampleCpuSeconds ?? sampleProcessCpuSeconds;
  const buffer = new Map<string, number>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = opts.deadline ?? (() => Number.POSITIVE_INFINITY);
  const platforms = opts.platforms ?? platformMetering();
  // Every meter's first UI flush runs at once (the daily cron's one-off route meter relies on it).
  let lastFlush = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let trailing = false;

  const add = (resource: string, amount: number, at?: Date): void => {
    if (!RESOURCE_CODE_PATTERN.test(resource)) throw new RangeError("meter: invalid resource code");
    if (!Number.isFinite(amount) || amount < 0)
      throw new RangeError("meter: amount must be a finite number ≥ 0");
    // A platform this process doesn't really use (pnpm dev): not its usage, never governor input.
    if (amount === 0 || !isMetered(platforms, resource)) return;
    const key = `${utcDay(at ?? now())} ${resource}`;
    buffer.set(key, (buffer.get(key) ?? 0) + amount);
  };

  const doFlush = async (): Promise<void> => {
    const entries: Array<[string, string, number]> = [];
    for (const [key, amount] of buffer) {
      const micro = Math.ceil(amount * 1e6 - 1e-7) / 1e6;
      if (micro <= 0) continue;
      const [day, resource] = key.split(" ") as [string, string];
      entries.push([day, resource, micro]);
    }
    if (entries.length === 0) return;
    entries.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
    for (const [day, resource] of entries) buffer.delete(`${day} ${resource}`);
    try {
      await withSystem(opts.pool, async (_db, client) => {
        for (const [day, resource, amount] of entries) {
          let left = amount;
          while (left > 0) {
            const chunk = Math.min(left, ADD_USAGE_MAX);
            await client.query("SELECT add_usage($1::date, $2::text, $3::numeric)", [
              day,
              resource,
              chunk.toFixed(6),
            ]);
            left = Math.round((left - chunk) * 1e6) / 1e6;
          }
        }
      });
      lastFlush = now();
    } catch (err) {
      for (const [day, resource, amount] of entries)
        add(resource, amount, new Date(`${day}T12:00:00Z`));
      throw err;
    }
  };

  const flush = async (): Promise<void> => {
    while (inFlight) await inFlight.catch(() => {});
    inFlight = doFlush();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  // Requests (or the Fast Origin Transfer they caused) not written yet. A flush's own leftovers
  // (its connection's transfer bytes) or a job's don't warrant keeping the instance up.
  const holdsTraffic = (): boolean => {
    for (const key of buffer.keys())
      if (key.endsWith(` ${RESOURCES.vercelInvocations}`) || key.endsWith(` ${RESOURCES.vercelFotMb}`)) return true;
    return false;
  };

  const maybeFlush = async (): Promise<void> => {
    const wait = lastFlush + interval - now();
    if (wait <= 0) return write();
    // Only deferred calls may wait: they run after the response, so nothing is held up. A wait
    // past the invocation's deadline would be cancelled (nothing written, the request timed out).
    const left = (deadline() ?? Number.NEGATIVE_INFINITY) - FLUSH_RESERVE_MS - now();
    if (!opts.defer || trailing || left <= 0 || !holdsTraffic()) return;
    const ms = Math.min(wait, left);
    const since = lastFlush;
    trailing = true;
    try {
      await sleep(ms);
    } finally {
      trailing = false;
    }
    add(RESOURCES.vercelMemGbh, (ms / 3_600_000) * memoryGb); // after() keeps the instance up
    if (lastFlush !== since) return maybeFlush(); // another flush wrote meanwhile: a new interval
    // The interval ended, or this is the invocation's last chance (write early), with the reserve
    // kept for this write (unless the timer fired late).
    return write(true);
  };

  const write = async (reserved = false): Promise<void> => {
    if (opts.canFlush && !opts.canFlush()) return;
    const left = (deadline() ?? Number.POSITIVE_INFINITY) - now();
    // Too close to the deadline to write safely: the next flush writes it.
    if (left < (reserved ? FLUSH_CUTOFF_MS : FLUSH_RESERVE_MS)) return;
    lastFlush = now(); // one attempt per interval, even if it fails
    add(RESOURCES.vercelCpuS, cpu());
    let cut = false;
    const writing = (async () => {
      await flush().catch(() => {});
      if (opts.neonAwake && !cut)
        await flushNeonAwake(opts.pool, undefined, platforms).catch(() => {});
    })();
    if (left === Number.POSITIVE_INFINITY) return writing;
    // Hard stop: the invocation ends in time even if the database stalls (a lock, a slow
    // connection). The abandoned write keeps its amounts accounted: it lands, or a failure puts
    // them back in the buffer (they die with the instance only if it is reaped).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        cut = true;
        resolve();
      }, left - FLUSH_CUTOFF_MS);
    });
    await Promise.race([writing, cutoff]);
    clearTimeout(timer);
  };

  return {
    add,
    async withMeter<T>(kind: MeterKind, fn: () => Promise<T> | T): Promise<T> {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        const wallS = Math.max(0, (performance.now() - t0) / 1000);
        add(RESOURCES.vercelCpuS, cpu());
        add(RESOURCES.vercelMemGbh, (wallS / 3600) * memoryGb);
        add(RESOURCES.vercelInvocations, 1);
        if (kind === "step") await flush().catch(() => {});
        else if (opts.defer) opts.defer(maybeFlush);
        else await maybeFlush();
      }
    },
    recordSandboxUsage(u: SandboxUsage): void {
      const secs = (u.stoppedAt.getTime() - u.createdAt.getTime()) / 1000;
      if (!Number.isFinite(secs) || secs < 0)
        throw new RangeError("recordSandboxUsage: stoppedAt must not precede createdAt");
      if (!Number.isInteger(u.vcpus) || u.vcpus < 1 || u.vcpus > 64)
        throw new RangeError("recordSandboxUsage: invalid vcpus");
      add(RESOURCES.sandboxCpuS, u.vcpus * secs, u.stoppedAt);
      add(
        RESOURCES.sandboxMemGbh,
        (u.vcpus * FREE_TIER_PROFILE.sandboxMemoryGbPerVcpu * secs) / 3600,
        u.stoppedAt,
      );
      if (u.countCreation !== false) add(RESOURCES.sandboxCreations, 1, u.createdAt);
    },
    recordInngest(runs: number, steps: number): void {
      if (!Number.isInteger(runs) || !Number.isInteger(steps) || runs < 0 || steps < 0) {
        throw new RangeError("recordInngest: counts must be non-negative integers");
      }
      add(RESOURCES.inngestExecutions, runs + steps);
      add(RESOURCES.inngestRuns, runs);
      add(RESOURCES.inngestSteps, steps);
    },
    recordLlmUsd(usd: number): void {
      add(RESOURCES.anthropicUsd, usd);
    },
    recordImageBytes(maxBytes: number): void {
      if (!Number.isInteger(maxBytes) || maxBytes < 0)
        throw new RangeError("recordImageBytes: bytes must be an integer ≥ 0");
      add(RESOURCES.vercelFotMb, maxBytes / 1e6);
    },
    recordOriginBytes(bytes: number): void {
      if (!Number.isInteger(bytes) || bytes < 0)
        throw new RangeError("recordOriginBytes: bytes must be an integer ≥ 0");
      add(RESOURCES.vercelFotMb, bytes / 1e6);
    },
    recordNeonTransferBytes(bytes: number): void {
      if (!Number.isInteger(bytes) || bytes < 0)
        throw new RangeError("recordNeonTransferBytes: bytes must be an integer ≥ 0");
      add(RESOURCES.neonTransferMb, bytes / 1e6);
    },
    recordGmailUnits(units: number): void {
      if (!Number.isInteger(units) || units < 0)
        throw new RangeError("recordGmailUnits: units must be an integer ≥ 0");
      add(RESOURCES.gmailUnits, units);
    },
    flush,
    maybeFlush,
    pending: () => new Map(buffer),
  };
}

const bytesSeen = new WeakMap<object, number>();

/**
 * Bytes the database sent to a pooled pg client since the previous call for that client: its
 * socket's byte counter, so every query's result counts. On a TLS socket that is the decrypted
 * stream (protocol framing included, TLS record overhead of about 3% not): the `neon_transfer`
 * calibration covers the difference.
 * Call it when the client goes back to the pool. 0 when the socket isn't reachable.
 */
export function clientBytesReceived(client: object): number {
  const read = (client as { connection?: { stream?: { bytesRead?: unknown } } }).connection?.stream
    ?.bytesRead;
  if (typeof read !== "number" || !Number.isFinite(read)) return 0;
  const prev = bytesSeen.get(client) ?? 0;
  bytesSeen.set(client, read);
  return Math.max(0, Math.floor(read - prev));
}

/**
 * Turn the pool's recorded checkouts into `mark_neon_awake(day, minutes[])` calls (FREE-TIER
 * §8.1 "Neon"): each checkout keeps the compute awake for its minute plus the 5-minute tail.
 * Call it only while the database is already awake (e.g. at the end of a job that used it).
 * On failure the checkouts are put back so they're counted next time. When Neon isn't metered
 * (`platforms`, default from the environment: a local database is not Neon compute) the
 * checkouts are dropped and nothing is written.
 */
export async function flushNeonAwake(
  pool: Pool,
  tailMinutes = FREE_TIER_PROFILE.neon.idleTailMinutes,
  platforms: PlatformMetering = platformMetering(),
): Promise<number> {
  const checkouts = drainCheckouts();
  if (checkouts.length === 0 || !platforms.neon) return 0;
  const byDay = [...awakeMinutesByDay(checkouts, tailMinutes)].sort(([a], [b]) => (a < b ? -1 : 1));
  try {
    await withSystem(pool, async (_db, client) => {
      for (const [day, minutes] of byDay) {
        await client.query("SELECT mark_neon_awake($1::date, $2::int[])", [day, minutes]);
      }
    });
  } catch (err) {
    for (const c of checkouts) recordCheckout(c.at);
    throw err;
  }
  return byDay.reduce((n, [, m]) => n + m.length, 0);
}
