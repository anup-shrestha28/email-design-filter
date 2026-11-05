/**
 * A saved design checklist (score_summary.checklist) built from the results the test cares about:
 * every rule not given passes. The counts are worked out from the rules, as the engine saves them.
 */
import {
  CHECKLIST_RULES,
  CHECKLIST_VERSION,
  type ChecklistResult,
  type ChecklistRuleId,
  type DesignChecklist,
} from "@edf/design/checklist";

export function checklistOf(
  results: Partial<Record<ChecklistRuleId, ChecklistResult>> = {},
  why: Partial<Record<ChecklistRuleId, string>> = {},
): DesignChecklist {
  const rules = CHECKLIST_RULES.map(({ id, label }) => {
    const result = results[id] ?? "pass";
    return { id, result, why: why[id] ?? `${label}: ${result}.` };
  });
  return {
    v: CHECKLIST_VERSION,
    rules,
    misses: rules.filter((r) => r.result === "miss").length,
    unknown: rules.filter((r) => r.result === "unknown").length,
  };
}
