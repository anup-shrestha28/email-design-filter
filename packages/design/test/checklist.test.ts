/**
 * The design checklist (scoring/checklist.ts): the owner's 16 rules, read from the engine's own
 * measured checks. Starts from the factory's well-designed email (every rule passes) and changes
 * one measurement at a time, so each rule is shown to follow its measurement:
 *  - pass / miss at the rule's own limit, with a sentence that quotes what was measured;
 *  - "unknown" when the measurements can't see it (text inside pictures, a check that didn't run),
 *    never a guess; "na" when the rule doesn't apply;
 *  - the verdict: Good = no miss and no unknown, Bad = 3+ misses, else Okay;
 *  - summarizeScore saves it for every rendered email, never for static-only coverage.
 */
import { describe, expect, it } from "vitest";
import {
  BAD_MISSES_MIN,
  CHECKLIST_RULES,
  CHECKLIST_VERSION,
  checklistVerdict,
  designChecklist,
  scoreEmail,
  summarizeScore,
  type CheckResult,
  type ChecklistRuleId,
  type SummarySignals,
} from "../src/index";
import { summarySignals } from "../src/scoring/summary";
import { baseCtx, baseFeatures } from "./helpers/factory";

const base = scoreEmail(baseFeatures({}), baseCtx());
const BASE_SIGNALS: Partial<SummarySignals> = base.signals ?? summarySignals(base.checks);

/** The base checks with one check's fields replaced (value merged). */
function withCheck(
  checks: readonly CheckResult[],
  id: string,
  patch: Partial<Pick<CheckResult, "status" | "s">> & { value?: Record<string, unknown> },
): CheckResult[] {
  return checks.map((c) =>
    c.id === id
      ? {
          ...c,
          ...(patch.status ? { status: patch.status } : {}),
          ...("s" in patch ? { s: patch.s ?? null } : {}),
          ...(patch.value
            ? { value: { ...((c.value as Record<string, unknown>) ?? {}), ...patch.value } }
            : {}),
        }
      : c,
  );
}

function rules(checks: readonly CheckResult[], signals: Partial<SummarySignals> = BASE_SIGNALS) {
  const c = designChecklist(checks, signals);
  return { c, by: (id: ChecklistRuleId) => c.rules.find((r) => r.id === id)! };
}

