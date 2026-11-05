/**
 * Design gallery model (src/lib/gallery.ts), no database:
 *  - the VERDICT POLICY from the design checklist: Good = every rule checked and passed, Okay = one
 *    or two missed or one unchecked, Bad = three or more missed, no current checklist = not checked
 *    yet; a malformed or older checklist is never trusted
 *  - the card line and the Problems ("Missed rules") options read the same saved checklist
 *  - the engine findings' wording helpers the full analysis page still uses (severe facts, the
 *    strength conflict rules, colour names, merge tags, trimming)
 *  - the category mapping is total over @edf/core's types and subtypes, and the SQL rules derived
 *    from it put every (type, subtype) pair in exactly one category
 *  - URL params: defaults, field-by-field fallback, the same q normalisation as the client, links
 */
import { describe, expect, it } from "vitest";
import { EMAIL_SUBTYPES, EMAIL_TYPES } from "@edf/core/types";
import {
  CHECKLIST_RULES,
  CHECKLIST_VERSION,
  designChecklist,
  checklistVerdict,
} from "@edf/design";
import {
  CHECKLIST_RULE_COUNT,
  DEFAULT_GALLERY_PARAMS,
  EMAIL_GALLERY_CATEGORY_IDS,
  GALLERY_CATEGORIES,
  GALLERY_PROBLEM_LABELS,
  GALLERY_PROBLEMS,
  GALLERY_Q_MAX,
  IMAGE_TEXT_CHARS_MAX,
  IMAGE_TEXT_SHARE_MIN,
  LEGACY_SHRINK_K_MAX,
  LEGACY_TINY_PHONE_TEXT_PX,
  MISSED_RULE_TEXT,
  REASON_MAX,
  VERDICT_LABELS,
  activeFilterChips,
  categoryRules,
  checklistReason,
  colourName,
  compatibleStrengthItems,
  galleryCategoryOf,
  galleryHref,
  galleryProblemsOf,
  mergeTagSnippet,
  parseGalleryParams,
  severeTriggers,
  storedChecklist,
  trimReason,
  legacySummaryCut,
  verdictOf,
  type EmailGalleryCategory,
} from "@/lib/gallery";
import { checklistOf } from "../support/checklist";

describe("verdictOf: the design checklist, strictly", () => {
  it("Good = every rule checked and passed; a rule that doesn't apply doesn't count", () => {
    expect(verdictOf({ checklist: checklistOf() })).toBe("good");
    expect(verdictOf({ checklist: checklistOf({ images: "na", scan: "na" }) })).toBe("good");
  });

  it("Okay = one or two missed, or none missed with any unchecked", () => {
    expect(verdictOf({ checklist: checklistOf({ width: "miss" }) })).toBe("ok");
    expect(verdictOf({ checklist: checklistOf({ width: "miss", fonts: "miss" }) })).toBe("ok");
    expect(verdictOf({ checklist: checklistOf({ contrast: "unknown" }) })).toBe("ok");
    // Unchecked rules never make it worse than its misses: two missed and five unchecked is Okay.
    expect(
      verdictOf({
        checklist: checklistOf({
          width: "miss",
          fonts: "miss",
          body: "unknown",
          contrast: "unknown",
          hierarchy: "unknown",
          cta: "unknown",
          button: "unknown",
        }),
      }),
    ).toBe("ok");
  });

  it("Bad = three or more missed", () => {
    expect(verdictOf({ checklist: checklistOf({ width: "miss", fonts: "miss", body: "miss" }) })).toBe("bad");
    const all = Object.fromEntries(CHECKLIST_RULES.map((r) => [r.id, "miss" as const]));
    expect(verdictOf({ checklist: checklistOf(all) })).toBe("bad");
  });

  it("no checklist, an older version or a malformed one: not checked yet", () => {
    const good = checklistOf();
    for (const bad of [
      null,
      undefined,
      "good",
      [],
      { ...good, v: "designmodo-2026.10" },
      { ...good, misses: "0" },
      { ...good, misses: -1 },
      { ...good, unknown: 1.5 },
      { ...good, misses: null },
      { v: CHECKLIST_VERSION, rules: [] },
    ])
      expect(verdictOf({ checklist: bad }), JSON.stringify(bad)).toBe("unscored");
    // The saved counts decide (the SQL twin reads them too); rules that aren't well-formed are left out.
    const odd = storedChecklist({ v: CHECKLIST_VERSION, rules: [{ id: "x", result: "miss" }, 3], misses: 0, unknown: 0 });
    expect(odd).toEqual({ v: CHECKLIST_VERSION, rules: [], misses: 0, unknown: 0 });
  });

  it("agrees with the engine's own verdict and rule list", () => {
    expect(CHECKLIST_RULES).toHaveLength(CHECKLIST_RULE_COUNT);
    for (const c of [checklistOf(), checklistOf({ hero: "miss" }), checklistOf({ hero: "miss", body: "miss", scan: "miss" })])
      expect(verdictOf({ checklist: c })).toBe(checklistVerdict(c));
    // A checklist the engine computes from nothing measured is never Good.
    const blank = designChecklist([], {});
    expect(verdictOf({ checklist: blank })).not.toBe("good");
  });

  it("labels", () => {
    expect(VERDICT_LABELS).toEqual({
      good: "Good design",
      bad: "Bad design",
      ok: "Okay",
      unscored: "Not checked yet",
    });
  });
});

