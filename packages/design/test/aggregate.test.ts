import { describe, expect, it } from "vitest";
import {
  AI_CHECK_IDS,
  CHECKS,
  CHECK_IDS,
  PILLARS,
  bandOf,
  confidenceBandOf,
  isProvisional,
  renderFeaturesSchema,
  scoreEmail,
  scoreEmailDetailed,
  staticDesignFeaturesSchema,
  type CheckStatus,
} from "../src/index";
import { aggregate, type PendingCheck } from "../src/scoring/aggregate";
import { baseAi, baseCtx, baseFeatures, baseRender, baseStatic } from "./helpers/factory";

describe("weights (DESIGN-SCORE §5, FREE-TIER.md §5.4)", () => {
  it("sum to 86 deterministic + 14 AI, with the documented pillar and group totals", () => {
    const det = CHECK_IDS.filter((id) => CHECKS[id].group !== "ai").reduce(
      (s, id) => s + CHECKS[id].w,
      0,
    );
    const ai = AI_CHECK_IDS.reduce((s, id) => s + CHECKS[id].w, 0);
    expect(det).toBeCloseTo(86, 10);
    expect(ai).toBeCloseTo(14, 10);
    const group = (g: string) =>
      CHECK_IDS.filter((id) => CHECKS[id].group === g).reduce((s, id) => s + CHECKS[id].w, 0);
    expect(group("static")).toBeCloseTo(22.5, 10);
    expect(group("stable")).toBeCloseTo(42.5, 10);
    expect(group("content")).toBeCloseTo(19.5, 10);
    expect(group("ocr")).toBeCloseTo(1.5, 10);
    const pillar = (p: string) =>
      CHECK_IDS.filter((id) => CHECKS[id].pillar === p).reduce((s, id) => s + CHECKS[id].w, 0);
    expect(PILLARS.map(pillar)).toEqual([20, 15, 15, 15, 10, 10, 5, 5, 5]);
  });
});

describe("the synthetic factory produces schema-valid features", () => {
  it("validates", () => {
    expect(renderFeaturesSchema.safeParse(baseRender()).success).toBe(true);
    expect(staticDesignFeaturesSchema.safeParse(baseStatic()).success).toBe(true);
  });
});

