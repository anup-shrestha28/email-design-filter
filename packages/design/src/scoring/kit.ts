/**
 * Shared plumbing for the pure check functions (DESIGN-SCORE §2.2 statuses, §10 layout).
 */
import type { FontFeatures } from "../features/fonts";
import type { RenderFeatures } from "../features/render";
import type { StaticDesignFeatures } from "../features/static";
import type { AiReview, CheckId, CheckStatus, FontProfile, ScoreContext } from "../types";
import { clamp } from "../util/math";

/** Everything a check may read. Checks are pure functions of this. */
export interface CheckInput {
  static: StaticDesignFeatures;
  /** Own render, the template sample's render, or null. */
  render: RenderFeatures | null;
  renderSource: "none" | "render" | "template";
  fonts: FontFeatures;
  fontProfile: FontProfile;
  ai: AiReview | null;
  ctx: ScoreContext;
  /**
   * True only for an own render. The static-heuristic checks (H1, T7, A2(b); FREE-TIER.md §5.4)
   * switch to the rendered definition only then — a template sample's render describes another
   * email's content.
   */
  ownRender: boolean;
}

export interface CheckOutcome {
  status: CheckStatus;
  s: number | null;
  value: unknown;
}

export type CheckFn = (input: CheckInput) => CheckOutcome;
export type CheckTable = Partial<Record<CheckId, CheckFn>>;

/** Credit → status (DESIGN-SCORE §2.2): pass ≥ 0.9, partial 0 < s < 0.9, fail 0. */
export function scored(s: number, value: unknown): CheckOutcome {
  const credit = clamp(s, 0, 1);
  const status: CheckStatus = credit >= 0.9 ? "pass" : credit > 0 ? "partial" : "fail";
  return { status, s: credit, value };
}

export function notApplicable(value: unknown = null): CheckOutcome {
  return { status: "not_applicable", s: null, value };
}

export function notEvaluated(reason: string): CheckOutcome {
  return { status: "not_evaluated", s: null, value: { reason } };
}

export function needsReview(value: unknown): CheckOutcome {
  return { status: "needs_review", s: null, value };
}

/** Render facts or a not_evaluated outcome. */
export function requireRender(input: CheckInput): RenderFeatures | CheckOutcome {
  return input.render ?? notEvaluated("no_render");
}

export function isOutcome(x: RenderFeatures | CheckOutcome): x is CheckOutcome {
  return "status" in x && "s" in x;
}

/** Round for storage in `value` (keeps JSON compact; decisions use full precision). */
export function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