describe("checklistReason: the card line and the detail lists", () => {
  it("Good: passes all 16 (or all that apply)", () => {
    expect(checklistReason(checklistOf()).reason).toEqual({
      kind: "strength",
      text: "Passes all 16 design rules",
    });
    expect(checklistReason(checklistOf({ images: "na" })).reason?.text).toBe(
      "Passes all 15 design rules that apply",
    );
  });

  it("missed rules lead, in the cheat sheet's order, within 120 characters", () => {
    const r = checklistReason(
      checklistOf(
        { contrast: "miss", button: "miss", no_decoration: "miss" },
        { button: "There's no button, only text links." },
      ),
    );
    expect(r.reason).toEqual({
      kind: "problem",
      text: "Misses 3 rules: no single main button, faint text, relies on pictures",
    });
    expect(r.problems[0]).toBe("There's no button, only text links.");
    expect(r.problems).toHaveLength(3);
    expect(r.strengths).toHaveLength(13);
    const one = checklistReason(checklistOf({ width: "miss" }));
    expect(one.reason?.text).toBe("Misses 1 rule: not about 600px wide");
    const all = Object.fromEntries(CHECKLIST_RULES.map((x) => [x.id, "miss" as const]));
    const many = checklistReason(checklistOf(all)).reason!.text;
    expect(many.length).toBeLessThanOrEqual(REASON_MAX);
    expect(many).toMatch(/^Misses 16 rules: no one clear message, .* and \d+ more$/);
  });

  it("nothing missed but something unchecked says so", () => {
    expect(checklistReason(checklistOf({ body: "unknown", contrast: "unknown" })).reason).toEqual({
      kind: "strength",
      text: "Passes every rule we could check (2 couldn't be checked)",
    });
  });

  it("an unchecked design has no line and no lists", () => {
    expect(checklistReason(null)).toEqual({ reason: null, problems: [], strengths: [] });
  });

  it("the card names a missed rule exactly when the Problems filter matches it", () => {
    const c = checklistOf({ hero: "miss", fonts: "miss", images: "unknown", scan: "na" });
    expect(galleryProblemsOf({ checklist: c })).toEqual(["hero", "fonts"]);
    expect(galleryProblemsOf({ checklist: null })).toEqual([]);
    expect(GALLERY_PROBLEMS).toEqual(CHECKLIST_RULES.map((r) => r.id));
    for (const id of GALLERY_PROBLEMS) {
      expect(GALLERY_PROBLEM_LABELS[id]).toBe(CHECKLIST_RULES.find((r) => r.id === id)!.label);
      expect(MISSED_RULE_TEXT[id]).toBeTruthy();
      // Link-safe: the URL parser lowercases values.
      expect(id).toBe(id.toLowerCase());
    }
  });

  it("every option round-trips through the URL and gets a chip", () => {
    const p = parseGalleryParams({ problem: GALLERY_PROBLEMS.join(",") });
    expect(p.problem).toEqual(GALLERY_PROBLEMS);
    expect(parseGalleryParams({ problem: "image_only,low_score,button" }).problem).toEqual(["button"]);
    const chips = activeFilterChips(parseGalleryParams({ problem: "no_decoration" }), {});
    expect(chips.map((c) => c.label)).toContain("Missed: Works without the pictures");
  });
});