function pending(
  id: (typeof CHECK_IDS)[number],
  status: CheckStatus,
  s: number | null,
): PendingCheck {
  return {
    id,
    pillar: CHECKS[id].pillar,
    status,
    s,
    value: null,
    w: CHECKS[id].w,
    source: "render",
  };
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("aggregation invariants (DESIGN-SCORE §3)", () => {
  it("Σ points = raw, Σ points lost = 100 − raw, Σ e = 100, AI ≤ 14 — for 500 random status mixes", () => {
    const rnd = lcg(42);
    const statuses: CheckStatus[] = [
      "pass",
      "partial",
      "fail",
      "not_applicable",
      "not_evaluated",
      "needs_review",
    ];
    for (let t = 0; t < 500; t++) {
      const checks = CHECK_IDS.map((id) => {
        const st = statuses[Math.floor(rnd() * statuses.length)]!;
        const s =
          st === "pass"
            ? 0.9 + rnd() * 0.1
            : st === "partial"
              ? 0.01 + rnd() * 0.88
              : st === "fail"
                ? 0
                : null;
        return pending(id, st, s);
      });
      const agg = aggregate(checks, () => 1);
      if (agg.raw === null) continue;
      const pts = agg.checks.reduce((s, c) => s + c.points, 0);
      const lost = agg.checks.reduce((s, c) => s + c.pointsLost, 0);
      const e = agg.checks.reduce((s, c) => s + c.e, 0);
      const aiPts = agg.checks
        .filter((c) => (AI_CHECK_IDS as readonly string[]).includes(c.id))
        .reduce((s, c) => s + c.points, 0);
      expect(pts).toBeCloseTo(agg.raw, 9);
      expect(lost).toBeCloseTo(100 - agg.raw, 9);
      expect(e).toBeCloseTo(100, 9);
      expect(aiPts).toBeLessThanOrEqual(14 + 1e-9);
      expect(agg.aiWeight).toBeLessThanOrEqual(14);
      const pillarMax = agg.pillars.reduce((s, p) => s + p.max, 0);
      const pillarPts = agg.pillars.reduce((s, p) => s + p.points, 0);
      expect(pillarMax).toBeCloseTo(100, 9);
      expect(pillarPts).toBeCloseTo(Math.round(agg.raw * 10) / 10, 9);
      for (const p of agg.pillars) expect(p.points).toBeLessThanOrEqual(p.max + 1e-9);
    }
  });
  it("AI stays ≤ 14 even when whole deterministic pillars are N/A", () => {
    const checks = CHECK_IDS.map((id) => {
      if ((AI_CHECK_IDS as readonly string[]).includes(id)) return pending(id, "pass", 1);
      if (CHECKS[id].pillar === "accessibility" || CHECKS[id].pillar === "mobile")
        return pending(id, "not_applicable", null);
      return id === "X4" ? pending(id, "fail", 0) : pending(id, "not_applicable", null);
    });
    const agg = aggregate(checks, () => 1);
    expect(agg.raw).toBeCloseTo(14, 9);
    const x4 = agg.checks.find((c) => c.id === "X4")!;
    expect(x4.e).toBeCloseTo(86, 9);
  });
  it("N/A deterministic weight is spread across all evaluated deterministic checks, never onto AI", () => {
    const all = CHECK_IDS.map((id) => pending(id, "pass", 1));
    const withNa = all.map((c) =>
      c.id === "A1" ? { ...c, status: "not_applicable" as const, s: null } : c,
    );
    const a = aggregate(withNa, () => 1);
    const h7 = a.checks.find((c) => c.id === "H7")!;
    expect(h7.e).toBe(6);
    const m1 = a.checks.find((c) => c.id === "M1")!;
    expect(m1.e).toBeCloseTo((86 * 2.5) / 81, 9);
  });
  it("no evaluated deterministic check → no score", () => {
    const agg = aggregate(
      CHECK_IDS.map((id) => pending(id, "not_evaluated", null)),
      () => 1,
    );
    expect(agg.raw).toBeNull();
    expect(agg.confidence).toBe(0);
  });
});

describe("bands and confidence (DESIGN-SCORE §3, §3.1)", () => {
  it("bands", () => {
    expect([100, 85, 84, 70, 69, 50, 49, 0].map(bandOf)).toEqual([
      "excellent",
      "excellent",
      "good",
      "good",
      "needs_work",
      "needs_work",
      "poor",
      "poor",
    ]);
  });
  it("confidence bands and the type-confidence drop", () => {
    expect(confidenceBandOf(0.9, 0.9)).toBe("high");
    expect(confidenceBandOf(0.8, null)).toBe("medium");
    expect(confidenceBandOf(0.69, 0.9)).toBe("low");
    expect(confidenceBandOf(0.9, 0.5)).toBe("medium");
    expect(confidenceBandOf(0.8, 0.5)).toBe("low");
  });
});

describe("coverage levels and confidence (FREE-TIER.md §5.4)", () => {
  const ctx = baseCtx();
  // Make every check applicable where the spec allows (T8 needs ≥ 100 English words, C3 > 150 words).
  const full = {
    static: { prose: { words: 240, sentences: 16, syllables: 340 } },
    render: { text: { words: 300 } },
  } as const;

  it("own render + fresh AI ≈ 0.985 (High)", () => {
    const r = scoreEmail(baseFeatures(full), ctx);
    expect(r.coverage).toBe("render");
    expect(r.confidence).toBeCloseTo(0.985, 3);
    expect(r.confidenceBand).toBe("high");
  });
  it("own render, AI pending = 0.845 (Medium), tagged aiPending", () => {
    const r = scoreEmail(baseFeatures({ ...full, ai: null }), ctx);
    expect(r.confidence).toBeCloseTo(0.845, 3);
    expect(r.confidenceBand).toBe("medium");
    expect(r.aiPending).toBe(true);
  });
  it("own render + the template's AI (0.5; C4 never reused, its gap counts) = 0.9025 (High)", () => {
    const r = scoreEmail(baseFeatures({ ...full, ai: baseAi({ source: "template" }) }), ctx);
    expect(r.confidence).toBeCloseTo(0.9025, 3);
    expect(r.checks.find((c) => c.id === "C4")?.status).toBe("not_evaluated");
  });
  it("from template with template AI: C4 left out of confidence → 0.7167 (Medium, not provisional)", () => {
    const withAi = scoreEmail(
      baseFeatures({ ...full, renderSource: "template", ai: baseAi({ source: "template" }) }),
      ctx,
    );
    expect(withAi.coverage).toBe("template");
    // (22.5 + 0.75·42.5 + 0.5·19.5 + 0.5·(6 + 4 + 1.5)) / (100 − 2.5) = 69.875 / 97.5 = 0.71667:
    // C4 (2.5) is structurally unavailable for a template-sourced score (DECISIONS.md #1).
    expect(withAi.confidence).toBe(0.7167);
    expect(withAi.confidence).toBeGreaterThanOrEqual(0.7);
    expect(withAi.confidenceBand).toBe("medium");
    expect(withAi.provisional).toBe(false);
    // The C4 score itself is never inherited from the template's review.
    const c4 = withAi.checks.find((c) => c.id === "C4");
    expect(c4?.status).toBe("not_evaluated");
    expect(c4?.points).toBe(0);
    expect(c4?.value).toEqual({ reason: "copy_review_not_reused" });
    // The template's own C4 level never reaches the score or the confidence.
    const templateC4Low = scoreEmail(
      baseFeatures({
        ...full,
        renderSource: "template",
        ai: baseAi({ source: "template", criteria: { C4: { level: 1 } } }),
      }),
      ctx,
    );
    expect(templateC4Low.raw).toBe(withAi.raw);
    expect(templateC4Low.confidence).toBe(withAi.confidence);
  });
  it("from template without AI stays 0.6413 (Low → Provisional): the C4 gap still counts", () => {
    const noAi = scoreEmail(baseFeatures({ ...full, renderSource: "template", ai: null }), ctx);
    expect(noAi.coverage).toBe("template");
    // (22.5 + 0.75·42.5 + 0.5·19.5) / 100 = 0.64125
    expect(noAi.confidence).toBe(0.6413);
    expect(noAi.confidenceBand).toBe("low");
    expect(noAi.provisional).toBe(true);
    for (const c of noAi.checks) {
      if (CHECKS[c.id].group === "stable" || CHECKS[c.id].group === "content")
        expect(c.source).toBe("template");
    }
    // A refused template review is a gap too, not a structural exclusion of every AI check.
    const refused = scoreEmail(
      baseFeatures({
        ...full,
        renderSource: "template",
        ai: baseAi({ source: "template", refused: true }),
      }),
      ctx,
    );
    expect(refused.confidence).toBe(0.6577);
    expect(refused.confidenceBand).toBe("low");
    expect(refused.provisional).toBe(true);
  });
  it("from template with this email's own AI review counts C4 normally → 0.7813 (Medium)", () => {
    const r = scoreEmail(
      baseFeatures({ ...full, renderSource: "template", ai: baseAi({ source: "email" }) }),
      ctx,
    );
    // (64.125 + 14) / 100
    expect(r.confidence).toBe(0.7813);
    expect(r.checks.find((c) => c.id === "C4")?.status).toBe("partial"); // level 4 → 0.75
  });
  it("static only: no number, confidence ≈ 0.225, static chips", () => {
    const r = scoreEmail(baseFeatures({ ...full, render: null, ai: null }), ctx);
    expect(r.coverage).toBe("static");
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
    expect(r.raw).toBeNull();
    expect(r.confidence).toBeCloseTo(0.225, 3);
    expect(r.provisional).toBe(true);
    expect(r.pillars).toEqual([]);
    const clipped = scoreEmail(
      baseFeatures({
        render: null,
        ai: null,
        static: { htmlBytes: 130_000, footer: { unsubscribe: "none" } },
      }),
      ctx,
    );
    expect(clipped.staticChips.map((c) => c.code)).toEqual(
      expect.arrayContaining(["clipped", "no_unsubscribe"]),
    );
  });
  it("a low classifier type confidence drops the band", () => {
    const r = scoreEmail(baseFeatures(full), baseCtx({ typeConfidence: 0.4 }));
    expect(r.confidenceBand).toBe("medium");
  });
});

describe("caps (DESIGN-SCORE §4)", () => {
  const ctx = baseCtx();
  it("a capped email is never in a Good band", () => {
    const cases = [
      // t-2026.2: sideways scroll / under half size is k < 0.5 (a layout wider than 750px).
      baseFeatures({ render: { layout: { k: 0.45, mobileContentWidth: 830 } } }),
      baseFeatures({
        render: {
          contrast: {
            groups: [
              {
                fg: "#bbbbbb",
                bg: "#ffffff",
                ratio: 1.9,
                p90: null,
                method: "color",
                large: false,
                role: "body",
                rendered: true,
                short: false,
                chars: 1500,
              },
            ],
          },
        },
      }),
      baseFeatures({
        static: { mergeTags: { body: 1, firstScreen: true } },
        render: { mergeTagFirstViewport: true },
      }),
      baseFeatures({
        static: { mergeTags: { body: 1, firstScreen: true } },
        renderSource: "template",
      }),
      baseFeatures({
        render: {
          images: {
            loads: [
              { status: 404, decoded: false },
              { status: 404, decoded: false },
              { status: 200, decoded: true },
            ],
          },
        },
      }),
      baseFeatures({
        render: {
          text: { chars: { legible: 40 } },
          images: { share: 0.9 },
          imagesOff: { on: 100, off: 5 },
        },
      }),
    ];
    for (const f of cases) {
      const r = scoreEmail(f, ctx);
      expect(r.caps.length).toBeGreaterThan(0);
      expect(r.score!).toBeLessThanOrEqual(69);
      expect(["good", "excellent"]).not.toContain(r.band);
      expect(r.needsImprovement[0]?.kind).toBe("cap");
    }
  });
  it("broken images: link rot on old emails is not evaluated", () => {
    const f = baseFeatures({
      render: {
        images: {
          loads: [
            { status: 404, decoded: false },
            { status: 410, decoded: false },
            { status: 200, decoded: true },
          ],
        },
      },
    });
    const fresh = scoreEmail(f, ctx);
    expect(fresh.caps).toContain("CAP_BROKEN_IMAGES");
    const old = scoreEmail(f, baseCtx({ receivedAt: new Date("2026-07-01T00:00:00Z") }));
    expect(old.caps).not.toContain("CAP_BROKEN_IMAGES");
    expect(old.checks.find((c) => c.id === "I3")?.status).toBe("pass");
  });
  it("merge tag in the subject caps the score", () => {
    const r = scoreEmail(baseFeatures(), baseCtx({ subject: "Hi *|FNAME|*, 20% off" }));
    expect(r.caps).toContain("CAP_MERGE_TAG");
    expect(r.staticChips.map((c) => c.code)).toContain("merge_tag_subject");
  });
  it("clipping before the CTA or > 25% of text after the clip caps the score", () => {
    const f = baseFeatures({
      static: { htmlBytes: 130_000 },
      render: { clip: { afterClipChars: 800, ctaAfterClip: false } },
    });
    expect(scoreEmail(f, ctx).caps).toContain("CAP_CLIPPED");
    const g = baseFeatures({
      static: { htmlBytes: 130_000 },
      render: { clip: { afterClipChars: 100, ctaAfterClip: true } },
    });
    expect(scoreEmail(g, ctx).caps).toContain("CAP_CLIPPED");
    const h = baseFeatures({
      static: { htmlBytes: 130_000 },
      render: { clip: { afterClipChars: 100, ctaAfterClip: false } },
    });
    expect(scoreEmail(h, ctx).caps).not.toContain("CAP_CLIPPED");
  });
  it("the image-only cap needs all three measured conditions", () => {
    const base = { text: { chars: { legible: 40 } }, images: { share: 0.9 } };
    expect(
      scoreEmail(baseFeatures({ render: { ...base, imagesOff: { on: 100, off: 5 } } }), ctx).caps,
    ).toContain("CAP_IMAGE_ONLY");
    expect(
      scoreEmail(baseFeatures({ render: { ...base, imagesOff: { on: 100, off: 60 } } }), ctx).caps,
    ).not.toContain("CAP_IMAGE_ONLY");
    expect(
      scoreEmail(baseFeatures({ render: { ...base, imagesOff: null } }), ctx).caps,
    ).not.toContain("CAP_IMAGE_ONLY");
    expect(
      scoreEmail(baseFeatures({ render: { ...base, imagesOff: { on: 0, off: 0 } } }), ctx).caps,
    ).toContain("CAP_IMAGE_ONLY");
  });
});

describe("provisional rule (DESIGN-SCORE §3.1; DECISIONS.md #24, conf-2026.3)", () => {
  it("AI pending and within ±3 of 50 or 70 → provisional (uncapped)", () => {
    expect(
      isProvisional({ confidence: 0.845, aiPending: true, nearEdge: true, capped: false }),
    ).toBe(true);
    expect(
      isProvisional({ confidence: 0.845, aiPending: false, nearEdge: true, capped: false }),
    ).toBe(false);
    expect(
      isProvisional({ confidence: 0.845, aiPending: true, nearEdge: false, capped: false }),
    ).toBe(false);
    expect(
      isProvisional({ confidence: 0.64, aiPending: false, nearEdge: false, capped: false }),
    ).toBe(true);
  });
  it("a binding cap is never provisional through the AI window (merge tag / clipped at 69)", () => {
    // Regression: the merge-tag and clipped fixtures scored 69 (capped) with the AI pending and
    // were marked provisional, which kept a visible {{ first_name }} out of "Bad design".
    const f = baseFeatures({ ai: null });
    const r = scoreEmail(f, baseCtx({ subject: "Hi *|FNAME|*, 20% off" }));
    expect(r.caps).toContain("CAP_MERGE_TAG");
    expect(r.capped).toBe(true);
    expect(r.score).toBe(69);
    expect(r.aiPending).toBe(true);
    expect(r.provisional).toBe(false);
    const clipped = scoreEmail(
      baseFeatures({
        ai: null,
        static: { htmlBytes: 130_000 },
        render: { clip: { afterClipChars: 800, ctaAfterClip: true } },
      }),
      baseCtx(),
    );
    expect(clipped.score).toBe(69);
    expect(clipped.provisional).toBe(false);
  });
  it("a low classifier type confidence lowers the band but never makes a score provisional", () => {
    // Regression: the model newsletter (98) and the merge-tags-in-code newsletter (95) were
    // classified "other" at type confidence 0.2 and were kept out of "Good design".
    const r = scoreEmail(baseFeatures({ ai: null }), baseCtx({ typeConfidence: 0.2 }));
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.confidenceBand).toBe("low");
    expect(r.score!).toBeGreaterThanOrEqual(85);
    expect(r.provisional).toBe(false);
  });
  it("thin design evidence (template render without AI, 0.64) stays provisional", () => {
    const r = scoreEmail(baseFeatures({ ai: null, renderSource: "template" }), baseCtx());
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.provisional).toBe(true);
  });
});

