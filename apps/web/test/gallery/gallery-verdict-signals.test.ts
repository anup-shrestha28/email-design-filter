/**
 * The gallery's severe problems without a cap (VERDICT POLICY, lib/gallery.ts severeTriggers)
 * against the real database:
 *  - v1.5 signals: text baked into images, text shrunk to ≈ 11 px on phones, no unsubscribe link
 *    and a score under 60 are Bad; scoring 2026.5 signals: pictures that didn't load, a layout
 *    under 80% with text under 12.5 px, the unsubscribe link after Gmail's cut and marketing mail
 *    without one — at their edges; list verdicts, the Good / Bad filters and their counts all
 *    agree with verdictOf (the SQL mirror in queries/gallery.ts), and Bad wins over an 85
 *  - rows scored before score_summary.signals existed read the same facts from their checks
 *    (migration 0015 summary_signals), and the SQL extraction equals @edf/design summarySignals
 *  - compaction empties checks but saves the signals first, so no verdict or reason changes
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser, type pg } from "@edf/db";
import { summarySignals } from "@edf/design";
import type { CheckResult } from "@edf/design/types";
import type { EmailRecord } from "@edf/pipeline";
import { compactFeatures } from "@edf/pipeline/maintenance";
import type * as GalleryQueries from "@/server/queries/gallery";
import type { GalleryItem } from "@/server/queries/types";
import { DEFAULT_GALLERY_PARAMS, verdictOf, type GalleryParams } from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => null, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Signals = Record<string, unknown> | null;

/** A check result as the engine stores it (only the fields the extraction reads matter). */
const check = (id: string, status: string, value: unknown): CheckResult =>
  ({
    id,
    pillar: "images",
    status,
    s: null,
    value,
    w: 1,
    e: 0,
    points: 0,
    pointsLost: 0,
    source: "deterministic",
  }) as unknown as CheckResult;

// Real facts from the owner's mailbox (score_summary.signals).
const GRUNS = {
  imgShare: 0.871,
  legibleChars: 97,
  phoneTextPx: 10,
  layoutK: 1,
  unsubscribe: "none",
};
const LINKEDIN = {
  imgShare: 0.127,
  legibleChars: null,
  phoneTextPx: 10.508,
  layoutK: 0.657,
  unsubscribe: "before_clip",
};
const UNSTOP = {
  imgShare: 0.005,
  legibleChars: null,
  phoneTextPx: 13,
  layoutK: 1,
  unsubscribe: "before_clip",
};
const CHANTY = { imgShare: 1, legibleChars: 367, phoneTextPx: 16, layoutK: 1, unsubscribe: "none" };
const CLEAN = {
  imgShare: 0.1,
  legibleChars: null,
  phoneTextPx: 16,
  layoutK: 1,
  unsubscribe: "before_clip",
};
/** A clean marketing email as scoring 2026.5 saves its signals (the current rules). */
const CUR = (over: Record<string, unknown> = {}) => ({
  ...CLEAN,
  primaryType: "promotional",
  headlineRatio: 2,
  hasHeadline: true,
  ctaSalience: 1,
  ctaMostProminent: true,
  ctaFirstScreen: true,
  ctaLabelContrast: 7,
  gate: [],
  htmlContentImages: 3,
  drawnContentImages: 3,
  imagesOff: false,
  imagesUnknownShare: 0,
  staticUnsubscribe: "found",
  renderUnsubscribe: "found",
  unsubscribeUnion: "before_clip",
  liveTextChars: 900,
  htmlKB: 40,
  ...over,
});

/** Grüns' checks as stored before the engine wrote signals (I1 image-heavy, U1 none). */
const GRUNS_CHECKS = [
  check("I1", "partial", { imgShare: 0.871, legibleChars: 97 }),
  check("T1", "fail", { px: 10, cssPx: 10, k: 1, fallback: false }),
  check("U1", "fail", { unsubscribe: "none" }),
];
/** A receipt: U1 doesn't apply to transactional mail, so "no unsubscribe" is never read. */
const RECEIPT_CHECKS = [
  check("I1", "not_applicable", { imgShare: 0.05 }),
  check("T1", "pass", { px: 15, cssPx: 15, k: 1, fallback: false }),
  check("U1", "not_applicable", { reason: "not_subscription_or_transactional" }),
];

