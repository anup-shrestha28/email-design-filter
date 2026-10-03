/**
 * What the governor's render switches mean for one user's on-demand render ("Analyze", "Run AI
 * review") (FREE-TIER.md §8.2 L2/L3, §8.3 Sandbox). Pure and free of pipeline imports, so the
 * email page and the Analyze action can use it without loading the pipeline; the render step
 * applies the same switches (@edf/pipeline `gateRenderOptions`).
 */
import type { GovernorActions } from "./governor";

/** The render switches as stored in `app_setting.governor` (a missing switch is off). */
export type RenderGovernorActions = Partial<
  Pick<
    GovernorActions,
    "fillRendersOff" | "plannedRendersOff" | "samplesOff" | "rendersOff" | "friendsBatchRequireTen" | "autoAiOff" | "aiOff"
  >
>;

export interface RenderGovernor {
  level: number;
  actions: RenderGovernorActions;
}

/** The render switches from `app_setting.governor` (missing → L0, no actions). */
export function renderGovernorOf(value: { level?: number; actions?: RenderGovernorActions } | null | undefined): RenderGovernor {
  return { level: Number(value?.level ?? 0), actions: value?.actions ?? {} };
}

/** No render VM at all: L3, or the Sandbox static-only stage. */
export function rendersStopped(gov: RenderGovernor): boolean {
  return gov.level >= 3 || gov.actions.rendersOff === true;
}

/**
 * Why this user's on-demand render can't run now, in plain English, or null when it can. Nobody's
 * at L3 / static-only; only the owner's at L2 / the Sandbox self-cap.
 */
export function onDemandPausedReason(gov: RenderGovernor, role: "owner" | "friend" | null): string | null {
  if (rendersStopped(gov)) {
    return "Design renders are paused for everyone to keep the app within its free limits. They resume on their own when usage drops.";
  }
  if (gov.actions.plannedRendersOff && role !== "owner") {
    return "Design renders for friends are paused to keep the app within its free limits. They resume on their own when usage drops.";
  }
  return null;
}
