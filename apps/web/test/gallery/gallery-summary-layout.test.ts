/**
 * The gallery shows every email full length and crops its card to the visible design, from the
 * render's layout facts, against the real database:
 *  - the list reads score_summary.layout (kept after compaction, migrations 0016 / 0017) and falls
 *    back to features.render.layout for rows saved before the engine wrote it; no render → no frame
 *  - summary_layout(features) in SQL equals @edf/design summaryLayout — with a measured content
 *    extent, with none found (null), and from a render that predates it (key absent) — and is null
 *    without a render
 *  - compaction empties features but saves the layout first (filling the content extent into an
 *    older summary layout), so the card keeps its full length and its crop
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser, type pg } from "@edf/db";
import { summaryLayout } from "@edf/design";
import type { RenderFeatures } from "@edf/design/types";
import type { EmailRecord } from "@edf/pipeline";
import { compactFeatures } from "@edf/pipeline/maintenance";
import type * as GalleryQueries from "@/server/queries/gallery";
import type { GalleryItem } from "@/server/queries/types";
import { DEFAULT_GALLERY_PARAMS, type GalleryParams } from "@/lib/gallery";
import { previewFrameOf } from "@/lib/gallery-preview";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => null, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Real layout facts from the owner's mailbox (Betterbrand, a 508 px column in the 800 px render).
const LAYOUT = {
  desktopHeight: 1318,
  mobileHeight: 1778,
  desktopContentWidth: 800,
  mobileContentWidth: 375,
  nomqContentWidth: null,
  k: 1,
  kNomq: null,
  mainContainer: { x: 146, y: 187, w: 508, h: 817.5 },
};
/** A long email with a fixed 624 px phone layout. */
const LONG = {
  ...LAYOUT,
  desktopHeight: 4588.5,
  mobileHeight: 6120,
  mobileContentWidth: 624,
  mainContainer: { x: 88, y: 0, w: 624, h: 4400 },
};
/** No main container found (the summary keeps null). */
const NO_BOX = { ...LAYOUT, mainContainer: null };
/** render-2026.3: the visible content extent was measured (a card with text a little inside it). */
const MEASURED = { ...LAYOUT, content: { left: 104, right: 696, bottom: 1290 } };
/** Measured, and nothing visible was found. */
const NOTHING = { ...LAYOUT, content: null };
/** A fixed 886 px layout (a 902 px document with the body margins), wider than the canvas, measured. */
const WIDE = {
  ...LAYOUT,
  desktopContentWidth: 902,
  content: { left: 8, right: 894, bottom: 1300 },
};
const renderOf = (layout: unknown) => ({ render: { layout } });
const tsLayout = (layout: unknown) =>
  summaryLayout(renderOf(layout).render as unknown as RenderFeatures);
/** A summary layout saved before 0017 (migration 0016's shape: no content, no desktop width). */
const oldSummaryLayout = (l: typeof LAYOUT) => ({
  desktopHeight: l.desktopHeight,
  mobileHeight: l.mobileHeight,
  mobileContentWidth: l.mobileContentWidth,
  mainContainer: l.mainContainer,
});

function scored(
  opts: { features: unknown; summaryLayout?: unknown | "absent" },
): Partial<EmailRecord> {
  const summary: Record<string, unknown> = { scoringVersion: "test", needsImprovement: [], good: [] };
  if (opts.summaryLayout !== undefined && opts.summaryLayout !== "absent")
    summary.layout = opts.summaryLayout;
  return {
    designStatus: "done",
    designSource: "render",
    designScore: 80,
    designBand: "good",
    designCapped: false,
    designProvisional: false,
    designIssues: [],
    designConfidence: "high",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      features: opts.features as never,
      checks: [],
      pillarScores: [],
      rawScore: 80,
      caps: [],
      confidence: 0.9,
      trust: {},
      scoreSummary: summary,
      aiReview: null,
      aiModel: null,
      renderRefEmailId: null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    },
  };
}

