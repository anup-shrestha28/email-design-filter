/**
 * Importance (DESIGN.md §7.5): 0–100, high ≥ 60, low < 25, reasons always stored.
 *
 * Time-bound boosts are encoded in the reasons as "boost:<code>:<points>:<expiresUnixSec>" so the
 * effective score can be computed at read time from the stored row alone (FREE-TIER.md §4.2):
 * effective = score − Σ points of boosts with expiry ≤ now. Boosts are applied latest-expiring
 * first and each records the points it actually added after clamping, so subtracting lapsed
 * boosts reproduces a fresh computation exactly.
 */
import type { EmailType, Importance, ImportanceInput, ImportanceResult } from "../types";

export const HIGH_THRESHOLD = 60;
export const LOW_THRESHOLD = 25;
/** Cap applied when a boost must not make mail "high" (guardrail, suspicious mail). */
export const NORMAL_CAP = HIGH_THRESHOLD - 1;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** OTP / password reset: 60 for 1 h, then 15. */
export const OTP_FRESH_MS = HOUR;
/** Shipping: 40 for 14 days, then the transactional base. */
export const SHIPPING_RECENT_MS = 14 * DAY;
/** Deal / deadline boost window before the deadline. */
export const TIME_SENSITIVE_WINDOW_MS = 48 * HOUR;
/** "A sender the user engages with": 60-day read rate at or above this. */
export const ENGAGED_READ_RATE = 0.3;
/** "High-frequency" sender for the never-opened penalty. */
export const HIGH_FREQUENCY_PER_WEEK = 3;

/** Base points by type (§7.5; "others 15–25" resolved per type/subtype, DECISIONS.md). */
function basePoints(type: EmailType, subtype: string | null): number {
  switch (type) {
    case "account_security":
      return 60; // login/security alert; OTP/reset handled by the 1-hour boost
    case "transactional":
      return subtype === "payment_failed" ? 70 : 25;
    case "event":
      return 35;
    case "newsletter":
      return 20;
    case "promotional":
      return 10;
    case "notification":
      return subtype === "mention" || subtype === "reminder" ? 25 : 20;
    case "lifecycle":
      return subtype === "trial_ending" ? 25 : 15;
    case "account_notice":
      return 20;
    default:
      return 15; // product_update, social, community, survey, other
  }
}

/** high ≥ 60, low < 25, else normal. */
export function importanceLevel(score: number): Importance {
  if (score >= HIGH_THRESHOLD) return "high";
  if (score < LOW_THRESHOLD) return "low";
  return "normal";
}

