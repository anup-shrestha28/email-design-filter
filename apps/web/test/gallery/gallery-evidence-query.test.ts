/**
 * The detail view's evidence against the real database (queries/gallery-evidence.ts,
 * actions/gallery-evidence.ts), on synthetic emails:
 *  - the caller's own gallery design: the verdict the gallery shows, explained from its saved
 *    design checklist (score_summary.checklist), rule by rule
 *  - another user's design, a security-sensitive, plain-text or trashed email and an unknown id all
 *    give nothing (the gallery's own row conditions); a design without a checklist (or with one of
 *    an older version) has nothing to explain yet; a signed-out caller and a malformed id are
 *    refused
 *  - after compaction (features and checks cleared) the saved checklist alone still explains it
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as EvidenceActions from "@/server/actions/gallery-evidence";
import type * as EvidenceQueries from "@/server/queries/gallery-evidence";
import { verdictOf } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { checklistOf } from "../support/checklist";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, sessionFor } from "../tests-server/helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/** Three rules missed (Bad), pictures not applicable. */
const CHECKLIST = checklistOf(
  { button: "miss", body: "miss", width: "miss", images: "na" },
  {
    button: "There's no button, only text links.",
    body: "Body text is 12.5px on phones (your rule: 14–16px).",
    width: "720px wide on desktop (your rule: about 600px).",
  },
);

function analysed(checklist: unknown = CHECKLIST): Partial<EmailRecord> {
  return {
    designStatus: "done",
    designSource: "render",
    designAiState: "pending",
    designScore: 81,
    designBand: "good",
    designCapped: false,
    designProvisional: false,
    designIssues: [],
    designConfidence: "medium",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      features: { v: 1, render: {} },
      checks: [],
      pillarScores: [],
      rawScore: 81,
      caps: [],
      confidence: 0.83,
      trust: {},
      scoreSummary: { coverage: "render", raw: 81, needsImprovement: [], good: [], checklist },
      aiReview: null,
      aiModel: null,
      renderRefEmailId: null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    },
  } as unknown as Partial<EmailRecord>;
}

describe.skipIf(!HAS_DB)("gallery evidence against the database", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let q: typeof EvidenceQueries;
  let actions: typeof EvidenceActions;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    q = await import("@/server/queries/gallery-evidence");
    actions = await import("@/server/actions/gallery-evidence");
    alice = await createUser(app, { role: "owner" });
    bob = await createUser(app, { role: "friend" });
    const aliceMb = await createMailbox(app, alice.id);
    const bobMb = await createMailbox(app, bob.id);
    id.bad = await seedEmail(app, alice.id, aliceMb, analysed());
    id.compacted = await seedEmail(app, alice.id, aliceMb, analysed());
    await owner.query(
      "UPDATE email_analysis SET features = NULL, checks = '[]', features_compacted_at = now() WHERE email_id = $1",
      [id.compacted],
    );
    id.older = await seedEmail(app, alice.id, aliceMb, analysed({ ...CHECKLIST, v: "designmodo-2026.10" }));
    id.none = await seedEmail(app, alice.id, aliceMb, analysed(null));
    id.security = await seedEmail(app, alice.id, aliceMb, {
      ...analysed(),
      securitySensitive: true,
      primaryType: "account_security",
      subtype: "password_reset",
    });
    id.plain = await seedEmail(app, alice.id, aliceMb, {
      ...analysed(),
      designStatus: "plain_text",
      designSource: "none",
    });
    id.trashed = await seedEmail(app, alice.id, aliceMb, analysed());
    await owner.query("UPDATE email SET in_trash = true WHERE id = $1", [id.trashed]);
    id.unscored = await seedEmail(app, alice.id, aliceMb, {
      designStatus: "done",
      designSource: "static",
    });
    id.bobs = await seedEmail(app, bob.id, bobMb, analysed());
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  beforeEach(() => {
    state.session = null;
  });

  it("explains the caller's own design from its saved checklist", async () => {
    state.session = sessionFor(alice);
    const r = await actions.galleryEvidence(id.bad);
    expect(r.ok).toBe(true);
    const e = r.ok ? r.data! : null;
    expect(e).not.toBeNull();
    expect(e!.verdict).toBe(verdictOf({ checklist: CHECKLIST }));
    expect(e!.verdict).toBe("bad");
    expect(e!.sentence).toBe("Bad: misses 3 of the 16 rules (3 or more is Bad).");
    expect(e!.rows).toHaveLength(16);
    const rows = new Map(e!.rows.map((x) => [x.id, x]));
    expect(rows.get("button")).toMatchObject({
      label: "One main button",
      state: "fail",
      value: "There's no button, only text links.",
    });
    expect(rows.get("width")?.value).toBe("720px wide on desktop (your rule: about 600px).");
    expect(rows.get("images")?.state).toBe("neutral");
    expect(rows.get("hero")?.state).toBe("pass");
    expect(await q.galleryEvidenceInput(alice.id, id.bad!)).toEqual({ checklist: CHECKLIST });
  });

  it("another user's design, security and plain-text mail, unchecked and unknown ids: nothing", async () => {
    state.session = sessionFor(bob);
    expect(await actions.galleryEvidence(id.bad)).toEqual({ ok: true, data: null });
    expect(await q.galleryEvidenceInput(bob.id, id.bad!)).toBeNull();
    // Bob's own design is his to see.
    const own = await actions.galleryEvidence(id.bobs);
    expect(own.ok && own.data?.verdict).toBe("bad");
    expect(await q.galleryEvidenceInput(alice.id, id.bobs!)).toBeNull();

    state.session = sessionFor(alice);
    for (const key of ["security", "plain", "trashed", "unscored", "none", "older"])
      expect(await actions.galleryEvidence(id[key]), key).toEqual({ ok: true, data: null });
    expect(await actions.galleryEvidence("01a0ec9b-7051-7043-9a44-da9578872152")).toEqual({
      ok: true,
      data: null,
    });
  });

  it("refuses a signed-out caller and a malformed id", async () => {
    expect(await actions.galleryEvidence(id.bad)).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    state.session = sessionFor(alice);
    for (const bad of ["nope", "'; DROP TABLE email; --", 42, null, { id: id.bad }])
      expect(await actions.galleryEvidence(bad)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("after compaction the saved checklist alone still explains it", async () => {
    state.session = sessionFor(alice);
    const before = await actions.galleryEvidence(id.bad);
    const after = await actions.galleryEvidence(id.compacted);
    expect(after.ok && after.data).toEqual(before.ok && before.data);
  });
});
