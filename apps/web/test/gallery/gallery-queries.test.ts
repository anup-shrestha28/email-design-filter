/**
 * Design gallery queries and actions against the real database (queries/gallery.ts,
 * actions/gallery.ts):
 *  - never listed: security-sensitive, plain-text and hidden mail; a disconnected mailbox's emails
 *    are listed but not previewable
 *  - cards, the Good / Bad filters and Best / Worst read the saved design checklist (the verdict
 *    rules themselves, at every edge, are gallery-checklist-sql.test.ts)
 *  - a page past the end (or a hand-made page number) clamps to the last page
 *  - SQL category filters agree with galleryCategoryOf() for every core type/subtype
 *  - numbered pages return every row exactly once, in order, for every sort and page size (ties, nulls, µs)
 *  - facet counts respect the OTHER active filters and the search
 *  - tenant isolation: another user's ids never produce rows or preview URLs
 *  - preview URLs are signed edf-view "img" URLs for the caller's own emails, ≤ 48 per call
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { EMAIL_SUBTYPES, EMAIL_TYPES } from "@edf/core/types";
import type { EmailRecord } from "@edf/pipeline";
import { parseViewToken, verifyViewToken } from "@edf/crypto";
import type * as GalleryQueries from "@/server/queries/gallery";
import type * as GalleryActions from "@/server/actions/gallery";
import type { GalleryItem } from "@/server/queries/types";
import {
  checklistReason,
  DEFAULT_GALLERY_PARAMS,
  EMAIL_GALLERY_CATEGORY_IDS,
  GALLERY_SHOWN_CATEGORIES,
  galleryCategoryOf,
  isShownCategory,
  type GalleryParams,
} from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { checklistOf } from "../support/checklist";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, fromSender, sessionFor } from "../tests-server/helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const HOUR = 3_600_000;
type Summary = {
  needsImprovement: Array<{ key: string; title: string; points: number; ai: boolean }>;
  good: Array<{ key: string; title: string; points: number; ai: boolean }>;
};
const summary = (needs: string[], good: string[], capKey?: string): Summary => ({
  needsImprovement: [
    ...(capKey
      ? [
          {
            key: `cap:${capKey}`,
            title: `Cap problem ${capKey} (score capped at 59)`,
            points: 9,
            ai: false,
          },
        ]
      : []),
    ...needs.map((t, i) => ({ key: `check:N${i}`, title: t, points: 1, ai: false })),
  ],
  good: good.map((t, i) => ({ key: `check:G${i}`, title: t, points: 1, ai: false })),
});

/** Checklists for the fixtures: every rule passed (Good), one missed (Okay), three missed (Bad). */
const GOOD = checklistOf();
const OKAY = checklistOf({ width: "miss" });
const BAD = checklistOf({ button: "miss", cta: "miss", body: "miss" });

/**
 * A scored design. Its saved checklist gives the verdict these scores had before the checklist
 * (85+ Good, capped or under 60 Bad, else Okay), so the list, filter and sort tests keep their
 * shape; `checklist` overrides it.
 */
function scored(
  score: number | null,
  band: EmailRecord["designBand"],
  opts: {
    capped?: boolean;
    provisional?: boolean;
    issues?: EmailRecord["designIssues"];
    summary?: Summary;
    caps?: string[];
    confidence?: number;
    source?: EmailRecord["designSource"];
    checklist?: unknown;
  } = {},
): Partial<EmailRecord> {
  const checklist =
    opts.checklist !== undefined
      ? opts.checklist
      : score === null
        ? undefined
        : score >= 85
          ? GOOD
          : opts.capped || score < 60
            ? BAD
            : OKAY;
  return {
    designStatus: "done",
    designSource: opts.source ?? (score === null ? "static" : "render"),
    designScore: score,
    designBand: band,
    designCapped: score === null ? null : (opts.capped ?? false),
    designProvisional: score === null ? null : (opts.provisional ?? false),
    designIssues: opts.issues ?? [],
    designConfidence: score === null ? null : "high",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      features: null,
      checks: [],
      pillarScores: [],
      rawScore: score,
      caps: opts.caps ?? [],
      confidence: opts.confidence ?? 0.9,
      trust: {},
      scoreSummary: {
        ...(opts.summary ?? summary([], [])),
        ...(checklist === undefined ? {} : { checklist }),
      },
      aiReview: null,
      aiModel: null,
      renderRefEmailId: null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    },
  };
}

