/**
 * R1-34: an AI review is an on-demand render too — requestAnalyze refuses it once the day's renders
 * are used, even with AI reviews left. The email page's "Run AI review" (canRunAiReview and its
 * "N left today") must agree, instead of staying enabled and then failing with "reached today's limit".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser } from "@edf/db";
import type { getPool as getAppPool } from "@/server/db";
import type { SessionUser } from "@/server/session";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";

const state = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => state.user,
}));
vi.mock("@/server/pipeline-client", () => ({ requestRender: async () => true }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

describe.skipIf(!HAS_DB)("the AI review allowance on the email page", () => {
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

  beforeAll(async () => {
    appPoolOf = (await import("@/server/db")).getPool;
    savedGovernor = (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ?? null;
    savedKill = (await owner.query("SELECT value FROM app_setting WHERE key = 'kill.render'")).rows[0]?.value ?? null;
    await setSetting("governor", { level: 0 });
    await setSetting("kill.render", false);
  });
  afterAll(async () => {
    await setSetting("governor", savedGovernor ?? { level: 0 });
    await setSetting("kill.render", savedKill ?? false);
    await pool.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  it("is off with 0 left once the day's on-demand renders are used, matching what the server allows", async () => {
    const { getEmailDetail } = await import("@/server/queries/email");
    const { requestAnalyze } = await import("@/server/actions/email");
    const u = await createUser(pool, { role: "friend" });
    state.user = { userId: u.id, role: "friend" } as SessionUser;
    const mailboxId = await createMailbox(pool, u.id);
    const analyzed = await seedEmail(pool, u.id, mailboxId, { providerMessageId: "m-analyzed" });
    const other = await seedEmail(pool, u.id, mailboxId, { providerMessageId: "m-other" });

    const fresh = (await getEmailDetail(u.id, other, "friend"))!;
    expect(fresh.actions).toMatchObject({ canRunAiReview: true, aiReviewRemainingToday: 1 });

    // The friend's one render today: a plain "Analyze this email" (no AI) on another email.
    await withUser(pool, u.id, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind, state, want_ai) VALUES ($1, $2, 'on_demand', 'done', false)`,
        [u.id, analyzed],
      ),
    );

    const after = (await getEmailDetail(u.id, other, "friend"))!;
    expect(after.actions).toMatchObject({
      canAnalyze: false,
      analyzeRemainingToday: 0,
      canRunAiReview: false,
      aiReviewRemainingToday: 0,
    });
    // The server agrees: the review would be refused.
    const r = await requestAnalyze(other, true);
    expect(r).toMatchObject({ ok: false, code: "limit" });
  });
});