function scored(
  score: number | null,
  band: EmailRecord["designBand"],
  opts: {
    signals?: Signals | "absent";
    checks?: CheckResult[];
    source?: EmailRecord["designSource"];
  } = {},
): Partial<EmailRecord> {
  const summary: Record<string, unknown> = {
    scoringVersion: "test",
    needsImprovement: [],
    good: [],
  };
  if (opts.signals !== "absent")
    summary.signals = opts.signals === undefined ? CLEAN : opts.signals;
  return {
    designStatus: "done",
    designSource: opts.source ?? (score === null ? "static" : "render"),
    designScore: score,
    designBand: band,
    designCapped: score === null ? null : false,
    designProvisional: score === null ? null : false,
    designIssues: [],
    designConfidence: score === null ? null : "high",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      // Non-null so compaction picks the row up (it only compacts stored features).
      features: {} as never,
      checks: opts.checks ?? [],
      pillarScores: [],
      rawScore: score,
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

describe.skipIf(!HAS_DB)("gallery verdict: severe problems without a cap", () => {
  let app: pg.Pool;
  let q: typeof GalleryQueries;
  let user: Awaited<ReturnType<typeof createUser>>;
  const now = Date.now();

  type Case = {
    name: string;
    want: string;
    score: number | null;
    band: EmailRecord["designBand"];
    opts?: Parameters<typeof scored>[2];
    /** The signals the verdict reads (what GALLERY_SIGNALS yields). */
    reads: Signals;
    reason?: string;
    /** email.primary_type, the type now (seedEmail's default: promotional). */
    primaryType?: EmailRecord["primaryType"];
  };
  const cases: Case[] = [
    {
      name: "gruns",
      want: "bad",
      score: 73,
      band: "good",
      opts: { signals: GRUNS },
      reads: GRUNS,
      reason: "Most of this email is pictures: only 97 characters of real text",
    },
    {
      name: "linkedin",
      want: "bad",
      score: 74,
      band: "good",
      opts: { signals: LINKEDIN },
      reads: LINKEDIN,
      reason: "Doesn't fit phones: text shrinks to about 10.5 px",
    },
    {
      name: "unstop",
      want: "ok",
      score: 72,
      band: "good",
      opts: { signals: UNSTOP },
      reads: UNSTOP,
    },
    {
      name: "chanty85",
      want: "bad",
      score: 85,
      band: "excellent",
      opts: { signals: CHANTY },
      reads: CHANTY,
      reason: "No unsubscribe link anywhere in the email",
    },
    {
      name: "clean85",
      want: "good",
      score: 85,
      band: "excellent",
      opts: { signals: CLEAN },
      reads: CLEAN,
    },
    { name: "s50", want: "bad", score: 50, band: "needs_work", reads: CLEAN },
    { name: "s59", want: "bad", score: 59, band: "needs_work", reads: CLEAN },
    { name: "s60", want: "ok", score: 60, band: "needs_work", reads: CLEAN },
    // Scored before the engine saved signals: read from the stored checks.
    {
      name: "legacyGruns",
      want: "bad",
      score: 73,
      band: "good",
      opts: { signals: "absent", checks: GRUNS_CHECKS },
      reads: summarySignals(GRUNS_CHECKS) as unknown as Signals,
      reason: "Most of this email is pictures: only 97 characters of real text",
    },
    {
      name: "legacyReceipt",
      want: "good",
      score: 88,
      band: "excellent",
      opts: { signals: "absent", checks: RECEIPT_CHECKS },
      reads: summarySignals(RECEIPT_CHECKS) as unknown as Signals,
    },
    // JSON null signals fall back to the checks too; no signals and no checks → nothing severe.
    {
      name: "nullSignals",
      want: "bad",
      score: 80,
      band: "good",
      opts: { signals: null, checks: GRUNS_CHECKS },
      reads: summarySignals(GRUNS_CHECKS) as unknown as Signals,
    },
    {
      name: "nothing",
      want: "good",
      score: 90,
      band: "excellent",
      opts: { signals: "absent" },
      reads: null,
    },
    // Junk values never trigger (nor break the SQL casts).
    {
      name: "junk",
      want: "good",
      score: 90,
      band: "excellent",
      opts: { signals: { imgShare: "0.9", legibleChars: "5", phoneTextPx: [], unsubscribe: 3 } },
      reads: { imgShare: "0.9", legibleChars: "5", phoneTextPx: [], unsubscribe: 3 },
    },
    {
      name: "unscored",
      want: "unscored",
      score: null,
      band: null,
      opts: { signals: GRUNS },
      reads: GRUNS,
    },
    // Scored by 2026.5: the current rules, at their edges.
    ...((): Case[] => {
      const cur = (
        name: string,
        want: string,
        over: Record<string, unknown>,
        reason?: string,
        score = 88,
        primaryType?: EmailRecord["primaryType"],
      ): Case => {
        const signals = CUR(over);
        return {
          name,
          want,
          score,
          band: score >= 85 ? "excellent" : "good",
          opts: { signals },
          reads: signals,
          reason,
          // The type now: the one the score used, unless the case changes it after scoring.
          primaryType:
            primaryType ??
            (typeof signals.primaryType === "string"
              ? (signals.primaryType as EmailRecord["primaryType"])
              : undefined),
        };
      };
      return [
        cur("curClean", "good", {}),
        cur(
          "curNotLoaded",
          "bad",
          {
            htmlContentImages: 1,
            drawnContentImages: 0,
            liveTextChars: 51,
            imgShare: 0.9,
            legibleChars: 51,
          },
          "Most of this email is one picture that didn't load: only 51 characters of real text",
        ),
        cur("curNotLoaded200", "good", {
          htmlContentImages: 1,
          drawnContentImages: 0,
          liveTextChars: 200,
        }),
        cur("curImagesOff", "good", {
          drawnContentImages: null,
          imagesOff: true,
          liveTextChars: 51,
        }),
        cur(
          "curPhone",
          "bad",
          { layoutK: 0.79, phoneTextPx: 12.4 },
          "Doesn't fit phones: text shrinks to about 12.4 px",
        ),
        cur("curPhoneK80", "good", { layoutK: 0.8, phoneTextPx: 10 }),
        cur("curPhonePx125", "good", { layoutK: 0.6, phoneTextPx: 12.5 }),
        // v1.5 called this Bad; the current rule doesn't.
        cur("curPhoneOld", "good", { layoutK: 0.81, phoneTextPx: 11.3 }),
        cur(
          "curCut",
          "bad",
          { unsubscribeUnion: "after_clip", htmlKB: 107.2, primaryType: "social" },
          "Gmail cuts this email off (107 KB; Gmail's limit is 102 KB) and hides the unsubscribe link",
        ),
        cur(
          "curNoUnsub",
          "bad",
          { unsubscribeUnion: "none", unsubscribe: null },
          "No unsubscribe link anywhere in this marketing email",
        ),
        cur("curNoticeNoUnsub", "good", {
          primaryType: "notification",
          unsubscribeUnion: "none",
          unsubscribe: "none",
        }),
        cur("curUnsubUnknown", "good", { unsubscribeUnion: null }),
        // The type changed after scoring (Correct this, or the AI settling a pending email): the
        // unsubscribe rule follows the type now, as the category chip does.
        cur(
          "curRetypedNotice",
          "good",
          { unsubscribeUnion: "none" },
          undefined,
          88,
          "account_notice",
        ),
        cur(
          "curRetypedPromo",
          "bad",
          { primaryType: "notification", unsubscribeUnion: "none" },
          "No unsubscribe link anywhere in this marketing email",
          88,
          "promotional",
        ),
        // Most of the picture area wasn't drawn: the picture share isn't trusted (Okay).
        cur(
          "curPicturesUnknown",
          "ok",
          { imgShare: 1, legibleChars: 65, liveTextChars: 65, imagesUnknownShare: 0.522 },
          undefined,
          72,
        ),
        cur(
          "curPicturesKnown",
          "bad",
          { imgShare: 1, legibleChars: 65, liveTextChars: 65, imagesUnknownShare: 0.5 },
          "Most of this email is pictures: only 65 characters of real text",
          72,
        ),
        cur("curHeld", "ok", { gate: ["headline"], headlineRatio: 1.1 }, undefined, 84),
        cur("curJunk", "good", {
          unsubscribeUnion: 3,
          primaryType: ["promotional"],
          drawnContentImages: "0",
        }),
      ];
    })(),
  ];

  const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
    ...DEFAULT_GALLERY_PARAMS,
    ...over,
  });

  async function all(p: GalleryParams): Promise<GalleryItem[]> {
    const out: GalleryItem[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await q.listGallery(user.id, { ...p, page, size: 96 } as GalleryParams);
      out.push(...r.items);
      if (r.page >= r.pageCount) break;
    }
    return out;
  }

  beforeAll(async () => {
    app = appPool();
    q = await import("@/server/queries/gallery");
    user = await createUser(app);
    const mb = await createMailbox(app, user.id);
    for (const [i, c] of cases.entries()) {
      await seedEmail(app, user.id, mb, {
        ...scored(c.score, c.band, c.opts),
        ...(c.primaryType ? { primaryType: c.primaryType } : {}),
        receivedAt: new Date(now - i * 60_000),
        subject: c.name,
        searchText: c.name,
      });
    }
  });

  afterAll(async () => {
    await app?.end();
  });

  const bySubject = async () => new Map((await all(params())).map((x) => [x.subject ?? "", x]));

  it("list verdicts and reasons follow the policy, and verdictOf agrees on the same inputs", async () => {
    const items = await bySubject();
    for (const c of cases) {
      expect(items.get(c.name)?.verdict, c.name).toBe(c.want);
      expect(
        verdictOf({
          score: c.score,
          band: c.band,
          capped: c.score === null ? null : false,
          provisional: c.score === null ? null : false,
          caps: [],
          issues: [],
          source: c.opts?.source ?? (c.score === null ? "static" : "render"),
          coverageConfidence: Math.fround(0.9),
          signals: c.reads,
          primaryType: c.primaryType ?? "promotional",
        }),
        `${c.name} (verdictOf)`,
      ).toBe(c.want);
      if (c.reason)
        expect(items.get(c.name)?.reason, c.name).toEqual({ kind: "problem", text: c.reason });
    }
  });

  it("the Good / Bad filters and their counts agree with the list", async () => {
    const names = (want: string) =>
      cases
        .filter((c) => c.want === want)
        .map((c) => c.name)
        .sort();
    const subjects = async (design: GalleryParams["design"]) =>
      (await all(params({ design }))).map((x) => x.subject ?? "").sort();
    expect(await subjects("bad")).toEqual(names("bad"));
    expect(await subjects("good")).toEqual(names("good"));
    const facets = await q.galleryFacets(user.id, params());
    expect(facets.design.bad).toBe(names("bad").length);
    expect(facets.design.good).toBe(names("good").length);
    expect(facets.design.all).toBe(cases.length);
  });

  it("summary_signals(checks) in SQL equals @edf/design summarySignals", async () => {
    const arrays: CheckResult[][] = [
      GRUNS_CHECKS,
      RECEIPT_CHECKS,
      [],
      [
        check("I1", "not_evaluated", { reason: "no_render" }),
        check("T1", "not_evaluated", { reason: "no_render" }),
      ],
      [
        check("T1", "partial", { px: 10.508, cssPx: 16, k: 0.657 }),
        check("U1", "partial", { unsubscribe: "after_clip" }),
      ],
      [
        check("I1", "fail", { imgShare: 1, legibleChars: 0 }),
        check("U1", "fail", { unsubscribe: "weird" }),
      ],
      [
        check("T1", "not_applicable", { reason: "no_text" }),
        check("I1", "partial", { imgShare: "x" }),
      ],
    ];
    for (const checks of arrays) {
      const r = await withUser(app, user.id, (_db, c) =>
        c.query<{ s: unknown }>("SELECT public.summary_signals($1::jsonb) AS s", [
          JSON.stringify(checks),
        ]),
      );
      expect(r.rows[0]!.s, JSON.stringify(checks)).toEqual(summarySignals(checks));
    }
  });

  it("compaction keeps every verdict and reason (it saves the signals before emptying checks)", async () => {
    const before = await bySubject();
    await withUser(app, user.id, async (_db, c) => {
      await c.query(
        "UPDATE email_analysis SET analyzed_at = now() - interval '40 days' WHERE user_id = $1",
        [user.id],
      );
      expect(await compactFeatures(c, user.id, 30)).toBe(cases.length);
      const legacy = await c.query<{ s: unknown; checks: unknown }>(
        `SELECT a.score_summary -> 'signals' AS s, a.checks FROM email_analysis a JOIN email e ON e.id = a.email_id
         WHERE e.user_id = $1 AND e.subject = 'legacyGruns'`,
        [user.id],
      );
      expect(legacy.rows[0]!.checks).toEqual([]);
      expect(legacy.rows[0]!.s).toEqual(summarySignals(GRUNS_CHECKS));
    });
    const after = await bySubject();
    for (const c of cases) {
      expect(after.get(c.name)?.verdict, c.name).toBe(before.get(c.name)?.verdict);
      // The severe problems' reasons come from the saved signals, so they stay word for word.
      // (Strengths drawn only from checks can go: the summary keeps its top five.)
      if (c.reason)
        expect(after.get(c.name)?.reason, c.name).toEqual({ kind: "problem", text: c.reason });
    }
  });
});

