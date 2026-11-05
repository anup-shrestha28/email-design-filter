/**
 * The nightly check of each user's newest emails (render-policy.ts NEWEST_PER_NIGHT,
 * NEWEST_CANDIDATE_SQL; 2026-11-06): so new gallery mail gets its Good / Okay / Bad within a night
 * or so, even while the governor has the other planned renders off.
 *  - the nightly plan gives every user with a mailbox the check, friends whatever their batching
 *    rule says, through L1 (fill off) and L2 (planned renders off: a friend's batch then takes none
 *    of their queued requests); none at L3, with the Sandbox's own allowance tight, or on the
 *    on-demand trigger;
 *  - the render step re-applies it;
 *  - the batch takes at most NEWEST_PER_NIGHT of the user's newest unchecked gallery emails, right
 *    after its queued requests: never checked ones, other mail types, ones a render found nothing in,
 *    ones whose last render failed, disconnected mailboxes or another user's; a deferred fill of one
 *    comes along as it is; a fresh batch never takes them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  calendarMonthStart,
  computeGovernor,
  FREE_TIER_PROFILE,
  RESOURCES as R,
} from "@edf/budget";
import { CHECKLIST_VERSION } from "@edf/design/checklist";
import { createPool, type pg, withUser } from "@edf/db";
import type { PipelineDeps } from "../src/deps";
import { renderForUser, workKinds, type RenderOptions } from "../src/render";
import { gateRenderOptions, planFrom, type RenderGovernor } from "../src/render-plan";
import { NEWEST_PER_NIGHT } from "../src/render-policy";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

const NOW = new Date("2026-11-06T04:30:00Z");

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

const users = [
  { user_id: "owner", role: "owner" as const, mailboxes: 1 },
  { user_id: "f1", role: "friend" as const, mailboxes: 1 },
  { user_id: "f2", role: "friend" as const, mailboxes: 0 },
];
const nightly = (gov: RenderGovernor, due: Parameters<typeof planFrom>[0]["due"] = []) =>
  planFrom({ trigger: "nightly", gov, aiPaused: false, due, users, now: NOW.getTime() });
const summary = (p: ReturnType<typeof nightly>) =>
  p.map((x) => ({
    user: x.userId,
    newest: x.options.newestLimit ?? 0,
    only: x.options.newestOnly === true,
    fill: x.options.fillAllowed,
    kinds: workKinds(x.options),
  }));

describe("the nightly plan", () => {
  it("L0: everyone with a mailbox gets the check, friends without meeting their batching rule", () => {
    expect(summary(nightly(governorFor({})))).toEqual([
      {
        user: "owner",
        newest: NEWEST_PER_NIGHT,
        only: false,
        fill: true,
        kinds: ["on_demand", "exemplar", "fill"],
      },
      { user: "f1", newest: NEWEST_PER_NIGHT, only: false, fill: false, kinds: ["on_demand"] },
    ]);
    // A friend who meets the rule gets their full batch, check included.
    const due = [{ user_id: "f1", queued_count: "12", on_demand_count: "0", oldest_at: NOW }];
    expect(summary(nightly(governorFor({}), due))[1]).toMatchObject({
      newest: NEWEST_PER_NIGHT,
      fill: true,
    });
  });

  it("L1 (fill off) and L2 (planned renders off): still checked; a friend's L2 batch takes nothing queued", () => {
    const l1 = governorFor({}, 50);
    expect(l1.level).toBe(1);
    expect(summary(nightly(l1)).map((x) => [x.user, x.newest, x.fill])).toEqual([
      ["owner", NEWEST_PER_NIGHT, false],
      ["f1", NEWEST_PER_NIGHT, false],
    ]);
    const l2 = governorFor({}, 60);
    expect(l2.level).toBe(2);
    expect(summary(nightly(l2))).toEqual([
      { user: "owner", newest: NEWEST_PER_NIGHT, only: false, fill: false, kinds: ["on_demand"] },
      { user: "f1", newest: NEWEST_PER_NIGHT, only: true, fill: false, kinds: [] },
    ]);
  });

  it("none at L3, with the Sandbox's allowance tight, or on the on-demand trigger", () => {
    expect(nightly(governorFor({}, 80))).toEqual([]);
    for (const gov of [
      governorFor({ [R.sandboxCpuS]: 9_900 }),
      governorFor({ [R.sandboxCpuS]: 12_600 }),
    ])
      expect(nightly(gov).some((x) => (x.options.newestLimit ?? 0) > 0)).toBe(false);
    // Sandbox self-cap: the owner's on-demand still has its VM, friends get nothing.
    const due = [{ user_id: "owner", queued_count: "1", on_demand_count: "1", oldest_at: NOW }];
    expect(summary(nightly(governorFor({ [R.sandboxCpuS]: 12_600 }), due))).toEqual([
      { user: "owner", newest: 0, only: false, fill: false, kinds: ["on_demand"] },
    ]);
    const onDemand = planFrom({
      trigger: "on_demand",
      gov: governorFor({}),
      aiPaused: false,
      due,
      users,
      now: NOW.getTime(),
    });
    expect(onDemand.some((x) => (x.options.newestLimit ?? 0) > 0)).toBe(false);
  });

  it("the render step re-applies it with the governor read then", () => {
    const opts: RenderOptions = {
      fillAllowed: false,
      samplesAllowed: false,
      aiSamplesAllowed: false,
      onDemandOnly: true,
      newestLimit: NEWEST_PER_NIGHT,
    };
    // L2 since the plan: a friend keeps only the check.
    const friendL2 = gateRenderOptions(governorFor({}, 60), "friend", opts)!;
    expect([friendL2.newestLimit, friendL2.newestOnly, workKinds(friendL2)]).toEqual([
      NEWEST_PER_NIGHT,
      true,
      [],
    ]);
    // L3, or the Sandbox tight: no check (a friend at L2 then has no VM at all).
    expect(gateRenderOptions(governorFor({}, 80), "owner", opts)).toBeNull();
    expect(
      gateRenderOptions(governorFor({ [R.sandboxCpuS]: 9_900 }), "owner", opts)?.newestLimit,
    ).toBe(0);
    expect(gateRenderOptions(governorFor({ [R.sandboxCpuS]: 12_600 }), "friend", opts)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the newest check against the database", () => {
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
      // Never reached: the Gmail refetch fails first, leaving the picked requests as picked.
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

  async function setup(role: "owner" | "friend") {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'T', $2, true)`,
      [userId, `${userId}@example.com`],
    );
    return withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, $2)", [userId, role]);
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
    u: { userId: string; active: string },
    over: {
      hoursAgo: number;
      type?: string;
      subtype?: string | null;
      source?: string;
      score?: number | null;
      checklist?: string;
      mailbox?: string;
    },
  ): Promise<string> {
    return withUser(pool, u.userId, async (_db, c) => {
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                              primary_type, subtype, type_source, search_tsv, design_status, design_source, design_score)
           VALUES ($1, $2, $3, 100, now() - make_interval(hours => $4::int), 'Hello', true, $5, $6, 'rule',
                   to_tsvector('simple', 'hello'), 'done', $7, $8) RETURNING id`,
          [
            u.userId,
            over.mailbox ?? u.active,
            randomUUID().replaceAll("-", "").slice(0, 16),
            over.hoursAgo,
            over.type ?? "promotional",
            over.subtype ?? null,
            over.source ?? "static",
            over.score ?? null,
          ],
        )
      ).rows[0]!.id;
      if (over.checklist)
        await c.query(
          `INSERT INTO email_analysis (email_id, user_id, scoring_version, checks, pillar_scores, confidence, score_summary)
           VALUES ($1, $2, 'test', '[]', '[]', 0.9, jsonb_build_object('checklist', jsonb_build_object('v', $3::text)))`,
          [id, u.userId, over.checklist],
        );
      return id;
    });
  }

  const requests = (userId: string) =>
    withUser(
      pool,
      userId,
      async (_db, c) =>
        (
          await c.query<{ email_id: string; kind: string; state: string }>(
            "SELECT email_id, kind, state FROM render_request WHERE user_id = $1",
            [userId],
          )
        ).rows,
    );

  it("takes the newest unchecked gallery emails, at most the night's number, and nothing else", async () => {
    const u = await setup("friend");
    // Twelve unchecked promotions, an hour apart: the ten newest are taken.
    const promos: string[] = [];
    for (let i = 0; i < 12; i++) promos.push(await email(u, { hoursAgo: 1 + i }));
    // Never taken: already checked, another mail type, a lifecycle email that isn't a welcome,
    // nothing to measure in its own render, a disconnected mailbox, a failed last render.
    await email(u, { hoursAgo: 0, checklist: CHECKLIST_VERSION });
    await email(u, { hoursAgo: 0, type: "notification" });
    await email(u, { hoursAgo: 0, type: "lifecycle", subtype: "trial_ending" });
    await email(u, { hoursAgo: 0, source: "render", score: null });
    await email(u, { hoursAgo: 0, mailbox: u.paused });
    const failed = await email(u, { hoursAgo: 0 });
    // Taken: a welcome email, one scored before the checklist (an older version), a deferred fill.
    const welcome = await email(u, { hoursAgo: 0, type: "lifecycle", subtype: "welcome" });
    const older = await email(u, {
      hoursAgo: 0,
      source: "render",
      score: 70,
      checklist: "designmodo-2026.10",
    });
    await withUser(pool, u.userId, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind, state) VALUES ($1, $2, 'fill', 'failed'), ($1, $3, 'fill', 'queued')`,
        [u.userId, failed, promos[0]],
      ),
    );
    // A friend at L2 (planned renders off): only the check, nothing queued of theirs.
    const opts = gateRenderOptions(governorFor({}, 60), "friend", {
      fillAllowed: false,
      samplesAllowed: false,
      aiSamplesAllowed: false,
      onDemandOnly: true,
      newestLimit: NEWEST_PER_NIGHT,
    })!;
    await owner.query(
      `UPDATE app_setting SET value = '{"level":2,"actions":{"plannedRendersOff":true,"fillRendersOff":true}}' WHERE key = 'governor'`,
    );
    const out = await renderForUser(deps, u.userId, opts);
    expect(out.picked).toBe(NEWEST_PER_NIGHT);
    const picked = (await requests(u.userId))
      .filter((r) => r.state !== "failed")
      .map((r) => r.email_id);
    // welcome and older are newest (0 h), then the eight newest promotions (the deferred fill of
    // promos[0] among them, as it was).
    expect(picked.sort()).toEqual([welcome, older, ...promos.slice(0, 8)].sort());
    expect((await requests(u.userId)).filter((r) => r.email_id === promos[0])).toHaveLength(1);
  });

  it("a friend's queued on-demand request waits at L2; the owner's comes first at L0", async () => {
    const f = await setup("friend");
    const asked = await email(f, { hoursAgo: 30 });
    const fresh = await email(f, { hoursAgo: 1 });
    await withUser(pool, f.userId, (_db, c) =>
      c.query("INSERT INTO render_request (user_id, email_id, kind) VALUES ($1, $2, 'on_demand')", [
        f.userId,
        asked,
      ]),
    );
    await owner.query(
      `UPDATE app_setting SET value = '{"level":2,"actions":{"plannedRendersOff":true,"fillRendersOff":true}}' WHERE key = 'governor'`,
    );
    const friendOpts = gateRenderOptions(governorFor({}, 60), "friend", {
      fillAllowed: false,
      samplesAllowed: false,
      aiSamplesAllowed: false,
      onDemandOnly: true,
      newestLimit: NEWEST_PER_NIGHT,
    })!;
    expect((await renderForUser(deps, f.userId, friendOpts)).picked).toBe(1);
    const fr = await requests(f.userId);
    expect(fr.find((r) => r.email_id === asked)).toMatchObject({
      kind: "on_demand",
      state: "queued",
    });
    expect(fr.find((r) => r.email_id === fresh)).toMatchObject({ kind: "fill" });

    const o = await setup("owner");
    const ownAsk = await email(o, { hoursAgo: 30 });
    await email(o, { hoursAgo: 1 });
    await withUser(pool, o.userId, (_db, c) =>
      c.query("INSERT INTO render_request (user_id, email_id, kind) VALUES ($1, $2, 'on_demand')", [
        o.userId,
        ownAsk,
      ]),
    );
    await owner.query(
      `UPDATE app_setting SET value = '{"level":0,"actions":{}}' WHERE key = 'governor'`,
    );
    const out = await renderForUser(deps, o.userId, {
      fillAllowed: false,
      samplesAllowed: false,
      aiSamplesAllowed: false,
      newestLimit: NEWEST_PER_NIGHT,
    });
    expect(out.picked).toBe(2);
  });

  it("a fresh batch never takes them", async () => {
    const u = await setup("owner");
    await email(u, { hoursAgo: 100 });
    const out = await renderForUser(deps, u.userId, {
      fresh: true,
      fillAllowed: true,
      samplesAllowed: false,
      aiSamplesAllowed: false,
      newestLimit: NEWEST_PER_NIGHT,
    });
    expect(out.picked).toBe(0);
  });
});
