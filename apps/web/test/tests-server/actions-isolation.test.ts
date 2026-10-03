/**
 * Email and sender Server Actions (DESIGN.md §9.3, §7.2–7.3, §9.5): every action needs a session,
 * validates its input, and — through withUser + RLS — can only ever touch the caller's own rows.
 * A second signed-in user who knows (or guesses) the first user's email and sender ids must not be
 * able to read or change anything, and must get the same answer as for an id that doesn't exist.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, fromSender, ownerRow, senderIdOf, sessionFor } from "./helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null, sent: [] as Array<{ name: string }> }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/inngest/client", () => ({
  inngest: {
    send: async (e: { name: string }) => {
      state.sent.push(e);
      return { ids: [] };
    },
  },
}));

type User = Awaited<ReturnType<typeof createUser>>;

describe.skipIf(!HAS_DB)("email & sender actions: authorization and tenant isolation", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let alice: User; // the victim (owner role)
  let bob: User; // a second, signed-in friend
  let aliceMb: string;
  let aliceEmail: string;
  let aliceSender: string;

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    alice = await createUser(app, { role: "owner" });
    bob = await createUser(app, { role: "friend" });
    aliceMb = await createMailbox(app, alice.id);
    await createMailbox(app, bob.id);
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  beforeEach(async () => {
    state.session = null;
    state.sent = [];
    aliceEmail = await seedEmail(app, alice.id, aliceMb, fromSender(`news-${randomUUID().slice(0, 8)}@northwind.example`));
    aliceSender = await senderIdOf(owner, aliceEmail);
  });

  const emailRow = (id: string) =>
    ownerRow<{ done_at: Date | null; pinned_at: Date | null; opened_in_app_at: Date | null; primary_type: string; type_source: string }>(
      owner,
      "SELECT done_at, pinned_at, opened_in_app_at, primary_type, type_source FROM email WHERE id = $1",
      [id],
    );
  const senderRow = (id: string) =>
    ownerRow<{ muted: boolean; user_importance_bias: number; unsubscribed_at: Date | null; type_override: string | null }>(
      owner,
      "SELECT muted, user_importance_bias, unsubscribed_at, type_override FROM sender WHERE id = $1",
      [id],
    );

  it("every action refuses without a session", async () => {
    const email = await import("@/server/actions/email");
    const sender = await import("@/server/actions/sender");
    const results = await Promise.all([
      email.setDone(aliceEmail, true),
      email.setPinned(aliceEmail, true),
      email.markOpened(aliceEmail),
      email.requestAnalyze(aliceEmail),
      email.correctType(aliceEmail, "newsletter", true),
      email.markPersonal(aliceEmail),
      sender.setSenderMuted(aliceSender, true),
      sender.setImportanceBias(aliceSender, 2),
      sender.openUnsubscribe(aliceSender),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: "Please sign in.", code: "unauthorized" });
    const row = await emailRow(aliceEmail);
    expect(row).toMatchObject({ done_at: null, pinned_at: null, opened_in_app_at: null, primary_type: "promotional" });
    expect(await senderRow(aliceSender)).toMatchObject({ muted: false, user_importance_bias: 0, unsubscribed_at: null });
  });

  it("rejects malformed ids and values before touching the database", async () => {
    state.session = sessionFor(alice);
    const email = await import("@/server/actions/email");
    const sender = await import("@/server/actions/sender");
    const invalid = { ok: false, error: "That request wasn't valid.", code: "invalid" };
    expect(await email.setDone("not-a-uuid", true)).toEqual(invalid);
    expect(await email.setDone("1; DROP TABLE email", true)).toEqual(invalid);
    expect(await email.setPinned(aliceEmail, "yes" as unknown as boolean)).toEqual(invalid);
    expect(await email.correctType(aliceEmail, "super_important", false)).toEqual(invalid);
    expect(await email.requestAnalyze(aliceEmail, 1 as unknown as boolean)).toEqual(invalid);
    expect(await sender.setImportanceBias(aliceSender, 3)).toEqual(invalid);
    expect(await sender.setImportanceBias(aliceSender, 1.5)).toEqual(invalid);
    expect(await sender.setSenderMuted("x", true)).toEqual(invalid);
    expect(await emailRow(aliceEmail)).toMatchObject({ done_at: null, pinned_at: null, primary_type: "promotional" });
    expect((await senderRow(aliceSender))?.user_importance_bias).toBe(0);
  });

  it("a second user cannot change the first user's email triage state", async () => {
    state.session = sessionFor(bob);
    const email = await import("@/server/actions/email");
    // No existence oracle: same answer as for an id that doesn't exist at all.
    expect(await email.setDone(aliceEmail, true)).toEqual({ ok: true });
    expect(await email.setPinned(aliceEmail, true)).toEqual({ ok: true });
    expect(await email.markOpened(aliceEmail)).toEqual({ ok: true });
    expect(await email.setDone("00000000-0000-4000-8000-000000000000", true)).toEqual({ ok: true });
    expect(await emailRow(aliceEmail)).toMatchObject({ done_at: null, pinned_at: null, opened_in_app_at: null });

    // The owner of the email can.
    state.session = sessionFor(alice);
    expect(await email.setDone(aliceEmail, true)).toEqual({ ok: true });
    expect(await email.setPinned(aliceEmail, true)).toEqual({ ok: true });
    expect(await email.markOpened(aliceEmail)).toEqual({ ok: true });
    const after = await emailRow(aliceEmail);
    expect(after?.done_at).toBeInstanceOf(Date);
    expect(after?.pinned_at).toBeInstanceOf(Date);
    expect(after?.opened_in_app_at).toBeInstanceOf(Date);
    // Undo works, and markOpened keeps the first-open time.
    const opened = after!.opened_in_app_at!.getTime();
    expect(await email.setDone(aliceEmail, false)).toEqual({ ok: true });
    expect(await email.markOpened(aliceEmail)).toEqual({ ok: true });
    const again = await emailRow(aliceEmail);
    expect(again?.done_at).toBeNull();
    expect(again?.opened_in_app_at?.getTime()).toBe(opened);
  });

  it("a second user cannot correct the first user's email type, nor their sender override", async () => {
    state.session = sessionFor(bob);
    const email = await import("@/server/actions/email");
    expect(await email.correctType(aliceEmail, "newsletter", true)).toEqual({ ok: true });
    expect(await emailRow(aliceEmail)).toMatchObject({ primary_type: "promotional", type_source: "rule" });
    expect((await senderRow(aliceSender))?.type_override).toBeNull();
    const fb = await owner.query("SELECT 1 FROM user_feedback WHERE email_id = $1", [aliceEmail]);
    expect(fb.rowCount).toBe(0);

    // The owner's correction applies to the email, is recorded, and (when asked) to the sender's other mail.
    const addr = (await owner.query<{ a: string }>("SELECT from_address::text AS a FROM email WHERE id = $1", [aliceEmail])).rows[0]!.a;
    const sibling = await seedEmail(app, alice.id, aliceMb, fromSender(addr));
    state.session = sessionFor(alice);
    expect(await email.correctType(aliceEmail, "newsletter", true)).toEqual({ ok: true });
    expect(await emailRow(aliceEmail)).toMatchObject({ primary_type: "newsletter", type_source: "user" });
    expect(await emailRow(sibling)).toMatchObject({ primary_type: "newsletter", type_source: "user" });
    expect((await senderRow(aliceSender))?.type_override).toBe("newsletter");
    const own = await owner.query<{ user_id: string; old_value: string; new_value: string }>(
      "SELECT user_id, old_value, new_value FROM user_feedback WHERE email_id = $1",
      [aliceEmail],
    );
    expect(own.rows).toEqual([{ user_id: alice.id, old_value: "promotional", new_value: "newsletter" }]);
  });

  it("a second user cannot delete the first user's mail with 'This is personal'", async () => {
    state.session = sessionFor(bob);
    const email = await import("@/server/actions/email");
    expect(await email.markPersonal(aliceEmail)).toEqual({ ok: true });
    expect(await emailRow(aliceEmail)).toBeDefined();
    expect((await senderRow(aliceSender))?.muted).toBe(false);

    state.session = sessionFor(alice);
    expect(await email.markPersonal(aliceEmail)).toEqual({ ok: true });
    expect(await emailRow(aliceEmail)).toBeUndefined();
    expect(await senderRow(aliceSender)).toMatchObject({ muted: true, type_override: "personal" });
  });

  it("a second user cannot queue a render of the first user's email", async () => {
    state.session = sessionFor(bob);
    const email = await import("@/server/actions/email");
    expect(await email.requestAnalyze(aliceEmail)).toEqual({ ok: false, error: "Email not found.", code: "not_found" });
    expect((await owner.query("SELECT 1 FROM render_request WHERE email_id = $1", [aliceEmail])).rowCount).toBe(0);
    expect(state.sent).toEqual([]);

    state.session = sessionFor(alice);
    expect(await email.requestAnalyze(aliceEmail)).toEqual({ ok: true, data: { status: "queued" } });
    const rr = await owner.query<{ user_id: string; kind: string }>("SELECT user_id, kind FROM render_request WHERE email_id = $1", [aliceEmail]);
    expect(rr.rows).toEqual([{ user_id: alice.id, kind: "on_demand" }]);
    expect(state.sent.map((e) => e.name)).toEqual(["render/requested"]);
  });

  it("a second user cannot mute, bias or unsubscribe from the first user's sender", async () => {
    state.session = sessionFor(bob);
    const sender = await import("@/server/actions/sender");
    expect(await sender.setSenderMuted(aliceSender, true)).toEqual({ ok: true });
    expect(await sender.setImportanceBias(aliceSender, -2)).toEqual({ ok: true });
    expect(await sender.openUnsubscribe(aliceSender)).toEqual({ ok: false, error: "Sender not found.", code: "not_found" });
    expect(await senderRow(aliceSender)).toMatchObject({ muted: false, user_importance_bias: 0, unsubscribed_at: null });
    const hidden = await ownerRow<{ sender_muted: boolean }>(owner, "SELECT sender_muted FROM email WHERE id = $1", [aliceEmail]);
    expect(hidden?.sender_muted).toBe(false);

    state.session = sessionFor(alice);
    expect(await sender.setSenderMuted(aliceSender, true)).toEqual({ ok: true });
    expect(await sender.setImportanceBias(aliceSender, -2)).toEqual({ ok: true });
    const unsub = await sender.openUnsubscribe(aliceSender);
    expect(unsub.ok).toBe(true);
    if (unsub.ok) {
      // A signed /out interstitial link to the sender's https unsubscribe page — never the raw link.
      expect(unsub.data.url).toMatch(/^\/out\?u=https%3A%2F%2Fnorthwind\.example%2Fu&t=.+/);
      expect(unsub.data.mailto).toBeNull();
      // The token is bound to Alice: it does not open the interstitial for Bob.
      const { verifyOutLink } = await import("@edf/crypto");
      const { outKeys } = await import("@/server/keys");
      const q = new URL(unsub.data.url!, "https://app.example").searchParams;
      const nowSec = Math.floor(Date.now() / 1000);
      const url = "https://northwind.example/u";
      expect(verifyOutLink(outKeys(), q.get("t")!, { sessionId: `u:${alice.id}`, url, nowSec })).toBe(true);
      expect(verifyOutLink(outKeys(), q.get("t")!, { sessionId: `u:${bob.id}`, url, nowSec })).toBe(false);
    }
    const s = await senderRow(aliceSender);
    expect(s).toMatchObject({ muted: true, user_importance_bias: -2 });
    expect(s?.unsubscribed_at).toBeInstanceOf(Date);
    expect((await ownerRow<{ sender_muted: boolean }>(owner, "SELECT sender_muted FROM email WHERE id = $1", [aliceEmail]))?.sender_muted).toBe(true);
  });

  it("the inbox actions never return another user's email, preview or counts", async () => {
    state.session = sessionFor(bob);
    const inbox = await import("@/app/(app)/inbox/actions");
    const preview = await inbox.getEmailPreview(aliceEmail);
    expect(preview).toEqual({ ok: false, error: "This email is no longer available.", code: "not_found" });
    const q = await inbox.queryInbox({ scope: "all" }, "");
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.data.page.items).toEqual([]);
      expect(q.data.counts?.total).toBe(0);
    }
    const s = await inbox.queryInbox({ scope: "all" }, "Northwind");
    expect(s.ok && s.data.page.items).toEqual([]);

    state.session = sessionFor(alice);
    const mine = await inbox.getEmailPreview(aliceEmail);
    expect(mine.ok && mine.data.id).toBe(aliceEmail);
    const found = await inbox.queryInbox({ scope: "all" }, "Northwind");
    expect(found.ok && found.data.page.items.map((i) => i.id)).toContain(aliceEmail);
  });
});
