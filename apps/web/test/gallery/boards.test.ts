/**
 * Boards against the real database (migration 0018, server/actions/boards.ts, queries/boards.ts,
 * the gallery's `?board=` filter):
 *  - create (optionally saving a design in one step, all or nothing), rename, delete; names are
 *    trimmed, 1–60 characters, unique per user ignoring case (another user may reuse a name)
 *  - save / unsave are idempotent; the card learns whether the design is still saved anywhere
 *  - the gallery's board filter lists exactly the board's designs; its counts and the board list
 *    agree; the gallery marks saved designs
 *  - tenant isolation: another user's boards and designs can't be seen, saved into or changed
 *  - a board's saves go with their email (deleted) and with the board; the designs stay
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type * as BoardActions from "@/server/actions/boards";
import type * as BoardQueries from "@/server/queries/boards";
import type * as GalleryQueries from "@/server/queries/gallery";
import { DEFAULT_GALLERY_PARAMS, galleryHref, parseGalleryParams } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, sessionFor } from "../tests-server/helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const BOARD = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("the board filter in gallery links", () => {
  it("reads a board id, drops anything else, and writes it back", () => {
    expect(parseGalleryParams({ board: BOARD }).board).toBe(BOARD);
    expect(parseGalleryParams({ board: "not-a-board" }).board).toBeNull();
    expect(parseGalleryParams({ board: "" }).board).toBeNull();
    expect(DEFAULT_GALLERY_PARAMS.board).toBeNull();
    expect(galleryHref({ board: BOARD })).toBe(`/gallery?board=${BOARD}`);
    expect(galleryHref({ board: BOARD, design: "good" })).toBe(`/gallery?design=good&board=${BOARD}`);
  });
});

describe.skipIf(!HAS_DB)("boards against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let actions: typeof BoardActions;
  let q: typeof BoardQueries;
  let gallery: typeof GalleryQueries;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;
  let a1: string;
  let a2: string;
  let a3: string;
  let b1: string;

  const as = (u: { id: string; email: string; name: string }) => {
    state.session = sessionFor(u);
  };
  const okData = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.data;
  };
  const scored = { designStatus: "done" as const, designSource: "render" as const, designScore: 88, designBand: "excellent" as const };

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    actions = await import("@/server/actions/boards");
    q = await import("@/server/queries/boards");
    gallery = await import("@/server/queries/gallery");
    alice = await createUser(app, { role: "owner" });
    bob = await createUser(app, { role: "friend" });
    const aliceMb = await createMailbox(app, alice.id);
    const bobMb = await createMailbox(app, bob.id);
    a1 = await seedEmail(app, alice.id, aliceMb, { subject: "a1", ...scored });
    a2 = await seedEmail(app, alice.id, aliceMb, { subject: "a2", ...scored });
    a3 = await seedEmail(app, alice.id, aliceMb, { subject: "a3", ...scored });
    b1 = await seedEmail(app, bob.id, bobMb, { subject: "b1", ...scored });
  });

  afterAll(async () => {
    state.session = null;
    await app?.end();
    await owner?.end();
  });

  it("creates, saves, lists, filters and marks", async () => {
    as(alice);
    // Create with a design saved in one step; the name is trimmed and its spaces collapsed.
    const welcome = okData(await actions.createBoard("  Great   welcome  ", a1));
    expect(welcome.name).toBe("Great welcome");
    const empty = okData(await actions.createBoard("Later"));

    // Saving twice is one save; the card learns it's saved somewhere.
    expect(okData(await actions.setSaved(a2, welcome.id, true))).toEqual({ savedAnywhere: true });
    expect(okData(await actions.setSaved(a2, welcome.id, true))).toEqual({ savedAnywhere: true });

    const choices = okData(await actions.getBoardChoices(a2));
    expect(choices.map((c) => [c.name, c.count, c.saved])).toEqual([
      ["Great welcome", 2, true],
      ["Later", 0, false],
    ]);

    const boards = await q.listBoards(alice.id);
    expect(boards.map((b) => [b.name, b.count])).toEqual([
      ["Great welcome", 2],
      ["Later", 0],
    ]);
    expect(boards[0]!.recent).toHaveLength(2);
    expect(boards[1]!.recent).toEqual([]);

    // The gallery's board filter lists exactly the board's designs, and agrees with the counts.
    const page = await gallery.listGallery(alice.id, { ...DEFAULT_GALLERY_PARAMS, board: welcome.id });
    expect(page.items.map((i) => i.subject).sort()).toEqual(["a1", "a2"]);
    expect(page.total).toBe(2);
    const facets = await gallery.galleryFacets(alice.id, { ...DEFAULT_GALLERY_PARAMS, board: welcome.id });
    expect(facets.categories.all).toBe(2);
    expect(facets.boards.map((b) => [b.name, b.count])).toEqual([
      ["Later", 0],
      ["Great welcome", 2],
    ]);
    const none = await gallery.listGallery(alice.id, { ...DEFAULT_GALLERY_PARAMS, board: empty.id });
    expect(none.total).toBe(0);

    // The whole gallery marks the saved designs.
    const everything = await gallery.listGallery(alice.id, DEFAULT_GALLERY_PARAMS);
    const saved = Object.fromEntries(everything.items.map((i) => [i.subject, i.saved]));
    expect(saved).toEqual({ a1: true, a2: true, a3: false });

    // Unsave: the board shrinks; still saved elsewhere or not.
    expect(okData(await actions.setSaved(a2, welcome.id, false))).toEqual({ savedAnywhere: false });
    expect(okData(await actions.setSaved(a2, welcome.id, false))).toEqual({ savedAnywhere: false });
    okData(await actions.setSaved(a1, empty.id, true));
    expect(okData(await actions.setSaved(a1, welcome.id, false))).toEqual({ savedAnywhere: true });
  });

  it("names: required, at most 60 characters, unique per user ignoring case", async () => {
    as(alice);
    okData(await actions.createBoard("Receipts"));
    for (const dupe of ["receipts", " RECEIPTS "]) {
      const r = await actions.createBoard(dupe);
      expect(r).toMatchObject({ ok: false, code: "invalid", error: "You already have a board with that name." });
    }
    expect(await actions.createBoard("   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(await actions.createBoard("x".repeat(61))).toMatchObject({ ok: false, code: "invalid" });
    expect(okData(await actions.createBoard("x".repeat(60))).name).toHaveLength(60);
    // A control character is never stored.
    expect(okData(await actions.createBoard("Tab\there")).name).toBe("Tab here");

    const other = okData(await actions.createBoard("Other"));
    expect(await actions.renameBoard(other.id, "RECEIPTS")).toMatchObject({ ok: false, code: "invalid" });
    expect(okData(await actions.renameBoard(other.id, "other (renamed)"))).toEqual({ name: "other (renamed)" });
    // Renaming to its own name in another case is fine.
    expect(okData(await actions.renameBoard(other.id, "OTHER (RENAMED)"))).toEqual({ name: "OTHER (RENAMED)" });

    // Bob may use the same name: names are per user.
    as(bob);
    okData(await actions.createBoard("Receipts"));
  });

  it("another user's boards and designs are out of reach", async () => {
    as(alice);
    const mine = okData(await actions.createBoard("Mine"));
    okData(await actions.setSaved(a3, mine.id, true));

    as(bob);
    // Bob can't see, save into, rename or delete Alice's board…
    expect((await q.listBoards(bob.id)).some((b) => b.id === mine.id)).toBe(false);
    expect(await actions.setSaved(b1, mine.id, true)).toMatchObject({ ok: false, code: "not_found" });
    expect(await actions.setSaved(a3, mine.id, false)).toMatchObject({ ok: false, code: "not_found" });
    expect(await actions.renameBoard(mine.id, "Hacked")).toMatchObject({ ok: false, code: "not_found" });
    expect(await actions.deleteBoard(mine.id)).toMatchObject({ ok: false, code: "not_found" });
    // …nor save Alice's design into his own board, in either step.
    const his = okData(await actions.createBoard("His"));
    expect(await actions.setSaved(a3, his.id, true)).toMatchObject({ ok: false, code: "not_found" });
    expect(await actions.createBoard("Sneaky", a3)).toMatchObject({ ok: false, code: "not_found" });
    // "Create and save" is all or nothing: the board wasn't kept either.
    expect((await q.listBoards(bob.id)).map((b) => b.name)).not.toContain("Sneaky");
    // His filter on her board shows nothing.
    const page = await gallery.listGallery(bob.id, { ...DEFAULT_GALLERY_PARAMS, board: mine.id });
    expect(page.total).toBe(0);

    // Alice's board is untouched.
    const row = await owner.query<{ name: string; n: string }>(
      "SELECT b.name, (SELECT count(*) FROM board_item bi WHERE bi.board_id = b.id) AS n FROM board b WHERE b.id = $1",
      [mine.id],
    );
    expect(row.rows[0]).toEqual({ name: "Mine", n: "1" });
    // Even straight SQL as the app role sees none of it in Bob's context.
    const { withUser } = await import("@edf/db");
    const seen = await withUser(app, bob.id, (_db, c) =>
      c.query("SELECT 1 FROM board_item WHERE board_id = $1", [mine.id]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it("saves go with their email and with their board; the designs stay", async () => {
    as(alice);
    const mb = await createMailbox(app, alice.id);
    const gone = await seedEmail(app, alice.id, mb, { subject: "gone", ...scored });
    const kept = await seedEmail(app, alice.id, mb, { subject: "kept", ...scored });
    const board = okData(await actions.createBoard("Short-lived", gone));
    okData(await actions.setSaved(kept, board.id, true));

    // Deleted in Gmail (the pipeline deletes the email row): its save goes too.
    const { withUser } = await import("@edf/db");
    await withUser(app, alice.id, (_db, c) => c.query("DELETE FROM email WHERE id = $1", [gone]));
    const choices = okData(await actions.getBoardChoices(kept));
    expect(choices.find((c) => c.id === board.id)).toMatchObject({ count: 1, saved: true });

    // Deleting the board deletes its saves, never the designs.
    expect(await actions.deleteBoard(board.id)).toEqual({ ok: true });
    expect(await actions.deleteBoard(board.id)).toMatchObject({ ok: false, code: "not_found" });
    const left = await owner.query("SELECT 1 FROM board_item WHERE board_id = $1", [board.id]);
    expect(left.rowCount).toBe(0);
    const email = await owner.query("SELECT 1 FROM email WHERE id = $1", [kept]);
    expect(email.rowCount).toBe(1);
  });

  it("the Saved chip lists every saved design, of any type, and its count ignores the type filter", async () => {
    const carol = await createUser(app, { role: "friend" });
    const mb = await createMailbox(app, carol.id);
    const promo = await seedEmail(app, carol.id, mb, { subject: "promo", ...scored });
    const welcome = await seedEmail(app, carol.id, mb, {
      subject: "welcome",
      ...scored,
      primaryType: "lifecycle",
      subtype: "welcome",
    });
    await seedEmail(app, carol.id, mb, { subject: "not saved", ...scored });
    as(carol);
    const one = okData(await actions.createBoard("One", promo));
    okData(await actions.createBoard("Two", welcome));
    // Saved in two boards still lists once.
    okData(await actions.setSaved(promo, okData(await actions.createBoard("Three")).id, true));
    expect(one.name).toBe("One");

    const saved = await gallery.listGallery(carol.id, { ...DEFAULT_GALLERY_PARAMS, saved: "1" });
    expect(saved.items.map((i) => i.subject).sort()).toEqual(["promo", "welcome"]);
    expect(saved.items.every((i) => i.saved)).toBe(true);
    const all = await gallery.galleryFacets(carol.id, DEFAULT_GALLERY_PARAMS);
    // 2, not more: Alice's many saves (earlier tests) never count for Carol.
    expect(all.saved).toBe(2);
    expect(all.categories.all).toBe(3);
    // With a type chip on, the Saved count still covers every type.
    const promos = await gallery.galleryFacets(carol.id, { ...DEFAULT_GALLERY_PARAMS, category: "promotions" });
    expect(promos.saved).toBe(2);
    // With Saved on, the type counts narrow to the saved designs.
    const onSaved = await gallery.galleryFacets(carol.id, { ...DEFAULT_GALLERY_PARAMS, saved: "1" });
    expect(onSaved.categories).toMatchObject({ all: 2, promotions: 1, welcome: 1 });
    as(alice);
  });

  it("refuses ids that aren't ids, and signed-out callers", async () => {
    as(alice);
    expect(await actions.setSaved("nope", BOARD, true)).toMatchObject({ ok: false, code: "invalid" });
    expect(await actions.getBoardChoices("nope")).toMatchObject({ ok: false, code: "invalid" });
    state.session = null;
    expect(await actions.createBoard("Anything")).toMatchObject({ ok: false, code: "unauthorized" });
  });
});