describe("severeTriggers (the findings' wording)", () => {
  const CLEAN = {
    imgShare: 0.1,
    legibleChars: null,
    phoneTextPx: 16,
    layoutK: 1,
    unsubscribe: "before_clip",
  };

  it("each severe rule at its edges", () => {
    const at = (over: Record<string, unknown>) => severeTriggers({ ...CLEAN, ...over });
    // text in images: share ≥ 0.5 AND < 200 live characters (alt text doesn't matter)
    expect(at({ imgShare: IMAGE_TEXT_SHARE_MIN, legibleChars: IMAGE_TEXT_CHARS_MAX - 1 })).toEqual([
      "text_in_images",
    ]);
    expect(at({ imgShare: 0.499, legibleChars: 10 })).toEqual([]);
    expect(at({ imgShare: 0.9, legibleChars: IMAGE_TEXT_CHARS_MAX })).toEqual([]);
    expect(at({ imgShare: 0.9, legibleChars: 0 })).toEqual(["text_in_images"]);
    expect(at({ imgShare: 0.9, legibleChars: null })).toEqual([]); // not measured
    // tiny phone text (v1.5 rows): any shrink AND text under 11.5 px (≈ 11 px or less)
    expect(at({ phoneTextPx: 11.49, layoutK: 0.9 })).toEqual(["tiny_phone_text"]);
    expect(at({ phoneTextPx: LEGACY_TINY_PHONE_TEXT_PX, layoutK: 0.9 })).toEqual([]);
    expect(at({ phoneTextPx: 10, layoutK: LEGACY_SHRINK_K_MAX })).toEqual([]); // fits: tiny CSS text is a T1 deduction
    expect(at({ phoneTextPx: 10, layoutK: null })).toEqual([]);
    // no unsubscribe: only "none" (a link after Gmail's clip is the clipping problem; null = exempt)
    expect(at({ unsubscribe: "none" })).toEqual(["no_unsubscribe"]);
    expect(at({ unsubscribe: "after_clip" })).toEqual([]);
    expect(at({ unsubscribe: null })).toEqual([]);
    // junk never triggers (nor throws)
    for (const junk of [null, undefined, 3, "none", [], { imgShare: "0.9", legibleChars: "5" }])
      expect(severeTriggers(junk)).toEqual([]);
  });
});

const check = (
  id: string,
  status: string,
  value: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  id,
  status,
  s: status === "pass" ? 1 : 0.5,
  w: 2,
  points: 1,
  pointsLost: status === "pass" ? 0 : 1,
  value,
  ...extra,
});

describe("compatibleStrengthItems", () => {
  it("the full analysis page's Good list gets the same conflict rules", () => {
    const good = [
      {
        key: "good:mobile",
        checkIds: ["M1", "M3", "T1"],
        title: "Built for phones: fits a 375px screen with 17.8px body text",
      },
      {
        key: "good:I2",
        checkIds: ["I2"],
        title: "All the text is real text, so it reads fine with images off",
      },
      { key: "good:A7", checkIds: ["A7"], title: "Links are easy to tap on phones" },
      { key: "good:L5", checkIds: ["L5"], title: "A restrained colour palette" },
    ];
    const needs = [
      { key: "check:M7", title: "100% of body text touches the screen edge on phones" },
      { key: "check:M4", title: "The main button “View invoice” is only 25px tall on phones" },
    ];
    const checks = [
      check("M7", "fail", { okShare: 0 }),
      check("M4", "partial", { minSidePx: 25 }),
      check("I4", "not_applicable"),
    ];
    expect(compatibleStrengthItems(good, needs, { checks }).map((g) => g.key)).toEqual(["good:L5"]);
    // From a saved summary (no checks): the listed problems still rule strengths out.
    expect(compatibleStrengthItems(good, needs).map((g) => g.key)).toEqual(["good:I2", "good:L5"]);
  });
});

