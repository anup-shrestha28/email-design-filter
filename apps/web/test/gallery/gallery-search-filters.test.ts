/**
 * The gallery's search, "Pick dates", Problems and counts against the real database
 * (queries/gallery.ts, lib/gallery-search.ts):
 *  - a search is a filter like any other: more than 200 matches are all counted, paged and in the
 *    counts, newest first (it used to be a capped, rank-ordered list of 200)
 *  - every word is a prefix; punctuation splits words the way the index does ("don't", "don’t");
 *    a sender's address and domain are searchable ("linkedin.com"); accents don't matter in names
 *    and subjects; "-word" leaves out; "or"; "quoted phrases"; symbols-only searches find that text
 *  - "Pick dates" reads days in the zone the cards show: "Automatic" (saved "UTC") follows the
 *    device's zone, a zone chosen in Settings wins
 *  - each Problems option is exactly galleryProblemsOf(): its cap or chip, the severe problem the
 *    Bad cards name (pictures, phones, Gmail's cut, no unsubscribe link — current and v1.5
 *    signals) or a low score; counts agree, and together the options are exactly the Bad designs
 *  - the counts are never cached: a new email shows in them at once, as in the list
 *  - senders sharing a name come with their address; the Font menu lists more than 30 fonts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as GalleryQueries from "@/server/queries/gallery";
import type { GalleryItem } from "@/server/queries/types";
import {
  DEFAULT_GALLERY_PARAMS,
  GALLERY_PROBLEMS,
  galleryProblemsOf,
  type GalleryParams,
} from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { fromSender } from "../tests-server/helpers";

// The device zone the browser reported (the edf-tz cookie), for requestTimeZone.
const device = vi.hoisted(() => ({ zone: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      name === "edf-tz" && device.zone !== null ? { name, value: device.zone } : undefined,
  }),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
  ...DEFAULT_GALLERY_PARAMS,
  ...over,
});

type Signals = Record<string, unknown> | null;
const CLEAN: Signals = {
  imgShare: 0.1,
  legibleChars: null,
  phoneTextPx: 16,
  layoutK: 1,
  unsubscribe: "before_clip",
};
/** CLEAN as scoring 2026.5 saves it (the current rules read these keys). */
const CURRENT = (over: Record<string, unknown> = {}): Signals => ({
  ...CLEAN,
  primaryType: "promotional",
  htmlContentImages: 3,
  drawnContentImages: 3,
  imagesOff: false,
  liveTextChars: 800,
  unsubscribeUnion: "before_clip",
  htmlKB: 40,
  gate: [],
  ...over,
});

