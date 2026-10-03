/**
 * Settings, invites, disconnect and account deletion (DESIGN.md §4.3, §9.5; FREE-TIER.md §4.5,
 * §4.9, §8.3, §9.4): input validation, the friend/owner split (import window, invites), the
 * fresh-session rule for destructive actions, and tenant isolation (a second user can neither
 * change the first user's settings nor disconnect their mailbox). Google, Inngest and Better Auth's
 * cookie lookup are the only stand-ins; the session module, the actions and the database are real.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, ownerRow, sessionFor } from "./helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null, sent: [] as Array<{ name: string; data?: unknown }> }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/inngest/client", () => ({
  inngest: {
    send: async (e: { name: string; data?: unknown }) => {
      state.sent.push(e);
      return { ids: [] };
    },
  },
}));

type User = Awaited<ReturnType<typeof createUser>>;
const MIN = 60_000;

describe.skipIf(!HAS_DB)("settings, invites, disconnect and delete actions", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let alice: User; // owner
  let bob: User; // friend

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    alice = await createUser(app, { role: "owner" });
    bob = await createUser(app, { role: "friend" });
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });
  beforeEach(() => {
    state.session = null;
    state.sent = [];
    // No test may reach Google or the key service.
    vi.stubGlobal("fetch", async () => {
      throw new Error("network disabled in tests");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const settingsOf = (userId: string) =>
    ownerRow<{ role: string; timezone: string; backfill_window_days: number; link_check_opt_in: boolean; ai_processing_consent_at: Date | null }>(
      owner,
      "SELECT role, timezone, backfill_window_days, link_check_opt_in, ai_processing_consent_at FROM user_settings WHERE user_id = $1",
      [userId],
    );
  const invite = (email: string) =>
    ownerRow<{ email: string; role: string; invited_by: string | null }>(owner, "SELECT email::text, role, invited_by FROM beta_allowlist WHERE email = $1", [email]);

  describe("updateSettings", () => {
    it("needs a session and validates every field", async () => {
      const { updateSettings } = await import("@/server/actions/settings");
      expect(await updateSettings({ timezone: "Europe/Berlin" })).toMatchObject({ ok: false, code: "unauthorized" });

      state.session = sessionFor(bob);
      const invalid = { ok: false, error: "That request wasn't valid.", code: "invalid" };
      expect(await updateSettings({ timezone: "Mars/Olympus_Mons" })).toEqual(invalid);
      expect(await updateSettings({ timezone: "" })).toEqual(invalid);
      expect(await updateSettings({ backfillWindowDays: 60 as 30 })).toEqual(invalid);
      expect(await updateSettings({ linkCheckOptIn: "true" as unknown as boolean })).toEqual(invalid);
      expect(await settingsOf(bob.id)).toMatchObject({ timezone: "UTC", backfill_window_days: 90, link_check_opt_in: false });

      expect(await updateSettings({ timezone: "Europe/Berlin", linkCheckOptIn: true })).toEqual({ ok: true });
      expect(await settingsOf(bob.id)).toMatchObject({ timezone: "Europe/Berlin", link_check_opt_in: true });
    });

    it("friends get a 30-day import window; only the owner can pick 90 or 180 days", async () => {
      const { updateSettings } = await import("@/server/actions/settings");
      state.session = sessionFor(bob);
      expect(await updateSettings({ backfillWindowDays: 180 })).toEqual({
        ok: false,
        error: "Import window is 30 days for invited accounts.",
        code: "invalid",
      });
      expect(await updateSettings({ backfillWindowDays: 90 })).toMatchObject({ ok: false, code: "invalid" });
      expect(await updateSettings({ backfillWindowDays: 30 })).toEqual({ ok: true });
      expect((await settingsOf(bob.id))?.backfill_window_days).toBe(30);

      state.session = sessionFor(alice);
      expect(await updateSettings({ backfillWindowDays: 180 })).toEqual({ ok: true });
      expect((await settingsOf(alice.id))?.backfill_window_days).toBe(180);
    });

    it("never lets a friend promote themselves, and only ever writes the caller's own row", async () => {
      const { updateSettings } = await import("@/server/actions/settings");
      const aliceBefore = await settingsOf(alice.id);
      state.session = sessionFor(bob);
      const sneaky = { timezone: "Asia/Tokyo", role: "owner", userId: alice.id, user_id: alice.id } as unknown as Parameters<typeof updateSettings>[0];
      expect(await updateSettings(sneaky)).toEqual({ ok: true });
      expect(await settingsOf(bob.id)).toMatchObject({ role: "friend", timezone: "Asia/Tokyo" });
      expect(await settingsOf(alice.id)).toEqual(aliceBefore);
    });
  });

  it("acceptDisclosure records consent and an audit entry for the caller only", async () => {
    const { acceptDisclosure } = await import("@/server/actions/settings");
    expect(await acceptDisclosure()).toMatchObject({ ok: false, code: "unauthorized" });
    const carol = await createUser(app);
    state.session = sessionFor(carol);
    expect(await acceptDisclosure()).toEqual({ ok: true });
    expect((await settingsOf(carol.id))?.ai_processing_consent_at).toBeInstanceOf(Date);
    expect((await settingsOf(bob.id))?.ai_processing_consent_at).toBeNull();
    const audit = await owner.query<{ action: string }>("SELECT action FROM audit_log WHERE user_id = $1", [carol.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["disclosure.accepted"]);
  });

  describe("invites (owner only)", () => {
    it("a friend can neither add nor remove invites", async () => {
      const { addInvite, removeInvite } = await import("@/server/actions/settings");
      const addr = `friend-of-bob-${randomBytes(4).toString("hex")}@example.com`;
      state.session = sessionFor(bob);
      expect(await addInvite(addr)).toEqual({ ok: false, error: "Only the owner can invite people.", code: "unauthorized" });
      expect(await invite(addr)).toBeUndefined();

      // An invite the owner made survives a friend's removal attempt.
      state.session = sessionFor(alice);
      expect((await addInvite(addr)).ok).toBe(true);
      state.session = sessionFor(bob);
      expect(await removeInvite(addr)).toEqual({ ok: false, error: "Only the owner can manage invites.", code: "unauthorized" });
      expect(await invite(addr)).toBeDefined();
    });

    it("the database refuses a friend's invite even if the app check were bypassed", async () => {
      const { withUser } = await import("@edf/db");
      await expect(withUser(app, bob.id, (_db, c) => c.query("SELECT add_invite($1, 'friend')", ["x@example.com"]))).rejects.toThrow(/owner only/);
      await expect(withUser(app, bob.id, (_db, c) => c.query("SELECT * FROM list_invites()"))).rejects.toThrow(/owner only/);
      await expect(withUser(app, bob.id, (_db, c) => c.query("SELECT * FROM beta_allowlist"))).rejects.toThrow(/permission denied/);
    });

    it("the owner's invite normalizes the address, returns a signed link and can be removed", async () => {
      const { addInvite, removeInvite } = await import("@/server/actions/settings");
      const { verifyInvite } = await import("@edf/crypto");
      const { inviteKeys } = await import("@/server/keys");
      const { env } = await import("@/env");
      const local = `New.Friend.${randomBytes(4).toString("hex")}`;
      state.session = sessionFor(alice);
      const r = await addInvite(`  ${local}@Example.COM `);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const addr = `${local.toLowerCase()}@example.com`;
      expect(await invite(addr)).toEqual({ email: addr, role: "friend", invited_by: alice.id });
      const prefix = `${env().APP_ORIGIN.replace(/\/$/, "")}/invite/`;
      expect(r.data.link.startsWith(prefix)).toBe(true);
      const token = decodeURIComponent(r.data.link.slice(prefix.length));
      expect(verifyInvite(inviteKeys(), token, Math.floor(Date.now() / 1000))).toEqual({ email: addr });

      expect(await addInvite("not an email")).toMatchObject({ ok: false, code: "invalid" });
      expect(await removeInvite(addr.toUpperCase())).toEqual({ ok: true });
      expect(await invite(addr)).toBeUndefined();
    });

    it("stops inviting at 90 of Google's 100 lifetime accounts", async () => {
      const { addInvite } = await import("@/server/actions/settings");
      const hashes = Array.from({ length: 90 }, () => randomBytes(32).toString("hex"));
      await owner.query("INSERT INTO oauth_subject_seen (sub_hash) SELECT unnest($1::text[])", [hashes]);
      try {
        state.session = sessionFor(alice);
        const addr = `late-${randomBytes(4).toString("hex")}@example.com`;
        expect(await addInvite(addr)).toEqual({
          ok: false,
          error: "Invites are paused: the Google account limit is nearly reached.",
          code: "limit",
        });
        expect(await invite(addr)).toBeUndefined();
      } finally {
        await owner.query("DELETE FROM oauth_subject_seen WHERE sub_hash = ANY($1::text[])", [hashes]);
      }
    });
  });

  describe("disconnect and delete (fresh session)", () => {
    it("disconnect needs a session no older than 10 minutes", async () => {
      const { disconnectMailbox } = await import("@/server/actions/settings");
      const mb = await createMailbox(app, alice.id);
      expect(await disconnectMailbox(mb)).toMatchObject({ ok: false, code: "unauthorized" });
      state.session = sessionFor(alice, 11 * MIN);
      expect(await disconnectMailbox(mb)).toEqual({ ok: false, error: "Please sign in again to confirm it's you.", code: "stale_session" });
      expect((await ownerRow<{ status: string }>(owner, "SELECT status FROM mailbox WHERE id = $1", [mb]))?.status).toBe("active");
    });

    it("a second user cannot disconnect the first user's mailbox", async () => {
      const { disconnectMailbox } = await import("@/server/actions/settings");
      const mb = await createMailbox(app, alice.id);
      state.session = sessionFor(bob, 1 * MIN);
      const r = await disconnectMailbox(mb);
      expect(r.ok).toBe(false);
      expect((await ownerRow<{ status: string }>(owner, "SELECT status FROM mailbox WHERE id = $1", [mb]))?.status).toBe("active");
      expect(state.sent).toEqual([]);

      state.session = sessionFor(alice, 1 * MIN);
      expect(await disconnectMailbox(mb)).toEqual({ ok: true });
      const row = await ownerRow<{ status: string; status_reason: string }>(owner, "SELECT status, status_reason FROM mailbox WHERE id = $1", [mb]);
      expect(row).toEqual({ status: "disconnecting", status_reason: "user_request" });
      expect(state.sent).toEqual([{ name: "mailbox/disconnected", data: { mailboxId: mb, userId: alice.id }, id: `disconnected-${mb}` }]);
    });

    it("delete needs a fresh session and the account's own email typed back; it deletes only the caller", async () => {
      const { deleteAccount } = await import("@/server/actions/settings");
      const dave = await createUser(app, { email: `Dave.${randomBytes(3).toString("hex")}@Example.com` });
      const daveMb = await createMailbox(app, dave.id);
      await seedEmail(app, dave.id, daveMb);
      const aliceMb = await createMailbox(app, alice.id);
      const aliceEmail = await seedEmail(app, alice.id, aliceMb);

      state.session = sessionFor(dave, 11 * MIN);
      expect(await deleteAccount(dave.email)).toMatchObject({ ok: false, code: "stale_session" });
      state.session = sessionFor(dave);
      expect(await deleteAccount(alice.email)).toEqual({ ok: false, error: "Type your account email to confirm.", code: "invalid" });
      expect(await deleteAccount("nope")).toMatchObject({ ok: false, code: "invalid" });
      expect((await owner.query('SELECT 1 FROM "user" WHERE id = $1', [dave.id])).rowCount).toBe(1);

      // Case and surrounding spaces don't matter.
      expect(await deleteAccount(`  ${dave.email.toUpperCase()} `)).toEqual({ ok: true });
      expect((await owner.query('SELECT 1 FROM "user" WHERE id = $1', [dave.id])).rowCount).toBe(0);
      expect((await owner.query("SELECT 1 FROM email WHERE user_id = $1", [dave.id])).rowCount).toBe(0);
      expect((await owner.query("SELECT 1 FROM mailbox WHERE user_id = $1", [dave.id])).rowCount).toBe(0);
      // Nobody else's data went with it.
      expect((await owner.query('SELECT 1 FROM "user" WHERE id = $1', [alice.id])).rowCount).toBe(1);
      expect((await owner.query("SELECT 1 FROM email WHERE id = $1", [aliceEmail])).rowCount).toBe(1);
    });
  });
});
