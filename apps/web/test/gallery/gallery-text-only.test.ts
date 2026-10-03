/**
 * Text-only emails never show in the gallery (queries/gallery.ts baseConditions TEXT_ONLY): HTML
 * mail laid out like a plain letter — pictures under 10%, no button, no hero band, no real headline
 * (none, or under 1.5× the body) — is left out of the list, the counts, the board counts, preview
 * access and the detail view, for every user. Each design feature alone keeps an email in; an email
 * not rendered yet stays until its render says otherwise.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as GalleryQueries from "@/server/queries/gallery";
import type * as EvidenceQueries from "@/server/queries/gallery-evidence";
import { DEFAULT_GALLERY_PARAMS } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

/** A letter: no pictures, no button, no hero, no headline. */
const LETTER = {
  imgShare: 0.02,
  ctaSalience: null,
  heroBand: false,
  hasHeadline: false,
  headlineRatio: 1,
};

function rendered(signals: Record<string, unknown>): Partial<EmailRecord> {
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
      rendererVersion: "render-test",
      features: null,
      checks: [],
      pillarScores: [],
      rawScore: 80,
      caps: [],
      confidence: 0.9,
      trust: {},
      scoreSummary: { needsImprovement: [], good: [], signals },
      aiReview: null,
      aiModel: null,
      renderRefEmailId: null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    },
  } as Partial<EmailRecord>;
}

describe.skipIf(!HAS_DB)("text-only emails are left out of the gallery", () => {
  let app: pg.Pool;
  let q: typeof GalleryQueries;
  let evidence: typeof EvidenceQueries;
  let user: Awaited<ReturnType<typeof createUser>>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = appPool();
    q = await import("@/server/queries/gallery");
    evidence = await import("@/server/queries/gallery-evidence");
    user = await createUser(app, { role: "friend" });
    const mb = await createMailbox(app, user.id);
    const seed = async (key: string, over: Partial<EmailRecord>) => {
      ids[key] = await seedEmail(app, user.id, mb, { subject: key, ...over });
    };
    await seed("letter", rendered(LETTER));
    await seed("letter-weak-headline", rendered({ ...LETTER, hasHeadline: true, headlineRatio: 1.4 }));
    // Any one design feature keeps it in.
    await seed("pictures", rendered({ ...LETTER, imgShare: 0.1 }));
    await seed("button", rendered({ ...LETTER, ctaSalience: 0 }));
    await seed("hero", rendered({ ...LETTER, heroBand: true }));
    await seed("headline", rendered({ ...LETTER, hasHeadline: true, headlineRatio: 1.5 }));
    // Not measured: shown (an older summary without the facts, or not rendered yet).
    await seed("unmeasured", rendered({}));
    await seed("older-summary", rendered({ imgShare: 0.005, phoneTextPx: 13, layoutK: 1 }));
    await seed("unscored", { designStatus: "done", designSource: "static", designScore: null, designBand: null });
  });

  afterAll(async () => {
    await app?.end();
  });

  it("lists and counts only the designed ones", async () => {
    const page = await q.listGallery(user.id, { ...DEFAULT_GALLERY_PARAMS, size: 96 });
    expect(page.items.map((i) => i.subject).sort()).toEqual(
      ["button", "headline", "hero", "older-summary", "pictures", "unmeasured", "unscored"].sort(),
    );
    expect(page.total).toBe(7);
    const facets = await q.galleryFacets(user.id, DEFAULT_GALLERY_PARAMS);
    expect(facets.categories.all).toBe(7);
  });

  it("never mints a preview or opens the detail view for a text-only email", async () => {
    const allowed = await q.previewableIds(user.id, [ids.letter!, ids.pictures!]);
    expect(allowed).toEqual([ids.pictures]);
    expect(await evidence.galleryEvidenceInput(user.id, ids.letter!)).toBeNull();
    expect(await evidence.galleryEvidenceInput(user.id, ids.pictures!)).not.toBeNull();
  });
});
