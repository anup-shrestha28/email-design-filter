/**
 * "How we judged this" — the gallery detail view's proof of a verdict (components/gallery/
 * verdict-evidence.tsx) and the full analysis page's "Design rules" section: the saved design
 * checklist (score_summary.checklist, lib/gallery.ts VERDICT POLICY), one row per rule in the cheat
 * sheet's order, each with what was measured. Client-safe, pure.
 *
 *  1. The verdict in one sentence, with the count that decided it and what each verdict needs
 *     ("Bad: misses 4 of the 16 rules (3 or more is Bad).").
 *  2. The 16 rules: passed (✓), missed (✗), couldn't be checked (?) or doesn't apply (–), each with
 *     its measured sentence ("Body text is 12.5px on phones (your rule: 14–16px).").
 *  3. What the rules can't see, said plainly: whether the fonts and colours are the brand's own,
 *     and whether the pictures support the message.
 *
 * The rules themselves are @edf/design scoring/checklist.ts's; the verdict is lib/gallery.ts
 * verdictOf, which reads the same saved checklist, so the panel can never disagree with the badge.
 */
import {
  BAD_MISSES_MIN,
  CHECKLIST_RULES,
  type ChecklistResult,
  type ChecklistRuleId,
} from "@edf/design/checklist";
import { CHECKLIST_RULE_COUNT, storedChecklist, verdictOf, type Verdict } from "./gallery";

export type EvidenceState = "pass" | "fail" | "neutral" | "unknown";

/** One rule, as the panel shows it. */
export interface EvidenceRow {
  id: ChecklistRuleId;
  /** The rule's plain name ("One main button"). */
  label: string;
  state: EvidenceState;
  /** What was measured, in one sentence. */
  value: string;
}

export interface VerdictEvidence {
  verdict: Exclude<Verdict, "unscored">;
  /** "Bad: misses 4 of the 16 rules (3 or more is Bad)." */
  sentence: string;
  /** Every rule, in the cheat sheet's order. */
  rows: EvidenceRow[];
  misses: number;
  unknown: number;
  /** What the rules can't measure. */
  notes: string[];
}

const STATE: Record<ChecklistResult, EvidenceState> = {
  pass: "pass",
  miss: "fail",
  na: "neutral",
  unknown: "unknown",
};

/** When a rule's saved sentence is missing (never written by the engine, but stored data can be odd). */
const FALLBACK: Record<ChecklistResult, string> = {
  pass: "Passed.",
  miss: "Missed.",
  na: "Doesn't apply to this email.",
  unknown: "We couldn't check this one.",
};

export const BRAND_NOTE =
  "Fonts and colours: we check there are no more than two font families and a small set of colours. Whether they match the brand's own isn't something we can measure.";
export const PICTURES_NOTE =
  "Pictures: we check that they load and are described. Whether they support the message isn't something we can measure.";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The verdict's sentence (see the file comment). */
function sentenceOf(
  verdict: VerdictEvidence["verdict"],
  misses: number,
  unknown: number,
  applies: number,
): string {
  switch (verdict) {
    case "good":
      return applies === CHECKLIST_RULE_COUNT
        ? `Good: passes all ${CHECKLIST_RULE_COUNT} rules.`
        : `Good: passes all ${applies} rules that apply to it.`;
    case "bad":
      return `Bad: misses ${misses} of the ${CHECKLIST_RULE_COUNT} rules (${BAD_MISSES_MIN} or more is Bad).`;
    case "ok":
      return misses > 0
        ? `Okay: misses ${misses} ${plural(misses, "rule", "rules")} (Good needs none missed; ${BAD_MISSES_MIN} or more is Bad).`
        : `Okay: passes every rule we could check, but ${unknown} couldn't be checked (Good needs every rule checked and passed).`;
  }
}

/**
 * The evidence for one design's saved checklist, or null when it has none of the current version
 * (the design is "Not checked yet"). The verdict is verdictOf's own.
 */
export function checklistEvidence(checklist: unknown): VerdictEvidence | null {
  const c = storedChecklist(checklist);
  const verdict = verdictOf({ checklist });
  if (!c || verdict === "unscored") return null;
  const byId = new Map(c.rules.map((r) => [r.id, r]));
  const rows: EvidenceRow[] = CHECKLIST_RULES.map(({ id, label }) => {
    const r = byId.get(id);
    if (!r) return { id, label, state: "unknown", value: FALLBACK.unknown };
    return { id, label, state: STATE[r.result], value: r.why.trim() || FALLBACK[r.result] };
  });
  const applies = CHECKLIST_RULE_COUNT - rows.filter((r) => r.state === "neutral").length;
  return {
    verdict,
    sentence: sentenceOf(verdict, c.misses, c.unknown, applies),
    rows,
    misses: c.misses,
    unknown: c.unknown,
    notes: [BRAND_NOTE, PICTURES_NOTE],
  };
}
