/**
 * The daily picture check (server/picture-health.ts) and the banners that show its result and the
 * governor's image switch (queries/account.ts syncBanner):
 *  - a card whose pictures load is fine; a card with no picture links, pictures edf-view won't
 *    serve, a card that doesn't load, or the image switch being on, is each reported;
 *  - the pictures-paused banner shows to anyone while the switch is on; a failed check shows to
 *    the owner only, for at most 36 hours, and never repeats what the paused banner already says.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "./support/db";

vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => null,
}));

const VIEW = "https://edf-view.example";

describe("pictureLinks", () => {
  it("finds the card's edf-view picture links, once each, never the placeholder", async () => {
    const { pictureLinks } = await import("@/server/picture-health");
    const html =
      `<img src="${VIEW}/img/v1.aaa.bbb" alt="a"><img alt="none"><img src="${VIEW}/img/unavailable">` +
      `<img src="${VIEW}/img/v1.aaa.bbb"><img src="https://elsewhere.example/x.png"><img src="${VIEW}/img/v1.c&amp;d">`;
    expect(pictureLinks(html, `${VIEW}/`)).toEqual([`${VIEW}/img/v1.aaa.bbb`, `${VIEW}/img/v1.c&d`]);
  });
});

describe("picture banners", () => {
  const base = {
    level: 0,
    inngestPaused: false,
    aiPaused: false,
    ingestKilled: false,
    tickEvery: 30 as const,
    picturesPaused: false,
    pictureCheck: null,
  };
  const mailbox = {
    id: "m1",
    emailAddress: "me@example.com",
    status: "active",
    backfill: { state: "done", stored: 0, queuedPosition: null },
  } as never;

  it("pictures paused: shown to everyone", async () => {
    const { syncBanner } = await import("@/server/queries/account");
    for (const role of ["owner", "friend"] as const) {
      expect(syncBanner([mailbox], { ...base, role, picturesPaused: true })?.id).toBe("pictures:paused");
    }
    expect(syncBanner([mailbox], { ...base, role: "owner" })).toBeNull();
  });

  it("a failed check: the owner only, for 36 hours, in plain words", async () => {
    const { syncBanner } = await import("@/server/queries/account");
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const old = new Date(Date.now() - 40 * 3600_000).toISOString();
    const check = (checkedAt: string, code = "pictures_not_served", role = "friend") => ({
      ok: false,
      checkedAt,
      problems: [{ role, code }],
    });
    const b = syncBanner([mailbox], { ...base, role: "owner", pictureCheck: check(recent) });
    expect(b?.id).toBe(`pictures:check:${recent}`);
    expect(b?.text).toContain("a friend's gallery: the picture service isn't sending pictures");
    expect(syncBanner([mailbox], { ...base, role: "friend", pictureCheck: check(recent) })).toBeNull();
    expect(syncBanner([mailbox], { ...base, role: "owner", pictureCheck: check(old) })).toBeNull();
    expect(syncBanner([mailbox], { ...base, role: "owner", pictureCheck: { ok: true, checkedAt: recent, problems: [] } })).toBeNull();
    // "paused" is already said by the paused banner.
    const paused = syncBanner([mailbox], { ...base, role: "owner", picturesPaused: true, pictureCheck: check(recent, "paused", "owner") });
    expect(paused?.id).toBe("pictures:paused");
  });
});

describe.skipIf(!HAS_DB)("checkUserPictures against the database", () => {
  const pool = appPool();
  const owner = ownerPool();
  let userId = "";
  let saved: unknown = null;
  const setGovernor = (value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  beforeAll(async () => {
    saved = (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ?? null;
    userId = (await createUser(pool, { role: "owner" })).id;
    const mb = await createMailbox(pool, userId);
    for (let i = 0; i < 2; i++) {
      await seedEmail(pool, userId, mb, {
        designStatus: "done",
        analysis: {
          scoringVersion: "test",
          rendererVersion: "render-test",
          features: { static: { images: { content: 3 } } },
          checks: [],
          pillarScores: [],
          rawScore: 80,
          caps: [],
          confidence: 0.9,
          trust: {},
          scoreSummary: { needsImprovement: [], good: [], signals: { imgShare: 0.5 } },
          aiReview: null,
          aiModel: null,
          renderRefEmailId: null,
          rendererHost: null,
          chromiumVersion: null,
          renderMs: null,
        },
      } as never);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await setGovernor(saved ?? { level: 0 });
    await owner.end();
    await pool.end();
    const { getPool } = await import("@/server/db");
    await (await getPool()).end();
  });

  /** edf-view answering the card and its pictures as given. */
  function stubView(card: (url: string) => Response, picture: (url: string) => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("/v/") ? card(String(url)) : picture(String(url)))),
    );
  }
  const viewOrigin = async () => (await import("@/env")).env().VIEW_ORIGIN.replace(/\/$/, "");
  const cardWithPictures = async () => {
    const o = await viewOrigin();
    return () => new Response(`<html><body><img src="${o}/img/v1.one.sig"><img src="${o}/img/v1.two.sig"></body></html>`, { status: 200 });
  };

  it("pictures that load: fine", async () => {
    await setGovernor({ level: 0, actions: {} });
    const { checkUserPictures } = await import("@/server/picture-health");
    stubView(await cardWithPictures(), () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } }));
    expect(await checkUserPictures(userId, "owner", await viewOrigin(), Date.now() + 60_000)).toBe("none");
  });

  it("each way pictures go missing is reported", async () => {
    const { checkUserPictures } = await import("@/server/picture-health");
    const origin = await viewOrigin();
    const run = () => checkUserPictures(userId, "owner", origin, Date.now() + 60_000);
    await setGovernor({ level: 0, actions: {} });
    // The placeholder (an SVG) is not a picture.
    stubView(await cardWithPictures(), () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }));
    expect(await run()).toBe("pictures_not_served");
    stubView(() => new Response("<html><body><img alt='x'></body></html>", { status: 200 }), () => new Response(""));
    expect(await run()).toBe("no_picture_links");
    stubView(() => new Response("oops", { status: 502 }), () => new Response(""));
    expect(await run()).toBe("card_failed");
    await setGovernor({ level: 0, actions: { imagesClickToLoad: true, friendsImagesClickToLoad: true } });
    expect(await run()).toBe("paused");
    await setGovernor({ level: 0, actions: {} });
  });
});
