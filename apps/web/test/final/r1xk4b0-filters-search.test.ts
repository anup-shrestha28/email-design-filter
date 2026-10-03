/**
 * R1-10: one invalid inbox URL field (a 21st font, a 72-char font name, a stray `sub`) used to make
 * parseFilters return the defaults for the WHOLE filter set, so the list silently showed the default
 * inbox while every chip still looked selected. Now invalid items are dropped, an over-long list keeps
 * its first items up to the limit, and only a bad field falls back; the subtype limit covers every
 * subtype the rail offers, and the font-name limit covers every stored family name (so a long name
 * picked from the rail or the command palette is applied, not silently dropped).
 *
 * R1-37: the prefix word of a search lost its punctuation ("rust-embedded" → "rustembedded"), which
 * matches nothing in the 'simple' tsvector. Hyphens, slashes, dots and @ now stay inside the word.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_SUBTYPES } from "@edf/core/types";
import type { pg } from "@edf/db";
import type * as InboxQueries from "@/server/queries/inbox";
import {
  capFonts,
  DEFAULT_FILTERS,
  MAX_FONT_NAME,
  MAX_FONTS,
  parseFilters,
  splitSearch,
} from "@/lib/filters";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

const fonts = (n: number) => Array.from({ length: n }, (_, i) => `font${i}`);

describe("parseFilters falls back field by field (R1-10)", () => {
  it("a 21st font keeps every other filter, and the first MAX_FONTS fonts", () => {
    const f = parseFilters({ scope: "all", design: ["bad"], sort: "score", fonts: fonts(21) });
    expect(f).toMatchObject({ scope: "all", design: ["bad"], sort: "score" });
    expect(f.fonts).toEqual(fonts(MAX_FONTS));
  });

  it("an over-long list of distinct items is trimmed to its limit; one padded with repeats resets", () => {
    const subs = Array.from(
      { length: 50 },
      (_, i) => "sub_" + String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26)),
    );
    const f = parseFilters({ unread: true, subtypes: subs, fonts: ["arial", ...fonts(25)] });
    expect(f.unread).toBe(true);
    expect(f.fonts).toEqual(["arial", ...fonts(MAX_FONTS - 1)]);
    expect(f.subtypes.length).toBeGreaterThan(20);
    expect(f.subtypes).toEqual(subs.slice(0, f.subtypes.length));
    expect(parseFilters({ subtypes: [...subs, "x"] }).subtypes).toEqual(f.subtypes);
    expect(parseFilters({ unread: true, fonts: Array(21).fill("arial") })).toMatchObject({
      unread: true,
      fonts: [],
    });
  });

  it("a long stored family name (72 chars, as the command palette can pick) is applied", () => {
    const long = "x".repeat(72);
    expect(parseFilters({ scope: "all", fonts: [long] })).toMatchObject({
      scope: "all",
      fonts: [long],
    });
    // Every name the design package can store fits (it cuts a font-family value at 500 chars).
    expect(MAX_FONT_NAME).toBeGreaterThanOrEqual(500);
  });

  it("a font name over the limit is dropped, the other fonts and filters are kept", () => {
    const f = parseFilters({
      scope: "receipts",
      fonts: ["montserrat", "x".repeat(MAX_FONT_NAME + 1)],
      unread: true,
    });
    expect(f).toMatchObject({ scope: "receipts", fonts: ["montserrat"], unread: true });
  });

  it("a list value on a non-list field falls back to its default", () => {
    const f = parseFilters({ scope: ["all"], sort: ["score"], unread: true });
    expect(f).toMatchObject({ scope: "subscriptions", sort: "newest", unread: true });
  });

  it("bad sender / mailbox / language values reset only themselves", () => {
    const f = parseFilters({
      types: ["promotions"],
      senderId: "nope",
      mailboxId: "x",
      language: "english",
      pinned: true,
    });
    expect(f).toMatchObject({
      types: ["promotions"],
      senderId: null,
      mailboxId: null,
      language: null,
      pinned: true,
    });
  });

  it("every subtype the rail can offer is accepted at once", () => {
    const all = [...new Set(Object.values(EMAIL_SUBTYPES).flat())];
    expect(all.length).toBeGreaterThan(20);
    const f = parseFilters({ scope: "all", subtypes: all });
    expect(f.subtypes).toEqual(all);
    expect(f.scope).toBe("all");
  });

  it("still never passes invalid values through", () => {
    const f = parseFilters({
      scope: "all",
      subtypes: ["sale", "sale' OR 1=1 --"],
      sort: "received_at; DROP TABLE email",
    });
    expect(f).toMatchObject({ scope: "all", subtypes: ["sale"], sort: "newest" });
    expect(parseFilters("scope=all")).toEqual(DEFAULT_FILTERS);
    expect(parseFilters([1, 2])).toEqual(DEFAULT_FILTERS);
  });

  it("capFonts keeps the UI inside the server's limits", () => {
    expect(capFonts(fonts(25))).toEqual(fonts(MAX_FONTS));
    expect(capFonts(["arial", "y".repeat(72), "y".repeat(MAX_FONT_NAME + 1), ""])).toEqual([
      "arial",
      "y".repeat(72),
    ]);
  });
});

describe("splitSearch keeps inner punctuation in the prefix word (R1-37)", () => {
  it("hyphenated words, paths, domains and addresses", () => {
    expect(splitSearch("rust-embedded")).toEqual({ query: "", prefix: "rust-embedded" });
    expect(splitSearch("news Acme/API")).toEqual({ query: "news", prefix: "acme/api" });
    expect(splitSearch("bob@example.com")).toEqual({ query: "", prefix: "bob@example.com" });
  });

  it("never lets a quote, backslash or tsquery operator through; trims edge punctuation", () => {
    expect(splitSearch("Montserrat'):*")).toEqual({ query: "", prefix: "montserrat" });
    expect(splitSearch("a\\b'c|d&e")).toEqual({ query: "", prefix: "abcde" });
    expect(splitSearch("-rust-")).toEqual({ query: "", prefix: "rust" });
    expect(splitSearch("autumn ---")).toEqual({ query: "autumn", prefix: "" });
    expect(splitSearch(`${"a".repeat(39)}-b`).prefix).toBe("a".repeat(39));
  });
});

describe.skipIf(!HAS_DB)("search finds hyphenated and slashed words (R1-37, database)", () => {
  let app: pg.Pool;
  let user: string;
  let email: string;
  let inbox: typeof InboxQueries;

  beforeAll(async () => {
    app = appPool();
    inbox = await import("@/server/queries/inbox");
    user = (await createUser(app, { role: "owner" })).id;
    const mb = await createMailbox(app, user);
    email = await seedEmail(app, user, mb, {
      subject: "Rust-Embedded weekly",
      searchText: "Rust-Embedded weekly from acme/api news@letters.example",
    });
  });
  afterAll(async () => {
    await app.end();
  });

  const found = async (search: string) =>
    (
      await inbox.listInbox(user, { ...DEFAULT_FILTERS, scope: "all" }, { search, limit: 50 })
    ).items.map((i) => i.id);

  it.each([
    "rust-embedded",
    "rust-emb",
    "weekly rust-embedded",
    "acme/api",
    "acme/a",
    "news@letters.example",
  ])("%s", async (q) => {
    expect(await found(q)).toEqual([email]);
  });
  it("still finds nothing for unrelated words", async () => {
    expect(await found("python-embedded")).toEqual([]);
  });
});
