/**
 * The live gallery's check and the "when will it be scored" states against the database
 * (queries/gallery-live.ts, actions/gallery-live.ts, queries/gallery-waiting.ts):
 *  - the stamp counts exactly the gallery's own designs (listGallery's total with every filter
 *    off), moves on a new design, a new score, a render starting and a design leaving, and not
 *    at all for another user's mail (RLS + the explicit user predicate);
 *  - "added since" is exact to the microsecond: the newest design itself never counts as new;
 *  - the view counts follow the page's filters (a new promotion isn't new in Newsletters);
 *  - the action: same stamp → no view query; bad input → "invalid"; signed out → "unauthorized";
 *    the governor's UI polling off (L1) → pollingOff;
 *  - unscored cards carry their waiting state from the real render queue, and the web's
 *    fresh-candidate rule counts the same emails as the pipeline's.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { raw, sql, withUser, type pg } from "@edf/db";
import { freshRows, saveAnalysis, type EmailRecord } from "@edf/pipeline";
import type * as LiveQueries from "@/server/queries/gallery-live";
import type * as LiveActions from "@/server/actions/gallery-live";
import type * as GalleryQueries from "@/server/queries/gallery";
import type * as Waiting from "@/server/queries/gallery-waiting";
import { DEFAULT_GALLERY_PARAMS, type GalleryParams } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import {
  appPool,
  createMailbox,
  createUser,
  emailRecord,
  ownerPool,
  seedEmail,
} from "../support/db";
import { type FakeSession, sessionFor } from "../tests-server/helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const H = 3_600_000;
const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
  ...DEFAULT_GALLERY_PARAMS,
  ...over,
});
const RESET_GOVERNOR = `UPDATE app_setting SET value = '{"level":0,"since":null,"triggers":[],"belowSince":null}' WHERE key = 'governor'`;

const scoredRecord = (score: number): Partial<EmailRecord> => ({
  designStatus: "done",
  designSource: "render",
  designScore: score,
  designBand: score >= 85 ? "excellent" : "good",
  designCapped: false,
  designProvisional: false,
  designConfidence: "high",
});

describe.skipIf(!HAS_DB)("the live gallery against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let live: typeof LiveQueries;
  let actions: typeof LiveActions;
  let gallery: typeof GalleryQueries;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;
  let aliceMb: string;
  let bobMb: string;
  const at = (h: number) => new Date(Date.now() - h * H);

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    await owner.query(RESET_GOVERNOR);
    live = await import("@/server/queries/gallery-live");
    actions = await import("@/server/actions/gallery-live");
    gallery = await import("@/server/queries/gallery");
    alice = await createUser(app, { role: "owner" });
    bob = await createUser(app, { role: "friend" });
    aliceMb = await createMailbox(app, alice.id);
    bobMb = await createMailbox(app, bob.id);
    await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(1),
      subject: "promo",
      ...scoredRecord(90),
    });
    await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(2),
      subject: "letter",
      primaryType: "newsletter",
      subtype: "digest",
      ...scoredRecord(80),
    });
    // Never in the gallery (so never in the stamp): plain text, security-sensitive, trashed.
    await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(3),
      designStatus: "plain_text",
      designSource: "none",
      htmlBytes: 0,
    });
    await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(3),
      designStatus: "skipped",
      designSource: "none",
      securitySensitive: true,
    });
    const trashed = await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(3),
      ...scoredRecord(70),
    });
    await owner.query("UPDATE email SET in_trash = true WHERE id = $1", [trashed]);
    await seedEmail(app, bob.id, bobMb, { receivedAt: at(1), ...scoredRecord(95) });
  });

  afterAll(async () => {
    await owner?.query(RESET_GOVERNOR);
    await app?.end();
    await owner?.end();
  });

  beforeEach(() => {
    state.session = null;
  });

  it("the stamp counts exactly the gallery's designs, and only the user's own", async () => {
    const { stamp, pollingOff } = await live.galleryStamp(alice.id);
    expect(pollingOff).toBe(false);
    expect(stamp.total).toBe(2);
    expect(stamp.scored).toBe(2);
    expect(stamp.total).toBe((await gallery.listGallery(alice.id, params())).total);
    // Postgres text, microseconds included.
    expect(stamp.newest).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\+00$/);
    expect(stamp.analyzedAt).not.toBeNull();
    const before = (await live.galleryStamp(bob.id)).stamp;
    await seedEmail(app, alice.id, aliceMb, { receivedAt: at(0.5), ...scoredRecord(88) });
    expect((await live.galleryStamp(bob.id)).stamp).toEqual(before);
  });

  it("'added since' is exact to the microsecond, and follows the page's filters", async () => {
    const s0 = (await live.galleryStamp(alice.id)).stamp;
    expect(await live.galleryViewChange(alice.id, params(), s0)).toEqual({
      total: s0.total,
      added: 0,
      rescored: 0,
    });
    await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(0.1),
      subject: "new promo",
      ...scoredRecord(91),
    });
    await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(0.1),
      subject: "unscored",
      searchText: "unscored gallery",
    });
    const s1 = (await live.galleryStamp(alice.id)).stamp;
    expect(s1.total).toBe(s0.total + 2);
    expect(s1.newest! > s0.newest!).toBe(true);
    expect(await live.galleryViewChange(alice.id, params(), s0)).toMatchObject({
      total: s1.total,
      added: 2,
    });
    // Neither is a newsletter, nor good-looking enough for Good (the unscored one).
    expect(
      await live.galleryViewChange(alice.id, params({ category: "newsletters" }), s0),
    ).toMatchObject({ total: 1, added: 0 });
    expect(await live.galleryViewChange(alice.id, params({ design: "good" }), s0)).toMatchObject({
      added: 1,
    });
    expect(await live.galleryViewChange(alice.id, params({ q: "unscored" }), s0)).toMatchObject({
      total: 1,
      added: 1,
    });
    // No stamp yet (an empty gallery when rendered): everything is new.
    expect(
      (await live.galleryViewChange(alice.id, params(), { newest: null, analyzedAt: null })).added,
    ).toBe(s1.total);
  });

  it("a new score (a render saved) moves the stamp and counts as rescored in the view; a hidden design leaves it", async () => {
    const id = await seedEmail(app, alice.id, aliceMb, {
      receivedAt: at(0.2),
      subject: "to render",
    });
    const s0 = (await live.galleryStamp(alice.id)).stamp;
    // A render finishing: the analysis saved with the design columns (render.ts → saveAnalysis).
    const rec = emailRecord(alice.id, aliceMb, scoredRecord(77));
    await withUser(app, alice.id, (_db, c) =>
      saveAnalysis(c, {
        emailId: id,
        userId: alice.id,
        analysis: rec.analysis!,
        design: {
          designStatus: "done",
          designSource: "render",
          designAiState: "pending",
          designScore: 77,
          designBand: "good",
          designCapped: false,
          designProvisional: false,
          designIssues: [],
          designConfidence: "medium",
          fontSource: "render",
          fontFamilies: [],
          usesWebFonts: false,
        },
        force: true,
      }),
    );
    const s1 = (await live.galleryStamp(alice.id)).stamp;
    expect(s1.scored).toBe(s0.scored + 1);
    expect(s1.analyzedAt! > s0.analyzedAt!).toBe(true);
    expect(s1.newest).toBe(s0.newest);
    expect(await live.galleryViewChange(alice.id, params(), s0)).toEqual({
      total: s0.total,
      added: 0,
      rescored: 1,
    });
    // A render starting moves the stamp too (the card's "Scoring now").
    await withUser(app, alice.id, (_db, c) =>
      c.query(
        "INSERT INTO render_request (user_id, email_id, kind, state) VALUES ($1, $2, 'on_demand', 'done')",
        [alice.id, id],
      ),
    );
    const s2 = (await live.galleryStamp(alice.id)).stamp;
    expect(s2.renderAt).not.toBe(s1.renderAt);
    // Trashed in Gmail: it leaves the gallery.
    await owner.query("UPDATE email SET in_trash = true WHERE id = $1", [id]);
    const s3 = (await live.galleryStamp(alice.id)).stamp;
    expect(s3.total).toBe(s2.total - 1);
    expect((await live.galleryViewChange(alice.id, params(), s2)).total).toBe(s2.total - 1);
  });

  it("the action: same stamp → no view; changed → the view's counts; bad input and no session refused", async () => {
    state.session = sessionFor(alice);
    const s = (await live.galleryStamp(alice.id)).stamp;
    const same = await actions.checkGallery({ params: params(), since: s });
    expect(same).toEqual({ ok: true, data: { stamp: s, pollingOff: false, view: null } });
    const moved = await actions.checkGallery({
      params: params(),
      since: { ...s, total: s.total - 1 },
    });
    expect(moved.ok && moved.data.view).toEqual({ total: s.total, added: 0, rescored: 0 });
    // Hand-made params are normalised like the page's (an unknown category is "all").
    const odd = await actions.checkGallery({
      params: { category: "nope", page: -3 },
      since: { ...s, scored: 0 },
    });
    expect(odd.ok && odd.data.view?.total).toBe(s.total);
    for (const since of [
      null,
      { ...s, newest: "yesterday" },
      { ...s, total: -1 },
      { ...s, analyzedAt: "2026-09-30'; DROP TABLE email; --" },
    ]) {
      expect(await actions.checkGallery({ params: params(), since })).toMatchObject({
        ok: false,
        code: "invalid",
      });
    }
    state.session = null;
    expect(await actions.checkGallery({ params: params(), since: s })).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("another user's stamp is never compared with (or leaks) Alice's", async () => {
    state.session = sessionFor(bob);
    const aliceStamp = (await live.galleryStamp(alice.id)).stamp;
    const r = await actions.checkGallery({ params: params(), since: aliceStamp });
    expect(r.ok && r.data.stamp.total).toBe(1);
    expect(r.ok && r.data.view).toEqual({ total: 1, added: 0, rescored: 0 });
  });

  it("the governor's UI polling off (L1) stops the checks", async () => {
    await owner.query(
      `UPDATE app_setting SET value = '{"level":1,"actions":{"syncStatusPollingOff":true}}' WHERE key = 'governor'`,
    );
    try {
      expect((await live.galleryStamp(alice.id)).pollingOff).toBe(true);
      state.session = sessionFor(alice);
      const s = (await live.galleryStamp(alice.id)).stamp;
      const r = await actions.checkGallery({ params: params(), since: s });
      expect(r.ok && r.data.pollingOff).toBe(true);
    } finally {
      await owner.query(RESET_GOVERNOR);
    }
  });
});

describe.skipIf(!HAS_DB)(
  "when unscored designs get their score, from the real render queue",
  () => {
    let app: pg.Pool;
    let owner: pg.Pool;
    let gallery: typeof GalleryQueries;
    let waiting: typeof Waiting;
    let me: Awaited<ReturnType<typeof createUser>>;
    let friend: Awaited<ReturnType<typeof createUser>>;
    let mb: string;
    let paused: string;
    let friendMb: string;
    const ids: Record<string, string> = {};
    const at = (h: number) => new Date(Date.now() - h * H);

    let jobsPaused: boolean;
    beforeAll(async () => {
      app = appPool();
      owner = ownerPool();
      await owner.query(RESET_GOVERNOR);
      // Other suites may leave the shared test database's "background jobs paused" flag on.
      jobsPaused =
        (await owner.query<{ p: boolean }>("SELECT inngest_paused AS p FROM system_state")).rows[0]
          ?.p === true;
      await owner.query("UPDATE system_state SET inngest_paused = false");
      gallery = await import("@/server/queries/gallery");
      waiting = await import("@/server/queries/gallery-waiting");
      me = await createUser(app, { role: "owner" });
      friend = await createUser(app, { role: "friend" });
      mb = await createMailbox(app, me.id);
      paused = await createMailbox(app, me.id, { status: "paused" });
      friendMb = await createMailbox(app, friend.id);
      const seed = async (
        key: string,
        h: number,
        over: Partial<EmailRecord> = {},
        box = mb,
        user = me.id,
      ) =>
        (ids[key] = await seedEmail(app, user, box, { receivedAt: at(h), subject: key, ...over }));
      await seed("fresh", 1);
      await seed("running", 2);
      await seed("tried", 3);
      await seed("measured", 4, { designSource: "render" }); // rendered, still no score
      await seed("older", 60);
      await seed("old", 20 * 24);
      await seed("disconnected", 1, {}, paused);
      await seed("scored", 1, scoredRecord(90));
      await seed("friends", 1, {}, friendMb, friend.id);
      await withUser(app, me.id, async (_db, c) => {
        await c.query(
          "INSERT INTO render_request (user_id, email_id, kind, state) VALUES ($1, $2, 'fill', 'running')",
          [me.id, ids.running],
        );
        await c.query(
          "INSERT INTO render_request (user_id, email_id, kind, state) VALUES ($1, $2, 'fill', 'failed')",
          [me.id, ids.tried],
        );
      });
    });

    afterAll(async () => {
      await owner?.query(RESET_GOVERNOR);
      await owner?.query("UPDATE system_state SET inngest_paused = $1", [jobsPaused]);
      await app?.end();
      await owner?.end();
    });

    const states = async (userId: string) =>
      Object.fromEntries(
        (await gallery.listGallery(userId, params({ size: 96 }))).items.map((i) => [
          i.subject,
          i.waiting?.state ?? (i.score === null ? "?" : "scored"),
        ]),
      );

    it("each card says what will really happen", async () => {
      expect(await states(me.id)).toEqual({
        fresh: "soon",
        running: "scoring",
        tried: "retry", // its fill render failed: the nightly run tries again
        measured: "unscorable",
        older: "scheduled",
        old: "manual",
        disconnected: "mailbox",
        scored: "scored",
      });
      expect(await states(friend.id)).toEqual({ friends: "queued" });
      const page = await gallery.listGallery(me.id, params({ size: 96 }));
      const tonight = page.items.find((i) => i.subject === "older")!.waiting!;
      expect(Date.parse(tonight.at!) - Date.now()).toBeGreaterThan(0);
      expect(Date.parse(tonight.at!) - Date.now()).toBeLessThanOrEqual(24 * H);
      expect(new Date(tonight.at!).toISOString()).toMatch(/T04:30:00\.000Z$/);
      // Scored cards carry no waiting state.
      expect(page.items.find((i) => i.subject === "scored")!.waiting).toBeUndefined();
    });

    it("the governor's switches are honoured", async () => {
      try {
        await owner.query(
          `UPDATE app_setting SET value = '{"level":1,"actions":{"fillRendersOff":true}}' WHERE key = 'governor'`,
        );
        // Fill off (L1): nothing is rendered on its own, but "Analyze this email" still works.
        expect(await states(me.id)).toMatchObject({
          fresh: "paused",
          running: "scoring",
          older: "paused",
          old: "manual",
        });
        // Friends' mail too: fill is off for everyone.
        expect(await states(friend.id)).toEqual({ friends: "paused" });
        await owner.query(
          `UPDATE app_setting SET value = '{"level":0,"actions":{"rendersNightlyOnly":true}}' WHERE key = 'governor'`,
        );
        expect(await states(me.id)).toMatchObject({ fresh: "scheduled", older: "scheduled" });
        await owner.query(
          `UPDATE app_setting SET value = '{"level":3,"actions":{}}' WHERE key = 'governor'`,
        );
        expect(await states(me.id)).toMatchObject({ fresh: "paused", running: "paused" });
        await owner.query(RESET_GOVERNOR);
        // Background jobs paused (Inngest's quota): nothing new starts; the running render still finishes.
        await owner.query("UPDATE system_state SET inngest_paused = true");
        expect(await states(me.id)).toMatchObject({
          fresh: "paused",
          older: "paused",
          running: "scoring",
        });
      } finally {
        await owner.query(RESET_GOVERNOR);
        await owner.query("UPDATE system_state SET inngest_paused = false");
      }
    });

    it("the web's fresh-candidate rule counts the same emails as the pipeline's", async () => {
      const [row] = await freshRows(
        { pool: app, tokens: {} as never, tickEvery: 30, governorLevel: async () => 0 },
        [{ user_id: me.id, role: "owner", mailboxes: 1, last_active_at: new Date() }],
        Date.now(),
      );
      const web = await withUser(app, me.id, async (db) =>
        Number(
          (
            await raw(db).execute<{ n: number }>(
              sql`SELECT count(*)::int AS n FROM email e WHERE e.user_id = ${me.id} AND ${waiting.freshCandidate("e")}`,
            )
          ).rows[0]!.n,
        ),
      );
      expect(row!.candidates).toBe(1); // "fresh" only: the others are tried, running, older, or disconnected
      expect(web).toBe(row!.candidates);
    });

    it("nothing extra is read when every design on the page is scored", async () => {
      const items = (await gallery.listGallery(me.id, params())).items.filter(
        (i) => i.score !== null,
      );
      const out = await withUser(app, me.id, (db) => waiting.withWaiting(db, me.id, items));
      expect(out).toBe(items);
    });

    it("a random uuid that isn't the user's never gets a state", async () => {
      const fake = {
        ...(await gallery.listGallery(me.id, params())).items[0]!,
        id: randomUUID(),
        score: null,
      };
      const [out] = await withUser(app, friend.id, (db) =>
        waiting.withWaiting(db, friend.id, [fake]),
      );
      expect(out!.waiting).toBeUndefined();
    });
  },
);