function scored(
  score: number | null,
  opts: {
    issues?: EmailRecord["designIssues"];
    signals?: Signals;
    fonts?: string[];
    caps?: string[];
  } = {},
): Partial<EmailRecord> {
  return {
    designStatus: "done",
    designSource: score === null ? "static" : "render",
    designScore: score,
    designBand: score === null ? null : score >= 85 ? "excellent" : score >= 60 ? "good" : "poor",
    designCapped: score === null ? null : false,
    designProvisional: score === null ? null : false,
    designIssues: opts.issues ?? [],
    designConfidence: score === null ? null : "high",
    ...(opts.fonts ? { fontFamilies: opts.fonts } : {}),
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      features: null,
      checks: [],
      pillarScores: [],
      rawScore: score,
      caps: (opts.caps ?? []) as never,
      confidence: 0.9,
      trust: {},
      scoreSummary: {
        needsImprovement: [],
        good: [],
        ...(opts.signals === undefined ? { signals: CLEAN } : { signals: opts.signals }),
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

describe.skipIf(!HAS_DB)("gallery search, dates, problems and counts against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let q: typeof GalleryQueries;
  const now = Date.now();

  async function all(userId: string, p: GalleryParams, zone?: string): Promise<GalleryItem[]> {
    const out: GalleryItem[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await q.listGallery(userId, { ...p, page, size: 96 }, zone);
      out.push(...r.items);
      if (page >= r.pageCount) break;
    }
    return out;
  }

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    q = await import("@/server/queries/gallery");
  });
  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  describe("search", () => {
    let user: string;
    const subjectsFor = async (search: string) =>
      (await all(user, params({ q: search }), "UTC")).map((i) => i.subject).sort();

    beforeAll(async () => {
      user = (await createUser(app)).id;
      const mb = await createMailbox(app, user);
      const seed = (subject: string, i: number, over: Partial<EmailRecord> = {}) =>
        seedEmail(app, user, mb, {
          ...scored(70),
          subject,
          searchText: `${subject} ${over.fromName ?? "Northwind"} ${over.fromAddress ?? "hello@northwind.example"}`,
          receivedAt: new Date(now - i * HOUR),
          ...over,
        });
      const linkedin = fromSender("jobs-noreply@linkedin.com", { displayName: "LinkedIn" });
      const betterbrand = fromSender("hello@trybetterbrand.com", { displayName: "Betterbrand" });
      const gruns = fromSender("hi@gruns.co", { displayName: "Grüns" });
      // An address without the name in it, so only the accent-free name can match "estee".
      const estee = fromSender("news@elc.example", { displayName: "Estée Lauder" });
      let i = 0;
      await seed("Don't miss today's jobs", i++, linkedin);
      await seed("Don’t forget your cart", i++);
      await seed("Tomorrow: Master MongoDB Search", i++);
      await seed("Full stack engineer jobs", i++, linkedin);
      await seed("A stack of full plates", i++);
      await seed("One filter was just the start", i++, betterbrand);
      await seed("Your fiber is working", i++, gruns);
      await seed("Do Grüns actually work?", i++, gruns);
      await seed("New serum for autumn", i++, estee);
      await seed("Your 10% Chanty gift expires soon 🎁", i++);
      await seed("Remote jobs this week", i++);
      await seed("Crème brûlée, three ways", i++);
      await seed("Senior C++ developer", i++);
      await seed("Cozy cardigans: 100 styles", i);
    });

    it("symbols after a word end it: C++ and 10% are whole words, not prefixes", async () => {
      expect(await subjectsFor("C++")).toEqual(["Senior C++ developer"]);
      // "c" alone is a prefix: it finds every word starting with c (cardigans, com, …).
      expect((await subjectsFor("c")).length).toBeGreaterThan(5);
      expect(await subjectsFor("10%")).toEqual(["Your 10% Chanty gift expires soon 🎁"]);
      expect(await subjectsFor("10")).toEqual(
        ["Cozy cardigans: 100 styles", "Your 10% Chanty gift expires soon 🎁"].sort(),
      );
      expect(await subjectsFor("jobs!")).toEqual(await subjectsFor("jobs"));
    });

    it("every word is a prefix, and every word counts", async () => {
      expect(await subjectsFor("Mongo Search")).toEqual(["Tomorrow: Master MongoDB Search"]);
      expect(await subjectsFor("mongo searching")).toEqual([]);
      expect(await subjectsFor("jobs")).toEqual(
        ["Don't miss today's jobs", "Full stack engineer jobs", "Remote jobs this week"].sort(),
      );
    });

    it("apostrophes split a word as the index does: don't and don’t find both spellings", async () => {
      const both = ["Don't miss today's jobs", "Don’t forget your cart"].sort();
      expect(await subjectsFor("don't")).toEqual(both);
      expect(await subjectsFor("don’t")).toEqual(both);
      expect(await subjectsFor("dont")).toEqual([]);
      expect(await subjectsFor("today's jobs")).toEqual(["Don't miss today's jobs"]);
    });

    it("the sender's address and domain are searchable", async () => {
      const li = ["Don't miss today's jobs", "Full stack engineer jobs"].sort();
      expect(await subjectsFor("linkedin.com")).toEqual(li);
      expect(await subjectsFor("jobs-noreply@linkedin.com")).toEqual(li);
      expect(await subjectsFor("trybetterbrand")).toEqual(["One filter was just the start"]);
      expect(await subjectsFor("gruns.co")).toEqual(
        ["Do Grüns actually work?", "Your fiber is working"].sort(),
      );
      // Only the start of an address part: "nkedin" is inside a word.
      expect(await subjectsFor("nkedin")).toEqual([]);
    });

    it("accents don't matter in the subject or the sender's name", async () => {
      const gruns = ["Do Grüns actually work?", "Your fiber is working"].sort();
      expect(await subjectsFor("gruns")).toEqual(gruns);
      expect(await subjectsFor("Grüns")).toEqual(gruns);
      expect(await subjectsFor("GRUNS")).toEqual(gruns);
      expect(await subjectsFor("estee")).toEqual(["New serum for autumn"]);
      expect(await subjectsFor("Estée")).toEqual(["New serum for autumn"]);
      expect(await subjectsFor("creme brulee")).toEqual(["Crème brûlée, three ways"]);
      expect(await subjectsFor("brûlée")).toEqual(["Crème brûlée, three ways"]);
    });

    it("-word leaves out, or finds either side, and quotes keep words together", async () => {
      expect(await subjectsFor("jobs -linkedin")).toEqual(["Remote jobs this week"]);
      expect(await subjectsFor("jobs -linked")).toEqual(["Remote jobs this week"]);
      expect(await subjectsFor("mongodb or estee")).toEqual(
        ["New serum for autumn", "Tomorrow: Master MongoDB Search"].sort(),
      );
      expect(await subjectsFor("full stack")).toEqual(
        ["A stack of full plates", "Full stack engineer jobs"].sort(),
      );
      expect(await subjectsFor('"full stack"')).toEqual(["Full stack engineer jobs"]);
      expect(await subjectsFor("“full stack”")).toEqual(["Full stack engineer jobs"]);
    });

    it("a search with no letters or digits finds that text, never everything", async () => {
      expect(await subjectsFor("🎁")).toEqual(["Your 10% Chanty gift expires soon 🎁"]);
      expect(await subjectsFor("%")).toEqual(["Your 10% Chanty gift expires soon 🎁"]);
      for (const nothing of ["!!!", "\\", "*", '""', "@@"])
        expect(await subjectsFor(nothing), nothing).toEqual([]);
      // Next to real words, punctuation is only a separator.
      expect(await subjectsFor("Remote - jobs")).toEqual(["Remote jobs this week"]);
    });

    it("hostile text is always a bound value and never breaks the query", async () => {
      for (const text of [
        "a'):* | !b & (c) <-> d:*",
        "'; DROP TABLE email; --",
        "\\' OR 1=1",
        "%_%",
        "x".repeat(100),
        "-",
        "or",
        "or or",
        '-""',
        "a\u0000b",
      ]) {
        const r = await q.listGallery(user, params({ q: text }), "UTC");
        expect(r.total, text).toBeGreaterThanOrEqual(0);
        await q.galleryFacets(user, params({ q: text }), "UTC");
      }
    });

    it("more than 200 matches: all of them are counted, paged and in the counts, newest first", async () => {
      const big = (await createUser(app)).id;
      const mb = await createMailbox(app, big);
      const N = 230;
      for (let k = 0; k < N; k++)
        await seedEmail(app, big, mb, {
          ...scored(k % 2 ? 90 : 40),
          // The rank-ordered cap kept the most relevant 200: the newest has the weakest match.
          subject: k === 0 ? "promo" : `promo promo promo ${k}`,
          searchText: k === 0 ? "promo" : `promo promo promo ${k}`,
          receivedAt: new Date(now - k * HOUR),
        });
      await seedEmail(app, big, mb, { ...scored(70), subject: "other", searchText: "other" });
      const p1 = await q.listGallery(big, params({ q: "promo", size: 24 }), "UTC");
      expect(p1).toMatchObject({ total: N, pageCount: Math.ceil(N / 24) });
      expect(p1.items[0]!.subject).toBe("promo"); // the newest match leads page 1
      const ids = (await all(big, params({ q: "promo" }), "UTC")).map((i) => i.id);
      expect(new Set(ids).size).toBe(N);
      const f = await q.galleryFacets(big, params({ q: "promo" }), "UTC");
      expect(f.categories.all).toBe(N);
      expect(f.design.all).toBe(N);
      expect(f.design.good + f.design.bad).toBe(N);
      // With other filters, every match is still there to filter.
      const bad = await q.listGallery(big, params({ q: "promo", design: "bad" }), "UTC");
      expect(bad.total).toBe(f.design.bad);
      expect(bad.total).toBe(N / 2);
    });
  });

  describe("Pick dates follows the zone the cards show", () => {
    let user: string;
    const day = new Date(now - 200 * DAY).toISOString().slice(0, 10);
    const midnightUtc = Date.parse(`${day}T00:00:00Z`);
    const subjects = async (zone?: string) =>
      (await all(user, params({ date: "custom", since: day, until: day }), zone)).map(
        (i) => i.subject,
      );

    beforeAll(async () => {
      user = (await createUser(app)).id; // user_settings.timezone stays 'UTC': "Automatic"
      const mb = await createMailbox(app, user);
      // 00:15 on `day` in Kathmandu (+05:45: still the day before in UTC), and 00:30 on `day` UTC
      // (06:15 in Kathmandu, the same day there too), and 23:45 the day before in Kathmandu.
      await seedEmail(app, user, mb, {
        ...scored(70),
        subject: "ktm-0015",
        receivedAt: new Date(midnightUtc - 5.5 * HOUR),
      });
      await seedEmail(app, user, mb, {
        ...scored(70),
        subject: "utc-0030",
        receivedAt: new Date(midnightUtc + 0.5 * HOUR),
      });
      await seedEmail(app, user, mb, {
        ...scored(70),
        subject: "ktm-prev-2345",
        receivedAt: new Date(midnightUtc - 6 * HOUR),
      });
    });

    it("'Automatic' reads the day in the device's zone, passed or from its cookie", async () => {
      expect((await subjects("Asia/Kathmandu")).sort()).toEqual(["ktm-0015", "utc-0030"]);
      device.zone = "Asia/Kathmandu";
      expect((await subjects()).sort()).toEqual(["ktm-0015", "utc-0030"]);
      const f = await q.galleryFacets(user, params({ date: "custom", since: day, until: day }));
      expect(f.categories.all).toBe(2);
      // The live gallery's count of the same view reads the same days.
      const live = await import("@/server/queries/gallery-live");
      const view = await live.galleryViewChange(
        user,
        params({ date: "custom", since: day, until: day }),
        { newest: null, analyzedAt: null },
      );
      expect(view.total).toBe(2);
      // A device in UTC sees the UTC day.
      device.zone = "Etc/UTC";
      expect((await subjects()).sort()).toEqual(["utc-0030"]);
      device.zone = null;
      expect((await subjects()).sort()).toEqual(["utc-0030"]); // no zone known yet: UTC
    });

    it("a zone chosen in Settings wins over the device", async () => {
      await owner.query(
        "UPDATE user_settings SET timezone = 'America/New_York' WHERE user_id = $1",
        [user],
      );
      device.zone = "Asia/Kathmandu";
      try {
        // New York's `day` starts 4–5 hours after UTC's: all three arrived the evening before.
        expect(await subjects()).toEqual([]);
        expect(await subjects("America/New_York")).toEqual([]);
      } finally {
        device.zone = null;
        await owner.query("UPDATE user_settings SET timezone = 'UTC' WHERE user_id = $1", [user]);
      }
    });
  });

  describe("Problems match what the Bad cards say", () => {
    let user: string;
    const rows: Array<{
      subject: string;
      issues: EmailRecord["designIssues"];
      signals: Signals;
      caps?: string[];
      score?: number;
      /** email.primary_type (default promotional): the type now, which the unsubscribe rule reads. */
      primaryType?: EmailRecord["primaryType"];
    }> = [
      { subject: "chip-image", issues: ["image_only"], signals: CLEAN },
      {
        subject: "pictures",
        issues: [],
        signals: { ...CLEAN!, imgShare: 0.87, legibleChars: 97 },
      },
      {
        subject: "pictures-but-text",
        issues: [],
        signals: { ...CLEAN!, imgShare: 1, legibleChars: 367 },
      },
      { subject: "chip-mobile", issues: ["mobile"], signals: CLEAN },
      {
        subject: "shrinks",
        issues: [],
        signals: { ...CLEAN!, phoneTextPx: 10.5, layoutK: 0.66 },
      },
      {
        subject: "small-but-fits",
        issues: [],
        signals: { ...CLEAN!, phoneTextPx: 10, layoutK: 1 },
      },
      { subject: "no-unsub", issues: [], signals: { ...CLEAN!, unsubscribe: "none" } },
      { subject: "unsub-exempt", issues: [], signals: { ...CLEAN!, unsubscribe: null } },
      { subject: "contrast", issues: ["contrast"], signals: CLEAN },
      {
        subject: "clipped-and-no-unsub",
        issues: ["clipped"],
        signals: { ...CLEAN!, unsubscribe: "none" },
      },
      { subject: "broken", issues: ["broken_images"], signals: CLEAN },
      {
        subject: "everything",
        issues: ["mobile", "image_only"],
        signals: {
          imgShare: 0.9,
          legibleChars: 0,
          phoneTextPx: 8,
          layoutK: 0.5,
          unsubscribe: "none",
        },
      },
      { subject: "clean", issues: [], signals: CLEAN },
      { subject: "no-signals", issues: [], signals: null },
      // Scored by 2026.5: the current rules.
      {
        subject: "cur-not-loaded",
        issues: [],
        signals: CURRENT({ htmlContentImages: 1, drawnContentImages: 0, liveTextChars: 51 }),
      },
      {
        subject: "cur-images-off",
        issues: [],
        signals: CURRENT({ drawnContentImages: null, imagesOff: true, liveTextChars: 51 }),
      },
      { subject: "cur-phone", issues: [], signals: CURRENT({ layoutK: 0.7, phoneTextPx: 10 }) },
      {
        subject: "cur-phone-ok",
        issues: [],
        signals: CURRENT({ layoutK: 0.81, phoneTextPx: 11.3 }),
      },
      { subject: "cur-cut", issues: [], signals: CURRENT({ unsubscribeUnion: "after_clip" }) },
      { subject: "cur-no-unsub", issues: [], signals: CURRENT({ unsubscribeUnion: "none" }) },
      {
        subject: "cur-notice-no-unsub",
        issues: [],
        primaryType: "notification",
        signals: CURRENT({
          primaryType: "notification",
          unsubscribeUnion: "none",
          unsubscribe: "none",
        }),
      },
      // The type changed after scoring (a correction, or the AI settling a pending email): the
      // rule follows the type now, as the category chip does.
      {
        subject: "cur-retyped-to-notice",
        issues: [],
        primaryType: "account_notice",
        signals: CURRENT({ primaryType: "promotional", unsubscribeUnion: "none" }),
      },
      {
        subject: "cur-retyped-to-promo",
        issues: [],
        primaryType: "promotional",
        signals: CURRENT({ primaryType: "notification", unsubscribeUnion: "none" }),
      },
      // Most of the picture area wasn't drawn: the picture share isn't trusted.
      {
        subject: "cur-pictures-unknown",
        issues: [],
        signals: CURRENT({
          imgShare: 1,
          legibleChars: 65,
          liveTextChars: 65,
          imagesUnknownShare: 0.522,
        }),
      },
      { subject: "cap-merge", issues: [], signals: CURRENT(), caps: ["CAP_MERGE_TAG"] },
      { subject: "cap-clip", issues: [], signals: CURRENT(), caps: ["CAP_CLIPPED"] },
      { subject: "low", issues: [], signals: CURRENT(), score: 55 },
    ];

    beforeAll(async () => {
      user = (await createUser(app)).id;
      const mb = await createMailbox(app, user);
      for (const [i, r] of rows.entries())
        await seedEmail(app, user, mb, {
          ...scored(r.score ?? 70, { issues: r.issues, signals: r.signals, caps: r.caps }),
          ...(r.primaryType ? { primaryType: r.primaryType } : {}),
          subject: r.subject,
          receivedAt: new Date(now - i * HOUR),
        });
    });

    it("each option is its chip or its severe problem, exactly as galleryProblemsOf says", async () => {
      const f = await q.galleryFacets(user, params(), "UTC");
      for (const x of GALLERY_PROBLEMS) {
        const want = rows
          .filter((r) =>
            galleryProblemsOf({
              score: r.score ?? 70,
              band: (r.score ?? 70) >= 60 ? "good" : "poor",
              caps: r.caps ?? [],
              issues: r.issues,
              signals: r.signals,
              primaryType: r.primaryType ?? "promotional",
            }).includes(x),
          )
          .map((r) => r.subject)
          .sort();
        const got = (await all(user, params({ problem: [x] }), "UTC")).map((i) => i.subject).sort();
        expect(got, x).toEqual(want);
        expect(f.problems[x], x).toBe(want.length);
      }
      const names = async (x: (typeof GALLERY_PROBLEMS)[number]) =>
        (await all(user, params({ problem: [x] }), "UTC")).map((i) => i.subject).sort();
      expect(await names("image_only")).toEqual([
        "chip-image",
        "cur-not-loaded",
        "everything",
        "pictures",
      ]);
      expect(await names("mobile")).toEqual(["chip-mobile", "cur-phone", "everything", "shrinks"]);
      expect(await names("clipped")).toEqual(["cap-clip", "clipped-and-no-unsub", "cur-cut"]);
      expect(await names("no_unsubscribe")).toEqual([
        "clipped-and-no-unsub",
        "cur-no-unsub",
        "cur-retyped-to-promo",
        "everything",
        "no-unsub",
      ]);
      expect(await names("image_only")).not.toContain("cur-pictures-unknown");
      expect(await names("merge_tag")).toEqual(["cap-merge"]);
      expect(await names("low_score")).toEqual(["low"]);
    });

    it("together the options are exactly the Bad designs, and each count is within Bad", async () => {
      const bad = (await all(user, params({ design: "bad" }), "UTC")).map((i) => i.id).sort();
      const anyProblem = (await all(user, params({ problem: [...GALLERY_PROBLEMS] }), "UTC"))
        .map((i) => i.id)
        .sort();
      expect(bad.length).toBeGreaterThan(0);
      expect(anyProblem).toEqual(bad);
      // An option with Design = Bad shows the same designs as the option alone.
      const f = await q.galleryFacets(user, params({ design: "bad" }), "UTC");
      const all0 = await q.galleryFacets(user, params(), "UTC");
      expect(f.problems).toEqual(all0.problems);
    });
  });

  describe("counts, senders and fonts", () => {
    it("the counts are read with the page: a new email is counted at once", async () => {
      const user = (await createUser(app)).id;
      const mb = await createMailbox(app, user);
      await seedEmail(app, user, mb, { ...scored(90), subject: "one" });
      const before = await q.galleryFacets(user, params(), "UTC");
      expect(before.categories.all).toBe(1);
      await seedEmail(app, user, mb, { ...scored(90), subject: "two" });
      const list = await q.listGallery(user, params(), "UTC");
      const after = await q.galleryFacets(user, params(), "UTC");
      expect(list.total).toBe(2);
      expect(after.categories.all).toBe(2);
      expect(after.design.good).toBe(2);
    });

    it("senders that share a name carry their address; the Font menu lists every font (> 30)", async () => {
      const user = (await createUser(app)).id;
      const mb = await createMailbox(app, user);
      const fonts = Array.from({ length: 38 }, (_, i) => `Font ${String(i).padStart(2, "0")}`);
      for (const [i, font] of fonts.entries())
        await seedEmail(app, user, mb, {
          ...scored(70, { fonts: [font] }),
          ...fromSender(i % 2 ? "jobs-noreply@linkedin.com" : "messages-noreply@linkedin.com", {
            displayName: "LinkedIn",
          }),
          subject: `s${i}`,
        });
      const f = await q.galleryFacets(user, params(), "UTC");
      expect(f.fonts.map((x) => x.name).sort()).toEqual(fonts);
      expect(f.senders.map((s) => [s.name, s.address, s.count]).sort()).toEqual([
        ["LinkedIn", "jobs-noreply@linkedin.com", 19],
        ["LinkedIn", "messages-noreply@linkedin.com", 19],
      ]);
    });
  });
});
