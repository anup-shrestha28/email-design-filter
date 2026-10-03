/**
 * What the render step hands the renderer and the Analyze button: the job carries the stored sender
 * facts the renderer needs to find the footer and logo (RenderJob.context, DESIGN-SCORE §2.1), and
 * on-demand renders report "paused" exactly when the governor stops them (FREE-TIER.md §8.2–8.3):
 * a friend's at L2 / the Sandbox self-cap, everyone's at L3 / static-only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import type { RenderJob } from "@edf/design";
import { calendarMonthStart, computeGovernor, FREE_TIER_PROFILE, RESOURCES as R } from "@edf/budget";
import { renderForUser, type RenderOptions } from "../src/render";
import { gateRenderOptions, onDemandPausedReason, renderGovernorOf, type RenderGovernor } from "../src/render-plan";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB } from "./env";

const NOW = new Date("2026-09-20T12:00:00Z");
const full: RenderOptions = { fillAllowed: true, samplesAllowed: true, aiSamplesAllowed: true, aiRealtimeAllowed: true };

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

describe("on-demand renders paused by the governor", () => {
  it("runs for everyone below the caps", () => {
    const gov = governorFor({});
    expect(onDemandPausedReason(gov, "owner")).toBeNull();
    expect(onDemandPausedReason(gov, "friend")).toBeNull();
    expect(onDemandPausedReason(renderGovernorOf(undefined), "friend")).toBeNull();
  });

  it("pauses only friends at the Sandbox self-cap and at L2", () => {
    for (const gov of [governorFor({ [R.sandboxCpuS]: 13_000 }), governorFor({}, 60)]) {
      expect(gov.actions.plannedRendersOff).toBe(true);
      expect(onDemandPausedReason(gov, "owner")).toBeNull();
      expect(onDemandPausedReason(gov, "friend")).toMatch(/renders for friends are paused/);
    }
  });

  it("pauses everyone at the Sandbox static-only stage and at L3", () => {
    for (const gov of [governorFor({ [R.sandboxCpuS]: 16_200 }), governorFor({}, 80)]) {
      expect(onDemandPausedReason(gov, "owner")).toMatch(/paused for everyone/);
      expect(onDemandPausedReason(gov, "friend")).toMatch(/paused for everyone/);
    }
  });

  it("says paused exactly when the render step would refuse the on-demand VM", () => {
    const sandbox: Array<Record<string, number>> = [{}, { [R.sandboxCpuS]: 10_080 }, { [R.sandboxCpuS]: 13_000 }, { [R.sandboxCpuS]: 16_200 }];
    const govs = sandbox.map((r) => governorFor(r));
    govs.push(governorFor({}, 50), governorFor({}, 60), governorFor({}, 80));
    for (const gov of govs) {
      for (const role of ["owner", "friend"] as const) {
        const refused = gateRenderOptions(gov, role, { ...full, onDemandOnly: true }) === null;
        expect(onDemandPausedReason(gov, role) !== null).toBe(refused);
      }
    }
  });
});

describe.skipIf(!HAS_DB)("the render job carries the renderer context", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  const HTML = `<html><body><img src="cid:logo" alt="Northwind"><p>Autumn sale</p><a href="https://northwind.example/sale">Shop</a>` +
    `<p><a href="https://northwind.example/u/abc">Manage preferences</a></p></body></html>`;
  const RAW = new TextEncoder().encode(
    [
      "From: Northwind <hello@northwind.example>",
      "To: someone@gmail.example",
      "Subject: Autumn sale",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      HTML,
      "",
    ].join("\r\n"),
  );

  it("passes the sender's https List-Unsubscribe URLs, domain and the email's language", async () => {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'owner')", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      const s = await c.query<{ id: string }>(
        `INSERT INTO sender (user_id, address, domain, first_seen_at, last_seen_at, list_unsubscribe)
         VALUES ($1, 'hello@northwind.example', 'northwind.example', now(), now(), $2::jsonb) RETURNING id`,
        [userId, JSON.stringify({ https: ["https://northwind.example/u/abc"], mailto: ["mailto:u@northwind.example"] })],
      );
      const e = await c.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, sender_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, language, search_tsv)
         VALUES ($1, $2, $3, $4, 100, now(), 'Autumn sale', true, 'promotional', 'pending', 'de', to_tsvector('simple', 'autumn')) RETURNING id`,
        [userId, m.rows[0]!.id, s.rows[0]!.id, randomUUID().replaceAll("-", "").slice(0, 16)],
      );
      await c.query("INSERT INTO render_request (user_id, email_id, kind) VALUES ($1, $2, 'on_demand')", [userId, e.rows[0]!.id]);
    });

    const jobs: RenderJob[] = [];
    const deps = {
      pool,
      tokens: {} as PipelineDeps["tokens"],
      tickEvery: 60,
      governorLevel: async () => 0,
      rawSourceFor: () => async () => RAW,
      renderer: {
        host: "test",
        renderBatch: async (batch: RenderJob[]) => {
          jobs.push(...batch);
          return [];
        },
      },
    } as unknown as PipelineDeps;

    const r = await renderForUser(deps, userId, { ...full, onDemandOnly: true });
    expect(r).toMatchObject({ picked: 1, skipped: null });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.context).toEqual({
      listUnsubscribeHttps: ["https://northwind.example/u/abc"],
      senderDomain: "northwind.example",
      language: "de",
    });
  });

  it("an on-demand request deferred for the time budget goes back to the queue without spending an attempt", async () => {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const requests = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'owner')", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      const ids: string[] = [];
      for (const minutesAgo of [2, 1]) {
        const e = await c.query<{ id: string }>(
          `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                              primary_type, type_source, search_tsv)
           VALUES ($1, $2, $3, 100, now(), 'Autumn sale', true, 'promotional', 'rule', to_tsvector('simple', 'autumn')) RETURNING id`,
          [userId, m.rows[0]!.id, randomUUID().replaceAll("-", "").slice(0, 16)],
        );
        const r = await c.query<{ id: string }>(
          `INSERT INTO render_request (user_id, email_id, kind, requested_at) VALUES ($1, $2, 'on_demand', now() - make_interval(mins => $3)) RETURNING id`,
          [userId, e.rows[0]!.id, minutesAgo],
        );
        ids.push(r.rows[0]!.id);
      }
      return ids;
    });

    const jobs: RenderJob[] = [];
    const deps = {
      pool,
      tokens: {} as PipelineDeps["tokens"],
      tickEvery: 60,
      governorLevel: async () => 0,
      rawSourceFor: () => async () => RAW,
      renderer: {
        host: "test",
        renderBatch: async (batch: RenderJob[]) => {
          jobs.push(...batch);
          return [];
        },
      },
    } as unknown as PipelineDeps;

    // A 48 s budget leaves room for one email's estimate (9 s + 30 s margin): the second is deferred.
    const r = await renderForUser(deps, userId, { ...full, onDemandOnly: true, budgetMs: 48_000 });
    expect(r).toMatchObject({ picked: 2 });
    expect(jobs).toHaveLength(1);
    const rows = await withUser(pool, userId, async (_db, c) =>
      (await c.query<{ id: string; state: string; attempts: number; error: string | null }>(
        "SELECT id, state, attempts, error FROM render_request WHERE id = ANY($1::uuid[])",
        [requests],
      )).rows,
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    // The first was attempted (the fake renderer returned nothing); the second never ran.
    expect(byId.get(requests[0]!)).toMatchObject({ state: "failed", attempts: 1, error: "no_output" });
    expect(byId.get(requests[1]!)).toMatchObject({ state: "queued", attempts: 0, error: "deferred" });
  });

  it("a request deferred after its Gmail fetch goes back to the queue but keeps the attempt, and fails after 3", async () => {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const requestId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, 'owner')", [userId]);
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      );
      const e = await c.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, search_tsv)
         VALUES ($1, $2, $3, 100, now(), 'Autumn sale', true, 'promotional', 'rule', to_tsvector('simple', 'autumn')) RETURNING id`,
        [userId, m.rows[0]!.id, randomUUID().replaceAll("-", "").slice(0, 16)],
      );
      const r = await c.query<{ id: string }>(
        "INSERT INTO render_request (user_id, email_id, kind) VALUES ($1, $2, 'on_demand') RETURNING id",
        [userId, e.rows[0]!.id],
      );
      return r.rows[0]!.id;
    });

    const jobs: RenderJob[] = [];
    const deps = {
      pool,
      tokens: {} as PipelineDeps["tokens"],
      tickEvery: 60,
      governorLevel: async () => 0,
      // A slow Gmail fetch: with a 40 s budget the second deadline check (after the fetch) trips.
      rawSourceFor: () => async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return RAW;
      },
      renderer: {
        host: "test",
        renderBatch: async (batch: RenderJob[]) => {
          jobs.push(...batch);
          return [];
        },
      },
    } as unknown as PipelineDeps;
    const state = async () =>
      withUser(pool, userId, async (_db, c) =>
        (await c.query<{ state: string; attempts: number; error: string | null }>(
          "SELECT state, attempts, error FROM render_request WHERE id = $1",
          [requestId],
        )).rows[0],
      );

    await renderForUser(deps, userId, { ...full, onDemandOnly: true, budgetMs: 40_000 });
    expect(jobs).toHaveLength(0);
    expect(await state()).toMatchObject({ state: "queued", attempts: 1, error: "deferred_after_fetch" });

    await withUser(pool, userId, (_db, c) => c.query("UPDATE render_request SET attempts = 2 WHERE id = $1", [requestId]));
    await renderForUser(deps, userId, { ...full, onDemandOnly: true, budgetMs: 40_000 });
    expect(jobs).toHaveLength(0);
    expect(await state()).toMatchObject({ state: "failed", attempts: 3, error: "deferred_after_fetch" });
  });
});
