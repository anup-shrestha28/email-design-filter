/**
 * The gallery's page numbers and Filters-panel URL state (lib/gallery.ts), pure:
 *  - every new field parses from a URL, a Next searchParams object and an already-parsed object
 *  - each invalid field falls back on its own; related fields are made consistent
 *  - galleryHref leaves defaults out and round-trips every field
 *  - page math: page count, clamping, "Showing 25–48 of 285", the 1 … 4 5 6 … 12 window
 *  - the removable chips and the Filters badge count
 *  - preview URLs for a 96-card page go out as two calls of ≤ 48 ids
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEAR_ADVANCED,
  DEFAULT_GALLERY_PARAMS,
  GALLERY_PAGE_MAX,
  GALLERY_SENDERS_MAX,
  GALLERY_PROBLEM_LABELS,
  GALLERY_PROBLEMS,
  activeFilterChips,
  advancedFilterCount,
  clampPage,
  galleryHref,
  galleryProblemsOf,
  nextDay,
  senderChipLabels,
  sharedSenderNames,
  zonedDayStart,
  pageBounds,
  pageCountOf,
  pageWindow,
  parseGalleryParams,
  type GalleryParams,
} from "@/lib/gallery";
import { PreviewUrlStore } from "@/components/gallery/preview-urls";

const A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const uuid = (i: number) => `0190a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, "0")}`;
const p = (over: Partial<GalleryParams>): GalleryParams => ({ ...DEFAULT_GALLERY_PARAMS, ...over });

describe("gallery URL params: pages and the Filters panel", () => {
  it("reads every new field from a URL, a searchParams object and a parsed object alike", () => {
    const want = p({
      page: 3,
      size: 48,
      smin: 60,
      smax: 90,
      date: "custom",
      since: "2026-09-01",
      until: "2026-09-20",
      sender: [A, B],
      problem: ["contrast", "mobile"],
      mailbox: A,
      webfonts: "no",
    });
    const qs = `page=3&size=48&smin=60&smax=90&date=custom&since=2026-09-01&until=2026-09-20&sender=${A},${B}&problem=contrast,mobile&mailbox=${A}&webfonts=no`;
    expect(parseGalleryParams(new URLSearchParams(qs))).toEqual(want);
    expect(parseGalleryParams(Object.fromEntries(new URLSearchParams(qs)))).toEqual(want);
    expect(parseGalleryParams(want)).toEqual(want);
    // Repeated keys (?sender=a&sender=b) count as a list too.
    expect(parseGalleryParams({ sender: [A, B] }).sender).toEqual([A, B]);
    expect(parseGalleryParams(new URLSearchParams(`sender=${A}&sender=${B}`)).sender).toEqual([
      A,
      B,
    ]);
  });

  it("each invalid field falls back to its own default, keeping the others", () => {
    const bad = {
      page: ["0", "-1", "1.5", "1e2", " 2", "abc", ""],
      size: ["25", "0", "1000", "abc", "24.0"],
      smin: ["-1", "101", "x", "5.5"],
      smax: ["-1", "101", "x"],
      date: ["yesterday", "7", "CUSTOM"],
      webfonts: ["maybe", "true"],
      mailbox: ["not-a-uuid", "1; DROP TABLE email", `${A}x`],
    } as const;
    for (const [key, values] of Object.entries(bad)) {
      for (const v of values) {
        const got = parseGalleryParams({ [key]: v, category: "welcome" });
        expect(got, `${key}=${v}`).toEqual(p({ category: "welcome" }));
      }
    }
    // Numbers from an object work; out-of-range ones don't.
    expect(parseGalleryParams({ page: 7, size: 96, smin: 10 })).toEqual(
      p({ page: 7, size: 96, smin: 10 }),
    );
    expect(parseGalleryParams({ page: 0, size: 30 })).toEqual(DEFAULT_GALLERY_PARAMS);
    // A page past GALLERY_PAGE_MAX is the last page there can be (the server then clamps it to the
    // real last page), never page 1.
    expect(parseGalleryParams({ page: "10001" }).page).toBe(GALLERY_PAGE_MAX);
    expect(parseGalleryParams({ page: "9".repeat(30) }).page).toBe(GALLERY_PAGE_MAX);
    expect(parseGalleryParams({ page: 123_456 }).page).toBe(GALLERY_PAGE_MAX);
    expect(parseGalleryParams({ page: String(GALLERY_PAGE_MAX) }).page).toBe(GALLERY_PAGE_MAX);
    // Dates must be real calendar days (and sane years).
    for (const d of [
      "2026-02-30",
      "2026-13-01",
      "26-09-01",
      "1999-12-31",
      "2101-01-01",
      "2026-9-1",
      "x",
    ])
      expect(parseGalleryParams({ date: "custom", since: d, until: "2026-09-20" }), d).toEqual(
        p({ date: "custom", until: "2026-09-20" }),
      );
  });

  it("lists: UUIDs only (lower-cased, de-duplicated), the first 20 senders, known problems only", () => {
    expect(parseGalleryParams({ sender: `${A.toUpperCase()},${A},${B}` }).sender).toEqual([A, B]);
    // A bad item is dropped; the good ones around it are kept (a hand-edited link keeps working).
    expect(parseGalleryParams({ sender: `${A},nope,${B}`, problem: "mobile" })).toEqual(
      p({ sender: [A, B], problem: ["mobile"] }),
    );
    expect(parseGalleryParams({ sender: `${A}' OR 1=1 --` }).sender).toEqual([]);
    expect(parseGalleryParams({ sender: ` ${A} ` }).sender).toEqual([A]);
    const twenty = Array.from({ length: GALLERY_SENDERS_MAX }, (_, i) => uuid(i));
    expect(parseGalleryParams({ sender: twenty.join(",") }).sender).toEqual(twenty);
    // Over 20: the first 20 (repeats don't count toward it).
    expect(parseGalleryParams({ sender: [...twenty, uuid(99)].join(",") }).sender).toEqual(twenty);
    expect(
      parseGalleryParams({ sender: [twenty[0], ...twenty, uuid(99)].join(",") }).sender,
    ).toEqual(twenty);
    // Empty items are ignored; problems keep one fixed order, in any case.
    expect(parseGalleryParams({ problem: "mobile,,image_only," }).problem).toEqual([
      "image_only",
      "mobile",
    ]);
    expect(parseGalleryParams({ problem: "mobile,spam" }).problem).toEqual(["mobile"]);
    expect(parseGalleryParams({ problem: "No_Unsubscribe,MOBILE" }).problem).toEqual([
      "mobile",
      "no_unsubscribe",
    ]);
    expect(parseGalleryParams({ sender: "", problem: "" })).toEqual(DEFAULT_GALLERY_PARAMS);
  });

  it("choices are read in any case (a shared ?category=Promotions works like ?cat=Promotions)", () => {
    expect(
      parseGalleryParams({
        category: "Promotions",
        design: "GOOD",
        sort: " Best ",
        date: "30D",
        webfonts: "Yes",
      }),
    ).toEqual(
      p({ category: "promotions", design: "good", sort: "best", date: "30d", webfonts: "yes" }),
    );
    expect(parseGalleryParams({ category: "Spam" })).toEqual(DEFAULT_GALLERY_PARAMS);
  });

  it("control characters in the search or the font never reach the database (a NUL broke the page)", () => {
    expect(parseGalleryParams({ q: "a\u0000 b" }).q).toBe("a  b");
    expect(parseGalleryParams({ q: "\u0000sale\u001f" }).q).toBe("sale");
    expect(parseGalleryParams({ font: "Arial\u0000" }).font).toBe("Arial");
    expect(parseGalleryParams({ font: "\u0000\u0007" }).font).toBeNull();
    expect(parseGalleryParams(new URLSearchParams("q=a%00+b&font=Arial%00")).q).toBe("a  b");
    for (const v of [
      parseGalleryParams({ q: "x\u0000y", font: "F\u007fG" }),
      parseGalleryParams(new URLSearchParams("q=%00%01%02&font=%1F")),
    ])
      expect(JSON.stringify(v)).not.toMatch(/\\u00[01][0-9a-f]|\\u007f/i);
  });

  it("makes related fields consistent: score swapped, dates only with 'Pick dates'", () => {
    expect(parseGalleryParams({ smin: "80", smax: "20" })).toMatchObject({ smin: 20, smax: 80 });
    expect(
      parseGalleryParams({ date: "custom", since: "2026-09-20", until: "2026-09-01" }),
    ).toMatchObject({ since: "2026-09-01", until: "2026-09-20" });
    // Days with another date choice are ignored; days alone mean "Pick dates"; "custom" without
    // days is "Any time".
    expect(parseGalleryParams({ date: "7d", since: "2026-09-01" })).toEqual(p({ date: "7d" }));
    expect(parseGalleryParams({ since: "2026-09-01" })).toEqual(
      p({ date: "custom", since: "2026-09-01" }),
    );
    expect(parseGalleryParams(new URLSearchParams("until=2026-09-20&since=2026-09-01"))).toEqual(
      p({ date: "custom", since: "2026-09-01", until: "2026-09-20" }),
    );
    expect(parseGalleryParams({ since: "not-a-day" })).toEqual(DEFAULT_GALLERY_PARAMS);
    expect(parseGalleryParams({ date: "custom" })).toEqual(DEFAULT_GALLERY_PARAMS);
    expect(parseGalleryParams({ date: "custom", until: "2026-09-01" })).toEqual(
      p({ date: "custom", until: "2026-09-01" }),
    );
  });

  it("galleryHref leaves every default out and round-trips every field", () => {
    expect(galleryHref(DEFAULT_GALLERY_PARAMS)).toBe("/gallery");
    expect(
      galleryHref({ page: 1, size: 24, smin: 0, smax: 100, date: "any", webfonts: "any" }),
    ).toBe("/gallery");
    const full = p({
      category: "promotions",
      design: "good",
      font: "Inter",
      q: "sale",
      sort: "best",
      page: 4,
      size: 96,
      smin: 60,
      smax: 100,
      date: "custom",
      since: "2026-09-01",
      until: null,
      sender: [A, B],
      problem: ["image_only", "broken_images"],
      mailbox: B,
      webfonts: "yes",
    });
    const href = galleryHref(full);
    expect(href).toBe(
      `/gallery?category=promotions&design=good&font=Inter&q=sale&sort=best&smin=60&date=custom&since=2026-09-01&sender=${A},${B}&problem=image_only,broken_images&mailbox=${B}&webfonts=yes&size=96&page=4`,
    );
    expect(parseGalleryParams(new URL(href, "http://x").searchParams)).toEqual(full);
    for (const one of [
      { page: 2 },
      { size: 48 as const },
      { smax: 59 },
      { date: "30d" as const },
      { date: "custom" as const, until: "2026-01-31" },
      { sender: [A] },
      { problem: ["clipped" as const] },
      { mailbox: A },
      { webfonts: "no" as const },
    ]) {
      const h = galleryHref(one);
      expect(parseGalleryParams(new URL(h, "http://x").searchParams), h).toEqual(p(one));
    }
  });
});

describe("gallery page math", () => {
  it("page count, clamping and the 'Showing first–last of total' numbers", () => {
    expect(pageCountOf(0, 24)).toBe(1);
    expect(pageCountOf(24, 24)).toBe(1);
    expect(pageCountOf(25, 24)).toBe(2);
    expect(pageCountOf(285, 24)).toBe(12);
    expect(clampPage(99, 285, 24)).toBe(12);
    expect(clampPage(0, 285, 24)).toBe(1);
    expect(clampPage(5, 0, 24)).toBe(1);
    expect(pageBounds(2, 24, 285)).toEqual({ first: 25, last: 48 });
    expect(pageBounds(12, 24, 285)).toEqual({ first: 265, last: 285 });
    expect(pageBounds(40, 24, 285)).toEqual({ first: 265, last: 285 });
    expect(pageBounds(1, 96, 5)).toEqual({ first: 1, last: 5 });
    expect(pageBounds(1, 24, 0)).toEqual({ first: 0, last: 0 });
    // Consecutive pages never overlap and never skip.
    for (const size of [24, 48, 96]) {
      let next = 1;
      for (let page = 1; page <= pageCountOf(285, size); page++) {
        const b = pageBounds(page, size, 285);
        expect(b.first).toBe(next);
        next = b.last + 1;
      }
      expect(next).toBe(286);
    }
  });

  it("page buttons: first, last and the neighbours, with a gap for 2+ hidden pages", () => {
    expect(pageWindow(5, 12)).toEqual([1, "gap", 4, 5, 6, "gap", 12]);
    expect(pageWindow(1, 12)).toEqual([1, 2, "gap", 12]);
    expect(pageWindow(3, 12)).toEqual([1, 2, 3, 4, "gap", 12]);
    expect(pageWindow(12, 12)).toEqual([1, "gap", 11, 12]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]); // a gap never hides a single page
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 2)).toEqual([1, 2]);
    expect(pageWindow(50, 3)).toEqual([1, 2, 3]);
  });
});

describe("Filters panel chips and badge", () => {
  it("one removable chip per filter, each removing only itself", () => {
    const params = p({
      smin: 60,
      date: "30d",
      sender: [A, B],
      problem: ["contrast"],
      mailbox: A,
      webfonts: "yes",
      board: B,
      font: "Inter",
      design: "good",
    });
    const chips = activeFilterChips(params, {
      senders: new Map([[A, "LinkedIn"]]),
      mailboxes: new Map([[A, "me@gmail.com"]]),
      boards: new Map([[B, "Welcome emails"]]),
    });
    expect(chips.map((c) => c.label)).toEqual([
      "Score 60–100",
      "Last 30 days",
      "LinkedIn",
      "1 sender",
      "Hard-to-read text",
      "me@gmail.com",
      "Uses web fonts",
      "Board: Welcome emails",
    ]);
    expect(advancedFilterCount(params)).toBe(8);
    expect(chips[7]!.remove).toEqual({ board: null });
    // A board the facets don't name (deleted meanwhile) still gets a chip that removes it.
    expect(activeFilterChips(p({ board: B })).map((c) => c.label)).toEqual(["Board: a board"]);
    expect(chips[0]!.remove).toEqual({ smin: null, smax: null });
    expect(chips[2]!.remove).toEqual({ sender: [B] });
    expect(chips[4]!.remove).toEqual({ problem: [] });
    expect(advancedFilterCount(DEFAULT_GALLERY_PARAMS)).toBe(0);
    expect(activeFilterChips(p({ font: "Inter", q: "x", sort: "best" }))).toEqual([]);
    expect(Object.keys(CLEAR_ADVANCED).sort()).toEqual([
      "board",
      "date",
      "mailbox",
      "problem",
      "sender",
      "since",
      "smax",
      "smin",
      "until",
      "webfonts",
    ]);
  });

  it("custom dates read as a range, or 'Since' / 'Until' with one end", () => {
    const label = (over: Partial<GalleryParams>) =>
      activeFilterChips(parseGalleryParams({ date: "custom", ...over }))[0]?.label;
    expect(label({ since: "2026-09-01", until: "2026-09-20" })).toBe("Sep 1, 2026 – Sep 20, 2026");
    expect(label({ since: "2026-09-01" })).toBe("Since Sep 1, 2026");
    expect(label({ until: "2026-01-31" })).toBe("Until Jan 31, 2026");
  });
});

describe("Pick dates: a calendar day in a time zone", () => {
  it("starts at that zone's midnight, as a UTC instant", () => {
    expect(zonedDayStart("2026-09-29", "Asia/Kathmandu").toISOString()).toBe(
      "2026-09-28T18:15:00.000Z",
    );
    expect(zonedDayStart("2026-09-29", "UTC").toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(zonedDayStart("2026-09-29", "Etc/UTC").toISOString()).toBe("2026-09-29T00:00:00.000Z");
    // Summer and winter time: New York is -04:00 in September and -05:00 in January.
    expect(zonedDayStart("2026-09-29", "America/New_York").toISOString()).toBe(
      "2026-09-29T04:00:00.000Z",
    );
    expect(zonedDayStart("2026-01-15", "America/New_York").toISOString()).toBe(
      "2026-01-15T05:00:00.000Z",
    );
    // The days the clocks change: still that day's own midnight.
    expect(zonedDayStart("2026-03-08", "America/New_York").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(zonedDayStart("2026-11-01", "America/New_York").toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(zonedDayStart("2026-10-04", "Australia/Sydney").toISOString()).toBe(
      "2026-10-03T14:00:00.000Z",
    );
    // An unknown zone is read as UTC rather than breaking the page.
    expect(zonedDayStart("2026-09-29", "Not/AZone").toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });

  it("starts at the clock jump when that zone skips midnight itself", () => {
    // Santiago, Sep 6 2026: 23:59:59 (-04:00) is followed by 01:00 (-03:00), at 04:00 UTC. The hour
    // before (03:00–04:00 UTC) is still Sep 5 there, so it must not count as Sep 6.
    expect(zonedDayStart("2026-09-06", "America/Santiago").toISOString()).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    // Havana, Mar 8 2026: midnight (-05:00) jumps to 01:00 (-04:00), at 05:00 UTC.
    expect(zonedDayStart("2026-03-08", "America/Havana").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
  });

  it("every day of a year, in zones with clock changes: the first instant dated that day there", () => {
    const zones = [
      "America/Santiago",
      "America/Havana",
      "America/New_York",
      "Europe/London",
      "Australia/Lord_Howe",
      "Asia/Tehran",
      "Pacific/Chatham",
      "Asia/Kathmandu",
    ];
    for (const tz of zones) {
      const dayThere = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      for (let day = "2026-01-01"; day <= "2026-12-31"; day = nextDay(day)) {
        const start = zonedDayStart(day, tz).getTime();
        expect(dayThere.format(new Date(start)), `${tz} ${day}`).toBe(day);
        expect(dayThere.format(new Date(start - 1)) < day, `${tz} ${day} (1 ms before)`).toBe(true);
      }
    }
  });

  it("the next day, across months and years", () => {
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("Problems: what the Bad cards name", () => {
  const clean = { imgShare: 0.1, phoneTextPx: 16, layoutK: 1, unsubscribe: "before_clip" };
  const scored = { score: 75, band: "good" as const };
  it("each option is its cap or chip, or the severe problem the card names for it", () => {
    expect(galleryProblemsOf({ ...scored, issues: [], signals: clean })).toEqual([]);
    expect(
      galleryProblemsOf({ ...scored, issues: ["contrast", "clipped"], signals: null }),
    ).toEqual(["contrast", "clipped"]);
    // The caps themselves count too (a merge tag has no issue chip of its own).
    expect(
      galleryProblemsOf({ ...scored, caps: ["CAP_MERGE_TAG", "CAP_BROKEN_IMAGES"], signals: null }),
    ).toEqual(["merge_tag", "broken_images"]);
    // "Most of this email is pictures: only 97 characters of real text"
    expect(
      galleryProblemsOf({ ...scored, signals: { ...clean, imgShare: 0.87, legibleChars: 97 } }),
    ).toEqual(["image_only"]);
    // "Doesn't fit phones: text shrinks to about 11 px"
    expect(
      galleryProblemsOf({ ...scored, signals: { ...clean, phoneTextPx: 10.5, layoutK: 0.66 } }),
    ).toEqual(["mobile"]);
    // "No unsubscribe link anywhere in the email"
    expect(galleryProblemsOf({ ...scored, signals: { ...clean, unsubscribe: "none" } })).toEqual([
      "no_unsubscribe",
    ]);
    // "Low score": under 60
    expect(galleryProblemsOf({ score: 59, band: "needs_work", signals: clean })).toEqual([
      "low_score",
    ]);
    expect(galleryProblemsOf({ score: 60, band: "needs_work", signals: clean })).toEqual([]);
    expect(
      galleryProblemsOf({
        ...scored,
        issues: ["image_only", "mobile", "broken_images"],
        signals: {
          imgShare: 1,
          legibleChars: 0,
          phoneTextPx: 8,
          layoutK: 0.5,
          unsubscribe: "none",
        },
      }),
    ).toEqual(["image_only", "mobile", "broken_images", "no_unsubscribe"]);
    // An unscored design has none, whatever its stale chips say.
    expect(galleryProblemsOf({ score: null, band: null, issues: ["clipped"] })).toEqual([]);
  });

  it("every option has a plain label and a chip; old links keep their ids", () => {
    expect(GALLERY_PROBLEMS).toContain("no_unsubscribe");
    for (const x of GALLERY_PROBLEMS) expect(GALLERY_PROBLEM_LABELS[x]).toMatch(/^[A-Z][^.]*$/);
    expect(GALLERY_PROBLEM_LABELS.no_unsubscribe).toBe("No unsubscribe link");
    expect(activeFilterChips(p({ problem: ["no_unsubscribe"] })).map((c) => c.label)).toEqual([
      "No unsubscribe link",
    ]);
    // Links made before the options matched the Bad rules one to one still filter the same.
    for (const old of [
      "image_only",
      "contrast",
      "mobile",
      "clipped",
      "broken_images",
      "no_unsubscribe",
    ])
      expect(parseGalleryParams({ problem: old }).problem, old).toEqual([old]);
    // Named for the Bad rule (the cut hides the main button, the unsubscribe link or a quarter of
    // the text), so an email just over the limit isn't missing from it.
    expect(GALLERY_PROBLEM_LABELS.clipped).toBe("Gmail cuts off key parts");
    expect(GALLERY_PROBLEM_LABELS.image_only).toBe("Mostly pictures");
  });
});

describe("senders that share a name", () => {
  const senders = [
    { id: A, name: "LinkedIn", address: "jobs-noreply@linkedin.com" },
    { id: B, name: "linkedin ", address: "messages-noreply@linkedin.com" },
    { id: uuid(3), name: "Shop", address: "hi@shop.example" },
  ];
  it("are told apart by their address, in the panel and on the chips", () => {
    expect([...sharedSenderNames(senders)]).toEqual(["linkedin"]);
    expect(senderChipLabels(senders)).toEqual(
      new Map([
        [A, "LinkedIn (jobs-noreply@linkedin.com)"],
        [B, "linkedin (messages-noreply@linkedin.com)"],
        [uuid(3), "Shop"],
      ]),
    );
    const chips = activeFilterChips(p({ sender: [A, B] }), { senders: senderChipLabels(senders) });
    expect(new Set(chips.map((c) => c.label)).size).toBe(2);
  });
});

describe("preview URLs for big pages", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 96-card page asks in two calls of 48 ids, sent side by side", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const store = new PreviewUrlStore(async (ids) => {
      calls.push(ids);
      return Object.fromEntries(ids.map((id) => [id, `https://view.test/v/t/${id}`]));
    });
    const ids = Array.from({ length: 96 }, (_, i) => `id${i}`);
    for (const id of ids) store.request(id);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.map((c) => c.length)).toEqual([48, 48]);
    expect(calls.flat()).toEqual(ids);
    for (const id of ids) expect(store.get(id)).toMatchObject({ state: "ready" });
  });
});