interface Boost {
  code: string;
  points: number;
  expiresAt: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Computes importance at `input.now` (DESIGN.md §7.5). */
export function computeImportance(input: ImportanceInput): ImportanceResult {
  const now = input.now.getTime();
  const received = input.receivedAt.getTime();
  const reasons: string[] = [];
  const labels = new Set(input.labelIds);
  const prior = input.prior;
  const positiveAllowed = !input.suspicious;

  const isOtpLike =
    input.primaryType === "account_security" &&
    (input.subtype === "verification_code" || input.subtype === "password_reset");
  const isShipping = input.primaryType === "transactional" && input.subtype === "shipping";

  let base = isOtpLike ? 15 : basePoints(input.primaryType, input.subtype);
  reasons.push(`type:${input.subtype ?? input.primaryType}`);

  if (
    positiveAllowed &&
    prior?.readRate60d !== null &&
    prior?.readRate60d !== undefined &&
    prior.readRate60d > 0
  ) {
    const pts = Math.round(clamp(prior.readRate60d, 0, 1) * 25);
    if (pts > 0) {
      base += pts;
      reasons.push("engaged_sender");
    }
  }
  if (positiveAllowed && labels.has("IMPORTANT")) {
    base += 15;
    reasons.push("gmail_important");
  }
  if (positiveAllowed && labels.has("STARRED")) {
    base += 30;
    reasons.push("starred");
  }
  if (
    prior &&
    prior.readRate60d === 0 &&
    prior.emailsPerWeek !== null &&
    prior.emailsPerWeek >= HIGH_FREQUENCY_PER_WEEK
  ) {
    base -= 20;
    reasons.push("never_opened_sender");
  }
  const bias = clamp(Math.round(prior?.userImportanceBias ?? 0), -2, 2);
  if (bias !== 0 && (bias < 0 || positiveAllowed)) {
    base += bias * 15;
    reasons.push(`user_bias:${bias > 0 ? "+" : ""}${bias}`);
  }

  // Guardrail (§7.3): LLM-sourced security / payment_failed labels need DMARC pass to go high.
  // A per-template cached label ("template_cache") is Claude's answer too, reused for later mail,
  // and a sender-prior label is a majority vote over the sender's stored labels, which include
  // those Claude and template-cache labels. Only a confident rule or the user's own override is
  // trusted without DMARC pass.
  let cap = 100;
  const llmSensitive =
    (input.typeSource === "llm" ||
      input.typeSource === "template_cache" ||
      input.typeSource === "sender_prior") &&
    (input.primaryType === "account_security" ||
      (input.primaryType === "transactional" && input.subtype === "payment_failed"));
  if (llmSensitive && input.authResult !== "pass") {
    cap = NORMAL_CAP;
    reasons.push("guardrail:dmarc_required");
  }
  // Suspicious mail isn't boosted and never ranks "high"; it goes to the Suspicious view (§7.8).
  if (input.suspicious) {
    cap = Math.min(cap, NORMAL_CAP);
    reasons.push("suspicious");
  }

  // Time-bound boosts active at `now`.
  const boosts: Boost[] = [];
  let nextStart: number | null = null;
  if (isOtpLike && now < received + OTP_FRESH_MS) {
    boosts.push({ code: "otp_fresh", points: 45, expiresAt: received + OTP_FRESH_MS });
  }
  if (isShipping && now < received + SHIPPING_RECENT_MS) {
    boosts.push({ code: "shipping_recent", points: 15, expiresAt: received + SHIPPING_RECENT_MS });
  }
  const engaged =
    prior !== null &&
    ((prior.readRate60d ?? 0) >= ENGAGED_READ_RATE || (prior.userImportanceBias ?? 0) > 0);
  if (positiveAllowed && engaged) {
    const dealEnds = input.deals
      .map((d) => d.endsAt?.getTime())
      .filter((t): t is number => t !== undefined && Number.isFinite(t) && t > now);
    const deadline = input.deadlineAt?.getTime();
    const candidates: Array<{ code: string; at: number }> = [];
    if (dealEnds.length > 0) candidates.push({ code: "deal_ending", at: Math.min(...dealEnds) });
    if (deadline !== undefined && Number.isFinite(deadline) && deadline > now)
      candidates.push({ code: "deadline", at: deadline });
    const soonest = candidates.sort((a, b) => a.at - b.at)[0];
    if (soonest) {
      if (soonest.at - now <= TIME_SENSITIVE_WINDOW_MS) {
        boosts.push({ code: soonest.code, points: 20, expiresAt: soonest.at });
      } else {
        // Not yet inside the 48 h window: ask for a re-score when it opens.
        nextStart = soonest.at - TIME_SENSITIVE_WINDOW_MS;
      }
    }
  }

  // Apply: base clamped, then boosts latest-expiring first, each recording its effective points.
  let score = clamp(base, 0, cap);
  boosts.sort((a, b) => b.expiresAt - a.expiresAt);
  let earliest: number | null = null;
  for (const b of boosts) {
    const next = clamp(score + b.points, 0, cap);
    const effective = next - score;
    score = next;
    const expSec = Math.floor(b.expiresAt / 1000);
    reasons.push(`boost:${b.code}:${effective}:${expSec}`);
    if (earliest === null || b.expiresAt < earliest) earliest = b.expiresAt;
  }
  const changeAt = [earliest, nextStart].filter((t): t is number => t !== null);
  const expiresAt = changeAt.length > 0 ? new Date(Math.min(...changeAt)) : null;
  score = Math.round(score);
  return { score, level: importanceLevel(score), reasons, expiresAt };
}

const BOOST_RE = /^boost:([a-z_]{1,40}):(-?\d{1,3}):(\d{1,12})$/;

/**
 * Effective importance at read time from the stored row (FREE-TIER.md §4.2): subtracts the
 * points of lapsed boosts and drops their reasons. Malformed reasons are kept untouched.
 */
export function effectiveImportance(
  row: { score: number; reasons: string[] },
  now: Date,
): { score: number; level: Importance; reasons: string[] } {
  const nowSec = now.getTime() / 1000;
  let score = row.score;
  const reasons: string[] = [];
  for (const r of row.reasons) {
    const m = BOOST_RE.exec(r);
    if (m && Number(m[3]) <= nowSec) {
      score -= Number(m[2]);
      continue;
    }
    reasons.push(r);
  }
  score = clamp(Math.round(score), 0, 100);
  return { score, level: importanceLevel(score), reasons };
}
