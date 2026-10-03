/**
 * Inbox filters, facet counts, font options and smart views (DESIGN.md §9.1, §9.4; DESIGN-SCORE.md
 * §3.1; DATA-MODEL.md §5) against the real database:
 *  - Good design = Excellent + Good bands, never provisional (so never capped); Bad design = Poor
 *    band, never provisional; the "Bad design" smart view also includes capped emails.
 *  - Facets are OR within, AND across; each facet's counts ignore that facet's own selection.
 *  - Fonts are grouped case-insensitively; "Uses web fonts" is ANDed with the families.
 *  - Keyset pagination returns every row exactly once for every sort.
 *  - Nothing — list, counts, fonts, smart views, search, sender/mailbox filters — crosses users.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as InboxQueries from "@/server/queries/inbox";
import type { InboxFilters } from "@/server/queries/types";
import { DEFAULT_FILTERS, parseFilters, splitSearch } from "@/lib/filters";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { fromSender, senderIdOf } from "./helpers";

type Deal = EmailRecord["deals"][number];
const HOUR = 3_600_000;
const deal = (over: Partial<Deal> = {}): Deal => ({
  kind: "percent_off", value: 20, currency: null, isUpTo: false, minSpend: null, code: null, startsAt: null,
  endsAt: null, endsAtConfidence: 0.9, source: "regex", ...over,
});
const scored = (score: number, band: EmailRecord["designBand"], over: Partial<EmailRecord> = {}): Partial<EmailRecord> => ({
  designStatus: "done", designScore: score, designBand: band, designProvisional: false, designCapped: false, designIssues: [],
  designConfidence: "medium", ...over,
});
const all = (over: Partial<InboxFilters> = {}): InboxFilters => ({ ...DEFAULT_FILTERS, scope: "all", ...over });

describe("parseFilters / splitSearch", () => {
  it("fills defaults and keeps a valid selection", () => {
    expect(parseFilters(undefined)).toEqual(DEFAULT_FILTERS);
    expect(DEFAULT_FILTERS).toMatchObject({ scope: "subscriptions", view: null, design: [], fonts: [], webFonts: false, sort: "newest" });
    const f = parseFilters({ design: ["good", "bad"], fonts: ["montserrat"], webFonts: true, sort: "score" });
    expect(f).toMatchObject({ design: ["good", "bad"], fonts: ["montserrat"], webFonts: true, sort: "score", scope: "subscriptions" });
  });

  it("rejects values outside the model instead of passing them to SQL", () => {
    expect(parseFilters({ design: ["excellent"] })).toEqual(DEFAULT_FILTERS);
    expect(parseFilters({ sort: "received_at; DROP TABLE email" })).toEqual(DEFAULT_FILTERS);
    expect(parseFilters({ subtypes: ["sale' OR 1=1 --"] })).toEqual(DEFAULT_FILTERS);
    expect(parseFilters({ design: ["good", "good", "good", "good", "good", "good", "good"] })).toEqual(DEFAULT_FILTERS);
    expect(parseFilters("scope=all")).toEqual(DEFAULT_FILTERS);
  });

  it("search: ≤ 100 characters, last token becomes a letters/digits prefix", () => {
    expect(splitSearch("")).toEqual({ query: "", prefix: "" });
    expect(splitSearch("   ")).toEqual({ query: "", prefix: "" });
    expect(splitSearch("autumn sal")).toEqual({ query: "autumn", prefix: "sal" });
    expect(splitSearch("autumn sale ")).toEqual({ query: "autumn sale", prefix: "" });
    expect(splitSearch("Montserrat'):*")).toEqual({ query: "", prefix: "montserrat" });
    expect(splitSearch("x".repeat(500)).prefix.length).toBe(40);
  });
});

describe.skipIf(!HAS_DB)("inbox queries against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let alice: string;
  let bob: string;
  let bobMb: string;
  let bobSender: string;
  const id: Record<string, string> = {};
  let inbox: typeof InboxQueries;

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    inbox = await import("@/server/queries/inbox");
    alice = (await createUser(app, { role: "owner" })).id;
    bob = (await createUser(app, { role: "friend" })).id;
    const mb = await createMailbox(app, alice);
    bobMb = await createMailbox(app, bob);
    const now = Date.now();
    const at = (h: number) => new Date(now - h * HOUR);
    const seed = (key: string, h: number, sender: string, over: Partial<EmailRecord>) =>
      seedEmail(app, alice, mb, { receivedAt: at(h), deals: [], ...fromSender(sender), ...over }).then((e) => (id[key] = e));

    await seed("excellent", 1, "a@brand-a.example", scored(90, "excellent", { fontFamilies: ["Montserrat"], usesWebFonts: true, subject: "Autumn lookbook", searchText: "Autumn lookbook Brand A a@brand-a.example" }));
    await seed("good", 2, "a@brand-a.example", scored(75, "good", { fontFamilies: ["montserrat", "Arial"], usesWebFonts: false }));
    await seed("capped", 3, "b@brand-b.example", scored(64, "needs_work", { designCapped: true, designIssues: ["contrast"], fontFamilies: ["Arial"], usesWebFonts: false }));
    await seed("poor", 4, "b@brand-b.example", scored(40, "poor", { designIssues: ["image_only"], fontFamilies: ["Georgia"], usesWebFonts: false }));
    await seed("provisional", 5, "c@brand-c.example", scored(71, "good", { designProvisional: true, fontFamilies: ["MONTSERRAT"], usesWebFonts: true }));
    await seed("plain", 6, "c@brand-c.example", { designStatus: "plain_text", designScore: null, designBand: null, fontFamilies: [], usesWebFonts: false });
    await seed("pending", 7, "c@brand-c.example", { designStatus: "pending", designScore: null, designBand: null, fontFamilies: [], usesWebFonts: false,
      deals: [deal({ endsAt: new Date(now + 5 * HOUR), code: "SOON10" })] });
    await seed("security", 8, "security@bank.example", {
      primaryType: "account_security", isSubscription: false, securitySensitive: true, designStatus: "skipped", designScore: null,
      designBand: null, fontFamilies: [], usesWebFonts: false, importance: "high", importanceScore: 90, snippet: "Your code is 123456",
    });
    await seed("newsletter", 9, "n@letters.example", scored(86, "excellent", { primaryType: "newsletter", fontFamilies: ["Georgia"], usesWebFonts: false,
      deals: [deal({ endsAt: new Date(now + 10 * 24 * HOUR) })] }));

    // Bob's mail looks just like Alice's — same senders, fonts and bands — so any leak shows up in a count.
    for (const [i, band] of (["excellent", "poor", "good"] as const).entries()) {
      const e = await seedEmail(app, bob, bobMb, {
        receivedAt: at(i + 1), deals: [], ...fromSender("a@brand-a.example"),
        ...scored(band === "poor" ? 30 : 88, band, { designIssues: band === "poor" ? ["image_only"] : [], fontFamilies: ["Montserrat", "Comic Sans MS"], usesWebFonts: true }),
      });
      if (i === 0) bobSender = await senderIdOf(owner, e);
    }
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  async function idsOf(userId: string, f: InboxFilters, search?: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await inbox.listInbox(userId, f, { cursor, search, limit: 3 });
      out.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
  const keys = (ids: string[]) => ids.map((x) => Object.keys(id).find((k) => id[k] === x) ?? `foreign:${x}`);

  it("Design facet: Good = Excellent + Good (never provisional), Bad = Poor, OR within the facet", async () => {
    expect(keys(await idsOf(alice, all({ design: ["good"] }))).sort()).toEqual(["excellent", "good", "newsletter"]);
    expect(keys(await idsOf(alice, all({ design: ["bad"] })))).toEqual(["poor"]);
    expect(keys(await idsOf(alice, all({ design: ["needs_work"] })))).toEqual(["capped"]);
    expect(keys(await idsOf(alice, all({ design: ["provisional"] })))).toEqual(["provisional"]);
    expect(keys(await idsOf(alice, all({ design: ["plain_text"] })))).toEqual(["plain"]);
    // Not analysed: no score yet, but never plain text or skipped (security) mail.
    expect(keys(await idsOf(alice, all({ design: ["not_analysed"] })))).toEqual(["pending"]);
    expect(keys(await idsOf(alice, all({ design: ["good", "bad"] }))).sort()).toEqual(["excellent", "good", "newsletter", "poor"]);
  });

  it("smart views: Best designed ≥ 85 and not provisional; Bad design = Poor or capped", async () => {
    expect(keys(await idsOf(alice, all({ view: "best_designed" }))).sort()).toEqual(["excellent", "newsletter"]);
    expect(keys(await idsOf(alice, all({ view: "bad_design" }))).sort()).toEqual(["capped", "poor"]);
    expect(keys(await idsOf(alice, all({ view: "security" })))).toEqual(["security"]);
    expect(keys(await idsOf(alice, all({ view: "deals_ending" })))).toEqual(["pending"]);
    const counts = Object.fromEntries((await inbox.smartViewCounts(alice)).map((c) => [c.view, c.count]));
    expect(counts).toMatchObject({ best_designed: 2, bad_design: 2, security: 1, deals_ending: 1, suspicious: 0 });
    const bobCounts = Object.fromEntries((await inbox.smartViewCounts(bob)).map((c) => [c.view, c.count]));
    expect(bobCounts).toMatchObject({ best_designed: 2, bad_design: 1, security: 0, deals_ending: 0 });
  });

  it("issue chips, deals and scope", async () => {
    expect(keys(await idsOf(alice, all({ issues: ["contrast"] })))).toEqual(["capped"]);
    expect(keys(await idsOf(alice, all({ issues: ["contrast", "image_only"] })))).toEqual(["capped", "poor"]);
    expect(keys(await idsOf(alice, all({ deals: ["has_code"] })))).toEqual(["pending"]);
    expect(keys(await idsOf(alice, all({ deals: ["active"] })))).toEqual(["pending", "newsletter"]);
    expect(keys(await idsOf(alice, all({ deals: ["ending"] })))).toEqual(["pending"]);
    // The default scope is subscriptions: the security email is not one.
    expect(keys(await idsOf(alice, DEFAULT_FILTERS))).not.toContain("security");
    expect(keys(await idsOf(alice, all({ scope: "receipts" })))).toEqual(["security"]);
  });

  it("font family filter is case-insensitive, OR within, and 'Uses web fonts' is ANDed", async () => {
    expect(keys(await idsOf(alice, all({ fonts: ["montserrat"] }))).sort()).toEqual(["excellent", "good", "provisional"]);
    expect(keys(await idsOf(alice, all({ fonts: ["montserrat"], webFonts: true }))).sort()).toEqual(["excellent", "provisional"]);
    expect(keys(await idsOf(alice, all({ fonts: ["arial", "georgia"] }))).sort()).toEqual(["capped", "good", "newsletter", "poor"]);
    expect(keys(await idsOf(alice, all({ webFonts: true }))).sort()).toEqual(["excellent", "provisional"]);
    // Combined with the Design facet (AND across facets).
    expect(keys(await idsOf(alice, all({ fonts: ["montserrat"], design: ["good"] }))).sort()).toEqual(["excellent", "good"]);
    // A font only Bob has matches nothing for Alice.
    expect(await idsOf(alice, all({ fonts: ["comic sans ms"] }))).toEqual([]);
  });

  it("font options group spellings case-insensitively, with counts, and only from the caller's mail", async () => {
    const opts = await inbox.fontOptions(alice);
    const byKey = Object.fromEntries(opts.map((o) => [o.key, o]));
    expect(Object.keys(byKey).sort()).toEqual(["arial", "georgia", "montserrat"]);
    expect(byKey.montserrat?.count).toBe(3);
    expect(["MONTSERRAT", "Montserrat", "montserrat"]).toContain(byKey.montserrat?.label);
    expect(byKey.arial?.count).toBe(2);
    expect(byKey.georgia?.count).toBe(2);
    expect(opts[0]?.key).toBe("montserrat"); // most used first
    const bobOpts = await inbox.fontOptions(bob);
    expect(bobOpts.map((o) => [o.key, o.count]).sort()).toEqual([["comic sans ms", 3], ["montserrat", 3]]);
  });

  it("facet counts: every facet's counts ignore its own selection but apply the others", async () => {
    const none = await inbox.facetCounts(alice, all());
    expect(none.total).toBe(9);
    expect(none.design).toEqual({ good: 3, needs_work: 1, bad: 1, provisional: 1, plain_text: 1, not_analysed: 1 });
    expect(none.issues).toEqual({ image_only: 1, contrast: 1, mobile: 0, clipped: 0, broken_images: 0 });
    expect(none.types).toMatchObject({ promotions: 7, newsletters: 1, security: 1 });
    expect(none.deals).toEqual({ active: 2, ending: 1, has_code: 1 });

    const good = await inbox.facetCounts(alice, all({ design: ["good"] }));
    expect(good.total).toBe(3);
    // Own facet: unchanged, so the user can widen the selection.
    expect(good.design).toEqual(none.design);
    // Other facets: counted within Good design only.
    expect(good.types).toMatchObject({ promotions: 2, newsletters: 1, security: 0 });
    expect(good.issues).toEqual({ image_only: 0, contrast: 0, mobile: 0, clipped: 0, broken_images: 0 });
    expect(good.deals).toMatchObject({ active: 1, ending: 0 });

    const promosBad = await inbox.facetCounts(alice, all({ types: ["promotions"], design: ["bad"] }));
    expect(promosBad.total).toBe(1);
    expect(promosBad.design).toMatchObject({ good: 2, bad: 1, needs_work: 1, not_analysed: 1 });
    expect(promosBad.types).toMatchObject({ promotions: 1, newsletters: 0 });

    // Non-facet filters (fonts) narrow every count.
    const mont = await inbox.facetCounts(alice, all({ fonts: ["montserrat"] }));
    expect(mont.total).toBe(3);
    expect(mont.design).toMatchObject({ good: 2, provisional: 1, bad: 0 });
    // The list agrees with the total.
    expect((await idsOf(alice, all({ fonts: ["montserrat"] }))).length).toBe(mont.total);
  });

  it("facet counts (and their cache) are per user", async () => {
    const a = await inbox.facetCounts(alice, all({ design: ["bad"] }));
    const b = await inbox.facetCounts(bob, all({ design: ["bad"] }));
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect(b.design).toEqual({ good: 2, needs_work: 0, bad: 1, provisional: 0, plain_text: 0, not_analysed: 0 });
    expect(b.types).toMatchObject({ promotions: 1, security: 0, newsletters: 0 });
    const stranger = (await createUser(app)).id;
    const s = await inbox.facetCounts(stranger, all({ design: ["bad"] }));
    expect(s.total).toBe(0);
    expect(Object.values(s.design).every((n) => n === 0)).toBe(true);
  });

  it("a second user's ids in sender/mailbox filters, search or a cursor never reveal their mail", async () => {
    expect(await idsOf(alice, all({ senderId: bobSender }))).toEqual([]);
    expect(await idsOf(alice, all({ mailboxId: bobMb }))).toEqual([]);
    expect((await inbox.facetCounts(alice, all({ senderId: bobSender }))).total).toBe(0);
    // Bob searching for Alice's subject finds nothing; Alice finds her own.
    expect(await idsOf(bob, all(), "lookbook")).toEqual([]);
    expect(keys(await idsOf(alice, all(), "lookbook"))).toEqual(["excellent"]);
    // A cursor taken from Bob's list, replayed by Alice, only pages through Alice's mail.
    const bobPage = await inbox.listInbox(bob, all(), { limit: 1 });
    expect(bobPage.nextCursor).not.toBeNull();
    const replay = await inbox.listInbox(alice, all(), { cursor: bobPage.nextCursor, limit: 100 });
    expect(replay.items.every((i) => Object.values(id).includes(i.id))).toBe(true);
    // Garbage cursors fall back to the first page.
    const first = await inbox.listInbox(alice, all(), { limit: 2 });
    const junk = await inbox.listInbox(alice, all(), { cursor: "not-base64-json", limit: 2 });
    expect(junk.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
  });

  it("keyset pagination returns every row exactly once, in order, for every sort", async () => {
    const expected = {
      newest: ["excellent", "good", "capped", "poor", "provisional", "plain", "pending", "security", "newsletter"],
      oldest: ["newsletter", "security", "pending", "plain", "provisional", "poor", "capped", "good", "excellent"],
    };
    expect(keys(await idsOf(alice, all({ sort: "newest" })))).toEqual(expected.newest);
    expect(keys(await idsOf(alice, all({ sort: "oldest" })))).toEqual(expected.oldest);

    const byScore = keys(await idsOf(alice, all({ sort: "score" })));
    expect(byScore.slice(0, 6)).toEqual(["excellent", "newsletter", "good", "provisional", "capped", "poor"]);
    expect(byScore.slice(6).sort()).toEqual(["pending", "plain", "security"]); // no score: last, still paged
    const byImportance = keys(await idsOf(alice, all({ sort: "importance" })));
    expect(new Set(byImportance).size).toBe(9);
    const byDeal = keys(await idsOf(alice, all({ sort: "deal_ending" })));
    expect(byDeal).toEqual(["pending", "newsletter"]); // only emails with a deal, soonest first
  });

  it("list items hide the snippet of security-sensitive mail and pin pinned mail on the first page", async () => {
    const page = await inbox.listInbox(alice, all({ view: "security" }));
    expect(page.items[0]?.snippet).toBeNull();
    const { withUser } = await import("@edf/db");
    await withUser(app, alice, (_db, c) => c.query("UPDATE email SET pinned_at = now() WHERE id = $1", [id.poor]));
    try {
      const first = await inbox.listInbox(alice, all(), { limit: 2 });
      expect(keys(first.pinned.map((i) => i.id))).toEqual(["poor"]);
      const second = await inbox.listInbox(alice, all(), { limit: 2, cursor: first.nextCursor });
      expect(second.pinned).toEqual([]);
      // Bob never sees Alice's pin.
      expect((await inbox.listInbox(bob, all())).pinned).toEqual([]);
    } finally {
      await withUser(app, alice, (_db, c) => c.query("UPDATE email SET pinned_at = NULL WHERE id = $1", [id.poor]));
    }
  });

  it("muted senders' mail is hidden from lists, counts, fonts and smart views", async () => {
    const carol = (await createUser(app)).id;
    const mb = await createMailbox(app, carol);
    const e = await seedEmail(app, carol, mb, { ...fromSender(`m-${randomUUID().slice(0, 6)}@muted.example`), ...scored(20, "poor", { fontFamilies: ["Papyrus"] }) });
    const { withUser } = await import("@edf/db");
    const sid = await senderIdOf(owner, e);
    expect((await inbox.fontOptions(carol)).map((o) => o.key)).toEqual(["papyrus"]);
    await withUser(app, carol, async (_db, c) => {
      await c.query("UPDATE sender SET muted = true WHERE id = $1", [sid]);
      await c.query("UPDATE email SET sender_muted = true WHERE sender_id = $1", [sid]);
    });
    expect(await idsOf(carol, all())).toEqual([]);
    expect((await inbox.facetCounts(carol, all({ design: ["bad"] }))).total).toBe(0);
    expect(await inbox.fontOptions(carol)).toEqual([]);
    expect((await inbox.smartViewCounts(carol)).find((v) => v.view === "bad_design")?.count).toBe(0);
  });
});
