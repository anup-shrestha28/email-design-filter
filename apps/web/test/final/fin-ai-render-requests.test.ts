/**
 * requestAnalyze and the render queue:
 *  - a click on a request a render is working on right now (running, not stale) leaves it alone:
 *    no want_ai / requested_at written onto it, so the running render (which chose no AI) doesn't
 *    use up today's AI allowance for a review that never runs (b5 verify #2);
 *  - a reaped fill (queued, error 'interrupted') the user then asks for becomes today's on-demand
 *    request without the error, so it counts toward the day's limit (C1-02);
 *  - while renders are nightly-only (Inngest soft cap, FREE-TIER.md §8.3) the request is queued
 *    but no render/requested event is sent (R1-19).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withUser } from "@edf/db";
import type { getPool as getAppPool } from "@/server/db";
import type { SessionUser } from "@/server/session";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";

const state = vi.hoisted(() => ({ user: null as SessionUser | null, sent: 0 }));
vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => state.user,
}));
vi.mock("@/server/pipeline-client", () => ({
  requestRender: async () => {
    state.sent++;
    return true;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

describe.skipIf(!HAS_DB)("requestAnalyze and the render queue", () => {
  const pool = appPool();
  const owner = ownerPool();
  let savedGovernor: unknown = null;
  let savedKill: unknown = null;
  let appPoolOf: typeof getAppPool | null = null;
  const setSetting = (key: string, value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  const requestRow = (userId: string, emailId: string) =>
    withUser(pool, userId, async (_db, c) =>
      (await c.query<{ kind: string; state: string; want_ai: boolean; error: string | null; today: boolean; requested_at: Date }>(
        `SELECT kind, state, want_ai, error, requested_at, requested_at >= date_trunc('day', now()) AS today
         FROM render_request WHERE email_id = $1 AND state IN ('queued', 'running')`,
        [emailId],
      )).rows[0],
    );

  beforeAll(async () => {
    appPoolOf = (await import("@/server/db")).getPool;
    savedGovernor = (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ?? null;
    savedKill = (await owner.query("SELECT value FROM app_setting WHERE key = 'kill.render'")).rows[0]?.value ?? null;
    await setSetting("kill.render", false);
  });
  beforeEach(async () => {
    state.sent = 0;
    await setSetting("governor", { level: 0 });
  });
  afterAll(async () => {
    await setSetting("governor", savedGovernor ?? { level: 0 });
    await setSetting("kill.render", savedKill ?? false);
    await pool.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  async function friendWithEmail() {
    const u = await createUser(pool, { role: "friend" });
    state.user = { userId: u.id, role: "friend" } as SessionUser;
    const mailboxId = await createMailbox(pool, u.id);
    const emailId = await seedEmail(pool, u.id, mailboxId);
    return { userId: u.id, emailId };
  }

  it("an AI review clicked on a running render (from a stale page) leaves the running row alone", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { userId, emailId } = await friendWithEmail();
    // A fill render picked this email two minutes ago (without AI) and is still running.
    await withUser(pool, userId, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind, state, want_ai, requested_at, updated_at)
         VALUES ($1, $2, 'fill', 'running', false, now() - interval '3 days', now() - interval '2 minutes')`,
        [userId, emailId],
      ),
    );
    const r = await requestAnalyze(emailId, true);
    expect(r).toMatchObject({ ok: true, data: { status: "queued" } });
    expect(await requestRow(userId, emailId)).toMatchObject({ kind: "fill", state: "running", want_ai: false, today: false });

    // A stale 'running' row (the render step was killed) is still requeued and upgraded.
    await withUser(pool, userId, (_db, c) =>
      c.query("UPDATE render_request SET updated_at = now() - interval '1 hour' WHERE email_id = $1", [emailId]),
    );
    await requestAnalyze(emailId, true);
    expect(await requestRow(userId, emailId)).toMatchObject({ kind: "on_demand", state: "queued", want_ai: true, today: true });
  });

  it("a reaped fill the user asks for counts toward today's limit (the 'interrupted' error is cleared)", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { userId, emailId } = await friendWithEmail();
    await withUser(pool, userId, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind, state, want_ai, error) VALUES ($1, $2, 'fill', 'queued', false, 'interrupted')`,
        [userId, emailId],
      ),
    );
    await requestAnalyze(emailId, false);
    expect(await requestRow(userId, emailId)).toMatchObject({ kind: "on_demand", state: "queued", error: null, today: true });
    // A friend's one render today is now used.
    const mailboxId = await createMailbox(pool, userId);
    const other = await seedEmail(pool, userId, mailboxId, { providerMessageId: "m-other-fin-ai" });
    expect(await requestAnalyze(other, false)).toMatchObject({ ok: false, code: "limit" });
  });

  it("while renders are nightly-only the request is queued but no render/requested event is sent", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { userId, emailId } = await friendWithEmail();
    await setSetting("governor", { level: 0, actions: { rendersNightlyOnly: true } });
    expect(await requestAnalyze(emailId, false)).toMatchObject({ ok: true, data: { status: "queued" } });
    expect(await requestRow(userId, emailId)).toMatchObject({ kind: "on_demand", state: "queued" });
    expect(state.sent).toBe(0);

    await setSetting("governor", { level: 0 });
    const { emailId: e2 } = await friendWithEmail();
    await requestAnalyze(e2, false);
    expect(state.sent).toBe(1);
  });
});
