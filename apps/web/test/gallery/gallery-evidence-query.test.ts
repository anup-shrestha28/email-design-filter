/**
 * The detail view's evidence against the real database (queries/gallery-evidence.ts,
 * actions/gallery-evidence.ts), on synthetic emails:
 *  - the caller's own gallery design: the verdict the gallery shows, explained from the stored
 *    facts (signals, caps, pillar scores, the quoted checks, why pictures didn't load)
 *  - another user's design, a security-sensitive, plain-text or trashed email and an unknown id all
 *    give nothing (the gallery's own row conditions); a signed-out caller and a malformed id are
 *    refused
 *  - after compaction (features and checks cleared) the saved summary alone still explains it
 *  - "no main button" is hedged when the stored HTML pass found a link painted as a button (the
 *    card's own render facts, queries/gallery.ts RENDER_FACTS)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as EvidenceActions from "@/server/actions/gallery-evidence";
import type * as EvidenceQueries from "@/server/queries/gallery-evidence";
import { verdictOf } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { type FakeSession, sessionFor } from "../tests-server/helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/** Signals as scoring 2026.5 saves them: Gmail cuts the email after its unsubscribe link. */
const SIGNALS = {
  imgShare: 0.07,
  legibleChars: null,
  phoneTextPx: 14,
  layoutK: 1,
  unsubscribe: "after_clip",
  primaryType: "promotional",
  headlineRatio: 1.5,
  hasHeadline: true,
  ctaSalience: 1,
  ctaMostProminent: false,
  ctaFirstScreen: false,
  ctaLabelContrast: 5.7,
  gate: ["button"],
  htmlContentImages: 8,
  drawnContentImages: 2,
  imagesOff: false,
  imagesUnknownShare: 0.75,
  staticUnsubscribe: "after_clip",
  renderUnsubscribe: "after_clip",
  unsubscribeUnion: "after_clip",
  liveTextChars: 347,
  htmlKB: 139.1,
};

const check = (id: string, status: string, value: unknown) => ({
  id,
  pillar: "technical",
  status,
  s: 1,
  value,
  w: 1,
  e: 1,
  points: 1,
  pointsLost: 0,
  source: "render",
});