describe("trimReason", () => {
  it("tidies titles a legacy (pre-2026.2) summary cut at exactly 80 characters", () => {
    const cut = "The layout is a fixed 606px, so on phones it shrinks to 62%: body text becomes ~";
    expect(Array.from(cut)).toHaveLength(80);
    // Current summaries cut at a word boundary themselves, so an 80-character title is whole.
    expect(trimReason(cut)).toBe(cut);
    expect(trimReason(cut, 200, { summaryCut: true })).toBe(
      "The layout is a fixed 606px, so on phones it shrinks to 62%: body text becomes…",
    );
    expect(
      trimReason(
        "100% of body text fails contrast (#888888 on #ffffff = 3.54:1) (score capped at ",
        200,
        { summaryCut: true },
      ),
    ).toBe("100% of body text fails contrast (#888888 on #ffffff = 3.54:1)");
    expect(
      trimReason(
        "Some code isn't supported by major email apps (max_width, border_radius, web_fon",
        200,
        { summaryCut: true },
      ),
    ).toBe("Some code isn't supported by major email apps");
    // A legacy-looking 80 characters that already ends in "…" was cut properly: kept.
    const cutNew = `${"The main button “Choose the plan that fits your team best and".padEnd(79, "x")}…`;
    expect(trimReason(cutNew, 200, { summaryCut: true })).toBe(cutNew);
  });

  it("knows which saved summaries predate word-boundary cuts", () => {
    expect(legacySummaryCut({ scoringVersion: "2026.1+w-2026.1+t-2026.1" })).toBe(true);
    expect(legacySummaryCut({ scoringVersion: "2025.9+x" })).toBe(true);
    expect(legacySummaryCut({ scoringVersion: "2026.2+w-2026.1+t-2026.2" })).toBe(false);
    expect(legacySummaryCut({ scoringVersion: "2027.1+x" })).toBe(false);
    expect(legacySummaryCut({})).toBe(true);
    expect(legacySummaryCut(null)).toBe(true);
  });

  it("never drops the last word of a text that wasn't cut (79 or 81+ characters, or the gallery's own sentences)", () => {
    const t79 = "Comfortable line spacing and generous margins make every paragraph easy to read";
    expect(Array.from(t79)).toHaveLength(79);
    expect(trimReason(t79)).toBe(t79);
    const t81 = `${t79}!!`;
    expect(trimReason(t81)).toBe(t81);
    const t87 =
      "The whole email is images: it's blank with images off and unreadable for screen readers";
    expect(trimReason(t87, 200)).toBe(t87);
    const own80 =
      "Comfortable line spacing and generous margins make every paragraph easy to read.";
    expect(Array.from(own80)).toHaveLength(80);
    expect(trimReason(own80, 200, { summaryCut: false })).toBe(own80);
  });

  it("drops the cap note and cuts long text at a word boundary", () => {
    expect(trimReason("short one")).toBe("short one");
    expect(trimReason("1 of 1 images are broken (score capped at 59)")).toBe(
      "1 of 1 images are broken",
    );
    expect(trimReason("x".repeat(300)).length).toBe(REASON_MAX);
  });
});

describe("plain-English helpers", () => {
  it("colourName names colours the way a reader would", () => {
    expect(colourName("#ffffff")).toBe("white");
    expect(colourName("#fff")).toBe("white");
    expect(colourName("#000000")).toBe("black");
    expect(colourName("#888888")).toBe("grey");
    expect(colourName("#a0a0a0")).toBe("light grey");
    expect(colourName("#dddddd")).toBe("very light grey");
    expect(colourName("#333333")).toBe("dark grey");
    expect(colourName("#ff0000")).toBe("red");
    expect(colourName("#1a56db")).toBe("blue");
    expect(colourName("#60a5fa")).toBe("light blue");
    expect(colourName("#bfdbfe")).toBe("pale blue");
    expect(colourName("rgb(255, 255, 255)")).toBe("white");
    expect(colourName("not a colour")).toBeNull();
  });

  it("mergeTagSnippet quotes the tag with the words around it", () => {
    expect(mergeTagSnippet("Hi *|FNAME|*, rain shells are 25% off")).toBe("Hi *|FNAME|*");
    expect(mergeTagSnippet("Welcome aboard {{ first_name }}!")).toBe(
      "Welcome aboard {{ first_name }}",
    );
    expect(mergeTagSnippet("Dear [First Name], your order")).toBeNull(); // not a merge-tag family
    expect(mergeTagSnippet("Dear [FIRSTNAME], your order")).toBe("Dear [FIRSTNAME]");
    expect(mergeTagSnippet("Nothing to see")).toBeNull();
  });
});