const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
  ...DEFAULT_GALLERY_PARAMS,
  ...over,
});

describe.skipIf(!HAS_DB)("design gallery against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let q: typeof GalleryQueries;
  let actions: typeof GalleryActions;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;
  let aliceMb: string;
  let pausedMb: string;
  const id: Record<string, string> = {};
  const now = Date.now();
  const at = (h: number) => new Date(now - h * HOUR);

  async function all(userId: string, p: GalleryParams): Promise<GalleryItem[]> {
    const out: GalleryItem[] = [];
    for (let n = 1; n <= 50; n++) {
      const page = await q.listGallery(userId, { ...p, page: n });
      expect(page.page).toBe(n);
      expect(page.items.length).toBeLessThanOrEqual(page.pageSize);
      out.push(...page.items);
      if (n >= page.pageCount) break;
      expect(page.items).toHaveLength(page.pageSize);
    }
    return out;
  }

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    q = await import("@/server/queries/gallery");
    actions = await import("@/server/actions/gallery");
    alice = await createUser(app, { role: "owner" });
    bob = await createUser(app, { role: "friend" });
    aliceMb = await createMailbox(app, alice.id);
    pausedMb = await createMailbox(app, alice.id, { status: "paused" });
    const bobMb = await createMailbox(app, bob.id);
    const seed = (
      key: string,
      h: number,
      over: Partial<EmailRecord>,
      mb = aliceMb,
      user = alice.id,
    ) =>
      seedEmail(app, user, mb, {
        receivedAt: at(h),
        subject: key,
        searchText: `${key} gallery`,
        ...over,
      }).then((x) => (id[key] = x));

    // Verdict boundaries.
    await seed("good85", 1, {
      ...scored(85, "excellent", {
        summary: summary(["Minor nit"], ["Clear main button", "Readable text"]),
      }),
      fontFamilies: ["Inter", "Georgia"],
      ...fromSender("hi@goodco.example", { displayName: "Good Co" }),
    });
    await seed("ok84", 2, {
      ...scored(84, "good", { summary: summary(["Small images lack alt text"], ["Nice layout"]) }),
      fontFamilies: ["inter"],
      primaryType: "product_update",
      subtype: "release_notes",
    });
    await seed("capped", 3, {
      ...scored(59, "needs_work", {
        capped: true,
        issues: ["contrast"],
        caps: ["CAP_CONTRAST"],
        summary: summary(["Other thing"], ["Something good"], "CAP_CONTRAST"),
      }),
      fontFamilies: ["Arial"],
    });
    await seed("poor", 4, {
      ...scored(40, "poor", { summary: summary(["Text is tiny on phones"], []) }),
      fontFamilies: ["Arial"],
      primaryType: "product_update",
      subtype: "announcement",
    });
    // Provisional only because the email TYPE is unsure (design coverage 0.9): still Good.
    await seed("provGood", 5, {
      ...scored(95, "excellent", { provisional: true }),
      primaryType: "lifecycle",
      subtype: "welcome",
    });
    // A poor score is Bad even when provisional.
    await seed("provPoor", 6, {
      ...scored(30, "poor", { provisional: true }),
      primaryType: "lifecycle",
      subtype: "welcome",
    });
    await seed("unscored", 7, {
      ...scored(null, null),
      fontFamilies: [],
      primaryType: "promotional",
      subtype: "cart_reminder",
    });
    // Listed but not previewable: its mailbox is paused.
    await seed("pausedMb", 8, scored(90, "excellent"), pausedMb);
    // Never listed.
    await seed("security", 9, {
      ...scored(null, null),
      designStatus: "skipped",
      designSource: "none",
      securitySensitive: true,
      primaryType: "account_security",
      subtype: "password_reset",
    });
    await seed("securityDone", 10, { ...scored(90, "excellent"), securitySensitive: true });
    await seed("plain", 11, {
      ...scored(null, null),
      designStatus: "plain_text",
      designSource: "none",
      htmlBytes: 0,
    });
    await seed("trashed", 12, scored(90, "excellent"));
    await owner.query("UPDATE email SET in_trash = true WHERE id = $1", [id.trashed]);
    // Bob's email, same shape as Alice's best one.
    await seed(
      "bobs",
      1,
      { ...scored(99, "excellent"), searchText: "bobs gallery" },
      bobMb,
      bob.id,
    );
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  beforeEach(() => {
    state.session = null;
  });

  it("lists designed mail only: no security-sensitive, plain-text or hidden emails", async () => {
    const items = await all(alice.id, params());
    const subjects = items.map((i) => i.subject);
    expect(subjects).toEqual([
      "good85",
      "ok84",
      "capped",
      "poor",
      "provGood",
      "provPoor",
      "unscored",
      "pausedMb",
    ]);
    for (const hidden of ["security", "securityDone", "plain", "trashed", "bobs"])
      expect(subjects).not.toContain(hidden);
  });

  it("maps each card: verdict, reason, lists, fonts, sender, category, previewable", async () => {
    const items = new Map((await all(alice.id, params())).map((i) => [i.subject, i]));
    const good = items.get("good85")!;
    expect(good).toMatchObject({
      id: id.good85,
      verdict: "good",
      score: 85,
      band: "excellent",
      category: "promotions",
      sender: { name: "Good Co", domain: "goodco.example" },
      fonts: ["Inter", "Georgia"],
      previewable: true,
      reason: { kind: "strength", text: "Passes all 16 design rules" },
      problems: [],
      strengths: checklistReason(GOOD).strengths,
    });
    expect(new Date(good.receivedAt).toISOString()).toBe(good.receivedAt);
    expect(items.get("ok84")).toMatchObject({
      verdict: "ok",
      category: "product_updates",
      reason: { kind: "problem", text: "Misses 1 rule: not about 600px wide" },
    });
    // The card's line and lists come from the checklist, never the engine's summary lists.
    expect(items.get("capped")).toMatchObject({
      verdict: "bad",
      reason: {
        kind: "problem",
        text: "Misses 3 rules: no single main button, body text hard to read, button vague or hard to see",
      },
      problems: checklistReason(BAD).problems,
    });
    expect(items.get("poor")).toMatchObject({ verdict: "bad" });
    expect(items.get("provGood")).toMatchObject({ verdict: "good", category: "welcome" });
    expect(items.get("provPoor")).toMatchObject({ verdict: "bad" });
    expect(items.get("unscored")).toMatchObject({
      verdict: "unscored",
      score: null,
      reason: null,
      problems: [],
      strengths: [],
      category: "abandoned_cart",
    });
    expect(items.get("pausedMb")).toMatchObject({ previewable: false });
  });

  it("design filters use the strict verdicts", async () => {
    const subjects = async (design: GalleryParams["design"]) =>
      (await all(alice.id, params({ design }))).map((i) => i.subject);
    expect(await subjects("good")).toEqual(["good85", "provGood", "pausedMb"]);
    expect(await subjects("bad")).toEqual(["capped", "poor", "provPoor"]);
  });

  it("category, font and search filters", async () => {
    const subjects = async (p: Partial<GalleryParams>) =>
      (await all(alice.id, params(p))).map((i) => i.subject);
    expect(await subjects({ category: "product_updates" })).toEqual(["ok84", "poor"]);
    expect(await subjects({ category: "welcome" })).toEqual(["provGood", "provPoor"]);
    expect(await subjects({ category: "abandoned_cart" })).toEqual(["unscored"]);
    expect(await subjects({ font: "INTER" })).toEqual(["good85", "ok84"]);
    expect(await subjects({ font: "Arial", design: "bad" })).toEqual(["capped", "poor"]);
    expect(await subjects({ q: "capp" })).toEqual(["capped"]);
    expect(await subjects({ q: "bobs" })).toEqual([]);
    expect(await subjects({ category: "product_updates", font: "Georgia" })).toEqual([]);
  });

  it("facet counts respect the other active filters", async () => {
    const f = await q.galleryFacets(alice.id, params());
    expect(f.categories).toEqual({
      all: 8,
      newsletters: 0,
      promotions: 3,
      social: 0,
      notifications: 0,
      welcome: 2,
      abandoned_cart: 1,
      product_updates: 2,
      receipts: 0,
      other: 0,
    });
    expect(f.design).toEqual({ all: 8, good: 3, bad: 3 });
    expect(f.fonts).toEqual([
      { name: "Montserrat", count: 3 },
      { name: "Arial", count: 2 },
      { name: "Inter", count: 2 },
      { name: "Georgia", count: 1 },
    ]);
    // Category selected: design + fonts narrow to it, category counts don't.
    const news = await q.galleryFacets(alice.id, params({ category: "product_updates" }));
    expect(news.categories.all).toBe(8);
    expect(news.categories.product_updates).toBe(2);
    expect(news.design).toEqual({ all: 2, good: 0, bad: 1 });
    expect(news.fonts.map((x) => x.name).sort()).toEqual(["Arial", "inter"]);
    // Design selected: categories + fonts narrow to it, design counts don't.
    const bad = await q.galleryFacets(alice.id, params({ design: "bad" }));
    expect(bad.design).toEqual({ all: 8, good: 3, bad: 3 });
    expect(bad.categories).toMatchObject({ all: 3, product_updates: 1, promotions: 1, welcome: 1 });
    expect(bad.fonts).toEqual([
      { name: "Arial", count: 2 },
      { name: "Montserrat", count: 1 },
    ]);
    // Font selected: the font list itself ignores it.
    const inter = await q.galleryFacets(alice.id, params({ font: "inter" }));
    expect(inter.fonts).toEqual(f.fonts);
    expect(inter.categories).toMatchObject({ all: 2, promotions: 1, product_updates: 1 });
    expect(inter.design).toEqual({ all: 2, good: 1, bad: 0 });
    // Search narrows everything.
    const search = await q.galleryFacets(alice.id, params({ q: "poor" }));
    expect(search.categories.all).toBe(1);
    expect(search.design).toEqual({ all: 1, good: 0, bad: 1 });
  });

  it("SQL category filters agree with galleryCategoryOf for every core type and subtype; only the marketing ones are listed", async () => {
    const carol = await createUser(app);
    const mb = await createMailbox(app, carol.id);
    const pairs = EMAIL_TYPES.flatMap((t) =>
      [null, ...(EMAIL_SUBTYPES[t] as readonly string[])].map((s) => [t, s] as const),
    );
    const expected = Object.fromEntries(EMAIL_GALLERY_CATEGORY_IDS.map((c) => [c, 0])) as Record<
      string,
      number
    >;
    for (const [i, [t, s]] of pairs.entries()) {
      await seedEmail(app, carol.id, mb, {
        ...scored(70, "good"),
        primaryType: t,
        subtype: s,
        receivedAt: at(i),
        subject: `${t}/${s}`,
      });
      expected[galleryCategoryOf(t, s)]!++;
    }
    // Only the shown (marketing) categories are listed or counted; every other type is left out.
    const listed = Object.fromEntries(
      EMAIL_GALLERY_CATEGORY_IDS.map((c) => [c, isShownCategory(c) ? expected[c]! : 0]),
    ) as Record<string, number>;
    const shownTotal = Object.values(listed).reduce((a, b) => a + b, 0);
    expect(shownTotal).toBeGreaterThan(0);
    expect(shownTotal).toBeLessThan(pairs.length);
    const f = await q.galleryFacets(carol.id, params());
    expect(f.categories).toEqual({ all: shownTotal, ...listed });
    const everything = await all(carol.id, params());
    expect(everything).toHaveLength(shownTotal);
    for (const it of everything) expect(isShownCategory(it.category), it.subject ?? "").toBe(true);
    for (const c of GALLERY_SHOWN_CATEGORIES) {
      const items = await all(carol.id, params({ category: c }));
      expect(items.length, c).toBe(expected[c]);
      for (const it of items) expect(it.category).toBe(c);
    }
  });

  it("numbered pages return every row exactly once, in order, for every sort and page size", async () => {
    const dave = await createUser(app);
    const mb = await createMailbox(app, dave.id);
    const scores = [null, 100, 85, 85, 84, 59, 40, 0, null, 70];
    for (let i = 0; i < 70; i++) {
      const s = scores[i % scores.length]!;
      const band =
        s === null
          ? null
          : s >= 85
            ? "excellent"
            : s >= 70
              ? "good"
              : s >= 50
                ? "needs_work"
                : "poor";
      // Several emails share a received_at, so the id tie-breaker matters.
      await seedEmail(app, dave.id, mb, {
        ...scored(s, band),
        receivedAt: at(Math.floor(i / 3)),
        subject: `p${i}`,
      });
    }
    // Two emails within the same millisecond (µs apart): paging must not skip either.
    await owner.query(
      `UPDATE email SET received_at = received_at + (interval '1 microsecond' * (CASE subject WHEN 'p0' THEN 7 WHEN 'p1' THEN 3 ELSE 0 END))
       WHERE user_id = $1 AND subject IN ('p0', 'p1')`,
      [dave.id],
    );
    const truth = await owner.query<{
      id: string;
      design_score: number | null;
      received_at: string;
    }>(
      "SELECT id, design_score, received_at::text AS received_at, extract(epoch from received_at) * 1000000 AS us FROM email WHERE user_id = $1",
      [dave.id],
    );
    const rows = truth.rows.map((r) => ({ ...r, us: Number((r as unknown as { us: string }).us) }));
    const byNewest = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      b.us - a.us || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const expected = {
      newest: [...rows].sort(byNewest),
      best: [...rows].sort(
        (a, b) => (b.design_score ?? -1) - (a.design_score ?? -1) || byNewest(a, b),
      ),
      worst: [...rows].sort(
        (a, b) => (a.design_score ?? 101) - (b.design_score ?? 101) || byNewest(a, b),
      ),
    };
    for (const sort of ["newest", "best", "worst"] as const) {
      for (const size of [24, 48, 96] as const) {
        const items = await all(dave.id, params({ sort, size }));
        expect(
          items.map((i) => i.id),
          `${sort} × ${size}`,
        ).toEqual(expected[sort].map((r) => r.id));
        expect(new Set(items.map((i) => i.id)).size).toBe(70);
      }
    }
    const first = await q.listGallery(dave.id, params());
    expect(first).toMatchObject({ total: 70, page: 1, pageSize: 24, pageCount: 3 });
    // Page 3 of 3 holds the last 22; a page past the end (or a huge hand-made one) is the last page.
    for (const page of [3, 4, 9999]) {
      const last = await q.listGallery(dave.id, params({ page }));
      expect(last).toMatchObject({ page: 3, pageCount: 3, total: 70 });
      expect(last.items.map((i) => i.id)).toEqual(expected.newest.slice(48).map((r) => r.id));
    }
    // New mail arriving shifts every page by one — nothing is lost between pages.
    await seedEmail(app, dave.id, mb, {
      ...scored(90, "excellent"),
      receivedAt: new Date(),
      subject: "new arrival",
    });
    const second = await q.listGallery(dave.id, params({ page: 2 }));
    expect(second.items[0]!.id).toBe(expected.newest[23]!.id);
    expect(second.total).toBe(71);
  });

  it("Best / Worst sort by verdict first, then score, across pages (a Bad 69 never outranks an Okay 65)", async () => {
    const erin = await createUser(app);
    const mb = await createMailbox(app, erin.id);
    const kinds = [
      { s: 69, band: "needs_work", capped: true, caps: ["CAP_MERGE_TAG"] },
      { s: 65, band: "needs_work" }, // Okay: over the Bad floor (60), no severe problem
      { s: 90, band: "excellent" },
      { s: 40, band: "poor" },
    ] as const;
    for (let i = 0; i < 36; i++) {
      const k = kinds[i % kinds.length]!;
      await seedEmail(app, erin.id, mb, {
        ...scored(k.s, k.band, "capped" in k ? { capped: true, caps: [...k.caps] } : {}),
        receivedAt: at(i),
        subject: `v${i}`,
      });
    }
    const rank = { bad: 0, ok: 1, good: 2, unscored: -1 } as const;
    const best = await all(erin.id, params({ sort: "best" }));
    const worst = await all(erin.id, params({ sort: "worst" }));
    expect(best).toHaveLength(36);
    expect(new Set(best.map((i) => i.id)).size).toBe(36);
    const key = (i: (typeof best)[number]) => rank[i.verdict] * 1000 + (i.score ?? 0);
    for (let i = 1; i < best.length; i++)
      expect(key(best[i - 1]!)).toBeGreaterThanOrEqual(key(best[i]!));
    for (let i = 1; i < worst.length; i++)
      expect(key(worst[i - 1]!)).toBeLessThanOrEqual(key(worst[i]!));
    expect(worst.slice(0, 9).every((i) => i.score === 40)).toBe(true);
    expect(worst[9]!.score).toBe(69); // Bad before any Okay
    expect(worst[18]!.verdict).toBe("ok");
  });

  it("isolation: another user's gallery, facets and preview ids never include Alice's emails", async () => {
    const bobItems = await all(bob.id, params());
    expect(bobItems.map((i) => i.subject)).toEqual(["bobs"]);
    expect((await q.galleryFacets(bob.id, params())).categories.all).toBe(1);
    expect(await q.previewableIds(bob.id, [id.good85!, id.ok84!])).toEqual([]);
    expect(await q.previewableIds(alice.id, [id.bobs!])).toEqual([]);
  });

  describe("actions", () => {
    it("refuse without a session", async () => {
      await expect(actions.galleryPreviewUrls([id.good85!])).rejects.toThrow();
    });

    it("galleryPreviewUrls signs 240 s edf-view 'card' URLs (the grid) for the caller's previewable emails only", async () => {
      state.session = sessionFor(alice);
      const { viewKeys } = await import("@/server/keys");
      const { env } = await import("@/env");
      const asked = [
        id.good85!,
        id.unscored!,
        id.security!,
        id.securityDone!,
        id.plain!,
        id.trashed!,
        id.pausedMb!,
        id.bobs!,
        "nope",
        randomUUID(),
      ];
      const urls = await actions.galleryPreviewUrls(asked);
      expect(Object.keys(urls).sort()).toEqual([id.good85!, id.unscored!].sort());
      const nowSec = Math.floor(Date.now() / 1000);
      for (const [emailId, url] of Object.entries(urls)) {
        const m = new RegExp(
          `^${env()
            .VIEW_ORIGIN.replace(/\/$/, "")
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/v/([^/]+)/${emailId}$`,
        ).exec(url);
        expect(m, url).not.toBeNull();
        const token = m![1]!;
        expect(verifyViewToken(viewKeys(), token, { userId: alice.id, emailId, nowSec })).toEqual({
          mode: "card",
        });
        expect(verifyViewToken(viewKeys(), token, { userId: bob.id, emailId, nowSec })).toBeNull();
        const exp = parseViewToken(token)!.exp;
        expect(exp - nowSec).toBeGreaterThan(230);
        expect(exp - nowSec).toBeLessThanOrEqual(241);
      }
      // Bob asking for Alice's ids gets nothing.
      state.session = sessionFor(bob);
      expect(await actions.galleryPreviewUrls([id.good85!, id.unscored!])).toEqual({});
      expect(Object.keys(await actions.galleryPreviewUrls([id.bobs!]))).toEqual([id.bobs]);
    });

    it("galleryPreviewUrls(ids, 'img') signs full-image URLs for the opened design; anything else is a card", async () => {
      state.session = sessionFor(alice);
      const { viewKeys } = await import("@/server/keys");
      const nowSec = Math.floor(Date.now() / 1000);
      const modeOf = (url: string) => {
        const token = /\/v\/([^/]+)\//.exec(url)![1]!;
        return verifyViewToken(viewKeys(), token, { userId: alice.id, emailId: id.good85!, nowSec })
          ?.mode;
      };
      expect(modeOf((await actions.galleryPreviewUrls([id.good85!], "img"))[id.good85!]!)).toBe(
        "img",
      );
      expect(
        modeOf((await actions.galleryPreviewUrls([id.good85!], "noimg" as never))[id.good85!]!),
      ).toBe("card");
    });

    it("galleryPreviewUrls honours the governor's image switch: images off (noimg) until the opened design asks", async () => {
      const { viewKeys } = await import("@/server/keys");
      const nowSec = Math.floor(Date.now() / 1000);
      const modeOf = (userId: string, emailId: string, url: string | undefined) => {
        const token = /\/v\/([^/]+)\//.exec(url ?? "")?.[1] ?? "";
        return verifyViewToken(viewKeys(), token, { userId, emailId, nowSec })?.mode;
      };
      const saved =
        (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]
          ?.value ?? null;
      const setGovernor = (value: unknown) =>
        owner.query(
          `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify(value)],
        );
      const modes = async (user: typeof alice, emailId: string) => {
        state.session = sessionFor(user);
        return [
          modeOf(user.id, emailId, (await actions.galleryPreviewUrls([emailId]))[emailId]),
          modeOf(user.id, emailId, (await actions.galleryPreviewUrls([emailId], "img"))[emailId]),
          modeOf(
            user.id,
            emailId,
            (await actions.galleryPreviewUrls([emailId], "img", { loadImages: true }))[emailId],
          ),
        ];
      };
      try {
        await setGovernor({ level: 0, actions: {} });
        expect(await modes(alice, id.good85!)).toEqual(["card", "img", "img"]);
        expect(await modes(bob, id.bobs!)).toEqual(["card", "img", "img"]);
        // Fast Origin Transfer soft level: friends' images are click-to-load, the owner's aren't.
        await setGovernor({ level: 0, actions: { friendsImagesClickToLoad: true } });
        expect(await modes(alice, id.good85!)).toEqual(["card", "img", "img"]);
        expect(await modes(bob, id.bobs!)).toEqual(["noimg", "noimg", "img"]);
        // CPU/Neon pressure (L2) alone leaves pictures on: only FOT or the L3 freeze turns them off.
        await setGovernor({ level: 2, actions: {} });
        expect(await modes(alice, id.good85!)).toEqual(["card", "img", "img"]);
        expect(await modes(bob, id.bobs!)).toEqual(["card", "img", "img"]);
        // FOT self-cap: everyone's.
        await setGovernor({ level: 2, actions: { imagesClickToLoad: true, friendsImagesClickToLoad: true } });
        expect(await modes(alice, id.good85!)).toEqual(["noimg", "noimg", "img"]);
        // "Load images" is for one opened design, never a batch of cards.
        state.session = sessionFor(alice);
        const two = await actions.galleryPreviewUrls([id.good85!, id.unscored!], "img", {
          loadImages: true,
        });
        expect(modeOf(alice.id, id.good85!, two[id.good85!])).toBe("noimg");
      } finally {
        await setGovernor(saved ?? { level: 0 });
      }
    });

    it("galleryPreviewUrls answers at most 48 ids per call", async () => {
      const erin = await createUser(app);
      const mb = await createMailbox(app, erin.id);
      const ids: string[] = [];
      for (let i = 0; i < 50; i++)
        ids.push(await seedEmail(app, erin.id, mb, { ...scored(70, "good"), receivedAt: at(i) }));
      state.session = sessionFor(erin);
      const urls = await actions.galleryPreviewUrls(ids);
      expect(Object.keys(urls)).toHaveLength(48);
      expect(Object.keys(urls).sort()).toEqual(ids.slice(0, 48).sort());
      expect(await actions.galleryPreviewUrls([])).toEqual({});
      expect(await actions.galleryPreviewUrls("x" as unknown as string[])).toEqual({});
    });
  });
});
