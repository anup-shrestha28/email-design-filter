/**
 * The gallery's verdict from the design checklist (lib/gallery.ts VERDICT POLICY) against the real
 * database — the SQL twin in queries/gallery.ts must agree with verdictOf on the same saved data:
 *  - list verdicts and card lines follow the saved checklist (score_summary.checklist): Good = every
 *    rule passed, Okay = one or two missed or one unchecked, Bad = three or more missed; no
 *    checklist, an older version or malformed counts = not checked yet, whatever the score says
 *  - the Good / Bad filters, the Missed-rule filters and all their counts agree with the list
 *  - Best / Worst sort by verdict, then rules missed, then score; unchecked designs come last
 *  - compaction empties checks but keeps the summary, so no verdict changes
 *  - summary_signals(checks) in SQL (still used by the text-only rule) equals @edf/design's
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser, type pg } from "@edf/db";
import { summarySignals } from "@edf/design";
import type { CheckResult } from "@edf/design/types";
import type { EmailRecord } from "@edf/pipeline";
import { compactFeatures } from "@edf/pipeline/maintenance";
import type * as GalleryQueries from "@/server/queries/gallery";
import type { GalleryItem } from "@/server/queries/types";
import {
  checklistReason,
  DEFAULT_GALLERY_PARAMS,
  GALLERY_PROBLEMS,
  galleryProblemsOf,
  verdictOf,
  type GalleryParams,
  type Verdict,
} from "@/lib/gallery";
import { HAS_DB } from "../support/env";
import { checklistOf } from "../support/checklist";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => null, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

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

function analysed(score: number | null, checklist: unknown): Partial<EmailRecord> {
  return {
    designStatus: "done",
    designSource: score === null ? "static" : "render",
    designScore: score,
    designBand:
      score === null
        ? null
        : score >= 85
          ? "excellent"
          : score >= 70
            ? "good"
            : score >= 50
              ? "needs_work"
              : "poor",
    designCapped: score === null ? null : false,
    designProvisional: score === null ? null : false,
    designIssues: [],
    designConfidence: score === null ? null : "high",
    analysis: {
      scoringVersion: "test",
      rendererVersion: null,
      // Non-null so compaction picks the row up (it only compacts stored features).
      features: {} as never,
      checks: [check("I1", "pass", { imgShare: 0.3, legibleChars: 900 })],
      pillarScores: [],
      rawScore: score,
      caps: [],
      confidence: 0.9,
      trust: {},
      scoreSummary: {
        scoringVersion: "test",
        needsImprovement: [],
        good: [],
        ...(checklist === undefined ? {} : { checklist }),
      },
      aiReview: null,
      aiModel: null,
      renderRefEmailId: null,
      rendererHost: null,
      chromiumVersion: null,
      renderMs: null,
    },
  } as Partial<EmailRecord>;
}

const ALL_MISSED = checklistOf({
  message: "miss",
  button: "miss",
  hero: "miss",
  hierarchy: "miss",
  width: "miss",
});

interface Case {
  name: string;
  score: number | null;
  checklist: unknown;
  verdict: Verdict;
}

const CASES: Case[] = [
  // The score never decides: a 40 that passes every rule is Good, a 97 that misses three is Bad.
  { name: "good", score: 40, checklist: checklistOf(), verdict: "good" },
  {
    name: "goodNa",
    score: 70,
    checklist: checklistOf({ images: "na", scan: "na" }),
    verdict: "good",
  },
  { name: "okOne", score: 92, checklist: checklistOf({ width: "miss" }), verdict: "ok" },
  {
    name: "okTwo",
    score: 60,
    checklist: checklistOf({ width: "miss", fonts: "miss", body: "unknown" }),
    verdict: "ok",
  },
  { name: "okUnknown", score: 99, checklist: checklistOf({ contrast: "unknown" }), verdict: "ok" },
  {
    name: "badThree",
    score: 97,
    checklist: checklistOf({ button: "miss", cta: "miss", hero: "miss" }),
    verdict: "bad",
  },
  { name: "badFive", score: 30, checklist: ALL_MISSED, verdict: "bad" },
  { name: "none", score: 88, checklist: undefined, verdict: "unscored" },
  { name: "nullChecklist", score: 88, checklist: null, verdict: "unscored" },
  {
    name: "older",
    score: 88,
    checklist: { ...checklistOf(), v: "designmodo-2026.10" },
    verdict: "unscored",
  },
  {
    name: "textCount",
    score: 88,
    checklist: { ...checklistOf(), misses: "0" },
    verdict: "unscored",
  },
  { name: "negative", score: 88, checklist: { ...checklistOf(), misses: -1 }, verdict: "unscored" },
  {
    name: "fraction",
    score: 88,
    checklist: { ...checklistOf(), unknown: 0.5 },
    verdict: "unscored",
  },
  { name: "array", score: 88, checklist: [checklistOf()], verdict: "unscored" },
  { name: "unscored", score: null, checklist: undefined, verdict: "unscored" },
];

describe.skipIf(!HAS_DB)("gallery verdict from the design checklist", () => {
  let app: pg.Pool;
  let q: typeof GalleryQueries;
  let user: Awaited<ReturnType<typeof createUser>>;
  const now = Date.now();

  const params = (over: Partial<GalleryParams> = {}): GalleryParams => ({
    ...DEFAULT_GALLERY_PARAMS,
    ...over,
  });

  async function all(p: GalleryParams): Promise<GalleryItem[]> {
    const out: GalleryItem[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await q.listGallery(user.id, { ...p, page, size: 96 } as GalleryParams, "UTC");
      out.push(...r.items);
      if (r.page >= r.pageCount) break;
    }
    return out;
  }
  const bySubject = async () => new Map((await all(params())).map((x) => [x.subject ?? "", x]));
  const names = async (p: GalleryParams) => (await all(p)).map((x) => x.subject ?? "").sort();

  beforeAll(async () => {
    app = appPool();
    q = await import("@/server/queries/gallery");
    user = await createUser(app);
    const mb = await createMailbox(app, user.id);
    for (const [i, c] of CASES.entries()) {
      await seedEmail(app, user.id, mb, {
        ...analysed(c.score, c.checklist),
        receivedAt: new Date(now - i * 60_000),
        subject: c.name,
        searchText: c.name,
      });
    }
  });

  afterAll(async () => {
    await app?.end();
  });

  it("list verdicts and card lines follow the saved checklist, and verdictOf agrees", async () => {
    const items = await bySubject();
    expect(items.size).toBe(CASES.length);
    for (const c of CASES) {
      const it = items.get(c.name)!;
      expect(it.verdict, c.name).toBe(c.verdict);
      expect(verdictOf({ checklist: c.checklist ?? null }), c.name).toBe(c.verdict);
      const r = checklistReason(c.checklist ?? null);
      expect(it.reason, c.name).toEqual(r.reason);
      expect(it.problems, c.name).toEqual(r.problems);
    }
    expect(items.get("badThree")!.reason?.text).toBe(
      "Misses 3 rules: no single main button, weak top section, button vague or hard to see",
    );
  });

  it("the Good / Bad filters and their counts agree with the list", async () => {
    const list = await all(params());
    const want = (v: Verdict) =>
      list
        .filter((x) => x.verdict === v)
        .map((x) => x.subject ?? "")
        .sort();
    expect(await names(params({ design: "good" }))).toEqual(want("good"));
    expect(await names(params({ design: "bad" }))).toEqual(want("bad"));
    expect(want("good")).toEqual(["good", "goodNa"]);
    expect(want("bad")).toEqual(["badFive", "badThree"]);
    const facets = await q.galleryFacets(user.id, params(), "UTC");
    expect(facets.design).toEqual({ all: CASES.length, good: 2, bad: 2 });
  });

  it("each Missed-rule option and its count agree with galleryProblemsOf", async () => {
    const list = await all(params());
    const facets = await q.galleryFacets(user.id, params(), "UTC");
    for (const id of GALLERY_PROBLEMS) {
      const want = CASES.filter((c) =>
        galleryProblemsOf({ checklist: c.checklist ?? null }).includes(id),
      )
        .map((c) => c.name)
        .sort();
      expect(await names(params({ problem: [id] })), id).toEqual(want);
      expect(facets.problems[id], id).toBe(want.length);
    }
    // A rule couldn't be checked or doesn't apply: never a match.
    expect(await names(params({ problem: ["contrast"] }))).toEqual([]);
    expect(await names(params({ problem: ["images"] }))).toEqual([]);
    // Any of several.
    expect(await names(params({ problem: ["width", "cta"] }))).toEqual(
      ["badFive", "badThree", "okOne", "okTwo"].sort(),
    );
    expect(list.length).toBe(CASES.length);
  });

  it("Best / Worst: verdict first, then rules missed, then score; unchecked last both ways", async () => {
    const best = (await all(params({ sort: "best" }))).map((x) => x.subject);
    // Two Goods (no misses): the higher score (70) first.
    expect(best.slice(0, 7)).toEqual([
      "goodNa",
      "good",
      "okUnknown",
      "okOne",
      "okTwo",
      "badThree",
      "badFive",
    ]);
    const worst = (await all(params({ sort: "worst" }))).map((x) => x.subject);
    expect(worst.slice(0, 7)).toEqual([
      "badFive",
      "badThree",
      "okTwo",
      "okOne",
      "okUnknown",
      "good",
      "goodNa",
    ]);
    const unchecked = CASES.filter((c) => c.verdict === "unscored").length;
    expect(
      best.slice(-unchecked).every((n) => CASES.find((c) => c.name === n)!.verdict === "unscored"),
    ).toBe(true);
    expect(
      worst.slice(-unchecked).every((n) => CASES.find((c) => c.name === n)!.verdict === "unscored"),
    ).toBe(true);
  });

  it("compaction keeps every verdict (the checklist lives in the summary)", async () => {
    const before = await bySubject();
    await withUser(app, user.id, async (_db, c) => {
      await c.query(
        "UPDATE email_analysis SET analyzed_at = now() - interval '40 days' WHERE user_id = $1",
        [user.id],
      );
      expect(await compactFeatures(c, user.id, 30)).toBeGreaterThan(0);
      const left = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM email_analysis WHERE user_id = $1 AND jsonb_array_length(checks) > 0",
        [user.id],
      );
      expect(left.rows[0]!.n).toBe(0);
    });
    const after = await bySubject();
    for (const c of CASES) {
      expect(after.get(c.name)?.verdict, c.name).toBe(before.get(c.name)?.verdict);
      expect(after.get(c.name)?.reason, c.name).toEqual(before.get(c.name)?.reason);
    }
  });

  it("summary_signals(checks) in SQL equals @edf/design summarySignals", async () => {
    const arrays: CheckResult[][] = [
      [
        check("I1", "partial", { imgShare: 0.871, legibleChars: 97 }),
        check("T1", "fail", { px: 10, cssPx: 10, k: 1, fallback: false }),
        check("U1", "fail", { unsubscribe: "none" }),
      ],
      [
        check("I1", "not_applicable", { imgShare: 0.05 }),
        check("T1", "pass", { px: 15, cssPx: 15, k: 1, fallback: false }),
        check("U1", "not_applicable", { reason: "not_subscription_or_transactional" }),
      ],
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
});