describe.skipIf(!HAS_DB)("gallery full-length previews: the saved layout", () => {
  let app: pg.Pool;
  let q: typeof GalleryQueries;
  let user: Awaited<ReturnType<typeof createUser>>;
  const now = Date.now();

  const cases: Array<{ name: string; features: unknown; summaryLayout?: unknown; frame: unknown }> = [
    // Written by the engine now: the summary has it.
    {
      name: "summary",
      features: renderOf(LAYOUT),
      summaryLayout: summaryLayout(renderOf(LAYOUT).render as unknown as RenderFeatures),
      frame: previewFrameOf(LAYOUT),
    },
    // Saved before the engine wrote it: read from the stored features.
    { name: "legacy", features: renderOf(LONG), frame: previewFrameOf(LONG) },
    // Static-only (no render yet): no frame, the card keeps its fixed box.
    { name: "static", features: { render: null }, frame: null },
    // render-2026.3: the summary carries the measured extent, and the card crops to it.
    {
      name: "measured",
      features: renderOf(MEASURED),
      summaryLayout: tsLayout(MEASURED),
      frame: previewFrameOf(MEASURED),
    },
    // Measured, nothing visible: no crop (the whole canvas).
    {
      name: "nothing",
      features: renderOf(NOTHING),
      summaryLayout: tsLayout(NOTHING),
      frame: previewFrameOf(NOTHING),
    },
    // An older summary layout next to features that have the extent: the summary is read (no crop)
    // until compaction (or migration 0017's backfill) fills the extent in.
    {
      name: "old-summary",
      features: renderOf(MEASURED),
      summaryLayout: oldSummaryLayout(MEASURED),
      frame: previewFrameOf(oldSummaryLayout(MEASURED)),
    },
  ];

  const params = (): GalleryParams => ({ ...DEFAULT_GALLERY_PARAMS });

  async function frames(): Promise<Map<string, unknown>> {
    const r = await q.listGallery(user.id, { ...params(), size: 96 } as GalleryParams);
    return new Map(
      r.items.map((i: GalleryItem) => [i.subject ?? "", (i as GalleryItem & { frame?: unknown }).frame]),
    );
  }

  beforeAll(async () => {
    app = appPool();
    q = await import("@/server/queries/gallery");
    user = await createUser(app);
    const mb = await createMailbox(app, user.id);
    for (const [i, c] of cases.entries()) {
      await seedEmail(app, user.id, mb, {
        ...scored({ features: c.features, summaryLayout: c.summaryLayout ?? "absent" }),
        receivedAt: new Date(now - i * 60_000),
        subject: c.name,
        searchText: c.name,
      });
    }
  });

  afterAll(async () => {
    await app?.end();
  });

  it("the list sizes each preview from the saved layout, or the stored features before it existed", async () => {
    const got = await frames();
    for (const c of cases) expect(got.get(c.name), c.name).toEqual(c.frame);
    // Sanity: the frames are real (a full-length card needs contentBottom).
    expect((got.get("legacy") as { contentBottom: number }).contentBottom).toBe(4589);
    expect((got.get("summary") as { contentBottom: number }).contentBottom).toBe(1318);
    // The measured extent reaches the card: it crops to the content, the old summary doesn't.
    expect(got.get("measured")).toMatchObject({ x: 104, width: 592 });
    expect(got.get("old-summary")).not.toHaveProperty("x");
    expect(got.get("nothing")).not.toHaveProperty("x");
  });

  async function sqlLayout(features: unknown): Promise<unknown> {
    const r = await withUser(app, user.id, (_db, c) =>
      c.query<{ s: unknown }>("SELECT public.summary_layout($1::jsonb) AS s", [
        JSON.stringify(features),
      ]),
    );
    return r.rows[0]!.s;
  }

  it("summary_layout(features) in SQL equals @edf/design summaryLayout, and is null without a render", async () => {
    for (const layout of [LAYOUT, LONG, NO_BOX, MEASURED, NOTHING, WIDE]) {
      expect(await sqlLayout(renderOf(layout)), JSON.stringify(layout)).toEqual(tsLayout(layout));
    }
    // The three states of the content extent survive the SQL mirror exactly.
    expect(await sqlLayout(renderOf(MEASURED))).toMatchObject({
      content: MEASURED.content,
      desktopContentWidth: 800,
    });
    expect(await sqlLayout(renderOf(NOTHING))).toHaveProperty("content", null);
    expect(await sqlLayout(renderOf(LAYOUT))).not.toHaveProperty("content");
    // A malformed extent is left out (as if not measured), never passed on half-valid.
    const malformed = [{ left: 1, right: "700", bottom: 9 }, { left: 1, right: 700 }, [1, 700, 9], "x"];
    for (const content of malformed) {
      const s = await sqlLayout(renderOf({ ...LAYOUT, content }));
      expect(s, JSON.stringify(content)).toEqual(tsLayout(LAYOUT));
    }
    for (const features of [null, {}, { render: null }, renderOf({ desktopHeight: "1318" })]) {
      const r = await withUser(app, user.id, (_db, c) =>
        c.query<{ s: unknown }>("SELECT public.summary_layout($1::jsonb) AS s", [
          JSON.stringify(features),
        ]),
      );
      expect(r.rows[0]!.s, JSON.stringify(features)).toBeNull();
    }
  });

  it("compaction keeps every preview full length and cropped (it saves the layout first)", async () => {
    const before = await frames();
    await withUser(app, user.id, async (_db, c) => {
      await c.query(
        "UPDATE email_analysis SET analyzed_at = now() - interval '40 days' WHERE user_id = $1",
        [user.id],
      );
      expect(await compactFeatures(c, user.id, 30)).toBe(cases.length);
      const rows = await c.query<{ subject: string; features: unknown; layout: unknown }>(
        `SELECT e.subject, a.features, a.score_summary -> 'layout' AS layout
         FROM email_analysis a JOIN email e ON e.id = a.email_id WHERE e.user_id = $1`,
        [user.id],
      );
      const by = new Map(rows.rows.map((r) => [r.subject, r]));
      for (const r of rows.rows) expect(r.features, r.subject).toBeNull();
      expect(by.get("legacy")!.layout).toEqual(tsLayout(LONG));
      expect(by.get("static")!.layout).toBeNull();
      expect(by.get("measured")!.layout).toEqual(tsLayout(MEASURED));
      expect(by.get("nothing")!.layout).toEqual(tsLayout(NOTHING));
      // The older summary layout gains the extent (and the desktop width) from the features.
      expect(by.get("old-summary")!.layout).toEqual(tsLayout(MEASURED));
    });
    const after = await frames();
    // The old summary now crops like the rest; nothing else changes.
    expect(after.get("old-summary")).toEqual(previewFrameOf(MEASURED));
    after.set("old-summary", before.get("old-summary"));
    expect(after).toEqual(before);
  });
});