describe("designChecklist", () => {
  it("a well-designed email passes all 16 rules, in the cheat sheet's order", () => {
    const { c } = rules(base.checks);
    expect(c.v).toBe(CHECKLIST_VERSION);
    expect(c.rules.map((r) => r.id)).toEqual(CHECKLIST_RULES.map((r) => r.id));
    expect(c.rules).toHaveLength(16);
    expect(c.rules.filter((r) => r.result !== "pass")).toEqual([]);
    expect(c).toMatchObject({ misses: 0, unknown: 0 });
    expect(checklistVerdict(c)).toBe("good");
    for (const r of c.rules) expect(r.why, r.id).toMatch(/^\S.*\.$/);
  });

  it("is pure: the same checks and signals always give the same answer", () => {
    expect(designChecklist(base.checks, BASE_SIGNALS)).toEqual(
      designChecklist(base.checks, BASE_SIGNALS),
    );
  });

  it("about 600px wide: L1 decides, and the miss quotes the width", () => {
    const { by } = rules(withCheck(base.checks, "L1", { s: 0.3, value: { width: 800 } }));
    expect(by("width")).toEqual({
      id: "width",
      result: "miss",
      why: "800px wide on desktop (your rule: about 600px).",
    });
  });

  it("no button but real text: both button rules are missed", () => {
    const { c, by } = rules(withCheck(base.checks, "H1", { value: { present: false } }));
    expect(by("button")).toMatchObject({
      result: "miss",
      why: "There's no button, only text links.",
    });
    expect(by("cta")).toMatchObject({ result: "miss" });
    expect(c.misses).toBe(2);
    expect(checklistVerdict(c)).toBe("ok");
  });

  it("look-alike buttons competing for different actions miss 'one main button'", () => {
    const { by } = rules(base.checks, { ...BASE_SIGNALS, ctaCompeting: true });
    expect(by("button").result).toBe("miss");
  });

  it("a generic button label ('Learn more') is too vague; a long specific one isn't", () => {
    const vague = rules(withCheck(base.checks, "H4", { s: 0.4, value: { label: "Learn more" } }));
    expect(vague.by("cta").result).toBe("miss");
    expect(vague.by("cta").why).toContain("too vague");
    const specific = rules(withCheck(base.checks, "H4", { s: 0.6 }));
    expect(specific.by("cta").result).toBe("pass");
    const faint = rules(withCheck(base.checks, "H3", { s: 0.5 }));
    expect(faint.by("cta")).toMatchObject({ result: "miss" });
    expect(faint.by("cta").why).toContain("doesn't stand out");
  });

  it("text inside pictures: what can't be measured is unknown, and relying on pictures is a miss", () => {
    const signals = { ...BASE_SIGNALS, liveTextChars: 80 };
    const { c, by } = rules(withCheck(base.checks, "H1", { value: { present: false } }), signals);
    for (const id of ["button", "cta", "hierarchy", "body", "contrast"] as const)
      expect(by(id).result, id).toBe("unknown");
    expect(by("no_decoration")).toMatchObject({ result: "miss" });
    expect(by("no_decoration").why).toContain("only 80 characters of real text");
    // Never Good: one miss, five unknown.
    expect(checklistVerdict(c)).toBe("ok");
  });

  it("fonts: at most two families", () => {
    expect(rules(withCheck(base.checks, "T6", { value: { families: 2 } })).by("fonts").result).toBe(
      "pass",
    );
    expect(rules(withCheck(base.checks, "T6", { value: { families: 3 } })).by("fonts")).toEqual({
      id: "fonts",
      result: "miss",
      why: "Uses 3 font families (your rule: no more than two).",
    });
  });

  it("readable body text: 14px on a phone and roomy lines", () => {
    expect(rules(withCheck(base.checks, "T1", { value: { px: 13 } })).by("body")).toMatchObject({
      result: "miss",
      why: "Body text is 13px on phones (your rule: 14–16px).",
    });
    expect(rules(withCheck(base.checks, "T1", { value: { px: 14 } })).by("body").result).toBe(
      "pass",
    );
    expect(rules(withCheck(base.checks, "T3", { value: { ratio: 1.2 } })).by("body").result).toBe(
      "miss",
    );
  });

  it("a rule that doesn't apply is 'na' and doesn't stop Good; one that didn't run is unknown", () => {
    let checks = withCheck(base.checks, "C3", { status: "not_applicable", s: null });
    checks = withCheck(checks, "I3", { status: "not_applicable", s: null });
    const { c, by } = rules(checks);
    expect(by("scan").result).toBe("na");
    expect(by("images").result).toBe("na");
    expect(checklistVerdict(c)).toBe("good");
    const notRun = rules(withCheck(base.checks, "L1", { status: "not_evaluated", s: null }));
    expect(notRun.by("width").result).toBe("unknown");
    expect(checklistVerdict(notRun.c)).toBe("ok");
  });

  it("three misses make it Bad; the counts are the rules'", () => {
    let checks = withCheck(base.checks, "L1", { s: 0.3, value: { width: 800 } });
    checks = withCheck(checks, "T6", { value: { families: 4 } });
    checks = withCheck(checks, "A1", { s: 0.5 });
    const { c } = rules(checks);
    expect(c.misses).toBe(BAD_MISSES_MIN);
    expect(c.misses).toBe(c.rules.filter((r) => r.result === "miss").length);
    expect(c.unknown).toBe(c.rules.filter((r) => r.result === "unknown").length);
    expect(checklistVerdict(c)).toBe("bad");
  });

  it("the verdict at its edges", () => {
    expect(checklistVerdict({ misses: 0, unknown: 0 })).toBe("good");
    expect(checklistVerdict({ misses: 0, unknown: 1 })).toBe("ok");
    expect(checklistVerdict({ misses: 2, unknown: 9 })).toBe("ok");
    expect(checklistVerdict({ misses: 3, unknown: 0 })).toBe("bad");
  });
});

describe("summarizeScore saves the checklist", () => {
  it("for a rendered email, from its own checks and signals", () => {
    const s = summarizeScore(base, null);
    expect(s.checklist).toEqual(
      designChecklist(base.checks, base.signals ?? summarySignals(base.checks)),
    );
  });

  it("never for static-only coverage (nothing was measured to check it against)", () => {
    expect(summarizeScore({ ...base, coverage: "static" }, null).checklist).toBeNull();
  });
});
