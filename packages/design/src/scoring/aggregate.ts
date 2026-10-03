/**
 * Aggregation (DESIGN-SCORE §3): global renormalization, effective weights, points and points
 * lost, pillar display and confidence. The AI share is strictly bounded: e_c = w_c for AI
 * checks, so AI contributes at most 14 points in every renormalization case.
 */
import {
  AI_CHECK_IDS,
  PILLARS,
  type AiCheckId,
  type CheckId,
  type CheckResult,
  type CheckStatus,
  type PillarScore,
} from "../types";
import { roundPreservingSum, roundTo, roundWithinCaps } from "../util/math";
import { AI_MAX_POINTS, CHECKS, PILLAR_META } from "./weights";

export type PendingCheck = Omit<CheckResult, "e" | "points" | "pointsLost">;

const AI_SET: ReadonlySet<string> = new Set(AI_CHECK_IDS);

export function isAiCheck(id: CheckId): id is AiCheckId {
  return AI_SET.has(id);
}

export function isEvaluated(status: CheckStatus): boolean {
  return status === "pass" || status === "partial" || status === "fail";
}

export interface Aggregate {
  checks: CheckResult[];
  /** Uncapped raw score (full precision), or null when no deterministic check was evaluated. */
  raw: number | null;
  pillars: PillarScore[];
  /**
   * Σ w(evaluated) × inheritance factor / Σ w(applicable), nominal weights. Checks whose factor
   * is `null` (structurally unavailable by design) are left out of both sums.
   */
  confidence: number;
  /** W_A: nominal weight of evaluated AI checks (≤ 14). */
  aiWeight: number;
}

/**
 * `det_credit = Σ_D w·s / Σ_D w`, `raw = Σ_A w·s + (100 − W_A)·det_credit`,
 * `e_c = w_c` (AI) or `(100 − W_A)·w_c / Σ_D w` (deterministic).
 *
 * `confidenceFactor` gives each applicable check's confidence weight (FREE-TIER.md §5.4): 1 for
 * own evidence, 0.75 / 0.5 for inherited evidence, or `null` when the check is structurally
 * unavailable by design (not a gap), which drops it from numerator and denominator. It never
 * changes the score itself.
 */
export function aggregate(
  pending: readonly PendingCheck[],
  confidenceFactor: (c: PendingCheck) => number | null,
): Aggregate {
  let detW = 0;
  let detWS = 0;
  let aiW = 0;
  let aiWS = 0;
  for (const c of pending) {
    if (!isEvaluated(c.status) || c.s === null) continue;
    if (isAiCheck(c.id)) {
      aiW += c.w;
      aiWS += c.w * c.s;
    } else {
      detW += c.w;
      detWS += c.w * c.s;
    }
  }
  if (aiW > AI_MAX_POINTS + 1e-9) throw new Error("invariant: AI weight exceeds 14");
  const hasScore = detW > 0;
  const detScale = hasScore ? (100 - aiW) / detW : 0;
  const checks: CheckResult[] = pending.map((c) => {
    if (!hasScore || !isEvaluated(c.status) || c.s === null)
      return { ...c, e: 0, points: 0, pointsLost: 0 };
    const e = isAiCheck(c.id) ? c.w : c.w * detScale;
    return { ...c, e, points: e * c.s, pointsLost: e * (1 - c.s) };
  });
  const raw = hasScore ? aiWS + (100 - aiW) * (detWS / detW) : null;

  // Pillar display: Σ points / Σ e per pillar; rounded so the displayed values add up exactly.
  const pts = PILLARS.map((p) =>
    checks.filter((c) => c.pillar === p).reduce((s, c) => s + c.points, 0),
  );
  const max = PILLARS.map((p) => checks.filter((c) => c.pillar === p).reduce((s, c) => s + c.e, 0));
  const maxR = hasScore ? roundPreservingSum(max, 1) : max.map(() => 0);
  const ptsR = hasScore ? roundWithinCaps(pts, maxR, 1) : pts.map(() => 0);
  const pillars: PillarScore[] = PILLARS.map((id, i) => ({
    id,
    label: PILLAR_META[id].label,
    points: ptsR[i]!,
    max: maxR[i]!,
    nominal: PILLAR_META[id].nominal,
  }));

  let applicable = 0;
  let evaluated = 0;
  for (const c of pending) {
    if (c.status === "not_applicable") continue;
    const factor = confidenceFactor(c);
    if (factor === null) continue;
    applicable += c.w;
    if (isEvaluated(c.status)) evaluated += c.w * factor;
  }
  const confidence = applicable > 0 ? evaluated / applicable : 0;
  return { checks, raw, pillars, confidence, aiWeight: aiW };
}

/** Nominal weight of a check (DESIGN-SCORE §5). */
export function nominalWeight(id: CheckId): number {
  return CHECKS[id].w;
}

/** Raw score rounded for storage/display (1 decimal). */
export function displayRaw(raw: number): number {
  return roundTo(raw, 1);
}
