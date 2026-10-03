/**
 * What the Design panel says around "Analyze" / "Run AI review" (pure, so it's tested without a
 * browser). While the governor has renders paused (FREE-TIER.md §8.2–8.3) nothing claims a request
 * was queued, and no copy invites a click on a disabled button — nor once today's allowance is used.
 */
import type { AnalyzeOutcome, EmailDetail } from "@/server/queries/types";

type Actions = EmailDetail["actions"];

export interface AnalyzeNotice {
  tone: "success" | "info";
  title: string;
  description: string;
}

/** The toast after a click: "queued" only when something was queued. */
export function analyzeNotice(outcome: AnalyzeOutcome, withAi: boolean): AnalyzeNotice {
  if (outcome.status === "paused") {
    return {
      tone: "info",
      title: "Design renders are paused",
      description: `${outcome.reason} Nothing was queued, and today's allowance wasn't used.`,
    };
  }
  return {
    tone: "success",
    title: withAi ? "AI review requested" : "Analysis queued",
    description: "Results usually arrive within a couple of minutes. This page updates when you come back.",
  };
}

/**
 * The re-run bar under a score ("Run fresh AI review" / "Analyze again"): hidden only for emails
 * that can never be analysed; while renders are paused it stays, disabled, with the reason.
 */
export function rerunBar(
  actions: Actions,
  paused: string | null = actions.rendersPaused ?? null,
): "hidden" | "paused" | "shown" {
  if (actions.reason && actions.reason !== actions.rendersPaused) return "hidden";
  return paused ? "paused" : "shown";
}

/**
 * Something a click learned that the page's data didn't say yet (renders paused, request queued).
 * It holds only while the panel still shows the data it was learned against: once a refresh brings
 * new data, the server's answer wins, so a pause that has since lifted doesn't linger.
 */
export interface FromClick<T> {
  value: T;
  seen: Actions;
}

export function fromClick<T>(click: FromClick<T> | null, actions: Actions): T | null {
  return click !== null && click.seen === actions ? click.value : null;
}

/** Where the used-up allowance's copy points (the daily counters reset at midnight UTC). */
export const ALLOWANCE_USED = "You've used today's allowance. It resets at midnight UTC.";

/**
 * "Analyze" is disabled only because today's allowance is used (not paused, not queued, not an
 * email that can never be analysed): the copy then says when it can be clicked again.
 */
export function analyzeAllowanceUsed(actions: Actions): boolean {
  return !actions.rendersPaused && !actions.renderQueued && !actions.reason && actions.analyzeRemainingToday === 0;
}

/** What the panel shows for an email with no score yet (DesignPanel's last three states). */
export function waitingState(actions: Actions): "queued_paused" | "queued" | "not_analysed" {
  if (actions.renderQueued) return actions.rendersPaused ? "queued_paused" : "queued";
  return "not_analysed";
}

/** The empty state's line under "Design not analysed yet" / "We couldn't analyse this email". */
export function notAnalysedBody(
  failed: boolean,
  rendersPaused: string | null | undefined,
  allowanceUsed = false,
): string {
  if (failed) {
    if (rendersPaused) return "The render didn't complete. You can try again once design renders resume.";
    return allowanceUsed
      ? "The render didn't complete. You can try again after midnight UTC, when today's allowance resets."
      : "The render didn't complete. You can try again — it doesn't count against Gmail.";
  }
  if (rendersPaused) return "It hasn't been rendered yet. You can analyze it once design renders resume.";
  return allowanceUsed
    ? "It's waiting for the next batch. You've used today's allowance, so you can analyze it yourself after midnight UTC."
    : "It's waiting for the next batch. You can analyze it now instead.";
}

/** The line on the "Design not analysed yet" card when only the email's code has been checked. */
export function staticOnlyBody(actions: Actions): string {
  const checked = "So far we've only checked this email's code.";
  if (actions.renderQueued) {
    return actions.rendersPaused
      ? `${checked} Your analysis is queued and runs once design renders resume.`
      : `${checked} Analysis queued — results usually arrive within a couple of minutes.`;
  }
  if (actions.rendersPaused) {
    return `${checked} Once design renders resume, you can analyze it to render it in a sandboxed browser and get a full, explained score.`;
  }
  return analyzeAllowanceUsed(actions)
    ? `${checked} You've used today's allowance; after midnight UTC you can analyze it to render it in a sandboxed browser and get a full, explained score.`
    : `${checked} Analyze it to render it in a sandboxed browser and get a full, explained score.`;
}

/** The note under a saved summary's score (the full breakdown needs a fresh render). */
export function savedSummaryNote(rendersPaused: string | null | undefined, allowanceUsed = false): string {
  const kept = "Saved summary. Full measurements are kept for 30 days (14 for invited accounts);";
  if (rendersPaused) return `${kept} you can analyze again for the complete breakdown once design renders resume.`;
  return allowanceUsed
    ? `${kept} you can analyze again for the complete breakdown after midnight UTC, when today's allowance resets.`
    : `${kept} analyze again for the complete breakdown.`;
}
