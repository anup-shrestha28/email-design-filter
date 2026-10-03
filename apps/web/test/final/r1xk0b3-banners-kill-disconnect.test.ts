/**
 * R1-20: the shell banner carries the app-wide state (FREE-TIER.md §1.3 rule 3 "every level shows a
 * banner", §8.2–8.3, §4.9, §6): the governor level (Saver / Essentials / Frozen), paused
 * background jobs, paused AI (the owner) — before, only mailbox and import banners existed.
 * R1-21 (web side): `kill.render` stops "Analyze" (page and action) and `invites.enabled = false`
 * stops new invites.
 * R1-25: a disconnect whose Google revoke failed tells the action's caller (`revokeFailed`).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type * as Pipeline from "@edf/pipeline";
import type { getPool as getAppPool } from "@/server/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { sessionFor, type FakeSession } from "../tests-server/helpers";

const state = vi.hoisted(() => ({
  session: null as FakeSession | null,
  revoke: { revoked: true, alreadyInvalid: false, revokeFailed: false },
  /** Google's /revoke as account deletion sees it (the rest of deleteAccount is real). */
  revokeGrant: async (): Promise<unknown> => ({ revoked: true, alreadyInvalid: false, reason: null }),
}));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));
// Google's /revoke is the one stand-in: the rest of the disconnect (tokens nulled, status) is real.
vi.mock("@edf/pipeline", async (orig) => {
  const real = await orig<typeof Pipeline>();
  return {
    ...real,
    disconnectNow: async (deps: Pipeline.PipelineDeps, mb: { userId: string; mailboxId: string }) => {
      await real.disconnectNow({ ...deps, tokens: { revokeGrant: async () => ({ revoked: true, alreadyInvalid: false, reason: null }) } } as never, mb);
      return state.revoke;
    },
    deleteAccount: (deps: Pipeline.PipelineDeps, userId: string) =>
      real.deleteAccount({ ...deps, tokens: { revokeGrant: () => state.revokeGrant() } } as never, userId),
  };
});