describe("explanations reconcile exactly (DESIGN-SCORE §7)", () => {
  it("Σ all needs-improvement points = 100 − min(raw, cap); displayed ≤ 5, caps first", () => {
    const variants = [
      baseFeatures(),
      baseFeatures({
        ai: null,
        render: {
          layout: { k: 0.5, mobileContentWidth: 750, kNomq: 0.5 },
          text: { body: { mobile: 14 } },
        },
      }),
      baseFeatures({
        static: { mergeTags: { body: 2, firstScreen: true }, links: { http: 3, https: 3 } },
      }),
      baseFeatures({
        render: {
          contrast: {
            groups: [
              {
                fg: "#cccccc",
                bg: "#ffffff",
                ratio: 1.6,
                p90: null,
                method: "color",
                large: false,
                role: "body",
                rendered: true,
                short: false,
                chars: 1500,
              },
            ],
          },
        },
      }),
    ];
    for (const f of variants) {
      const d = scoreEmailDetailed(f, baseCtx());
      const r = d.result;
      const capLimit = d.capHits.length > 0 ? Math.min(...d.capHits.map((c) => c.limit)) : Infinity;
      const total = d.all.reduce((s, i) => s + i.points, 0);
      expect(total).toBeCloseTo(100 - Math.min(d.rawExact!, capLimit), 9);
      expect(r.needsImprovement.length).toBeLessThanOrEqual(5);
      expect(r.good.length).toBeLessThanOrEqual(5);
      const firstNonCap = r.needsImprovement.findIndex((i) => i.kind !== "cap");
      if (firstNonCap >= 0)
        expect(r.needsImprovement.slice(firstNonCap).every((i) => i.kind !== "cap")).toBe(true);
    }
  });
  it("groups a fixed-width layout into one bullet (M1/M2/M3/M7/T1)", () => {
    const f = baseFeatures({
      render: {
        layout: { k: 0.8, mobileContentWidth: 470, kNomq: 0.8 },
        text: { body: { mobile: 14 }, blockWidths: [[300, 1500]], gutters: [[10, 1500]] },
      },
    });
    const r = scoreEmail(f, baseCtx());
    const group = r.needsImprovement.find((i) => i.key === "group:fixed-width");
    expect(group).toBeDefined();
    expect(group!.checkIds).toEqual(expect.arrayContaining(["M1", "T1"]));
    expect(group!.title).toMatch(/fixed 470px.*80%.*~11px/);
    expect(r.needsImprovement.filter((i) => i.checkIds.includes("M1"))).toHaveLength(1);
  });
  it("Good excludes A4, A5, A9, A10, A11 and includes AI levels ≥ 4 tagged as AI", () => {
    const r = scoreEmail(baseFeatures(), baseCtx());
    const ids = r.good.flatMap((g) => g.checkIds);
    for (const hidden of ["A4", "A5", "A9", "A10", "A11"]) expect(ids).not.toContain(hidden);
    const allGood = scoreEmail(
      baseFeatures({
        ai: baseAi({
          criteria: { H7: { level: 5, evidence: "One dominant hero and button.", region: "top" } },
        }),
      }),
      baseCtx(),
    );
    const aiItem = allGood.good.find((g) => g.checkIds.includes("H7"));
    expect(aiItem?.ai).toBe(true);
  });
});