function analysed(over: Partial<EmailRecord> = {}): Partial<EmailRecord> {
  return {
    designStatus: "done",
    designSource: "render",
    designAiState: "pending",
    designScore: 69,
    designBand: "needs_work",
    designCapped: true,
    designProvisional: false,
    designIssues: ["clipped"],
    designConfidence: "medium",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      features: {
        v: 1,
        render: {
          images: {
            loads: [
              ...Array.from({ length: 2 }, () => ({ status: 200, decoded: true, area: 900 })),
              ...Array.from({ length: 6 }, () => ({
                status: 403,
                decoded: false,
                reason: "expired",
                area: 900,
              })),
            ],
          },
        },
      },
      checks: [
        check("A1", "pass", { mainFailShare: 0, worst: null }),
        check("H6", "partial", { ratio: 1.5, headline: true, largestPx: 24, medianPx: 16 }),
        check("H3", "partial", {
          label: "Apply now",
          present: true,
          salience: 1,
          mostProminent: false,
        }),
        check("I3", "pass", { evaluated: 2, failed: 0, svg: 0 }),
        check("M3", "pass", { wideShare: 1 }),
        check("M7", "pass", { okShare: 1 }),
        check("X1", "partial", { bytes: 139114, clipped: true, afterShare: 0.856 }),
        check("H7", "not_evaluated", null),
      ],
      pillarScores: [
        { id: "accessibility", label: "Accessibility", points: 23.3, max: 25.2, nominal: 20 },
        { id: "technical", label: "Technical Health", points: 3.5, max: 7.2, nominal: 5 },
        { id: "footer", label: "Footer & Unsubscribe UX", points: 0, max: 0, nominal: 5 },
      ],
      rawScore: 84,
      caps: ["CAP_CLIPPED"],
      confidence: 0.83,
      trust: {},
      scoreSummary: {
        coverage: "render",
        raw: 84,
        signals: SIGNALS,
        needsImprovement: [
          { key: "cap:CAP_CLIPPED", title: "Gmail clips it (139 KB)", points: 15, ai: false },
        ],
        good: [],
        pillars: [{ id: "accessibility", points: 23.3, max: 25.2 }],
      },
      aiReview: null,
      aiModel: null,
      renderRefEmailId: null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    },
    ...over,
  } as Partial<EmailRecord>;
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
    id.clipped = await seedEmail(app, alice.id, aliceMb, analysed());
    id.compacted = await seedEmail(app, alice.id, aliceMb, analysed());
    await owner.query(
      "UPDATE email_analysis SET features = NULL, checks = '[]', features_compacted_at = now() WHERE email_id = $1",
      [id.compacted],
    );
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
    // The render found no main button, but the HTML pass found a link painted as one.
    const base = analysed();
    const a = base.analysis as unknown as Record<string, unknown>;
    const render = (a.features as { render: Record<string, unknown> }).render;
    id.maybeButton = await seedEmail(app, alice.id, aliceMb, {
      ...base,
      analysis: {
        ...a,
        features: {
          v: 1,
          static: { cta: { buttonLike: 1 } },
          render: { ...render, cta: { buttonLike: 0 }, links: { targets: [] } },
        },
        scoreSummary: {
          ...(a.scoreSummary as Record<string, unknown>),
          signals: { ...SIGNALS, ctaSalience: null, ctaMostProminent: null, ctaFirstScreen: null },
        },
      },
    } as unknown as Partial<EmailRecord>);
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  beforeEach(() => {
    state.session = null;
  });

  it("explains the caller's own design from its stored facts", async () => {
    state.session = sessionFor(alice);
    const r = await actions.galleryEvidence(id.clipped);
    expect(r.ok).toBe(true);
    const e = r.ok ? r.data! : null;
    expect(e).not.toBeNull();
    expect(e!.verdict).toBe(
      verdictOf({
        score: 69,
        band: "needs_work",
        capped: true,
        provisional: false,
        caps: ["CAP_CLIPPED"],
        issues: ["clipped"],
        source: "render",
        coverageConfidence: 0.83,
        signals: SIGNALS,
      }),
    );
    expect(e!.rule).toEqual({ kind: "cap", cap: "CAP_CLIPPED" });
    expect(e!.sentence).toBe(
      "Bad: Gmail cuts this email off — it's 139 KB and Gmail's limit is 102 KB, so the unsubscribe link is hidden.",
    );
    const rows = new Map([...e!.good, ...e!.serious].map((x) => [x.id, x]));
    expect(rows.get("score")?.value).toBe(
      "69: capped by a serious problem (its points add up to 84)",
    );
    expect(rows.get("headline")?.value).toBe("Headline 24 px, text 16 px (1.5×)");
    expect(rows.get("button")).toMatchObject({
      state: "fail",
      value:
        "The main button “Apply now”: a bold colour, but it sits below the first phone screen, and another link or picture is bigger",
    });
    expect(rows.get("broken_images")?.value).toBe("Both pictures we could check load");
    expect(rows.get("contrast")?.value).toBe("All of it is dark enough");
    expect(rows.get("phone")?.value).toBe(
      "0% of the text in narrow columns, 0% at the screen edge",
    );
    // The pillar scores (with their nominal weights), in plain words; an area that doesn't apply is left out.
    expect(e!.areas?.rows).toEqual([
      { id: "accessibility", label: "Easy for everyone to read", points: 23.3, max: 25.2 },
      { id: "technical", label: "Works in every email app", points: 3.5, max: 7.2 },
    ]);
    expect(e!.areas?.notes).toEqual([
      "AI review is off, so the other areas count a bit more.",
      "These add up to 84, but a serious problem caps the score at 69.",
    ]);
    expect(e!.notes).toEqual(["6 of its 8 pictures didn't load: the links had expired."]);
  });

  it("another user's design, security and plain-text mail, unscored and unknown ids: nothing", async () => {
    state.session = sessionFor(bob);
    expect(await actions.galleryEvidence(id.clipped)).toEqual({ ok: true, data: null });
    expect(await q.galleryEvidenceInput(bob.id, id.clipped!)).toBeNull();
    // Bob's own design is his to see.
    const own = await actions.galleryEvidence(id.bobs);
    expect(own.ok && own.data?.verdict).toBe("bad");
    expect(await q.galleryEvidenceInput(alice.id, id.bobs!)).toBeNull();

    state.session = sessionFor(alice);
    for (const key of ["security", "plain", "trashed"])
      expect(await actions.galleryEvidence(id[key]), key).toEqual({ ok: true, data: null });
    expect(await actions.galleryEvidence(id.unscored)).toEqual({ ok: true, data: null });
    expect(await actions.galleryEvidence("01a0ec9b-7051-7043-9a44-da9578872152")).toEqual({
      ok: true,
      data: null,
    });
  });

  it("refuses a signed-out caller and a malformed id", async () => {
    expect(await actions.galleryEvidence(id.clipped)).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    state.session = sessionFor(alice);
    for (const bad of ["nope", "'; DROP TABLE email; --", 42, null, { id: id.clipped }])
      expect(await actions.galleryEvidence(bad)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("hedges 'no main button' when the stored HTML pass found a link painted as a button", async () => {
    state.session = sessionFor(alice);
    const input = await q.galleryEvidenceInput(alice.id, id.maybeButton!);
    expect(input?.noButtonBacked).toBe(false);
    const r = await actions.galleryEvidence(id.maybeButton);
    const e = r.ok ? r.data! : null;
    expect(e?.good.find((x) => x.id === "button")).toMatchObject({
      state: "fail",
      value: "No main button found, though we may have missed one",
    });
    // Without the HTML pass's count it isn't known either way: the plain measured fact.
    expect((await q.galleryEvidenceInput(alice.id, id.clipped!))?.noButtonBacked).toBeNull();
  });

  it("after compaction the saved summary alone still explains it", async () => {
    state.session = sessionFor(alice);
    const r = await actions.galleryEvidence(id.compacted);
    const e = r.ok ? r.data! : null;
    expect(e?.sentence).toBe(
      "Bad: Gmail cuts this email off — it's 139 KB and Gmail's limit is 102 KB, so the unsubscribe link is hidden.",
    );
    const rows = new Map([...e!.good, ...e!.serious].map((x) => [x.id, x]));
    // Values only the cleared checks had are "not measured" now, never guessed.
    expect(rows.get("contrast")).toMatchObject({ state: "unknown", value: null });
    expect(rows.get("headline")?.value).toBe("Headline 1.5× the size of the text");
    expect(e!.notes).toEqual([
      "Some of its pictures didn't load when we checked it, so the picture checks couldn't see them.",
      "The detailed measurements were cleared to save space, so a few values aren't shown.",
    ]);
  });
});
