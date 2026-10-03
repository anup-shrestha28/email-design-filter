/**
 * fin-connect fixes in the web app:
 *  - C1-13: removing a joined friend's invite pauses their mailboxes, so they stop being polled and
 *    processed (not only their sign-in and connect flow).
 *  - C1-12: a 'connecting' placeholder a crashed callback left behind is deleted on the user's next
 *    connect, so it neither shows in Settings nor takes one of their two slots for a day.
 *  - R1-41 leftover: requireUser sends a signed-out page to /sign-in?next=<path>, like proxy.ts,
 *    plus ?expired=1 (the cookie that got past the proxy is invalid, so /sign-in shows its form
 *    instead of sending a "signed-in" visitor back to the page, which would loop).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withUser, type pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool } from "../support/db";
import { type FakeSession, sessionFor } from "../tests-server/helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null, headers: new Headers() }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

describe("requireUser keeps the page as next (R1-41)", () => {
  it("builds the same sign-in target as proxy.ts", async () => {
    const { signInPath } = await import("@/server/session");
    expect(signInPath("/inbox")).toBe("/sign-in?next=%2Finbox");
    expect(signInPath("/email/123?q=secret#x")).toBe("/sign-in?next=%2Femail%2F123");
    expect(signInPath("/gallery")).toBe("/sign-in");
    expect(signInPath("/today")).toBe("/sign-in?next=%2Ftoday");
    expect(signInPath("/out")).toBe("/sign-in");
    expect(signInPath("/out/x")).toBe("/sign-in");
    expect(signInPath("//evil.example")).toBe("/sign-in");
    expect(signInPath(null)).toBe("/sign-in");
  });

  it("redirects a signed-out page to /sign-in?next=<path>&expired=1, from the argument or the proxy's header", async () => {
    const { requireUser, PATH_HEADER } = await import("@/server/session");
    state.session = null;
    state.headers = new Headers();
    await expect(requireUser("/connect")).rejects.toThrow(/^REDIRECT \/sign-in\?next=%2Fconnect&expired=1$/);
    state.headers = new Headers({ [PATH_HEADER]: "/settings" });
    await expect(requireUser()).rejects.toThrow(/^REDIRECT \/sign-in\?next=%2Fsettings&expired=1$/);
    state.headers = new Headers();
    await expect(requireUser()).rejects.toThrow(/^REDIRECT \/sign-in\?expired=1$/);
  });
});

describe.skipIf(!HAS_DB)("invite removal and stale connect placeholders", () => {
  let app: pg.Pool;
  let owner: pg.Pool;

  beforeAll(() => {
    app = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });
  beforeEach(() => {
    state.session = null;
    state.headers = new Headers();
  });

  const statusOf = async (id: string) =>
    (await owner.query<{ status: string; status_reason: string | null }>("SELECT status, status_reason FROM mailbox WHERE id = $1", [id])).rows[0];

  it("removing a joined friend's invite pauses their active mailboxes only (C1-13)", async () => {
    const { removeInvite } = await import("@/server/actions/settings");
    const boss = await createUser(app, { role: "owner" });
    const friend = await createUser(app, { role: "friend" });
    const other = await createUser(app, { role: "friend" });
    const active = await createMailbox(app, friend.id, { status: "active" });
    const reauth = await createMailbox(app, friend.id, { status: "needs_reauth" });
    const untouched = await createMailbox(app, other.id, { status: "active" });
    const bossMailbox = await createMailbox(app, boss.id, { status: "active" });

    state.session = sessionFor(boss);
    expect(await removeInvite(friend.email.toUpperCase())).toEqual({ ok: true });
    expect(await statusOf(active)).toEqual({ status: "paused", status_reason: "invite_removed" });
    // needs_reauth stays as it is, so the 30-day purge still removes it.
    expect((await statusOf(reauth))?.status).toBe("needs_reauth");
    expect((await statusOf(untouched))?.status).toBe("active");
    expect((await statusOf(bossMailbox))?.status).toBe("active");
    // Removing an address with no invite changes nothing.
    await owner.query("UPDATE mailbox SET status = 'active', status_reason = NULL WHERE id = $1", [active]);
    expect(await removeInvite(friend.email)).toEqual({ ok: true });
    expect((await statusOf(active))?.status).toBe("active");
  });

  it("a stale 'connecting' placeholder is deleted before the limit is counted; a fresh one still counts (C1-12)", async () => {
    const { countMailboxes } = await import("@/server/connect");
    const u = await createUser(app, { role: "friend" });
    await createMailbox(app, u.id, { status: "active" });
    const insertConnecting = (age: string) =>
      withUser(app, u.id, async (_db, c) => {
        const hex = randomUUID().replaceAll("-", "").slice(0, 24);
        const r = await c.query<{ id: string }>(
          `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, created_at)
           VALUES ($1, 'gmail', $2, $3, 'connecting', now() - $4::interval) RETURNING id`,
          [u.id, `pending:${hex}`, `${hex}@connecting.invalid`, age],
        );
        return r.rows[0]!.id;
      });
    const stale = await insertConnecting("1 hour");
    const fresh = await insertConnecting("1 minute");
    expect(await withUser(app, u.id, (_db, c) => countMailboxes(c, u.id))).toBe(2);
    expect(await statusOf(stale)).toBeUndefined();
    expect((await statusOf(fresh))?.status).toBe("connecting");
  });
});
