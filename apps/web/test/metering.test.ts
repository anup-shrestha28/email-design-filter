/**
 * edf-app's own traffic reaches the governor (FREE-TIER §8.1): the view-source route meters its
 * HTML as Fast Origin Transfer (never the image allowances it mints), edf-view's reports meter the
 * exact image bytes it served, both under the code the FOT caps read, and UI / machine-to-machine
 * traffic is buffered per instance and written by an occasional flush (never one write per request) with the
 * pool's checkouts (neon_awake), its Neon transfer and the process CPU of unwrapped work. What is
 * buffered inside an interval is written before the instance goes idle, but a flush never holds
 * `after()` open past the invocation's deadline (Vercel cancels it and records a timeout).
 * Runs the real metering.ts, db.ts, session lookup and route against this run's test database.
 * These tests meter as production does (EDF_METER_LOCAL=1); the last ones check where usage is
 * metered at all: off Vercel, by default, no Vercel, Neon or Inngest usage (@edf/budget platform.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drainCheckouts, type pg, withSystem } from "@edf/db";
import { FLUSH_RESERVE_MS, platformOf, RESOURCES as R, runGovernor, type Meter } from "@edf/budget";
import { HAS_DB } from "./support/env";
import { appPool, ownerPool } from "./support/db";
import type * as Metering from "@/server/metering";

const h = vi.hoisted(() => ({
  pool: null as unknown,
  afterQueue: [] as Array<() => unknown>,
  imageBytesMinted: 0,
  unsignableUrls: 0,
  headers: async (): Promise<Headers> => new Headers(),
}));

// `after()` queues until the "response" is out.
vi.mock("next/server", () => ({ after: (task: () => unknown) => void h.afterQueue.push(task) }));
vi.mock("next/headers", () => ({ headers: () => h.headers() }));
vi.mock("@/server/auth", () => ({ auth: () => ({ api: { getSession: async () => null } }) }));
vi.mock("@/server/pipeline-deps", () => ({ pipelineDeps: async () => ({ pool: h.pool }) }));
vi.mock("@/server/m2m", () => ({
  JSON_HEADERS: { "Content-Type": "application/json" },
  authenticateCaller: async () => "edf-view",
  jsonError: (status: number, error: string) => Response.json({ error }, { status }),
  recordM2mFailure: async () => {},
  clientIp: () => "203.0.113.1",
}));
vi.mock("@/server/view-source", () => ({
  // Like the real one, it reads the database (so it is awake and the flush may write).
  buildViewSource: async () => {
    const { withSystem } = await import("@edf/db");
    await withSystem(h.pool as pg.Pool, (_db, c) => c.query("SELECT 1"));
    return { ok: true, html: "<p>hello</p>", height: 400, imageBytesMinted: h.imageBytesMinted, unsignableUrls: h.unsignableUrls };
  },
}));

const VERCEL_CONTEXT = Symbol.for("@vercel/request-context");
type G = { __edfMeter?: Meter; __edfDbUsedAt?: number; __edfPool?: unknown; __edfPoolChecked?: unknown } & Record<symbol, unknown>;
const g = globalThis as unknown as G;

/** Vercel's request context, as `getDeadline()` reads it (an invocation that must end at `at`). */
function vercelDeadline(at: number | null): void {
  if (at === null) delete g[VERCEL_CONTEXT];
  else g[VERCEL_CONTEXT] = { get: () => ({ deadline: new Date(at).toISOString() }) };
}

