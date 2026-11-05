/**
 * Fixed gallery wording shared by the cards, the badge and the detail view. Client-safe.
 *
 * The reason lines and the detail's lists are NOT rewritten here: they arrive from the server
 * already plain and specific (lib/gallery.ts `checklistReason`: the design checklist's rules with
 * what was measured, "Body text is 12.5px on phones (your rule: 14–16px)"). An earlier client-side
 * rewrite stripped such facts into generic lines ("Text is easy to read").
 *
 * The gallery's verdict is the design checklist, so a design without one is "not checked yet"
 * (lib/gallery.ts VERDICT POLICY): the waiting words say "checked", never "scored".
 */
import type { Verdict } from "./gallery";
import type { Waiting } from "./gallery-waiting";
import { calendarDaysFrom, formatTimeOfDay, type DateContext } from "./format";

/** Short badge words (the full labels, VERDICT_LABELS, are for screen readers and the detail view). */
export const VERDICT_SHORT: Record<Verdict, string> = {
  good: "Good",
  bad: "Bad",
  ok: "Okay",
  unscored: "Not checked yet",
};

/** The detail's line for an unchecked design when there's nothing more to say. */
export const UNSCORED_LINE = "This design hasn't been checked against the design rules yet.";

export interface WaitingCopy {
  /** The badge word ("Checking now", "Checking soon", "Can't be checked", else "Not checked yet"). */
  badge: string;
  /** The card's one short line: when (or why not). */
  line: string;
  /** The detail view's sentence. */
  detail: string;
}

const SOON: WaitingCopy = {
  badge: "Checking soon",
  line: "Usually within the hour",
  detail: "Checking soon — it's usually checked within the hour.",
};

/**
 * What an unchecked card says about its check, in plain words that are true (lib/gallery-waiting.ts
 * decides the state from the real render queue). Times are the viewer's own clock.
 */
export function waitingCopy(w: Waiting | null | undefined, c: DateContext): WaitingCopy {
  switch (w?.state) {
    case "scoring":
      return {
        badge: "Checking now",
        line: "Ready in a few minutes",
        detail: "Checking now — it's usually ready in a few minutes.",
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
          badge: "Not checked yet",
          line: days === 0 ? `Trying again around ${time}` : `Trying again ${when}`,
          detail: `Checking it didn't work last time. It's tried again in the daily run, ${when}.`,
        };
      return {
        badge: "Not checked yet",
        line: days === 0 ? `Gets checked around ${time}` : `Gets checked ${when}`,
        detail: `It gets checked in the daily run, ${when}.`,
      };
    }
    case "queued":
      return {
        badge: "Not checked yet",
        line: "Waiting in line to be checked",
        detail: "It's waiting in line to be checked. This can take a few days.",
      };
    case "paused":
      return {
        badge: "Not checked yet",
        line: "Checking is paused for now",
        detail:
          "Checking is paused for now to keep the app within its free limits. It starts again on its own.",
      };
    case "off":
      return {
        badge: "Not checked yet",
        line: "Checking is switched off",
        detail:
          "Checking is switched off for now. It comes back when the app's owner turns it on again.",
      };
    case "manual":
      return {
        badge: "Not checked yet",
        line: "Open it to check it",
        detail:
          "It's too old to be checked on its own (only the last 2 weeks are). Open the full analysis and choose “Analyze this email”.",
      };
    case "failed":
      return {
        badge: "Not checked yet",
        line: "Checking didn't work",
        detail:
          "Checking this design didn't work. To try again, open the full analysis and choose “Analyze this email”.",
      };
    case "unscorable":
      return {
        badge: "Can't be checked",
        line: "Not enough to measure",
        detail: "There isn't enough in this design to measure, so it can't be checked.",
      };
    case "stored":
      return {
        badge: "Not checked yet",
        line: "Open it to check it",
        detail:
          "It was saved while storage was nearly full, so it isn't checked on its own. Open the full analysis and choose “Analyze this email”.",
      };
    case "mailbox":
      return {
        badge: "Not checked yet",
        line: "Reconnect Gmail to check it",
        detail:
          "It can't be checked while its Gmail account is disconnected. You can reconnect it in Settings.",
      };
    case "later":
      return {
        badge: "Not checked yet",
        line: "Newer emails are checked first",
        detail:
          "Each night your 10 newest unchecked designs are checked first, so this one waits its turn.",
      };
    default:
      return { badge: "Not checked yet", line: "", detail: UNSCORED_LINE };
  }
}
