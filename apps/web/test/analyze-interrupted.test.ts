/**
 * "Analyze" on an email whose render request a killed render step left 'running' (FREE-TIER.md
 * §5.1): the click puts that request back in the queue instead of leaving it stuck, and a request
 * the step interrupted doesn't use up the day's allowance (friends get one a day). The allowance
 * holds against parallel clicks and against upgrading an older queued request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser } from "@edf/db";
import type { getPool as getAppPool } from "@/server/db";
import type { SessionUser } from "@/server/session";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "./support/db";

const state = vi.hoisted(() => ({ user: null as SessionUser | null, renders: [] as string[] }));
vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => state.user,
}));
vi.mock("@/server/pipeline-client", () => ({
  requestRender: async (userId: string) => {
    state.renders.push(userId);
    return true;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

describe.skipIf(!HAS_DB)("Analyze after a render step was killed", () => {
  const pool = appPool();
  const owner = ownerPool();
  let savedGovernor: unknown = null;
  let appPoolOf: typeof getAppPool | null = null;

  const setGovernor = (value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  beforeAll(async () => {
    appPoolOf = (await import("@/server/db")).getPool;
    savedGovernor = (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ?? null;
    await setGovernor({ level: 0 });
  });
  afterEach(() => {
    state.renders.length = 0;
  });
  afterAll(async () => {
    await setGovernor(savedGovernor ?? { level: 0 });
    await pool.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  it("puts a request left 'running' back in the queue, and an interrupted request doesn't use up the day", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { getEmailDetail } = await import("@/server/queries/email");
    const u = await createUser(pool, { role: "friend" });
    const mailboxId = await createMailbox(pool, u.id);
    const stuckEmail = await seedEmail(pool, u.id, mailboxId);
    const interruptedEmail = await seedEmail(pool, u.id, mailboxId, { providerMessageId: "m-interrupted" });
    state.user = { userId: u.id, email: u.email, name: u.name, image: null, sessionId: "s", sessionCreatedAt: new Date(), role: "friend" };

    // A sample render picked 1 hour ago by a step that was then killed: never picked again.
    const stuck = await withUser(pool, u.id, async (_db, c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO render_request (user_id, email_id, kind, state, attempts, updated_at)
         VALUES ($1, $2, 'exemplar', 'running', 1, now() - interval '1 hour') RETURNING id`,
        [u.id, stuckEmail],
      )).rows[0]!.id,
    );
    // Today's on-demand request, which the nightly reaper failed as interrupted.
    await withUser(pool, u.id, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind, state, attempts, error, want_ai)
         VALUES ($1, $2, 'on_demand', 'failed', 1, 'interrupted', true)`,
        [u.id, interruptedEmail],
      ),
    );
    const before = await getEmailDetail(u.id, interruptedEmail, "friend");
    expect(before?.actions).toMatchObject({ analyzeRemainingToday: 1, aiReviewRemainingToday: 1 });

    expect(await requestAnalyze(stuckEmail)).toEqual({ ok: true, data: { status: "queued" } });
    expect(state.renders).toEqual([u.id]);
    const rows = await withUser(pool, u.id, async (_db, c) =>
      (await c.query<{ id: string; state: string; kind: string }>(
        "SELECT id, state, kind FROM render_request WHERE email_id = $1 AND state IN ('queued', 'running')",
        [stuckEmail],
      )).rows,
    );
    expect(rows).toEqual([{ id: stuck, state: "queued", kind: "on_demand" }]);

    // That click was the friend's one render for today: the next one is refused.
    expect(await requestAnalyze(interruptedEmail)).toMatchObject({ ok: false });
  });

  const asFriend = async () => {
    const u = await createUser(pool, { role: "friend" });
    const mailboxId = await createMailbox(pool, u.id);
    state.user = { userId: u.id, email: u.email, name: u.name, image: null, sessionId: "s", sessionCreatedAt: new Date(), role: "friend" };
    return { u, mailboxId };
  };
  const activeOnDemand = (userId: string) =>
    withUser(pool, userId, async (_db, c) =>
      Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM render_request WHERE kind = 'on_demand'")).rows[0]!.n),
    );

  it("parallel requests for different emails can't get past a friend's one render a day", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { u, mailboxId } = await asFriend();
    const emails: string[] = [];
    for (let i = 0; i < 5; i++) emails.push(await seedEmail(pool, u.id, mailboxId, { providerMessageId: `m-par-${i}` }));
    // Make the race certain: hold inserts into render_request (plain reads still pass) until all
    // five requests are waiting on a lock, so without serialization each counts zero first.
    const blocker = await owner.connect();
    let pending: Promise<Awaited<ReturnType<typeof requestAnalyze>>[]>;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE render_request IN EXCLUSIVE MODE");
      pending = Promise.all(emails.map((id) => requestAnalyze(id, true)));
      const waiting = async () =>
        Number((await owner.query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        )).rows[0]!.n);
      for (let i = 0; i < 200 && (await waiting()) < emails.length; i++) await new Promise((r) => setTimeout(r, 50));
      expect(await waiting()).toBe(emails.length);
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    const results = await pending;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(4);
    expect(await activeOnDemand(u.id)).toBe(1);
  });

  it("turning an older queued request into an AI review counts it today", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { getEmailDetail } = await import("@/server/queries/email");
    // A template sample queued before midnight (UTC), and a fill a killed step re-queued as
    // 'interrupted': neither counted toward today until this click made it an on-demand review.
    for (const old of [
      { kind: "exemplar", requestedAt: "date_trunc('day', now()) - interval '1 hour'", error: null },
      { kind: "fill", requestedAt: "now()", error: "interrupted" },
    ]) {
      const { u, mailboxId } = await asFriend();
      const sample = await seedEmail(pool, u.id, mailboxId, { providerMessageId: "m-sample" });
      const other = await seedEmail(pool, u.id, mailboxId, { providerMessageId: "m-other" });
      await withUser(pool, u.id, (_db, c) =>
        c.query(
          `INSERT INTO render_request (user_id, email_id, kind, state, requested_at, error)
           VALUES ($1, $2, $3, 'queued', ${old.requestedAt}, $4)`,
          [u.id, sample, old.kind, old.error],
        ),
      );
      expect(await requestAnalyze(sample, true)).toEqual({ ok: true, data: { status: "queued" } });
      const detail = await getEmailDetail(u.id, other, "friend");
      expect(detail?.actions, old.kind).toMatchObject({ analyzeRemainingToday: 0, aiReviewRemainingToday: 0 });
      expect(await requestAnalyze(other, true), old.kind).toMatchObject({ ok: false });
      expect(await activeOnDemand(u.id)).toBe(1);
    }
  });

  it("a repeat click on a request already counted doesn't re-date it", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const u = await createUser(pool, { role: "owner" });
    const emailId = await seedEmail(pool, u.id, await createMailbox(pool, u.id));
    state.user = { userId: u.id, email: u.email, name: u.name, image: null, sessionId: "s", sessionCreatedAt: new Date(), role: "owner" };
    const at = () =>
      withUser(pool, u.id, async (_db, c) =>
        (await c.query<{ at: Date }>("SELECT requested_at AS at FROM render_request WHERE email_id = $1", [emailId])).rows[0]!.at.getTime(),
      );
    expect(await requestAnalyze(emailId, true)).toEqual({ ok: true, data: { status: "queued" } });
    const first = await at();
    await new Promise((r) => setTimeout(r, 20));
    expect(await requestAnalyze(emailId, true)).toEqual({ ok: true, data: { status: "queued" } });
    expect(await at()).toBe(first);
  });

  it("leaves a request a live step is running alone", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const u = await createUser(pool, { role: "owner" });
    const emailId = await seedEmail(pool, u.id, await createMailbox(pool, u.id));
    state.user = { userId: u.id, email: u.email, name: u.name, image: null, sessionId: "s", sessionCreatedAt: new Date(), role: "owner" };
    await withUser(pool, u.id, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind, state, attempts, updated_at)
         VALUES ($1, $2, 'fill', 'running', 1, now() - interval '1 minute')`,
        [u.id, emailId],
      ),
    );
    expect(await requestAnalyze(emailId)).toEqual({ ok: true, data: { status: "queued" } });
    const st = await withUser(pool, u.id, async (_db, c) =>
      (await c.query<{ state: string }>("SELECT state FROM render_request WHERE email_id = $1", [emailId])).rows.map((r) => r.state),
    );
    expect(st).toEqual(["running"]);
  });
});