describe.skipIf(!HAS_DB)("gallery reasons: facts from the stored render and HTML pass", () => {
  let app: pg.Pool;
  let q: typeof GalleryQueries;
  let user: Awaited<ReturnType<typeof createUser>>;

  /** A scored Okay row with a "no clear button" item, and these stored features. */
  const row = (
    name: string,
    features: Record<string, unknown> | null,
    signals: Record<string, unknown> = CUR(),
    score = 80,
  ): Partial<EmailRecord> => ({
    ...scored(score, "good", { signals, checks: [check("H1", "fail", { present: false })] }),
    subject: name,
    analysis: {
      ...(scored(score, "good").analysis as NonNullable<EmailRecord["analysis"]>),
      features: features as never,
      checks: [check("H1", "fail", { present: false })],
      scoreSummary: {
        scoringVersion: "test",
        needsImprovement: [
          {
            key: "group:no-cta",
            title: "There's no clear button for the main action",
            points: 3,
            ai: false,
          },
          { key: "check:T1", title: "Body text is 14px on phones", points: 1, ai: false },
        ],
        good: [],
        signals,
      },
    },
  });
  const cta = (staticButtons: number, targets: unknown[]) => ({
    static: {
      cta: { buttonLike: staticButtons, labels: [], primaryLabel: null, primaryOffset: null },
    },
    render: {
      cta: { buttonLike: 0, labels: [], buttonStyles: 0, firstTwoViewportsDistinct: 0 },
      links: { targets },
      images: { loads: [] },
    },
  });
  const POSTER = CUR({
    htmlContentImages: 1,
    drawnContentImages: 0,
    liveTextChars: 51,
    imgShare: 0.87,
    legibleChars: 51,
    imagesUnknownShare: 1,
  });

  beforeAll(async () => {
    app = appPool();
    q = await import("@/server/queries/gallery");
    user = await createUser(app);
    const mb = await createMailbox(app, user.id);
    const rows = [
      // Nothing like a button in either pass: "no clear button" is backed up (listed, not leading).
      row("letter", cta(0, [[348, 41, true]])),
      // A link box a button's size (an 8-word label the render's finder missed): not listed.
      row(
        "bigLink",
        cta(0, [
          [343, 66, true],
          [32, 32, true],
        ]),
      ),
      // The HTML pass found a link painted as a button: not listed.
      row("staticButton", cta(1, [])),
      // Compacted (no features): can't be backed up, not listed.
      row("compacted", null),
      // A poster too big for us to load.
      row(
        "poster",
        {
          render: {
            cta: { buttonLike: 0, labels: [], buttonStyles: 0 },
            links: { targets: [] },
            images: {
              loads: [
                { status: "too_large", reason: "too_large", decoded: false, area: 125000 },
                { status: 200, decoded: true, area: 300 },
              ],
            },
          },
          static: { cta: { buttonLike: 0 } },
        },
        POSTER,
        71,
      ),
    ];
    for (const [i, r] of rows.entries())
      await seedEmail(app, user.id, mb, { ...r, receivedAt: new Date(Date.now() - i * 60_000) });
  });

  afterAll(async () => {
    await app?.end();
  });

  it("'no clear button' is listed only when both passes back it up, and never leads", async () => {
    const r = await q.listGallery(user.id, { ...DEFAULT_GALLERY_PARAMS, size: 96 }, "UTC");
    const by = new Map(r.items.map((x) => [x.subject ?? "", x]));
    const noButton = "No clear button for the main action";
    expect(by.get("letter")?.problems).toContain(noButton);
    expect(by.get("letter")?.reason?.text).not.toBe(noButton);
    for (const name of ["bigLink", "staticButton", "compacted"])
      expect(by.get(name)?.problems, name).not.toContain(noButton);
    expect(by.get("poster")?.verdict).toBe("bad");
    expect(by.get("poster")?.reason).toEqual({
      kind: "problem",
      text: "Most of this email is one huge picture (too big for us to load): only 51 characters of real text",
    });
  });
});