describe("galleryCategoryOf", () => {
  const pairs = EMAIL_TYPES.flatMap((t) =>
    [null, ...(EMAIL_SUBTYPES[t] as readonly string[])].map((s) => [t, s] as const),
  );

  it("is total over every type and subtype in @edf/core", () => {
    for (const [t, s] of pairs)
      expect(EMAIL_GALLERY_CATEGORY_IDS).toContain(galleryCategoryOf(t, s));
    expect(galleryCategoryOf("not-a-type", null)).toBe("other");
    expect(galleryCategoryOf("promotional", "not-a-subtype")).toBe("promotions");
  });

  it("maps as the gallery promises", () => {
    for (const s of [null, ...EMAIL_SUBTYPES.newsletter])
      expect(galleryCategoryOf("newsletter", s)).toBe("newsletters");
    expect(galleryCategoryOf("promotional", "cart_reminder")).toBe("abandoned_cart");
    for (const s of [null, "sale", "coupon", "product_launch", "recommendation"])
      expect(galleryCategoryOf("promotional", s)).toBe("promotions");
    expect(galleryCategoryOf("lifecycle", "welcome")).toBe("welcome");
    expect(galleryCategoryOf("lifecycle", "onboarding")).toBe("welcome");
    expect(galleryCategoryOf("lifecycle", "trial_ending")).toBe("other");
    expect(galleryCategoryOf("lifecycle", null)).toBe("other");
    for (const s of [null, ...EMAIL_SUBTYPES.product_update])
      expect(galleryCategoryOf("product_update", s)).toBe("product_updates");
    // Event and webinar invites are promotions in the gallery (Events merged, 2026-10-04).
    for (const s of [null, ...EMAIL_SUBTYPES.event])
      expect(galleryCategoryOf("event", s)).toBe("promotions");
    for (const s of [null, ...EMAIL_SUBTYPES.transactional])
      expect(galleryCategoryOf("transactional", s)).toBe("receipts");
    // App mail has chips of its own, so "Other" stays small.
    const own = {
      social: "social",
      community: "social",
      notification: "notifications",
      account_notice: "notifications",
      account_security: "notifications",
      survey: "notifications",
      other: "other",
    } as const;
    for (const [t, want] of Object.entries(own) as Array<[keyof typeof own, string]>) {
      for (const s of [null, ...(EMAIL_SUBTYPES[t] as readonly string[])])
        expect(galleryCategoryOf(t, s), `${t}/${s}`).toBe(want);
    }
  });

  it("every category but 'all' is reachable, and the SQL rules place each pair in exactly its category", () => {
    const reached = new Set(pairs.map(([t, s]) => galleryCategoryOf(t, s)));
    expect([...reached].sort()).toEqual([...EMAIL_GALLERY_CATEGORY_IDS].sort());
    expect(GALLERY_CATEGORIES.map((c) => c.id)).toEqual(["all", ...EMAIL_GALLERY_CATEGORY_IDS]);
    const matches = (c: EmailGalleryCategory, t: string, s: string | null) =>
      categoryRules(c).some(
        (r) =>
          r.primaryType === t &&
          (r.byDefault ? s === null || !r.except.includes(s) : s !== null && r.only.includes(s)),
      );
    for (const [t, s] of [
      ...pairs,
      ["promotional", "odd_subtype"] as const,
      ["lifecycle", "odd_subtype"] as const,
    ]) {
      const hits = EMAIL_GALLERY_CATEGORY_IDS.filter((c) => matches(c, t, s));
      expect(hits, `${t}/${s}`).toEqual([galleryCategoryOf(t, s)]);
    }
  });
});