describe.skipIf(!HAS_DB)("app-wide banners, web kill switches and disconnect reporting", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let appPoolOf: typeof getAppPool | null = null;
  let saved: { governor: unknown; ai: unknown; inngest: boolean } | null = null;
  const setSetting = (key: string, value: unknown) =>
    owner.query("UPDATE app_setting SET value = $2::jsonb WHERE key = $1", [key, JSON.stringify(value)]);
  const setInngestPaused = (p: boolean) => owner.query("UPDATE system_state SET inngest_paused = $1", [p]);
  const reset = async () => {
    await setSetting("governor", { level: 0, actions: {} });
    await setSetting("ai.paused", { paused: false, reason: null, since: null });
    await setSetting("kill.ingest", false);
    await setSetting("kill.render", false);
    await setSetting("invites.enabled", true);
    await setInngestPaused(false);
  };

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    appPoolOf = (await import("@/server/db")).getPool;
    const s = await owner.query<{ key: string; value: unknown }>("SELECT key, value FROM app_setting WHERE key IN ('governor', 'ai.paused')");
    const inngest = await owner.query<{ p: boolean }>("SELECT inngest_paused AS p FROM system_state");
    saved = {
      governor: s.rows.find((r) => r.key === "governor")?.value ?? { level: 0 },
      ai: s.rows.find((r) => r.key === "ai.paused")?.value ?? { paused: false },
      inngest: inngest.rows[0]?.p ?? false,
    };
  });
  beforeEach(async () => {
    state.session = null;
    state.revoke = { revoked: true, alreadyInvalid: false, revokeFailed: false };
    state.revokeGrant = async () => ({ revoked: true, alreadyInvalid: false, reason: null });
    await reset();
  });
  afterAll(async () => {
    await reset();
    if (saved) {
      await setSetting("governor", saved.governor);
      await setSetting("ai.paused", saved.ai);
      await setInngestPaused(saved.inngest);
    }
    await app.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  describe("R1-20 banners", () => {
    const bannerOf = async (userId: string) => (await (await import("@/server/queries/account")).getSyncStatus(userId)).banner;

    it("each governor level shows its banner; Frozen outranks everything, even a reauth", async () => {
      const u = await createUser(app, { role: "friend" });
      await createMailbox(app, u.id);
      expect(await bannerOf(u.id)).toBeNull();

      await setSetting("governor", { level: 1, actions: {} });
      expect(await bannerOf(u.id)).toMatchObject({ id: "governor:1", level: "info", text: expect.stringMatching(/^Saver mode.*every 60 min/) });
      await setSetting("governor", { level: 2, actions: {} });
      expect(await bannerOf(u.id)).toMatchObject({ id: "governor:2", level: "warning", text: expect.stringMatching(/^Essentials mode.*6 hours/) });
      await setSetting("governor", { level: 3, actions: {} });
      expect(await bannerOf(u.id)).toMatchObject({ id: "governor:3", level: "error", text: expect.stringMatching(/^Frozen/) });

      await createMailbox(app, u.id, { status: "needs_reauth" });
      expect((await bannerOf(u.id))?.id).toBe("governor:3");
      await setSetting("governor", { level: 1, actions: {} });
      expect((await bannerOf(u.id))?.id).toMatch(/^reauth:/); // an actionable error beats Saver mode
    });

    it("paused background jobs and a stopped ingest show for everyone; paused AI only for the owner", async () => {
      const friend = await createUser(app, { role: "friend" });
      const me = await createUser(app, { role: "owner" });
      await createMailbox(app, friend.id);
      await createMailbox(app, me.id);

      await setSetting("ai.paused", { paused: true, reason: "spend_limit", since: new Date().toISOString() });
      expect((await bannerOf(me.id))?.id).toBe("ai:paused");
      expect(await bannerOf(friend.id)).toBeNull();

      await setInngestPaused(true);
      expect(await bannerOf(friend.id)).toMatchObject({ id: "inngest:paused", level: "warning" });
      expect((await bannerOf(me.id))?.id).toBe("inngest:paused");

      await setSetting("kill.ingest", true);
      expect(await bannerOf(friend.id)).toMatchObject({ id: "kill:ingest", level: "warning" });
    });

    it("a frozen app shows its banner even with no mailbox connected", async () => {
      const u = await createUser(app, { role: "friend" });
      expect((await bannerOf(u.id))?.id).toBe("connect");
      await setSetting("governor", { level: 3, actions: {} });
      expect((await bannerOf(u.id))?.id).toBe("governor:3");
    });

    it("with no mailbox, an app-wide warning outranks the connect prompt (Saver mode doesn't)", async () => {
      const u = await createUser(app, { role: "friend" });
      await setSetting("governor", { level: 1, actions: {} });
      expect((await bannerOf(u.id))?.id).toBe("connect");
      await setSetting("governor", { level: 2, actions: {} });
      expect(await bannerOf(u.id)).toMatchObject({ id: "governor:2", level: "warning" });
      await setSetting("governor", { level: 0, actions: {} });
      await setInngestPaused(true);
      expect((await bannerOf(u.id))?.id).toBe("inngest:paused");
    });
  });

  describe("R1-21 web kill switches", () => {
    it("kill.render: the email page says why and the Analyze action queues nothing", async () => {
      const { getEmailDetail } = await import("@/server/queries/email");
      const { requestAnalyze } = await import("@/server/actions/email");
      const me = await createUser(app, { role: "owner" });
      const emailId = await seedEmail(app, me.id, await createMailbox(app, me.id));
      expect((await getEmailDetail(me.id, emailId, "owner"))!.actions).toMatchObject({ rendersPaused: null, canAnalyze: true });

      await setSetting("kill.render", true);
      const detail = (await getEmailDetail(me.id, emailId, "owner"))!;
      expect(detail.actions.rendersPaused).toMatch(/switched off/);
      expect(detail.actions.canAnalyze).toBe(false);
      state.session = sessionFor(me);
      const r = await requestAnalyze(emailId);
      expect(r).toMatchObject({ ok: true, data: { status: "paused", reason: expect.stringMatching(/switched off/) } });
      const queued = await owner.query("SELECT 1 FROM render_request WHERE email_id = $1", [emailId]);
      expect(queued.rowCount).toBe(0);
    });

    it("invites.enabled = false: the owner can't add an invite", async () => {
      const { addInvite } = await import("@/server/actions/settings");
      const me = await createUser(app, { role: "owner" });
      state.session = sessionFor(me);
      await setSetting("invites.enabled", false);
      const addr = `off-${randomBytes(4).toString("hex")}@example.com`;
      expect(await addInvite(addr)).toEqual({ ok: false, error: "Invites are switched off right now.", code: "limit" });
      await setSetting("invites.enabled", true);
      expect((await addInvite(addr)).ok).toBe(true);
    });
  });

  describe("R1-25 disconnect", () => {
    it("reports a revoke Google didn't confirm, and stays quiet when it did", async () => {
      const { disconnectMailbox } = await import("@/server/actions/settings");
      const me = await createUser(app, { role: "owner" });
      state.session = sessionFor(me);

      state.revoke = { revoked: false, alreadyInvalid: false, revokeFailed: true };
      const failed = await createMailbox(app, me.id);
      expect(await disconnectMailbox(failed)).toEqual({ ok: true, data: { revokeFailed: true } });
      const row = await owner.query<{ status: string }>("SELECT status FROM mailbox WHERE id = $1", [failed]);
      expect(row.rows[0]?.status).toBe("disconnecting"); // the disconnect itself still went ahead

      state.revoke = { revoked: true, alreadyInvalid: false, revokeFailed: false };
      expect(await disconnectMailbox(await createMailbox(app, me.id))).toEqual({ ok: true });
    });

    it("account deletion reports a revoke Google didn't confirm too; the account is deleted either way", async () => {
      const { deleteAccount } = await import("@/server/actions/settings");
      const gone = async (id: string) => (await owner.query(`SELECT 1 FROM "user" WHERE id = $1`, [id])).rowCount === 0;

      const a = await createUser(app, { role: "friend" });
      await createMailbox(app, a.id);
      state.session = sessionFor(a);
      state.revokeGrant = async () => Promise.reject(new Error("gmail 503"));
      expect(await deleteAccount(a.email)).toEqual({ ok: true, data: { revokeFailed: true } });
      expect(await gone(a.id)).toBe(true);

      const b = await createUser(app, { role: "friend" });
      await createMailbox(app, b.id);
      state.session = sessionFor(b);
      state.revokeGrant = async () => ({ revoked: true, alreadyInvalid: false, reason: null });
      expect(await deleteAccount(b.email)).toEqual({ ok: true });
      expect(await gone(b.id)).toBe(true);
    });
  });
});
