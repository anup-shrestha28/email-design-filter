/**
 * Fresh renders (render-policy.ts; FREE-TIER.md §5.1, §5.3, §5.5): the owner's new mail without a
 * score gets its own render soon after it arrives, only within the budget rules:
 *  - only while the governor allows fill (not L1 / Sandbox soft / ≥ 55% of the hard limit, not
 *    with planned renders off, not while renders are nightly-only, never once renders stop);
 *  - the owner only, while they use the app; friends keep the nightly batching rule;
 *  - one VM per batch, ≥ 15 minutes apart, ≤ 8 fill batches a rolling day (the nightly one included);
 *  - their own Sandbox allowance (2,520 CPU-s a rolling 30 days, recorded per batch from its VM time);
 *  - a fresh batch takes queued on-demand and fill work, then only fresh mail (static-only,
 *    ≤ 48 h, in an active mailbox, never requested) — no samples, never template-scored mail;
 *  - the nightly fill leaves out mail of mailboxes that aren't active (the render step can't fetch it).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calendarMonthStart, computeGovernor, FREE_TIER_PROFILE, RESOURCES as R } from "@edf/budget";
import { createPool, type pg, withUser } from "@edf/db";
import type { PipelineDeps } from "../src/deps";
import { MAX_EMAILS_PER_BATCH, renderForUser, workKinds, type RenderOptions } from "../src/render";
import { freshCpuUsed, freshRenderDue, freshRows, gateRenderOptions, planFrom, type RenderGovernor } from "../src/render-plan";
import {
  FILL_BATCHES_PER_DAY,
  FRESH_ACTIVE_MINUTES,
  FRESH_BATCH_MAX_CPU_S,
  FRESH_CPU_RESOURCE,
  FRESH_CPU_S_PER_30_DAYS,
  FRESH_MIN_GAP_MINUTES,
  RENDER_BATCH_CAPACITY,
  freshDue,
  freshRendersAllowed,
  nextNightlyAfter,
  type FreshRow,
} from "../src/render-policy";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

const NOW = new Date("2026-09-20T12:00:00Z");
const MIN = 60_000;

function governorFor(r30: Record<string, number>, neonCuHoursMtd = 0): RenderGovernor {
  const g = computeGovernor({
    usage: { rolling30d: r30, monthToDate: {}, trailing7dAvg: {} },
    neonCuHoursMtd,
    neonStorageMb: 50,
    calibration: {},
    profile: FREE_TIER_PROFILE,
    now: NOW,
    periodStart: calendarMonthStart(NOW),
    previous: null,
  });
  return { level: g.level, actions: g.actions };
}

const row = (over: Partial<FreshRow> = {}): FreshRow => ({
  user_id: "owner",
  role: "owner",
  last_active_at: new Date(NOW.getTime() - 5 * MIN),
  candidates: 3,
  last_fill_at: new Date(NOW.getTime() - 60 * MIN),
  fill_batches_24h: 1,
  fresh_cpu_s_30d: 0,
  ...over,
});

describe("fresh-batch gating (pure)", () => {
  it("the governor: only while fill is allowed, not nightly-only, and renders aren't stopped", () => {
    expect(freshRendersAllowed(governorFor({}))).toBe(true);
    // L1 (Neon 50 CU-h), Sandbox soft (80% of the 12,600 self-cap) and ≥ 55% of the hard limit: fill off.
    expect(freshRendersAllowed(governorFor({}, 50))).toBe(false);
    expect(freshRendersAllowed(governorFor({ [R.sandboxCpuS]: 10_080 }))).toBe(false);
    expect(freshRendersAllowed(governorFor({ [R.sandboxCpuS]: 9_900 }))).toBe(false);
    expect(freshRendersAllowed(governorFor({ [R.sandboxCpuS]: 9_800 }))).toBe(true);
    // L2 / the Sandbox self-cap: planned renders off; L3 / static-only: nothing.
    expect(freshRendersAllowed(governorFor({}, 60))).toBe(false);
    expect(freshRendersAllowed(governorFor({ [R.sandboxCpuS]: 13_000 }))).toBe(false);
    expect(freshRendersAllowed(governorFor({ [R.sandboxCpuS]: 16_200 }))).toBe(false);
    expect(freshRendersAllowed(governorFor({}, 80))).toBe(false);
    // The Inngest soft cap: renders only in the nightly run.
    expect(freshRendersAllowed({ level: 0, actions: { rendersNightlyOnly: true } as never })).toBe(false);
    // The owner's kill.render folds into rendersOff (readRenderGovernor).
    expect(freshRendersAllowed({ level: 0, actions: { rendersOff: true } })).toBe(false);
  });

  it("the owner only, while they use the app, with fresh mail waiting", () => {
    const now = NOW.getTime();
    expect(freshDue(row(), now)).toBe(true);
    expect(freshDue(row({ role: "friend" }), now)).toBe(false);
    expect(freshDue(row({ candidates: 0 }), now)).toBe(false);
    expect(freshDue(row({ last_active_at: null }), now)).toBe(false);
    expect(freshDue(row({ last_active_at: new Date(now - (FRESH_ACTIVE_MINUTES + 1) * MIN) }), now)).toBe(false);
    expect(freshDue(row({ last_active_at: new Date(now - (FRESH_ACTIVE_MINUTES - 1) * MIN) }), now)).toBe(true);
  });

  it("rate limit: ≥ 15 minutes after the last fill batch, ≤ 8 fill batches a rolling day", () => {
    const now = NOW.getTime();
    expect(FRESH_MIN_GAP_MINUTES).toBe(15);
    expect(FILL_BATCHES_PER_DAY).toBe(8);
    expect(freshDue(row({ last_fill_at: new Date(now - 14 * MIN) }), now)).toBe(false);
    expect(freshDue(row({ last_fill_at: new Date(now - 15 * MIN) }), now)).toBe(true);
    expect(freshDue(row({ last_fill_at: null, fill_batches_24h: 0 }), now)).toBe(true);
    expect(freshDue(row({ fill_batches_24h: FILL_BATCHES_PER_DAY - 1 }), now)).toBe(true);
    expect(freshDue(row({ fill_batches_24h: FILL_BATCHES_PER_DAY }), now)).toBe(false);
  });

  it("their own Sandbox allowance: 20% of the self-cap; a batch starts only while a whole one still fits", () => {
    const now = NOW.getTime();
    const sandbox = FREE_TIER_PROFILE.resources.find((r) => r.code === R.sandboxCpuS)!;
    const fillWindow = FREE_TIER_PROFILE.sandboxFillMaxFractionOfHard * sandbox.hardLimit;
    expect(FRESH_CPU_S_PER_30_DAYS).toBe(2_520);
    expect(FRESH_CPU_S_PER_30_DAYS).toBe(0.2 * sandbox.selfCap);
    // At most about a quarter of the 9,900 CPU-s window the nightly fill (yours and friends') shares;
    // uncapped, ≈ 450 extra renders a month (3,150–7,650 CPU-s) could take up to 77% of it.
    expect(fillWindow).toBe(9_900);
    expect(FRESH_CPU_S_PER_30_DAYS / fillWindow).toBeLessThan(0.26);
    // One batch is at most its VM's 2 vCPUs × 250 s (the tick stops render VMs older than that).
    expect(FRESH_BATCH_MAX_CPU_S).toBe(500);
    expect(freshDue(row({ fresh_cpu_s_30d: FRESH_CPU_S_PER_30_DAYS - FRESH_BATCH_MAX_CPU_S }), now)).toBe(true);
    expect(freshDue(row({ fresh_cpu_s_30d: FRESH_CPU_S_PER_30_DAYS - FRESH_BATCH_MAX_CPU_S + 0.5 }), now)).toBe(false);
    expect(freshDue(row({ fresh_cpu_s_30d: FRESH_CPU_S_PER_30_DAYS }), now)).toBe(false);
    // Nothing fresh planned once it's used up; queued on-demand work still gets its VM.
    const due = [{ user_id: "owner", queued_count: "1", on_demand_count: "1", oldest_at: NOW }];
    const p = planFrom({
      trigger: "on_demand",
      gov: governorFor({}),
      aiPaused: false,
      due,
      users: [{ user_id: "owner", role: "owner", mailboxes: 1 }],
      fresh: [row({ fresh_cpu_s_30d: FRESH_CPU_S_PER_30_DAYS })],
      now,
    });
    expect(p.map((x) => [x.userId, x.options.fresh === true, x.options.onDemandOnly === true])).toEqual([["owner", false, true]]);
  });

  const users = [
    { user_id: "owner", role: "owner" as const, mailboxes: 1 },
    { user_id: "f1", role: "friend" as const, mailboxes: 1 },
  ];
  const plan = (gov: RenderGovernor, fresh: FreshRow[], due: Parameters<typeof planFrom>[0]["due"] = []) =>
    planFrom({ trigger: "on_demand", gov, aiPaused: false, due, users, fresh, now: NOW.getTime() });

  it("the on-demand trigger plans the owner's fresh batch: fill for fresh mail, no samples", () => {
    const p = plan(governorFor({}), [row()]);
    expect(p).toEqual([
      {
        userId: "owner",
        options: { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false, aiRealtimeAllowed: true },
      },
    ]);
    // Queued work it takes: on-demand only (queued fill — retries, a nightly batch's rest — waits for
    // the nightly run); its fill is the fresh mail it inserts itself.
    expect(workKinds(p[0]!.options)).toEqual(["on_demand"]);
  });

  it("one VM per user: a fresh batch also takes the user's queued on-demand work", () => {
    const due = [
      { user_id: "owner", queued_count: "1", on_demand_count: "1", oldest_at: NOW },
      { user_id: "f1", queued_count: "1", on_demand_count: "1", oldest_at: NOW },
    ];
    const p = plan(governorFor({}), [row(), row({ user_id: "f1", role: "friend" })], due);
    expect(p.map((x) => [x.userId, x.options.fresh === true])).toEqual([
      ["owner", true],
      ["f1", false],
    ]);
  });

  it("friends keep the nightly batching rule; nothing fresh while the governor says no", () => {
    expect(plan(governorFor({}), [row({ user_id: "f1", role: "friend", candidates: 40 })])).toEqual([]);
    for (const gov of [governorFor({}, 50), governorFor({ [R.sandboxCpuS]: 10_080 }), governorFor({}, 60), governorFor({}, 80)]) {
      expect(plan(gov, [row()]).some((x) => x.options.fresh)).toBe(false);
    }
    expect(plan({ level: 0, actions: { rendersNightlyOnly: true } as never }, [row()])).toEqual([]);
    // The nightly trigger never plans a fresh batch (it has its own full options).
    const nightly = planFrom({ trigger: "nightly", gov: governorFor({}), aiPaused: false, due: [], users, fresh: [row()], now: NOW.getTime() });
    expect(nightly.some((x) => x.options.fresh)).toBe(false);
  });

  it("the render step re-checks: no fresh VM once renders are nightly-only; only on-demand once fill is off", () => {
    const fresh: RenderOptions = { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false };
    expect(gateRenderOptions({ level: 0, actions: { rendersNightlyOnly: true } as never }, "owner", fresh)).toBeNull();
    const off = gateRenderOptions(governorFor({ [R.sandboxCpuS]: 10_080 }), "owner", fresh);
    expect(off?.fillAllowed).toBe(false);
    expect(workKinds(off!)).toEqual(["on_demand"]);
    expect(gateRenderOptions(governorFor({ [R.sandboxCpuS]: 16_200 }), "owner", fresh)).toBeNull();
  });

  it("the UI's capacity and nightly time match the render step", () => {
    expect(RENDER_BATCH_CAPACITY).toBeLessThanOrEqual(MAX_EMAILS_PER_BATCH);
    expect(new Date(nextNightlyAfter(Date.parse("2026-09-30T04:29:59Z"))).toISOString()).toBe("2026-09-30T04:30:00.000Z");
    expect(new Date(nextNightlyAfter(Date.parse("2026-09-30T04:30:00Z"))).toISOString()).toBe("2026-10-01T04:30:00.000Z");
  });
});

describe.skipIf(!HAS_DB)("fresh batches against the database", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let deps: PipelineDeps;

  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
    deps = {
      pool,
      tokens: {} as PipelineDeps["tokens"],
      tickEvery: 30,
      governorLevel: async () => 0,
      // A renderer that's never reached: the refetch fails first (no Gmail here), which leaves the
      // picked requests as they were picked, for the assertions.
      renderer: { host: "test", renderBatch: async () => [] },
    };
  });
  afterAll(async () => {
    await owner?.query(
      `UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`,
    );
    await pool?.end();
    await owner?.end();
  });
  beforeEach(async () => {
    await owner.query(
      `UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`,
    );
  });

  async function setup(role: "owner" | "friend", activeMinutesAgo: number | null = 1) {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await owner.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'T', $2, true)`, [userId, `${userId}@example.com`]);
    return withUser(pool, userId, async (_db, c) => {
      await c.query(
        "INSERT INTO user_settings (user_id, role, last_active_at) VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(mins => $3::int) END)",
        [userId, role, activeMinutesAgo],
      );
      const mb = async (status: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, $4) RETURNING id`,
            [userId, randomUUID(), `${randomUUID().slice(0, 8)}@gmail.example`, status],
          )
        ).rows[0]!.id;
      return { userId, active: await mb("active"), paused: await mb("paused") };
    });
  }

  async function email(
    userId: string,
    mailboxId: string,
    over: { hoursAgo?: number; source?: string; status?: string; hidden?: boolean; sensitive?: boolean } = {},
  ): Promise<string> {
    return withUser(pool, userId, async (_db, c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                              primary_type, type_source, search_tsv, design_status, design_source, in_trash, security_sensitive)
           VALUES ($1, $2, $3, 100, now() - make_interval(hours => $4::int), 'Hello', true, 'promotional', 'rule',
                   to_tsvector('simple', 'hello'), $5, $6, $7, $8) RETURNING id`,
          [
            userId,
            mailboxId,
            randomUUID().replaceAll("-", "").slice(0, 16),
            over.hoursAgo ?? 1,
            over.status ?? "done",
            over.source ?? "static",
            over.hidden ?? false,
            over.sensitive ?? false,
          ],
        )
      ).rows[0]!.id,
    );
  }

  async function requests(userId: string) {
    return withUser(pool, userId, async (_db, c) =>
      (await c.query<{ email_id: string; kind: string }>("SELECT email_id, kind FROM render_request WHERE user_id = $1 ORDER BY requested_at", [userId])).rows,
    );
  }

  it("counts only fresh candidates, and a fresh batch picks exactly those (then its rate limit holds)", async () => {
    const u = await setup("owner");
    const fresh1 = await email(u.userId, u.active, { hoursAgo: 1 });
    const fresh2 = await email(u.userId, u.active, { hoursAgo: 30 });
    await email(u.userId, u.active, { hoursAgo: 60 }); // older than 48 h: nightly fill's
    await email(u.userId, u.active, { source: "template" }); // already scored from its template
    await email(u.userId, u.active, { source: "render" });
    await email(u.userId, u.active, { hidden: true });
    await email(u.userId, u.active, { sensitive: true, status: "skipped", source: "none" });
    await email(u.userId, u.paused); // its mailbox isn't active: the render step can't fetch it
    const tried = await email(u.userId, u.active, { hoursAgo: 2 });
    await withUser(pool, u.userId, (_db, c) =>
      c.query("INSERT INTO render_request (user_id, email_id, kind, state) VALUES ($1, $2, 'fill', 'failed')", [u.userId, tried]),
    );
    // A failed try from 5 minutes ago counts as the last fill batch; age it past the gap.
    await owner.query("UPDATE render_request SET requested_at = now() - interval '20 minutes' WHERE email_id = $1", [tried]);

    const users = [{ user_id: u.userId, role: "owner" as const, mailboxes: 1, last_active_at: new Date() }];
    const [r] = await freshRows(deps, users, Date.now());
    expect(r).toMatchObject({ candidates: 2, fill_batches_24h: 1 });
    expect(freshDue(r!, Date.now())).toBe(true);
    expect(await freshRenderDue(deps)).toBe(true);

    const before = (await requests(u.userId)).length;
    const out = await renderForUser(deps, u.userId, { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false });
    expect(out.picked).toBe(2);
    const picked = (await requests(u.userId)).slice(before);
    expect(picked.map((x) => x.kind)).toEqual(["fill", "fill"]);
    expect(picked.map((x) => x.email_id).sort()).toEqual([fresh1, fresh2].sort());

    // Right after: tried once (no candidates left), and the 15-minute gap holds.
    const [again] = await freshRows(deps, users, Date.now());
    expect(again).toMatchObject({ candidates: 0, fill_batches_24h: 2 });
    await email(u.userId, u.active, { hoursAgo: 0 });
    const [third] = await freshRows(deps, users, Date.now());
    expect(third!.candidates).toBe(1);
    expect(freshDue(third!, Date.now())).toBe(false);
  });

  it("a fresh batch never takes queued fill: it always leaves its own record, and a failed try waits for the night", async () => {
    const u = await setup("owner");
    // 25 queued fill requests (a killed nightly VM's batch, put back by the reaper), from 5 hours ago.
    const queued: string[] = [];
    for (let i = 0; i < 25; i++) queued.push(await email(u.userId, u.active, { hoursAgo: 72, source: "template" }));
    await withUser(pool, u.userId, (_db, c) =>
      c.query(
        "INSERT INTO render_request (user_id, email_id, kind, requested_at) SELECT $1, x, 'fill', now() - interval '5 hours' FROM unnest($2::uuid[]) x",
        [u.userId, queued],
      ),
    );
    const fresh = await email(u.userId, u.active, { hoursAgo: 1 });
    const users = [{ user_id: u.userId, role: "owner" as const, mailboxes: 1, last_active_at: new Date() }];
    const [r] = await freshRows(deps, users, Date.now());
    expect(freshDue(r!, Date.now())).toBe(true);

    const out = await renderForUser(deps, u.userId, { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false });
    expect(out.picked).toBe(1);
    const rows = await withUser(pool, u.userId, async (_db, c) =>
      (await c.query<{ email_id: string; state: string }>("SELECT email_id, state FROM render_request WHERE user_id = $1", [u.userId])).rows,
    );
    // Only the fresh email was taken (its try failed here — no Gmail — so it went back to the queue
    // as fill); the queued fill is still queued for the nightly run.
    expect(rows.find((x) => x.email_id === fresh)?.state).toBe("queued");
    expect(rows.filter((x) => x.state === "queued").map((x) => x.email_id).sort()).toEqual([...queued, fresh].sort());
    // The batch left its record: the rate limit now holds.
    const [after] = await freshRows(deps, users, Date.now());
    expect(after!.fill_batches_24h).toBe(2);
    expect(freshDue({ ...after!, candidates: 1 }, Date.now())).toBe(false);

    // The next fresh batch, 20 minutes on, leaves the failed try to the nightly run.
    await owner.query("UPDATE render_request SET requested_at = requested_at - interval '20 minutes' WHERE email_id = $1", [fresh]);
    const next = await renderForUser(deps, u.userId, { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false });
    expect(next.picked).toBe(0);
  });

  it("their own allowance: a batch records its VM time; once used up there is no fresh batch, and the step takes no fresh mail", async () => {
    const clear = () => owner.query("DELETE FROM usage_ledger WHERE resource = $1", [FRESH_CPU_RESOURCE]);
    const savedCal = (await owner.query<{ value: unknown }>("SELECT value FROM app_setting WHERE key = 'calibration'")).rows[0]?.value;
    const setCal = (value: unknown) =>
      owner.query("INSERT INTO app_setting (key, value) VALUES ('calibration', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
        JSON.stringify(value),
      ]);
    await clear();
    try {
      const u = await setup("owner");
      await email(u.userId, u.active, { hoursAgo: 1 });
      const RAW = new TextEncoder().encode(
        ["From: Shop <news@shop.example>", "To: me@gmail.example", "Subject: Hello", "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8", "", "<html><body><p>Autumn sale</p><a href=\"https://shop.example/sale\">Shop</a></body></html>", ""].join("\r\n"),
      );
      // A renderer that is reached (the raw message comes from rawSourceFor) and runs its VM ≥ 200 ms.
      const rendering: PipelineDeps = {
        ...deps,
        rawSourceFor: () => async () => RAW,
        renderer: { host: "test", renderBatch: async () => (await new Promise((r) => setTimeout(r, 200)), []) },
      };
      const fresh: RenderOptions = { fresh: true, fillAllowed: true, samplesAllowed: false, aiSamplesAllowed: false };
      expect((await renderForUser(rendering, u.userId, fresh)).picked).toBe(1);
      const used = await freshCpuUsed(deps);
      expect(used).toBeGreaterThanOrEqual(0.4); // 2 vCPUs × ≥ 0.2 s
      expect(used).toBeLessThan(60);
      // Read as the governor reads Sandbox CPU: × the sandbox_cpu calibration factor.
      await setCal({ sandbox_cpu: 0.5 });
      expect(await freshCpuUsed(deps)).toBeCloseTo(used * 0.5, 5);
      await setCal(savedCal ?? {});

      // Not enough left for a whole batch: new fresh mail, the 15-minute gap passed, still no batch.
      await pool.query("SELECT add_usage(current_date, $1, $2::numeric)", [FRESH_CPU_RESOURCE, FRESH_CPU_S_PER_30_DAYS - FRESH_BATCH_MAX_CPU_S - used + 1]);
      await email(u.userId, u.active, { hoursAgo: 0 });
      await owner.query("UPDATE render_request SET requested_at = now() - interval '20 minutes' WHERE user_id = $1", [u.userId]);
      const users = [{ user_id: u.userId, role: "owner" as const, mailboxes: 1, last_active_at: new Date() }];
      const [r] = await freshRows(deps, users, Date.now());
      expect(r!.candidates).toBe(1);
      expect(r!.fresh_cpu_s_30d).toBeGreaterThan(FRESH_CPU_S_PER_30_DAYS - FRESH_BATCH_MAX_CPU_S);
      expect(freshDue(r!, Date.now())).toBe(false);
      expect(freshDue({ ...r!, fresh_cpu_s_30d: 0 }, Date.now())).toBe(true); // the allowance is what says no
      expect(await freshRenderDue(deps)).toBe(false);
      // A fresh batch planned before it ran out: the render step re-checks and takes no fresh mail.
      expect((await renderForUser(rendering, u.userId, fresh)).picked).toBe(0);
    } finally {
      await setCal(savedCal ?? {});
      await clear();
    }
  });

  it("no renderer set up: no fresh batch is ever asked for", async () => {
    const me = await setup("owner");
    await email(me.userId, me.active);
    expect(await freshRenderDue(deps)).toBe(true);
    expect(await freshRenderDue({ ...deps, renderer: null })).toBe(false);
  });

  it("friends, idle owners and a governor without fill get no fresh batch", async () => {
    const friend = await setup("friend");
    await email(friend.userId, friend.active);
    const idle = await setup("owner", FRESH_ACTIVE_MINUTES + 5);
    await email(idle.userId, idle.active);
    const users = [
      { user_id: friend.userId, role: "friend" as const, mailboxes: 1, last_active_at: new Date() },
      { user_id: idle.userId, role: "owner" as const, mailboxes: 1, last_active_at: new Date(Date.now() - (FRESH_ACTIVE_MINUTES + 5) * MIN) },
    ];
    expect(await freshRows(deps, users, Date.now())).toEqual([]);

    const me = await setup("owner");
    await email(me.userId, me.active);
    expect(await freshRenderDue(deps)).toBe(true);
    await owner.query("UPDATE app_setting SET value = $1::jsonb WHERE key = 'governor'", [JSON.stringify(governorFor({ [R.sandboxCpuS]: 10_080 }))]);
    expect(await freshRenderDue(deps)).toBe(false);
    await owner.query("UPDATE app_setting SET value = $1::jsonb WHERE key = 'governor'", [JSON.stringify({ level: 0, actions: { rendersNightlyOnly: true } })]);
    expect(await freshRenderDue(deps)).toBe(false);
  });

  it("the nightly fill leaves out mail of mailboxes that aren't active", async () => {
    const u = await setup("owner");
    const ok = await email(u.userId, u.active, { hoursAgo: 72, source: "template" });
    await email(u.userId, u.paused, { hoursAgo: 1 });
    const out = await renderForUser(deps, u.userId, { fillAllowed: true, samplesAllowed: true, aiSamplesAllowed: false });
    expect(out.picked).toBe(1);
    expect((await requests(u.userId)).map((x) => x.email_id)).toEqual([ok]);
  });
});
