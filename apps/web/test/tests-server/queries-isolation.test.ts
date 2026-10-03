/**
 * Read queries (DESIGN.md §9.5; FREE-TIER.md §8.3): the owner-only System page and invite list are
 * refused to friends both by the session gate and inside the database, and every per-user query —
 * email detail, sender list and profile, Today, Insights, sync status, settings — returns only the
 * caller's data even when handed another user's ids.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, inviteEmail, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, fromSender, senderIdOf, sessionFor } from "./helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

type User = Awaited<ReturnType<typeof createUser>>;
const DAY = 86_400_000;

describe.skipIf(!HAS_DB)("owner-only paths and per-user queries", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let alice: User; // owner
  let bob: User; // friend
  let aliceMb: string;
  let aliceEmail: string;
  let aliceSender: string;

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    alice = await createUser(app, { role: "owner", name: "Alice Owner" });
    bob = await createUser(app, { role: "friend", name: "Bob Friend" });
    aliceMb = await createMailbox(app, alice.id, { address: `alice-${randomBytes(3).toString("hex")}@gmail.example` });
    const bobMb = await createMailbox(app, bob.id);
    const now = Date.now();
    // Alice: a scored promo from one sender (3 emails, so it shows in sender rankings) with a live deal.
    for (let i = 0; i < 3; i++) {
      const e = await seedEmail(app, alice.id, aliceMb, {
        ...fromSender("hello@alice-shop.example", { displayName: "Alice Shop" }),
        receivedAt: new Date(now - (i + 1) * 3_600_000),
        designStatus: "done", designScore: 88, designBand: "excellent", designProvisional: false, designCapped: false,
        fontFamilies: ["Montserrat"], importance: "high", importanceScore: 90,
        deals: [{ kind: "percent_off", value: 30, currency: null, isUpTo: false, minSpend: null, code: "ALICE30", startsAt: null,
          endsAt: new Date(now + 6 * 3_600_000), endsAtConfidence: 0.9, source: "regex" }],
      });
      if (i === 0) aliceEmail = e;
    }
    aliceSender = await senderIdOf(owner, aliceEmail);
    // Bob has one unrelated email.
    await seedEmail(app, bob.id, bobMb, { ...fromSender("hi@bob-news.example", { displayName: "Bob News" }), primaryType: "newsletter", deals: [], fontFamilies: ["Georgia"] });
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });
  beforeEach(() => {
    state.session = null;
  });

  describe("owner-only paths", () => {
    it("requireOwner lets the owner in, sends a friend to the gallery and a visitor to sign-in", async () => {
      const { requireOwner } = await import("@/server/session");
      state.session = sessionFor(alice);
      await expect(requireOwner()).resolves.toMatchObject({ userId: alice.id, role: "owner" });
      state.session = sessionFor(bob);
      await expect(requireOwner()).rejects.toThrow("REDIRECT /gallery");
      state.session = null;
      await expect(requireOwner()).rejects.toThrow("REDIRECT /sign-in");
    });

    it("the role always comes from the database, and a user without settings is a friend", async () => {
      const { requireUserOrThrow } = await import("@/server/session");
      state.session = sessionFor(bob);
      expect((await requireUserOrThrow()).role).toBe("friend");
      // A user row with no user_settings (e.g. mid sign-up) is never treated as the owner.
      const id = `u_${randomBytes(8).toString("hex")}`;
      await inviteEmail(`${id}@example.com`); // created through the invite gate, like every user row
      await app.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'X', $2, true)`, [id, `${id}@example.com`]);
      state.session = sessionFor({ id, email: `${id}@example.com`, name: "X" });
      expect((await requireUserOrThrow()).role).toBe("friend");
    });

    it("sessions older than 30 days are refused", async () => {
      const { requireUserOrThrow } = await import("@/server/session");
      state.session = sessionFor(alice, 31 * DAY);
      await expect(requireUserOrThrow()).rejects.toThrow("Not signed in");
    });

    it("the System status refuses a friend inside the database; the owner gets aggregate counts", async () => {
      const { getSystemStatus } = await import("@/server/queries/system");
      await expect(getSystemStatus(bob.id)).rejects.toThrow(/owner only/);
      const s = await getSystemStatus(alice.id);
      expect(s.users).toBeGreaterThanOrEqual(2);
      expect(s.mailboxes.total).toBeGreaterThanOrEqual(2);
      expect(s.googleAccounts).toMatchObject({ alertAt: 70, stopAt: 90, limit: 100 });
      // Aggregates only: no addresses or ids of anyone's mailboxes or mail.
      const text = JSON.stringify(s);
      expect(text).not.toContain(aliceMb);
      expect(text).not.toContain("@gmail.example");
      expect(text).not.toContain(aliceEmail);
    });

    it("settings show the invite list to the owner only", async () => {
      const { getSettings } = await import("@/server/queries/account");
      const addr = `invitee-${randomBytes(3).toString("hex")}@example.com`;
      const { withUser } = await import("@edf/db");
      await withUser(app, alice.id, (_db, c) => c.query("SELECT add_invite($1, 'friend')", [addr]));
      const asBob = await getSettings({ ...(await sessionUser(bob)) });
      expect(asBob.invites).toBeNull();
      expect(asBob.user.role).toBe("friend");
      expect(asBob.mailboxes.map((m) => m.id)).not.toContain(aliceMb);
      const asAlice = await getSettings({ ...(await sessionUser(alice)) });
      expect(asAlice.invites?.map((i) => i.email)).toContain(addr);
      expect(asAlice.mailboxes.map((m) => m.id)).toEqual([aliceMb]);
    });
  });

  async function sessionUser(u: User) {
    const { requireUserOrThrow } = await import("@/server/session");
    state.session = sessionFor(u);
    return requireUserOrThrow();
  }

  describe("per-user queries never cross tenants", () => {
    it("email detail: another user's email id returns nothing", async () => {
      const { getEmailDetail } = await import("@/server/queries/email");
      expect(await getEmailDetail(bob.id, aliceEmail, "friend")).toBeNull();
      expect(await getEmailDetail(bob.id, "not-a-uuid", "friend")).toBeNull();
      const mine = await getEmailDetail(alice.id, aliceEmail, "owner");
      expect(mine?.id).toBe(aliceEmail);
      expect(mine?.deals.map((d) => d.code)).toEqual(["ALICE30"]);
      // The viewer URL is signed for this user and this email.
      expect(mine?.viewer?.src).toContain(`/${aliceEmail}`);
    });

    it("senders: list, search and profile are scoped to the caller", async () => {
      const { getSenderProfile, listSenders } = await import("@/server/queries/senders");
      expect(await getSenderProfile(bob.id, aliceSender)).toBeNull();
      const bobList = await listSenders(bob.id);
      expect(bobList.map((s) => s.address)).toEqual(["hi@bob-news.example"]);
      expect(await listSenders(bob.id, { search: "Alice Shop" })).toEqual([]);
      expect(await listSenders(bob.id, { search: "alice-shop" })).toEqual([]);
      const aliceFound = await listSenders(alice.id, { search: "alice-shop" });
      expect(aliceFound.map((s) => s.id)).toEqual([aliceSender]);
      const profile = await getSenderProfile(alice.id, aliceSender);
      expect(profile?.recentEmails.map((e) => e.id)).toContain(aliceEmail);
      expect(profile?.fonts).toEqual([{ family: "Montserrat", emails: 3 }]);
    });

    it("Today, Insights and sync status contain only the caller's mail", async () => {
      const { getToday, getSyncStatus } = await import("@/server/queries/account");
      const { getInsights } = await import("@/server/queries/insights");
      const bobToday = await getToday(await sessionUser(bob));
      expect(bobToday.needsAttention).toEqual([]);
      expect(bobToday.dealsEndingSoon).toEqual([]);
      expect(bobToday.designHighlights.best).toBeNull();
      const aliceToday = await getToday(await sessionUser(alice));
      expect(aliceToday.dealsEndingSoon.map((e) => e.id)).toContain(aliceEmail);
      expect(aliceToday.firstName).toBe("Alice");

      const bobInsights = await getInsights(bob.id, 90);
      expect(bobInsights.totals.emails).toBe(1);
      expect(bobInsights.fonts.map((f) => f.family)).not.toContain("Montserrat");
      expect(bobInsights.topSenders.map((s) => s.name)).toEqual(["Bob News"]);
      expect(bobInsights.bestSenders).toEqual([]);
      const aliceInsights = await getInsights(alice.id, 90);
      expect(aliceInsights.totals.emails).toBe(3);
      expect(aliceInsights.bestSenders.map((s) => s.id)).toEqual([aliceSender]);

      const sync = await getSyncStatus(bob.id);
      expect(sync.mailboxes.map((m) => m.id)).not.toContain(aliceMb);
      expect(sync.mailboxes).toHaveLength(1);
    });
  });
});
