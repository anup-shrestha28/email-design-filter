/**
 * Self-metering of UI and machine-to-machine traffic (FREE-TIER.md §8.1). One meter per server
 * instance, so a request only adds to an in-memory buffer:
 *  - route handlers run inside `meterRequest()` (Active CPU, GB-h, one invocation); pages and
 *    Server Actions count their invocation and GB-h (until the response is done) through
 *    `meterInvocation()` (the per-request session lookup calls it);
 *  - every pool checkout (pages, Server Actions, routes) schedules an interval flush after the
 *    response (`after()`), so work outside any wrapper still lands: the flush books the process CPU
 *    since the last sample and the pool's checkouts (`neon_awake`);
 *  - every connection going back to the pool books the bytes Postgres sent it (Neon transfer);
 *  - a flush writes at most every 60 s per instance (the first at once), and only if the app itself
 *    used the database in the last minute (the flush's own checkouts don't count), so metering
 *    never wakes Neon and never keeps it awake by itself. Requests buffered inside an interval are
 *    written when it ends (the trailing flush waits in `after()`), or earlier if the invocation
 *    waiting in `after()` would hit its deadline first (`getDeadline()`, else the route's
 *    `maxDuration`): after() work past it is cancelled and the request recorded as timed out.
 *    With no deadline known, or too little time left, they wait for the next flush on the
 *    instance (lost only if it is reaped first). No request writes on its own account.
 * Outside a request (tests, scripts) nothing is flushed implicitly.
 * Off Vercel (`pnpm dev`) the meter drops the Vercel and Neon amounts and, with the Inngest Dev
 * Server, the execution counts: none of that is platform usage (@edf/budget platform.ts;
 * `EDF_METER_LOCAL=1` meters them locally, to test the governor). On Vercel everything is metered,
 * and so is any production build whose database isn't on this machine (`VERCEL` or not).
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { getDeadline } from "@vercel/functions";
import {
  clientBytesReceived,
  createMeter,
  FREE_TIER_PROFILE,
  RESOURCES,
  type Meter,
  type MeterKind,
} from "@edf/budget";
import type { pg } from "@edf/db";
import { rawPool } from "./db";

const AWAKE_MS = 60_000;

const g = globalThis as unknown as { __edfMeter?: Meter; __edfDbUsedAt?: number };
/** Inside a deferred flush: the deadline of the invocation that runs it (ms; undefined: unknown). */
const flushing = new AsyncLocalStorage<{ deadline: number | undefined }>();
/** Inside `meterRequest()`: when the route's `maxDuration` runs out, if it gave one. */
const inMeteredRequest = new AsyncLocalStorage<{ deadline: number | undefined }>();

/** When this invocation (and its `after()` work) must be done: Vercel's shared deadline, else the route's. */
function invocationDeadline(): number | undefined {
  return getDeadline()?.getTime() ?? inMeteredRequest.getStore()?.deadline;
}

function afterResponse(task: () => Promise<void>): void {
  const deadline = invocationDeadline();
  try {
    after(async () => {
      // Let the response's other after() callbacks run first (meterInvocation's GB-h), so the
      // flush writes them instead of leaving them buffered.
      await new Promise((r) => setImmediate(r));
      await flushing.run({ deadline }, task);
    });
  } catch {
    // outside a request scope: the next request's flush (or an explicit flush) writes it
  }
}

/** The app used the database in the last minute, so it is awake and a flush barely extends that. */
export function databaseAwake(now = Date.now()): boolean {
  return now - (g.__edfDbUsedAt ?? Number.NEGATIVE_INFINITY) < AWAKE_MS;
}

/**
 * Run a write that only piggybacks on an awake database (m2m.ts's failure audit): its checkouts,
 * like a flush's, don't count as the app using the database, so it never extends
 * `databaseAwake()` and can't keep Neon awake by itself.
 */
export function withoutMarkingDbUse<T>(fn: () => Promise<T>): Promise<T> {
  return flushing.run({ deadline: flushing.getStore()?.deadline ?? invocationDeadline() }, fn);
}

/** This instance's meter (created on first use). */
export function instanceMeter(): Meter {
  g.__edfMeter ??= createMeter({
    pool: rawPool(),
    canFlush: () => databaseAwake(),
    defer: afterResponse,
    deadline: () => flushing.getStore()?.deadline,
    neonAwake: true,
  });
  return g.__edfMeter;
}

/** db.ts: called once when the instance's pool is created. */
export function watchPool(pool: pg.Pool): void {
  pool.on("acquire", () => {
    if (flushing.getStore()) return;
    g.__edfDbUsedAt = Date.now();
    afterResponse(() => instanceMeter().maybeFlush());
  });
  pool.on("release", (_err: Error | undefined, client: object) => {
    instanceMeter().recordNeonTransferBytes(clientBytesReceived(client));
  });
}

/**
 * Meter one route-handler request; the flush (if due) runs after the response. Pass the route's
 * `maxDuration` (seconds) when it sets one: a deferred flush never outlives it.
 */
export function meterRequest<T>(
  fn: () => Promise<T>,
  { kind = "route", maxDuration }: { kind?: MeterKind; maxDuration?: number } = {},
): Promise<T> {
  const deadline = maxDuration === undefined ? undefined : Date.now() + maxDuration * 1000;
  return inMeteredRequest.run({ deadline }, () => instanceMeter().withMeter(kind, fn));
}

/**
 * One invocation for a request with no wrapper of its own (a page render, a Server Action), and its
 * GB-h from this call until the response is done; a no-op inside `meterRequest()`, which already
 * counted both. Call it once per request, early (e.g. from a `cache()`d session lookup). Their CPU
 * is booked by the interval flush.
 */
export function meterInvocation(): void {
  if (inMeteredRequest.getStore()) return;
  const meter = instanceMeter();
  meter.add(RESOURCES.vercelInvocations, 1);
  const t0 = performance.now();
  try {
    after(() => {
      const hours = Math.max(0, performance.now() - t0) / 3_600_000;
      meter.add(RESOURCES.vercelMemGbh, hours * FREE_TIER_PROFILE.functionMemoryGb);
    });
  } catch {
    // outside a request scope: nothing to time
  }
}

/** URLs a view dropped because the signers refused them (diagnostic); written with the next flush. */
export function meterUnsignableUrls(count: number): void {
  if (count > 0) instanceMeter().add(RESOURCES.viewUnsignableUrls, count);
}

/**
 * Fast Origin Transfer (the governor's FOT caps, §8.1): the bytes of a large response body
 * (view-source HTML, export pages). Written with the instance's next flush. Viewer images are not
 * metered here: edf-view reports the exact bytes it served (service-counts.ts writes them).
 */
export function meterOriginBytes({ body = 0 }: { body?: number }): void {
  if (body > 0) instanceMeter().recordOriginBytes(body);
}
