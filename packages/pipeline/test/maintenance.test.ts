/**
 * Nightly upkeep that must not lose state (FREE-TIER.md §4.7, §5.1; DATA-MODEL.md §6):
 *  - orphan senders are removed, except those carrying the user's choices (mute, type override,
 *    importance bias, unsubscribe, feedback), which the next email from them must still find;
 *    the disconnect purge of the user's last mailbox still removes them (not while another
 *    mailbox remains, since senders are per user);
 *  - render requests a killed step left 'running' go back in the queue (or fail) instead of
 *    blocking their email for good, including a friend's, which planning reaps before it counts
 *    who is due;
 *  - the tick's render safety net fires only for queued on-demand requests a render run would take.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import type { RenderJob } from "@edf/design";
import { deleteOrphanSenders } from "../src/maintenance";
import { renderForUser } from "../src/render";
import { onDemandRenderDue, planRenders } from "../src/render-plan";
import { purgeMailbox } from "../src/purge";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

describe.skipIf(!HAS_DB)("nightly upkeep", () => {
  let pool: pg.Pool;
  let admin: pg.Pool; // RLS-exempt, for parking queue rows other test files left behind
  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 2 });
    admin = createPool({ connectionString: OWNER_URL, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  async function seedUser(role: "owner" | "friend" = "owner"): Promise<{ userId: string; mailboxId: string }> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    const mailboxId = await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, $2)", [userId, role]);
      return (await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}@gmail.example`],
      )).rows[0]!.id;
    });
    return { userId, mailboxId };
  }

  it("keeps orphan senders that carry the user's choices; the disconnect purge removes them", async () => {
    const { userId, mailboxId } = await seedUser();
    const senders = await withUser(pool, userId, async (_db, c) => {
      const add = async (name: string, cols = "", vals = "") =>
        (await c.query<{ id: string }>(
          `INSERT INTO sender (user_id, address, domain, first_seen_at, last_seen_at${cols})
           VALUES ($1, $2, 'example.org', now(), now()${vals}) RETURNING id`,
          [userId, `${name}@example.org`],
        )).rows[0]!.id;
      const s = {
        plain: await add("plain"),
        muted: await add("muted", ", muted", ", true"),
        override: await add("override", ", type_override", ", 'newsletter'"),
        personal: await add("personal", ", type_override", ", 'personal'"),
        bias: await add("bias", ", user_importance_bias", ", -2"),
        unsubscribed: await add("unsubscribed", ", unsubscribed_at", ", now()"),
        feedback: await add("feedback"),
        withMail: await add("withmail"),
      };
      await c.query(
        "INSERT INTO user_feedback (user_id, sender_id, field, old_value, new_value) VALUES ($1, $2, 'importance', 'normal', 'low')",
        [userId, s.feedback],
      );
      await c.query(
        `INSERT INTO email (user_id, mailbox_id, sender_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, search_tsv)
         VALUES ($1, $2, $3, 'm1', 100, now(), 'Hi', true, 'promotional', 'rule', to_tsvector('simple', 'hi'))`,
        [userId, mailboxId, s.withMail],
      );
      return s;
    });
    const remaining = () =>
      withUser(pool, userId, async (_db, c) =>
        (await c.query<{ id: string }>("SELECT id FROM sender WHERE user_id = $1", [userId])).rows.map((r) => r.id).sort(),
      );

    expect(await withUser(pool, userId, (_db, c) => deleteOrphanSenders(c, userId))).toBe(1);
    expect(await remaining()).toEqual(Object.values(senders).filter((id) => id !== senders.plain).sort());

    expect(await withUser(pool, userId, (_db, c) => deleteOrphanSenders(c, userId, { keepPreferences: false }))).toBe(5);
    expect(await remaining()).toEqual([senders.personal, senders.withMail].sort());
  });

  it("disconnecting one of two mailboxes keeps the user's choices; disconnecting the last removes them", async () => {
    const { userId, mailboxId: first } = await seedUser();
    const { muted, plain, second } = await withUser(pool, userId, async (_db, c) => {
      const m = await c.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
        [userId, randomUUID(), `${userId}-2@gmail.example`],
      );
      const add = async (name: string, isMuted: boolean) =>
        (await c.query<{ id: string }>(
          `INSERT INTO sender (user_id, address, domain, first_seen_at, last_seen_at, muted) VALUES ($1, $2, 'example.org', now(), now(), $3) RETURNING id`,
          [userId, `${name}@example.org`, isMuted],
        )).rows[0]!.id;
      return { second: m.rows[0]!.id, muted: await add("muted", true), plain: await add("plain", false) };
    });
    const remaining = async () =>
      withUser(pool, userId, async (_db, c) => (await c.query<{ id: string }>("SELECT id FROM sender WHERE user_id = $1", [userId])).rows.map((r) => r.id));
    const deps = { pool, tokens: {} as PipelineDeps["tokens"], tickEvery: 60, governorLevel: async () => 0 } as unknown as PipelineDeps;

    expect(await purgeMailbox(deps, { userId, mailboxId: first })).toBe(true);
    expect(await remaining()).toEqual([muted]); // the other mailbox may still get its mail

    expect(await purgeMailbox(deps, { userId, mailboxId: second })).toBe(true);
    expect(await remaining()).toEqual([]);
    expect(plain).toBeTruthy();
  });

  it("render requests left 'running' by a killed step are queued again (or failed) and no longer block the email", async () => {
    const { userId, mailboxId } = await seedUser();
    const ids = await withUser(pool, userId, async (_db, c) => {
      const email = async (n: string) =>
        (await c.query<{ id: string }>(
          `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                              primary_type, type_source, search_tsv)
           VALUES ($1, $2, $3, 100, now(), 'Sale', true, 'promotional', 'rule', to_tsvector('simple', 'sale')) RETURNING id`,
          [userId, mailboxId, n],
        )).rows[0]!.id;
      const request = async (emailId: string, kind: string, attempts: number, age: string) =>
        (await c.query<{ id: string }>(
          `INSERT INTO render_request (user_id, email_id, kind, state, attempts, updated_at)
           VALUES ($1, $2, $3, 'running', $4, now() - $5::interval) RETURNING id`,
          [userId, emailId, kind, attempts, age],
        )).rows[0]!.id;
      const sample = await email("m-sample");
      const onDemand = await email("m-ondemand");
      const exhausted = await email("m-exhausted");
      const live = await email("m-live");
      return {
        sample: await request(sample, "exemplar", 1, "1 hour"),
        onDemand: await request(onDemand, "on_demand", 1, "1 hour"),
        exhausted: await request(exhausted, "fill", 3, "1 hour"),
        live: await request(live, "exemplar", 1, "1 minute"), // a step still running
      };
    });

    const html = `<html><body><h1>Sale</h1><a href="https://shop.example/sale">Shop</a></body></html>`;
    const raw = new TextEncoder().encode(
      ["From: Shop <news@shop.example>", "To: someone@gmail.example", "Subject: Sale", "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8", "", html, ""].join("\r\n"),
    );
    const jobs: RenderJob[] = [];
    const deps = {
      pool,
      tokens: {} as PipelineDeps["tokens"],
      tickEvery: 60,
      governorLevel: async () => 0,
      rawSourceFor: () => async () => raw,
      renderer: {
        host: "test",
        renderBatch: async (batch: RenderJob[]) => {
          jobs.push(...batch);
          return [];
        },
      },
    } as unknown as PipelineDeps;
    const r = await renderForUser(deps, userId, { fillAllowed: false, samplesAllowed: true, aiSamplesAllowed: false, aiRealtimeAllowed: false });
    expect(r.picked).toBe(1); // the interrupted sample, picked again
    expect(jobs).toHaveLength(1);

    const states = await withUser(pool, userId, async (_db, c) =>
      Object.fromEntries(
        (await c.query<{ id: string; state: string; attempts: number }>("SELECT id, state, attempts FROM render_request WHERE user_id = $1", [userId]))
          .rows.map((x) => [x.id, { state: x.state, attempts: x.attempts }]),
      ),
    );
    expect(states[ids.sample]).toEqual({ state: "queued", attempts: 2 }); // picked (attempt 2), then re-queued: no renderer output
    expect(states[ids.onDemand]).toEqual({ state: "failed", attempts: 1 }); // the user can ask again
    expect(states[ids.exhausted]).toEqual({ state: "failed", attempts: 3 });
    expect(states[ids.live]).toEqual({ state: "running", attempts: 1 });
  });

  it("planning a render run first reaps a friend's stuck request, so it counts toward the friend being due", async () => {
    const friend = await seedUser("friend");
    const requestId = await withUser(pool, friend.userId, async (_db, c) => {
      const emailId = (await c.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                            primary_type, type_source, search_tsv)
         VALUES ($1, $2, 'm-stuck', 100, now(), 'Sale', true, 'promotional', 'rule', to_tsvector('simple', 'sale')) RETURNING id`,
        [friend.userId, friend.mailboxId],
      )).rows[0]!.id;
      // Asked for 3 days ago, then left 'running' by a killed step: the friend's only request.
      return (await c.query<{ id: string }>(
        `INSERT INTO render_request (user_id, email_id, kind, state, attempts, requested_at, updated_at)
         VALUES ($1, $2, 'exemplar', 'running', 1, now() - interval '3 days', now() - interval '1 hour') RETURNING id`,
        [friend.userId, emailId],
      )).rows[0]!.id;
    });
    // A renderer is set up (never reached here): without one nothing is planned or due.
    const deps = { pool, tokens: {} as PipelineDeps["tokens"], tickEvery: 60, governorLevel: async () => 0, renderer: { host: "test", renderBatch: async () => [] } } as unknown as PipelineDeps;
    try {
      const plan = await planRenders(deps, "nightly");
      expect(plan.map((p) => p.userId)).toContain(friend.userId); // oldest item ≥ 48 h
      const state = await withUser(pool, friend.userId, async (_db, c) =>
        (await c.query<{ state: string }>("SELECT state FROM render_request WHERE id = $1", [requestId])).rows[0]?.state,
      );
      expect(state).toBe("queued");
    } finally {
      await withUser(pool, friend.userId, (_db, c) => c.query("UPDATE render_request SET state = 'failed' WHERE user_id = $1", [friend.userId]));
    }
  });

  it("on-demand work is due for the tick's re-send only when a render run would take it", async () => {
    const owner = await seedUser("owner");
    const friend = await seedUser("friend");
    const request = (u: { userId: string; mailboxId: string }, kind: string) =>
      withUser(pool, u.userId, async (_db, c) => {
        const emailId = (await c.query<{ id: string }>(
          `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                              primary_type, type_source, search_tsv)
           VALUES ($1, $2, $3, 100, now(), 'Sale', true, 'promotional', 'rule', to_tsvector('simple', 'sale')) RETURNING id`,
          [u.userId, u.mailboxId, randomUUID()],
        )).rows[0]!.id;
        await c.query("INSERT INTO render_request (user_id, email_id, kind) VALUES ($1, $2, $3)", [u.userId, emailId, kind]);
      });
    const setGovernor = (value: unknown) => pool.query("UPDATE app_setting SET value = $1::jsonb WHERE key = 'governor'", [JSON.stringify(value)]);
    const before = (await pool.query<{ value: unknown }>("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value;
    // A renderer is set up (never reached here): without one nothing is planned or due.
    const deps = { pool, tokens: {} as PipelineDeps["tokens"], tickEvery: 60, governorLevel: async () => 0, renderer: { host: "test", renderBatch: async () => [] } } as unknown as PipelineDeps;
    // The render queue is global: requests other test files left queued (or 'running', which
    // planning reaps back to queued) would make work "due" before this test adds any.
    await admin.query("UPDATE render_request SET state = 'failed' WHERE state IN ('queued', 'running')");
    try {
      await request(owner, "exemplar");
      expect(await onDemandRenderDue(deps)).toBe(false); // planned work waits for the nightly run
      await request(friend, "on_demand");
      expect(await onDemandRenderDue(deps)).toBe(true);
      await setGovernor({ level: 2, actions: { plannedRendersOff: true } });
      expect(await onDemandRenderDue(deps)).toBe(false); // friends' renders are paused
      await request(owner, "on_demand");
      expect(await onDemandRenderDue(deps)).toBe(true);
      await setGovernor({ level: 0, actions: { rendersOff: true } });
      expect(await onDemandRenderDue(deps)).toBe(false); // static-only: no VM for anyone
      // No renderer set up (RENDERER=off, or no Sandbox snapshot): queued requests wait for one
      // instead of starting a render run on every tick, and a render run plans nobody.
      await setGovernor(before ?? {});
      expect(await onDemandRenderDue(deps)).toBe(true);
      expect(await onDemandRenderDue({ ...deps, renderer: null })).toBe(false);
      expect(await planRenders({ ...deps, renderer: null }, "on_demand")).toEqual([]);
      expect(await planRenders({ ...deps, renderer: null }, "nightly")).toEqual([]);
    } finally {
      await setGovernor(before ?? {});
      for (const u of [owner, friend]) {
        await withUser(pool, u.userId, (_db, c) => c.query("UPDATE render_request SET state = 'failed' WHERE user_id = $1", [u.userId]));
      }
    }
  });
});