describe.skipIf(!HAS_DB)("edf-app metering (view-source FOT, UI flushes)", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let m: typeof Metering;

  beforeAll(async () => {
    delete g.__edfPool;
    delete g.__edfPoolChecked;
    pool = appPool(); // the test's own reads; edf-app's code uses its db.ts pool
    owner = ownerPool();
    m = await import("@/server/metering");
    h.pool = (await import("@/server/db")).rawPool();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await (h.pool as pg.Pool | null)?.end();
    await pool?.end();
    await owner?.end();
  });
  beforeEach(async () => {
    vi.useRealTimers();
    vi.stubEnv("EDF_METER_LOCAL", "1"); // meter every platform, as on Vercel (see the last tests)
    vercelDeadline(null);
    delete g.__edfMeter;
    delete g.__edfDbUsedAt;
    h.afterQueue.length = 0;
    h.unsignableUrls = 0;
    await owner.query("DELETE FROM usage_ledger");
    await owner.query("DELETE FROM neon_awake");
    await owner.query(
      `UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`,
    );
    drainCheckouts();
  });
  afterEach(() => {
    vercelDeadline(null);
    vi.unstubAllEnvs();
  });

  const ledger = async (): Promise<Record<string, number>> => {
    const { rows } = await pool.query<{ resource: string; amount: string }>(
      "SELECT resource, sum(amount) AS amount FROM usage_ledger GROUP BY resource",
    );
    return Object.fromEntries(rows.map((r) => [r.resource, Number(r.amount)]));
  };
  const pending = (code: string) =>
    [...m.instanceMeter().pending()].reduce((n, [k, v]) => (k.endsWith(` ${code}`) ? n + v : n), 0);
  /** What Next does once the response is out: starts every after() callback in order, then waits for all. */
  const runAfter = async () => {
    while (h.afterQueue.length) await Promise.all(h.afterQueue.splice(0).map(async (task) => task()));
  };
  const view = async () => {
    const { GET } = await import("@/app/api/view-source/[token]/[emailId]/route");
    const res = await GET(new Request("https://app.example/api/view-source/t/e"), {
      params: Promise.resolve({ token: "t", emailId: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(res.status).toBe(200);
    return Buffer.byteLength(await res.text());
  };

  const viewStats = async (counts: Record<string, number>) => {
    const { POST } = await import("@/app/api/view-stats/route");
    const res = await POST(
      new Request("https://app.example/api/view-stats", {
        method: "POST",
        body: JSON.stringify({ v: 1, windowStart: 1_790_000_000, windowEnd: 1_790_000_060, counts }),
      }),
    );
    expect(res.status).toBe(204);
  };

  it("view-source meters only its HTML as FOT, never the image allowances it mints (cards and full views)", async () => {
    h.imageBytesMinted = 15 * 1024 * 1024; // a full view's whole allowance (a card's is 6 MB)
    h.unsignableUrls = 3;
    const html = await view();
    await runAfter(); // a fresh instance's first flush
    const l = await ledger();
    expect(l[R.vercelFotMb]).toBeCloseTo((2 * html) / 1e6, 6); // the HTML, twice (to edf-view, then /v)
    expect(l[R.vercelInvocations]).toBe(1);
    expect(l[R.viewUnsignableUrls]).toBe(3); // the dropped URLs, with the same flush
  });

  it("edf-view's exact served image bytes are metered as FOT once; card bytes (a subset) are not added again", async () => {
    // A card view: the route meters its HTML only, although it minted a 6 MB allowance…
    h.imageBytesMinted = 6 * 1024 * 1024; // CARD_BUDGET_BYTES
    const html = await view();
    // …and edf-view's report of what it really served (card images are part of img_bytes_served)
    // is what meters the images, written in the report's own transaction.
    await viewStats({ img_ok: 4, img_bytes_served: 900_000, img_card_bytes_served: 250_000 });
    expect((await ledger())[R.vercelFotMb]).toBe(0.9); // before any flush: the report's own write
    await runAfter();
    const l = await ledger();
    expect(l[R.vercelFotMb]).toBeCloseTo((900_000 + 2 * html) / 1e6, 6);
    // The diagnostic rows stay.
    expect(l["view.img_card_bytes_served"]).toBe(250_000);
    expect(l["view.img_bytes_served"]).toBe(900_000);
    expect(l["view.img_ok"]).toBe(4);
    // A later report adds only its own bytes (no re-count of the earlier one).
    await viewStats({ img_bytes_served: 123_457 });
    expect((await ledger())[R.vercelFotMb]).toBeCloseTo((900_000 + 123_457 + 2 * html) / 1e6, 6);
  });

  it("a report with no served image bytes meters no FOT; a malformed one writes nothing", async () => {
    await viewStats({ view_requests: 7, img_bad_signature: 2 });
    const { POST } = await import("@/app/api/view-stats/route");
    const bad = await POST(new Request("https://app.example/api/view-stats", { method: "POST", body: "{}" }));
    expect(bad.status).toBe(400);
    const l = await ledger();
    expect(l[R.vercelFotMb]).toBeUndefined();
    expect(l["view.view_requests"]).toBe(7);
  });

  it("FOT from edf-view's reports reaches the governor × the 1.25 default calibration", async () => {
    // The seeded app_setting.calibration has no vercel_fot key, so the profile default applies.
    const cal = await pool.query<{ value: Record<string, number> }>("SELECT value FROM app_setting WHERE key = 'calibration'");
    expect(cal.rows[0]?.value.vercel_fot).toBeUndefined();
    for (let i = 0; i < 3; i++) await viewStats({ img_ok: 100, img_bytes_served: 10_000_000 });
    expect((await ledger())[R.vercelFotMb]).toBe(30);
    const r = await runGovernor(pool);
    expect(r.result.resources.find((x) => x.code === R.vercelFotMb)?.value).toBeCloseTo(37.5, 6);
  });

  for (const source of ["Vercel's invocation deadline", "the route's maxDuration"] as const) {
    it(`a burst of views is written before the invocation's deadline, not held past it (${source})`, async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      h.imageBytesMinted = 3_000_000; // never metered: only the HTML is
      const html = await view();
      await runAfter(); // a fresh instance's first flush
      vi.setSystemTime(Date.now() + 5_000);
      const deadline = Date.now() + 30_000; // view-source's maxDuration
      if (source === "Vercel's invocation deadline") vercelDeadline(deadline);
      await view();
      await view();
      let done = false;
      const idle = runAfter().then(() => (done = true)); // no further request reaches this instance
      expect((await ledger())[R.vercelFotMb]).toBeCloseTo((2 * html) / 1e6, 6);
      // The wait ends the flush reserve before the deadline (the minute ends 25 s later).
      await vi.advanceTimersByTimeAsync(deadline - FLUSH_RESERVE_MS - Date.now());
      await vi.waitFor(() => expect(done).toBe(true));
      await idle;
      expect(Date.now()).toBeLessThan(deadline);
      const l = await ledger();
      expect(l[R.vercelFotMb]).toBeCloseTo((3 * 2 * html) / 1e6, 6);
      expect(l[R.vercelInvocations]).toBe(3);
    });
  }

  it("with too little time left, nothing waits in after(): the next flush on the instance writes it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await view();
    await runAfter();
    vi.setSystemTime(Date.now() + 5_000);
    vercelDeadline(Date.now() + FLUSH_RESERVE_MS - 1_000); // a request that used most of its budget
    await view();
    await runAfter(); // returns without a timer
    expect((await ledger())[R.vercelInvocations]).toBe(1);
    expect(pending(R.vercelInvocations)).toBe(1);
    vi.setSystemTime(Date.now() + 60_000);
    vercelDeadline(Date.now() + 30_000);
    await view();
    await runAfter();
    expect((await ledger())[R.vercelInvocations]).toBe(3);
  });

  it("a page or Server Action counts one invocation through its session lookup", async () => {
    const { getSessionUser } = await import("@/server/session");
    expect(await getSessionUser()).toBeNull();
    expect(pending(R.vercelInvocations)).toBe(1);
    // A route handler's lookup doesn't: meterRequest counted it.
    await m.meterRequest(() => getSessionUser());
    expect(pending(R.vercelInvocations)).toBe(2);
  });

  it("a prerender's session lookup bails out at headers() before touching the meter (builds need no secrets)", async () => {
    const bailout = new Error("Dynamic server usage: headers");
    h.headers = async () => {
      throw bailout;
    };
    try {
      const { getSessionUser } = await import("@/server/session");
      await expect(getSessionUser()).rejects.toBe(bailout);
      expect(g.__edfMeter).toBeUndefined(); // no meter, so no pool and no env() read
    } finally {
      h.headers = async () => new Headers();
    }
  });

  it("a page or Server Action books its invocation and GB-h until the response is done", async () => {
    m.meterInvocation();
    await new Promise((r) => setTimeout(r, 40)); // rendering and streaming
    expect(pending(R.vercelInvocations)).toBe(1);
    expect(pending(R.vercelMemGbh)).toBe(0);
    await runAfter();
    expect(pending(R.vercelMemGbh)).toBeGreaterThanOrEqual((0.035 / 3600) * 2);
    expect(pending(R.vercelMemGbh)).toBeLessThan((5 / 3600) * 2);
  });

  it("a page's GB-h is written by the flush its own earlier checkout scheduled, not left behind", async () => {
    const app = h.pool as pg.Pool;
    await withSystem(app, (_db, c) => c.query("SELECT 1")); // e.g. the session lookup's first query
    m.meterInvocation();
    await new Promise((r) => setTimeout(r, 20));
    await runAfter(); // a fresh instance's first flush
    expect((await ledger())[R.vercelMemGbh]).toBeGreaterThanOrEqual((0.015 / 3600) * 2);
    expect(pending(R.vercelMemGbh)).toBe(0);
  });

  it("an Inngest step writes its CPU at once and leaves run/step counting to the middleware", async () => {
    const { runStep } = await import("@/server/inngest/job");
    m.instanceMeter().recordInngest(1, 1); // what the middleware recorded for this run and step
    expect(await runStep("test.step", async (deps) => (await deps.pool.query<{ n: number }>("SELECT 1 AS n")).rows[0]?.n)).toBe(1);
    const l = await ledger(); // no after(): the step's own flush
    expect(l[R.vercelInvocations]).toBe(1);
    expect(l[R.inngestSteps]).toBe(1);
    expect(l[R.inngestExecutions]).toBe(2);
  });

  it("buffers UI traffic per instance: one write per interval, with unwrapped checkouts, transfer and CPU", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const app = h.pool as pg.Pool;
    const route = () => m.meterRequest(() => withSystem(app, (_db, c) => c.query("SELECT repeat('x', 50000)")));

    await route();
    await runAfter(); // a fresh instance writes at once
    expect((await ledger())[R.vercelInvocations]).toBe(1);

    vi.setSystemTime(Date.now() + 1_000);
    vercelDeadline(Date.now() + 300_000); // a route with the default 300 s
    await route();
    await route();
    const idle = runAfter();
    expect((await ledger())[R.vercelInvocations]).toBe(1); // inside the minute: nothing written
    await vi.advanceTimersByTimeAsync(59_000);
    await idle; // written when the minute ends (the trailing flush)
    expect((await ledger())[R.vercelInvocations]).toBe(3);

    vi.setSystemTime(Date.now() + 61_000);
    // A page or Server Action: no wrapper; its session lookup counts the invocation (a route
    // handler's lookup doesn't: meterRequest counted it).
    await m.meterRequest(async () => m.meterInvocation());
    m.meterInvocation();
    await withSystem(app, (_db, c) => c.query("SELECT 1"));
    await runAfter();
    const l = await ledger();
    expect(l[R.vercelInvocations]).toBe(5);
    expect(l[R.vercelCpuS]).toBeGreaterThan(0);
    expect(l[R.neonTransferMb]).toBeGreaterThan(0.15); // three 50 kB results and more
    const { rows } = await pool.query<{ bits: number }>("SELECT coalesce(sum(bit_count(minutes)), 0)::int AS bits FROM neon_awake");
    expect(rows[0]?.bits).toBeGreaterThanOrEqual(6);

    // Minutes later, a request that doesn't touch the database: a flush would wake it, so it waits.
    const before = await ledger();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(m.databaseAwake()).toBe(false);
    m.instanceMeter().add(R.vercelInvocations, 1);
    await m.instanceMeter().maybeFlush();
    expect(await ledger()).toEqual(before);
  });

  // Where usage is metered at all (@edf/budget platform.ts; packages/budget/DECISIONS.md "Local
  // development"): pnpm dev on a laptop must never feed the governor platform usage.
  const PLATFORM_ROWS = [
    R.vercelCpuS, R.vercelInvocations, R.vercelMemGbh, R.vercelFotMb, R.neonTransferMb,
    R.inngestExecutions, R.inngestRuns, R.inngestSteps, "view.view_requests", "view.img_requests", "view.img_bytes_served",
  ];
  const MODES = [
    ["pnpm dev (the default off Vercel)", { EDF_METER_LOCAL: undefined, VERCEL: undefined, INNGEST_DEV: "1" }, false],
    ["EDF_METER_LOCAL=1 (testing the governor locally)", { EDF_METER_LOCAL: "1", VERCEL: undefined, INNGEST_DEV: "1" }, true],
    ["on Vercel", { EDF_METER_LOCAL: undefined, VERCEL: "1", INNGEST_DEV: undefined }, true],
  ] as const;
  for (const [mode, env, metered] of MODES) {
    it(`${mode}: ${metered ? "Vercel, Neon and Inngest usage is metered" : "no Vercel, Neon or Inngest usage reaches the ledger or the governor"}`, async () => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const { recordServiceCounts } = await import("@/server/service-counts");
      const { runStep } = await import("@/server/inngest/job");
      h.unsignableUrls = 3;
      await view(); // a route: invocation, CPU, GB-h, its HTML as FOT, a checkout and its transfer
      await viewStats({ view_requests: 7, img_requests: 9, img_bytes_served: 900_000 });
      const keysReport = JSON.stringify({ v: 1, windowStart: 1_790_000_000, windowEnd: 1_790_000_060, counts: { unwrap_ok: 2 } });
      expect(await recordServiceCounts("edf-keys", new Request("https://app.example/api/keys-audit", { method: "POST", body: keysReport }))).toBe(true);
      m.instanceMeter().recordInngest(1, 1); // the middleware's counts for a run and its step
      await runStep("test.step", async (deps) => (await deps.pool.query("SELECT 1")).rowCount);
      await runAfter();

      const l = await ledger();
      // App-level rows are recorded everywhere (the governor reads none of them).
      expect(l[R.viewUnsignableUrls]).toBe(3);
      expect(l["keys.unwrap_ok"]).toBe(2);
      // edf-view's report is always in the audit log, with every count.
      const audit = await owner.query<{ metadata: { counts: Record<string, number> } }>(
        "SELECT metadata FROM audit_log WHERE actor = 'edf-view' AND action = 'view.stats' ORDER BY id DESC LIMIT 1",
      );
      expect(audit.rows[0]?.metadata.counts).toEqual({ view_requests: 7, img_requests: 9, img_bytes_served: 900_000 });
      const { rows } = await pool.query<{ bits: number }>("SELECT coalesce(sum(bit_count(minutes)), 0)::int AS bits FROM neon_awake");
      const gov = await runGovernor(pool);
      if (metered) {
        for (const code of PLATFORM_ROWS) expect(l[code], code).toBeGreaterThan(0);
        expect(l[R.vercelFotMb]).toBeGreaterThan(0.9);
        expect(l[R.inngestExecutions]).toBe(2);
        expect(rows[0]?.bits).toBeGreaterThanOrEqual(6);
        expect(gov.result.resources.find((x) => x.code === R.vercelCpuS)?.value).toBeGreaterThan(0);
      } else {
        expect(Object.keys(l).sort()).toEqual([R.viewUnsignableUrls, "keys.unwrap_ok"].sort());
        expect(rows[0]?.bits).toBe(0);
        expect(gov.result.level).toBe(0);
        expect(gov.result.triggers).toEqual([]);
        expect(gov.result.externalLoadSpikes).toEqual([]);
        expect(gov.result.resources.filter((x) => platformOf(x.code) !== null && x.value > 0)).toEqual([]);
      }
    });
  }
});
