/**
 * Fixed gallery wording shared by the cards, the badge and the detail view. Client-safe.
 *
 * The reason lines and the detail's problem / strength lists are NOT rewritten here: they arrive
 * from the server already plain and specific (lib/gallery.ts `galleryReason`, REASON POLICY),
 * with the measured facts a reader can check by looking ("Body text is light grey on white
 * (2.1:1)", "Cut off in Gmail: 116 KB …"). An earlier client-side rewrite stripped those facts
 * into generic lines ("Text is easy to read"), which the policy rules out.
 */
import type { Verdict } from "./gallery";
import type { Waiting } from "./gallery-waiting";
import { calendarDaysFrom, formatTimeOfDay, type DateContext } from "./format";

/** Short badge words (the full labels, VERDICT_LABELS, are for screen readers and the detail view). */
export const VERDICT_SHORT: Record<Verdict, string> = {
  good: "Good",
  bad: "Bad",
  ok: "Okay",
  unscored: "Not scored yet",
};

/** The detail's line for a design without a score when there's nothing more to say. */
export const UNSCORED_LINE = "This design doesn't have a score yet.";

export interface WaitingCopy {
  /** The badge word ("Scoring now", "Scoring soon", "No score", else "Not scored yet"). */
  badge: string;
  /** The card's one short line: when (or why not). */
  line: string;
  /** The detail view's sentence. */
  detail: string;
}

const SOON: WaitingCopy = {
  badge: "Scoring soon",
  line: "Usually within the hour",
  detail: "Scoring soon — it usually has a score within the hour.",
};

/**
 * What an unscored card says about its score, in plain words that are true (lib/gallery-waiting.ts
 * decides the state from the real render queue). Times are the viewer's own clock.
 */
export function waitingCopy(w: Waiting | null | undefined, c: DateContext): WaitingCopy {
  switch (w?.state) {
    case "scoring":
      return {
        badge: "Scoring now",
        line: "Ready in a few minutes",
        detail: "Scoring now — the score is usually ready in a few minutes.",
      };
    case "soon":
      return SOON;
    case "scheduled":
    case "retry": {
      const at = w.at ?? "";
      const t = Date.parse(at);
      // The run's time has come (the page is older than the run): it's on its way.
      if (Number.isNaN(t) || t <= c.now) return SOON;
      const time = formatTimeOfDay(at, c);
      const days = calendarDaysFrom(at, c);
      const when =
        days === 0
          ? `today around ${time}`
          : days === 1
            ? `tomorrow around ${time}`
            : `around ${time}`;
      if (w.state === "retry")
        return {
          badge: "Not scored yet",
          line: days === 0 ? `Trying again around ${time}` : `Trying again ${when}`,
          detail: `Scoring it didn't work last time. It's tried again in the daily scoring run, ${when}.`,
        };
      return {
        badge: "Not scored yet",
        line: days === 0 ? `Gets its score around ${time}` : `Gets its score ${when}`,
        detail: `It gets its score in the daily scoring run, ${when}.`,
      };
    }
    case "queued":
      return {
        badge: "Not scored yet",
        line: "Waiting in line to be scored",
        detail: "It's waiting in line to be scored. This can take a few days.",
      };
    case "paused":
      return {
        badge: "Not scored yet",
        line: "Scoring is paused for now",
        detail:
          "Scoring is paused for now to keep the app within its free limits. It starts again on its own.",
      };
    case "off":
      return {
        badge: "Not scored yet",
        line: "Scoring is switched off",
        detail:
          "Scoring is switched off for now. It comes back when the app's owner turns it on again.",
      };
    case "manual":
      return {
        badge: "Not scored yet",
        line: "Open it to get a score",
        detail:
          "It's too old to be scored on its own (only the last 2 weeks are). Open the full analysis and choose “Analyze this email”.",
      };
    case "failed":
      return {
        badge: "Not scored yet",
        line: "Scoring didn't work",
        detail:
          "Scoring this design didn't work. To try again, open the full analysis and choose “Analyze this email”.",
      };
    case "unscorable":
      return {
        badge: "No score",
        line: "Can't be scored",
        detail: "There isn't enough in this design to measure, so it can't get a score.",
      };
    case "stored":
      return {
        badge: "Not scored yet",
        line: "Open it to get a score",
        detail:
          "It was saved while storage was nearly full, so it isn't scored on its own. Open the full analysis and choose “Analyze this email”.",
      };
    case "mailbox":
      return {
        badge: "Not scored yet",
        line: "Reconnect Gmail to score it",
        detail:
          "It can't be scored while its Gmail account is disconnected. You can reconnect it in Settings.",
      };
    default:
      return { badge: "Not scored yet", line: "", detail: UNSCORED_LINE };
  }
}