describe("gallery URL params", () => {
  it("defaults", () => {
    expect(DEFAULT_GALLERY_PARAMS).toEqual({
      category: "all",
      design: "all",
      font: null,
      q: "",
      sort: "newest",
      page: 1,
      size: 24,
      smin: 0,
      smax: 100,
      date: "any",
      since: null,
      until: null,
      sender: [],
      problem: [],
      mailbox: null,
      webfonts: "any",
      board: null,
      saved: null,
    });
    expect(parseGalleryParams(undefined)).toEqual(DEFAULT_GALLERY_PARAMS);
    expect(parseGalleryParams({})).toEqual(DEFAULT_GALLERY_PARAMS);
    expect(parseGalleryParams("category=welcome")).toEqual(DEFAULT_GALLERY_PARAMS);
  });

  it("reads Next searchParams objects and URLSearchParams", () => {
    const want = {
      ...DEFAULT_GALLERY_PARAMS,
      category: "welcome",
      design: "good",
      font: "Inter",
      q: "autumn sale",
      sort: "best",
    };
    expect(
      parseGalleryParams({
        category: "welcome",
        design: "good",
        font: "Inter",
        q: "autumn sale",
        sort: "best",
      }),
    ).toEqual(want);
    expect(
      parseGalleryParams({
        category: ["welcome", "promotions"],
        design: "good",
        font: "Inter",
        q: " autumn sale ",
        sort: "best",
      }),
    ).toEqual(want);
    expect(
      parseGalleryParams(
        new URLSearchParams("category=welcome&design=good&font=Inter&q=autumn+sale&sort=best"),
      ),
    ).toEqual(want);
  });

  it("an invalid field falls back to its default and keeps the others", () => {
    expect(parseGalleryParams({ category: "spam", design: "bad", sort: "worst" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      design: "bad",
      sort: "worst",
    });
    expect(parseGalleryParams({ design: "excellent", category: "product_updates" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      category: "product_updates",
    });
    expect(parseGalleryParams({ q: 42, font: "Lato" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      font: "Lato",
    });
    expect(parseGalleryParams({ font: "", sort: "received_at; DROP TABLE email" })).toEqual(
      DEFAULT_GALLERY_PARAMS,
    );
    expect(parseGalleryParams({ font: "x".repeat(600), category: "welcome" })).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      category: "welcome",
    });
    // A category the gallery no longer shows (it is for marketing design only) reads as All.
    for (const hidden of ["receipts", "social", "newsletters", "notifications", "other", "events"]) {
      expect(parseGalleryParams({ category: hidden, design: "good" })).toEqual({
        ...DEFAULT_GALLERY_PARAMS,
        design: "good",
      });
    }
    // The Saved chip: "1" or nothing.
    expect(parseGalleryParams({ saved: "1" }).saved).toBe("1");
    expect(parseGalleryParams({ saved: "yes" }).saved).toBeNull();
    expect(parseGalleryParams({ saved: "" }).saved).toBeNull();
    expect(parseGalleryParams({ q: 42, category: "all" })).toEqual(DEFAULT_GALLERY_PARAMS);
  });

  it("q over 100 characters is cut exactly as the client cuts it (trim, then the first 100), never dropped", () => {
    const clientNormalise = (q: string) => q.trim().slice(0, GALLERY_Q_MAX); // use-gallery-params.ts / gallery-search.tsx
    for (const q of [
      "x".repeat(101),
      `  ${"ab ".repeat(60)}  `,
      "a".repeat(100),
      " spaced out  ",
      "é".repeat(150),
    ]) {
      expect(parseGalleryParams({ q }).q, q).toBe(clientNormalise(q));
    }
    expect(parseGalleryParams({ q: "x".repeat(101) }).q).toHaveLength(100);
  });

  it("galleryHref leaves defaults out and round-trips", () => {
    expect(galleryHref()).toBe("/gallery");
    expect(galleryHref({ category: "all", sort: "newest" })).toBe("/gallery");
    const href = galleryHref({
      category: "abandoned_cart",
      design: "bad",
      font: "DM Sans",
      q: "50% off",
      sort: "worst",
    });
    expect(href).toBe(
      "/gallery?category=abandoned_cart&design=bad&font=DM+Sans&q=50%25+off&sort=worst",
    );
    expect(parseGalleryParams(new URL(href, "http://x").searchParams)).toEqual({
      ...DEFAULT_GALLERY_PARAMS,
      category: "abandoned_cart",
      design: "bad",
      font: "DM Sans",
      q: "50% off",
      sort: "worst",
    });
    expect(galleryHref({ design: "good" }, "/")).toBe("/?design=good");
  });
});

