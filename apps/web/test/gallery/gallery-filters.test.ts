/**
 * The gallery's numbered pages and Filters panel against the real database (queries/gallery.ts):
 *  - pages: OFFSET / LIMIT over a total order, a page past the end clamps to the last page
 *  - score range, date received (relative and custom days in the user's own zone), senders,
 *    problems (any of), mailbox, web fonts — alone and combined
 *  - facet counts for senders, problems, mailboxes and web fonts respect the OTHER filters
 *  - another user's sender / mailbox ids never match anything
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as GalleryQueries from "@/server/queries/gallery";
import type { GalleryItem } from "@/server/queries/types";
import { DEFAULT_GALLERY_PARAMS, type GalleryParams } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { fromSender } from "../tests-server/helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function scored(
  score: number | null,
  band: EmailRecord["designBand"],
  issues: EmailRecord["designIssues"] = [],
): Partial<EmailRecord> {
  return {
    designStatus: "done",
    designSource: score === null ? "static" : "render",
    designScore: score,
    designBand: band,
    designCapped: score === null ? null : false,
    designProvisional: score === null ? null : false,
    designIssues: issues,
    designConfidence: score === null ? null : "high",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      features: null,
      checks: [],
      pillarScores: [],
      rawScore: score,
      caps: [],
      confidence: 0.9,
      trust: {},
      scoreSummary: { needsImprovement: [], good: [] },
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

describe.skipIf(!HAS_DB)("gallery pages and advanced filters against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let q: typeof GalleryQueries;
  let fay: Awaited<ReturnType<typeof createUser>>;
  let gus: Awaited<ReturnType<typeof createUser>>;
  let mb1: string;
  let mb2: string;
  let gusMb: string;
  const sender: Record<string, string> = {};
  let gusSender: string;
  const now = Date.now();
  /** A calendar day 200 days ago, and two emails either side of its midnight in Kathmandu (+05:45). */
  const day = new Date(now - 200 * DAY).toISOString().slice(0, 10);
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);

  async function all(userId: string, p: GalleryParams): Promise<GalleryItem[]> {
    const out: GalleryItem[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await q.listGallery(userId, { ...p, page });
      out.push(...r.items);
      if (page >= r.pageCount) break;
    }
    return out;
  }
  const subjects = async (p: Partial<GalleryParams>, userId = fay.id) =>
    (await all(userId, params(p))).map((i) => i.subject);

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    q = await import("@/server/queries/gallery");
    fay = await createUser(app);
    gus = await createUser(app);
    mb1 = await createMailbox(app, fay.id, { address: `fay-${fay.id}@gmail.example` });
    mb2 = await createMailbox(app, fay.id, { address: `fay2-${fay.id}@gmail.example` });
    gusMb = await createMailbox(app, gus.id);
    await owner.query("UPDATE user_settings SET timezone = 'Asia/Kathmandu' WHERE user_id = $1", [
      fay.id,
    ]);
    const linkedin = fromSender("jobs@linkedin.example", { displayName: "LinkedIn" });
    const shop = fromSender("hi@shop.example", { displayName: "Shop" });
    const news = fromSender("daily@news.example", { displayName: "News" });
    const seed = (subject: string, receivedAt: Date, over: Partial<EmailRecord>, mb = mb1) =>
      seedEmail(app, fay.id, mb, { subject, searchText: subject, receivedAt, ...over });
    await seed("a1", new Date(now - 1 * DAY), {
      ...scored(90, "excellent"),
      ...linkedin,
      usesWebFonts: true,
    });
    await seed("a2", new Date(now - 10 * DAY), {
      ...scored(40, "poor", ["contrast", "mobile"]),
      ...linkedin,
      usesWebFonts: false,
    });
    await seed(
      "a3",
      new Date(now - 40 * DAY),
      { ...scored(60, "needs_work", ["image_only"]), ...shop, usesWebFonts: true },
      mb2,
    );
    await seed(
      "a4",
      new Date(now - 100 * DAY),
      { ...scored(null, null), ...shop, usesWebFonts: false },
      mb2,
    );
    await seed("a5", new Date(now - 2 * DAY), {
      ...scored(75, "good"),
      ...news,
      usesWebFonts: false,
    });
    // 00:15 on `day` in Kathmandu (the previous day in UTC), and 23:45 the evening before.
    await seed("a6", new Date(midnightUtc - 5.5 * HOUR), { ...scored(80, "good"), ...news });
    await seed("a7", new Date(midnightUtc - 6 * HOUR), { ...scored(80, "good"), ...news });
    await seedEmail(app, gus.id, gusMb, {
      ...scored(90, "excellent"),
      ...linkedin,
      subject: "gus",
      receivedAt: new Date(now - DAY),
    });
    const ids = await owner.query<{ id: string; address: string; user_id: string }>(
      "SELECT id, address::text AS address, user_id FROM sender WHERE user_id IN ($1, $2)",
      [fay.id, gus.id],
    );
    for (const r of ids.rows) {
      if (r.user_id === fay.id) sender[r.address.split("@")[1]!.split(".")[0]!] = r.id;
      else gusSender = r.id;
    }
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it("no advanced filter: everything, newest first", async () => {
    expect(await subjects({})).toEqual(["a1", "a5", "a2", "a3", "a4", "a7", "a6"].sort(byAge));
  });

  it("score range: inclusive, and unscored designs only show with the full range", async () => {
    expect(await subjects({ smin: 60, smax: 80 })).toEqual(["a5", "a3", "a7", "a6"].sort(byAge));
    expect(await subjects({ smin: 0, smax: 40 })).toEqual(["a2"]);
    expect(await subjects({ smin: 90, smax: 100 })).toEqual(["a1"]);
    expect(await subjects({ smin: 0, smax: 100 })).toContain("a4");
  });

  it("date received: last 7 / 30 / 90 days, and custom days in the user's own time zone", async () => {
    expect(await subjects({ date: "7d" })).toEqual(["a1", "a5"]);
    expect(await subjects({ date: "30d" })).toEqual(["a1", "a5", "a2"]);
    expect(await subjects({ date: "90d" })).toEqual(["a1", "a5", "a2", "a3"]);
    // Both emails are on the day before in UTC; in Kathmandu only a6 is on `day`.
    expect(await subjects({ date: "custom", since: day, until: day })).toEqual(["a6"]);
    expect(await subjects({ date: "custom", since: null, until: day })).toEqual(
      ["a7", "a6"].sort(byAge),
    );
    const next = new Date(midnightUtc + DAY).toISOString().slice(0, 10);
    expect(await subjects({ date: "custom", since: next, until: null })).toEqual([
      "a1",
      "a5",
      "a2",
      "a3",
      "a4",
    ]);
  });

  it("senders, problems (any of), mailbox and web fonts", async () => {
    expect(await subjects({ sender: [sender.linkedin!] })).toEqual(["a1", "a2"]);
    expect(await subjects({ sender: [sender.linkedin!, sender.shop!] })).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
    expect(await subjects({ problem: ["contrast"] })).toEqual(["a2"]);
    expect(await subjects({ problem: ["image_only", "mobile"] })).toEqual(["a2", "a3"]);
    expect(await subjects({ problem: ["clipped"] })).toEqual([]);
    expect(await subjects({ mailbox: mb2 })).toEqual(["a3", "a4"]);
    expect(await subjects({ webfonts: "yes" })).toEqual(["a1", "a3", "a7", "a6"].sort(byAge));
    expect(await subjects({ webfonts: "no" })).toEqual(["a5", "a2", "a4"]);
    // Combined: every filter narrows.
    expect(await subjects({ sender: [sender.linkedin!], problem: ["contrast"] })).toEqual(["a2"]);
    expect(await subjects({ sender: [sender.shop!], smin: 50, webfonts: "yes" })).toEqual(["a3"]);
  });

  it("another user's sender or mailbox never matches, and never leaks rows", async () => {
    expect(await subjects({ sender: [gusSender] })).toEqual([]);
    expect(await subjects({ mailbox: gusMb })).toEqual([]);
    expect(await subjects({ sender: [sender.linkedin!] }, gus.id)).toEqual([]);
    expect(await subjects({ mailbox: mb1 }, gus.id)).toEqual([]);
    const f = await q.galleryFacets(gus.id, params());
    expect(f.mailboxes.map((m) => m.id)).toEqual([gusMb]);
    expect(f.senders.map((s) => s.id)).toEqual([gusSender]);
    expect(
      (await q.galleryFacets(gus.id, params({ sender: [sender.linkedin!] }))).senders.map(
        (s) => s.id,
      ),
    ).toEqual([gusSender]); // Fay's sender id finds no name for Gus
  });

  it("facet counts for the Filters panel respect the other filters, not their own", async () => {
    const f = await q.galleryFacets(fay.id, params());
    expect(f.problems).toEqual({
      image_only: 1,
      contrast: 1,
      mobile: 1,
      clipped: 0,
      broken_images: 0,
      no_unsubscribe: 0,
      merge_tag: 0,
      low_score: 1,
    });
    expect(f.webFonts).toEqual({ yes: 4, no: 3 });
    expect(f.senders.map((s) => [s.name, s.domain, s.count])).toEqual([
      ["News", "news.example", 3],
      ["LinkedIn", "linkedin.example", 2],
      ["Shop", "shop.example", 2],
    ]);
    expect(f.mailboxes).toEqual([
      { id: mb1, address: `fay-${fay.id}@gmail.example`.toLowerCase(), count: 5 },
      { id: mb2, address: `fay2-${fay.id}@gmail.example`.toLowerCase(), count: 2 },
    ]);

    // A sender is picked: problems, mailboxes and web fonts narrow to it; the sender list doesn't.
    const li = await q.galleryFacets(fay.id, params({ sender: [sender.linkedin!] }));
    // The picked sender comes first, so it's always in the list.
    expect(li.senders.map((s) => [s.name, s.count])).toEqual([
      ["LinkedIn", 2],
      ["News", 3],
      ["Shop", 2],
    ]);
    expect(li.problems).toEqual({
      image_only: 0,
      contrast: 1,
      mobile: 1,
      clipped: 0,
      broken_images: 0,
      no_unsubscribe: 0,
      merge_tag: 0,
      low_score: 1,
    });
    expect(li.mailboxes.map((m) => m.count)).toEqual([2, 0]);
    expect(li.webFonts).toEqual({ yes: 1, no: 1 });
    expect(li.categories.all).toBe(2);
    expect(li.design.all).toBe(2);

    // A problem is picked: the problem counts ignore it; senders narrow (a picked sender with no
    // design left still shows, with 0, so its chip keeps its name).
    const img = await q.galleryFacets(
      fay.id,
      params({ problem: ["image_only"], sender: [sender.linkedin!] }),
    );
    expect(img.problems).toEqual(li.problems);
    expect(img.senders).toEqual([
      {
        id: sender.shop,
        name: "Shop",
        domain: "shop.example",
        address: "hi@shop.example",
        count: 1,
      },
      {
        id: sender.linkedin,
        name: "LinkedIn",
        domain: "linkedin.example",
        address: "jobs@linkedin.example",
        count: 0,
      },
    ]);

    // Mailbox, web fonts, score and date narrow the others too.
    const box = await q.galleryFacets(fay.id, params({ mailbox: mb2 }));
    expect(box.mailboxes.map((m) => m.count)).toEqual([5, 2]);
    expect(box.problems.image_only).toBe(1);
    expect(box.problems.contrast).toBe(0);
    const web = await q.galleryFacets(fay.id, params({ webfonts: "no" }));
    expect(web.webFonts).toEqual({ yes: 4, no: 3 });
    expect(web.senders.map((s) => [s.name, s.count])).toEqual([
      ["LinkedIn", 1],
      ["News", 1],
      ["Shop", 1],
    ]);
    const recent = await q.galleryFacets(fay.id, params({ date: "30d", smin: 50 }));
    expect(recent.categories.all).toBe(2); // a1 (90) and a5 (75)
    expect(recent.webFonts).toEqual({ yes: 1, no: 1 });
  });

  it("numbered pages: no overlap, nothing skipped, a page past the end shows the last page", async () => {
    const hal = await createUser(app);
    const mb = await createMailbox(app, hal.id);
    for (let i = 0; i < 30; i++)
      await seedEmail(app, hal.id, mb, {
        ...(i % 3 === 0 ? scored(null, null) : scored(50 + (i % 7), "needs_work")),
        // Pairs share a received_at, so the id tie-break decides.
        receivedAt: new Date(now - Math.floor(i / 2) * HOUR),
        subject: `h${i}`,
      });
    for (const sort of ["newest", "best", "worst"] as const) {
      const p1 = await q.listGallery(hal.id, params({ sort, size: 24 }));
      const p2 = await q.listGallery(hal.id, params({ sort, size: 24, page: 2 }));
      expect(p1).toMatchObject({ total: 30, page: 1, pageSize: 24, pageCount: 2 });
      expect(p2).toMatchObject({ total: 30, page: 2, pageCount: 2 });
      expect(p1.items).toHaveLength(24);
      expect(p2.items).toHaveLength(6);
      const ids = [...p1.items, ...p2.items].map((i) => i.id);
      expect(new Set(ids).size, sort).toBe(30);
      // The same order as one big page.
      const one = await q.listGallery(hal.id, params({ sort, size: 48 }));
      expect(
        one.items.map((i) => i.id),
        sort,
      ).toEqual(ids);
      expect(one.pageCount).toBe(1);
      // Asking again gives the same page (the order is total, never "whatever Postgres returns").
      const again = await q.listGallery(hal.id, params({ sort, size: 24, page: 2 }));
      expect(again.items.map((i) => i.id)).toEqual(p2.items.map((i) => i.id));
    }
    const past = await q.listGallery(hal.id, params({ page: 99 }));
    expect(past).toMatchObject({ page: 2, pageCount: 2, total: 30 });
    expect(past.items).toHaveLength(6);
    const empty = await q.listGallery(hal.id, params({ page: 5, problem: ["clipped"] }));
    expect(empty).toMatchObject({ items: [], total: 0, page: 1, pageCount: 1 });
  });
});

/** Fay's subjects, newest first (a1 1 day old … a4 100 days, a7 / a6 ~200 days). */
const AGE: Record<string, number> = { a1: 1, a5: 2, a2: 10, a3: 40, a4: 100, a6: 199.9, a7: 200 };
function byAge(a: string, b: string): number {
  return AGE[a]! - AGE[b]!;
}
