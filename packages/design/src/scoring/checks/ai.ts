/**
 * AI checks — H7 (6), L8 (4), C4 (2.5), I6 (1.5): at most 14 points (DESIGN-SCORE §6).
 * Credit = `(level − 1) / 4` on the anchored 1–5 rubric.
 */
import type { AiCheckId } from "../../types";
import { AI_CORPUS_MEDIAN_LEVEL_PRIOR } from "../weights";
import {
  type CheckFn,
  type CheckInput,
  type CheckOutcome,
  type CheckTable,
  notApplicable,
  notEvaluated,
  scored,
} from "../kit";

/** Levels after the injection safeguard: flagged reviews are capped at the corpus median. */
export function effectiveLevel(input: CheckInput, level: number): number {
  const ai = input.ai;
  const flagged = !!ai && (ai.injectionPatternHit || ai.flags.suspected_prompt_injection);
  const clamped = Math.min(5, Math.max(1, Math.round(level)));
  return flagged ? Math.min(clamped, AI_CORPUS_MEDIAN_LEVEL_PRIOR) : clamped;
}

function aiCheck(id: AiCheckId): CheckFn {
  return (input): CheckOutcome => {
    const ai = input.ai;
    if (!ai) return notEvaluated("ai_pending");
    if (ai.refused) return notEvaluated("ai_refused");
    // C4 judges this email's own copy and is never reused across emails (DESIGN-SCORE §6).
    if (id === "C4" && ai.source === "template") return notEvaluated("copy_review_not_reused");
    if (id === "I6" && input.render && input.render.images.content === 0)
      return notApplicable({ reason: "no_images" });
    const c = ai.criteria[id];
    if (!c) return notEvaluated("criterion_missing");
    if (c.level === null)
      return id === "I6" ? notApplicable({ reason: "no_images" }) : notEvaluated("no_level");
    const level = effectiveLevel(input, c.level);
    const flagged = level !== Math.min(5, Math.max(1, Math.round(c.level)));
    return scored((level - 1) / 4, {
      level,
      evidence: c.evidence,
      region: c.region,
      capped: flagged,
      source: ai.source,
    });
  };
}

export const AI_CHECKS: CheckTable = {
  H7: aiCheck("H7"),
  L8: aiCheck("L8"),
  C4: aiCheck("C4"),
  I6: aiCheck("I6"),
};
