/**
 * "How we judged this" — the gallery detail view's proof of a verdict (components/gallery/
 * verdict-evidence.tsx), worked out only from what is stored for the email: the score, band, caps
 * and issue chips, the saved signals (score_summary.signals, kept after compaction), the pillar
 * scores, the summary's explanation keys and — only while they are stored — a few check values
 * and the image loads. Client-safe, pure.
 *
 *  1. The verdict in one sentence, naming the rule that decided it with the measured value and the
 *     limit ("Bad: Gmail cuts this email off — it's 136 KB and Gmail's limit is 102 KB, so the
 *     unsubscribe link is hidden.").
 *  2. What Good needs: the score, a real headline, a main button that stands out, pictures for
 *     system mail, a large picture or a headline band (scored from methodology 2026.6), room for the
 *     text on a phone and no serious problem, each ticked or crossed with what was measured.
 *  3. The serious problems — one row per Problems option (lib/gallery.ts GALLERY_PROBLEMS), so a
 *     row fails exactly when the gallery's "Bad because" breakdown counts it — and how the email
 *     was classified, which the unsubscribe rule depends on.
 *  4. The score by area, with a note when the AI review's share is spread over the other areas.
 *  5. Notes on what couldn't be measured (pictures that didn't load and why, a template's score,
 *     low confidence, an older or compacted analysis).
 *
 * The rules themselves are lib/gallery.ts's (verdictOf, severeTriggers, galleryProblemsOf and
 * their constants): this file only explains them. `rule` names the one that decided the verdict,
 * and the tests assert it is always one verdictOf really used. Unknown facts are shown as unknown
 * ("not measured"), never guessed. Every number is rounded so it can never read as being on the
 * other side of the limit it is compared with (7.9% of a needed 8% reads "7%", not "8%").
 */
import { CAP_DISPLAY_ORDER, type CapId, type DesignBand, type PillarId } from "@edf/design/types";
import {
  colourName,
  CONFIDENCE_EPSILON,
  COVERAGE_CONFIDENCE_MIN,
  CTA_SALIENCE_MIN,
  currentSignals,
  GALLERY_PROBLEM_LABELS,
  GALLERY_PROBLEMS,
  galleryProblemsOf,
  GATE_BARS,
  GMAIL_CLIP_KB,
  GOOD_SCORE_MIN,
  GOOD_SOURCES,
  HEADLINE_RATIO_MIN,
  IMAGE_TEXT_CHARS_MAX,
  IMAGE_TEXT_SHARE_MIN,
  IMAGERY_SHARE_MIN,
  IMAGES_UNKNOWN_SHARE_MAX,
  ISSUE_CAP,
  LEGACY_TINY_PHONE_TEXT_PX,
  lowCoverageProvisional,
  pctBelow,
  PHONE_PROBLEM_SHARE,
  POOR_SCORE_MAX,
  picturesUnknown,
  PROBLEM_CAP,
  PROBLEM_TRIGGERS,
  severeTriggers,
  SHRINK_K_MAX,
  TINY_PHONE_TEXT_PX,
  TOO_BIG_REASONS,
  UNSUBSCRIBE_REQUIRED_TYPE,
  verdictOf,
  type GalleryProblem,
  type GateBar as CardGateBar,
  type SevereTrigger,
  type Verdict,
} from "./gallery";

// ───────────────────────── input ─────────────────────────

/** One stored check result, reduced to what the panel quotes (email_analysis.checks). */
export interface EvidenceCheck {
  status: string;
  value: unknown;
}

/** One content image's load (features.render.images.loads), while features are stored. */
export interface EvidenceImageLoad {
  status?: unknown;
  decoded?: unknown;
  reason?: unknown;
}

/** One score area (email_analysis.pillar_scores, or score_summary.pillars after compaction). */
export interface EvidencePillar {
  id: string;
  points: number;
  max: number;
  /** The area's weight when every check counts (absent in score_summary.pillars). */
  nominal?: number | null;
}

/** Everything the panel reads (server/queries/gallery-evidence.ts builds it from one email). */
export interface EvidenceInput {
  score: number | null;
  band: DesignBand | null;
  capped: boolean | null;
  provisional: boolean | null;
  /** email_analysis.caps: every cap that fired, binding or not. */
  caps: readonly string[];
  /** email.design_issues. */
  issues: readonly string[];
  /** email.design_source. */
  source: string | null;
  /** email_analysis.confidence (design coverage, 0..1). */
  coverageConfidence: number | null;
  /** The verdict's signals (queries/gallery.ts GALLERY_SIGNALS). */
  signals: unknown;
  /**
   * email.primary_type: the email's type now, which the unsubscribe rule reads (as the gallery
   * does, VerdictInput.primaryType); null = not known, then the type the score used.
   */
  primaryType: string | null;
  /** The points before any cap or hold (score_summary.raw, else email_analysis.raw_score). */
  raw: number | null;
  /** score_summary.needsImprovement: its cap and gate items say what fired and why. */
  needs: ReadonlyArray<{ key: string; title: string }>;
  pillars: readonly EvidencePillar[];
  /** The AI review rated this email (true), it didn't (false), or unknown (null). */
  aiReviewed: boolean | null;
  /** A1, H3, H6, I3, M1, M3, M7, X1 by id, while the checks are stored (null once compacted). */
  checks: Readonly<Record<string, EvidenceCheck>> | null;
  /** The content images' loads, while the features are stored (null once compacted). */
  imageLoads: readonly EvidenceImageLoad[] | null;
  /**
   * The stored render and HTML pass back up "no main button" (lib/gallery.ts noButtonBackedUp, the
   * card's own test): false when a link painted as a button or a button-sized link suggests one the
   * render missed; null or absent when they aren't stored.
   */
  noButtonBacked?: boolean | null;
  /** The detailed features were cleared (compaction): only the saved summary is left. */
  compacted: boolean;
}

// ───────────────────────── output ─────────────────────────

/**
 * pass / fail: ticked or crossed. neutral: doesn't apply here, or counted in another row.
 * unknown: not measured (shown as such, never guessed).
 */
export type EvidenceState = "pass" | "fail" | "neutral" | "unknown";

export interface EvidenceRow {
  id: string;
  /** What is checked, as a short plain statement ("A real headline, at least 1.5× the text"). */
  label: string;
  state: EvidenceState;
  /** What was measured, in plain words ("Headline 28 px, text 16 px (1.8×)"); null = not measured. */
  value: string | null;
  /** The limit it was held to ("Bad under 60"); null when the label says it. */
  limit: string | null;
}

/** The rule that decided the verdict (verdictOf's own inputs; see VERDICT POLICY). */
export type DecidingRule =
  /** Bad: a cap fired (email_analysis.caps, or an issue chip standing for one). */
  | { kind: "cap"; cap: CapId }
  /** Bad: the engine capped the score, without saying which cap. */
  | { kind: "capped" }
  /** Bad: a severe problem the signals show (severeTriggers). */
  | { kind: "severe"; trigger: SevereTrigger }
  /** Bad: a score under 60. */
  | { kind: "low_score" }
  /** Good: 85+, no serious problem, a real render, enough evidence. */
  | { kind: "good" }
  /** Okay: under 85 because the Excellent gate held it at 84 for this failed Good check. */
  | { kind: "gate"; bar: GateBar }
  /** Okay: a score under 85. */
  | { kind: "score" }
  /** Okay: 85+, but provisional for thin design evidence. */
  | { kind: "coverage" }
  /** Okay: 85+, but not measured from a real render. */
  | { kind: "source" };

export interface VerdictEvidence {
  verdict: Exclude<Verdict, "unscored">;
  rule: DecidingRule;
  /** "Bad: …", "Okay: …" or "Good: …" — the deciding rule with its value and limit. */
  sentence: string;
  /** What Good needs, in order. */
  good: EvidenceRow[];
  /** The serious problems, one per Problems option (ids are GalleryProblem ids). */
  serious: EvidenceRow[];
  /**
   * The rows the sentence itself states with value and limit (the deciding rule's): what the
   * problem list may leave out while the checks are folded.
   */
  stated: string[];
  /** How the email was classified and why it matters ("Treated as a marketing email. …"). */
  treatedAs: string | null;
  /** The score by area; null when no area scores are stored. */
  areas: { rows: AreaRow[]; notes: string[] } | null;
  /** What couldn't be measured, and why. */
  notes: string[];
}

export interface AreaRow {
  id: string;
  label: string;
  points: number;
  max: number;
}

// ───────────────────────── constants ─────────────────────────

/**
 * The Excellent gate's bars (signals.gate), in the order the card names them (lib/gallery.ts
 * GATE_BARS); "plain" is the v1.3 rule's single miss.
 */
export type GateBar = CardGateBar | "plain";
const GATE_ORDER: readonly GateBar[] = [...GATE_BARS, "plain"];
/** The score an email that misses the Excellent gate is held at (@edf/design EXCELLENCE_CEILING). */
export const GATE_CEILING = GOOD_SCORE_MIN - 1;
/** The engine's explanation item for the Excellent gate: present exactly when it held the score. */
const GATE_KEY = "gate:excellence";
/**
 * Types that carry their own imagery, so the Excellent gate's picture bar (G3) doesn't apply
 * (@edf/design excellence.ts IMAGERY_EXEMPT; the tests assert they agree).
 */
export const IMAGERY_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  "promotional",
  "product_update",
  "event",
]);
/**
 * Faint main text caps the score when more than this share of it fails (@edf/design
 * CONTRAST_CAP_SHARE; the tests assert they agree).
 */
export const CONTRAST_CAP_SHARE = 0.4;
/** The AI review's checks (@edf/design AI_CHECK_IDS): their share is spread over the rest without it. */
export const AI_CHECKS = ["H7", "L8", "C4", "I6"] as const;

/** The serious-problem rows in the order they're listed (any Problems option not named here last). */
const SERIOUS_ORDER: readonly string[] = [
  "clipped",
  "image_only",
  "mobile",
  "no_unsubscribe",
  "contrast",
  "broken_images",
  "merge_tag",
  "low_score",
];

/** Plain names for the score areas (the engine's labels say "CTA", "Technical Health"). */
export const AREA_LABELS: Record<PillarId, string> = {
  accessibility: "Easy for everyone to read",
  mobile: "Works on phones",
  typography: "Text and fonts",
  hierarchy: "Headline and main button",
  images: "Pictures",
  layout: "Layout and colours",
  content: "Subject and wording",
  technical: "Works in every email app",
  footer: "Unsubscribe and footer",
};

/** "Treated as …": the email types in plain words, with their article. */
const TYPE_NAMES: Record<string, string> = {
  promotional: "a marketing email",
  newsletter: "a newsletter",
  product_update: "a product update",
  lifecycle: "a welcome or follow-up email",
  transactional: "an order or receipt email",
  account_security: "a security email",
  account_notice: "an account email",
  notification: "an app notification",
  event: "an event email",
  social: "a social update",
  community: "a community update",
  survey: "a survey",
  other: "other mail",
};

// ───────────────────────── reading the input ─────────────────────────

type Value = Record<string, unknown>;

function obj(x: unknown): Value | null {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Value) : null;
}
function num(v: Value | null | undefined, key: string): number | null {
  const x = v?.[key];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function str(v: Value | null | undefined, key: string): string | null {
  const x = v?.[key];
  return typeof x === "string" && x.trim() !== "" ? x : null;
}
function bool(v: Value | null | undefined, key: string): boolean | null {
  const x = v?.[key];
  return typeof x === "boolean" ? x : null;
}

/** A stored check's value, only when the check was evaluated (pass / partial / fail). */
function checkValue(input: EvidenceInput, id: string): Value | null {
  const c = input.checks?.[id];
  if (!c || !["pass", "partial", "fail"].includes(c.status)) return null;
  return obj(c.value);
}

/** The caps that fired, from the caps list and the issue chips, in the order the card names them. */
function capsOf(input: EvidenceInput): CapId[] {
  const fired = new Set<string>(input.caps);
  // lib/gallery.ts's own map, so the panel names the cap the card does.
  const issueCap = ISSUE_CAP as Readonly<Record<string, CapId | undefined>>;
  for (const i of input.issues) {
    const cap = issueCap[i];
    if (cap) fired.add(cap);
  }
  return CAP_DISPLAY_ORDER.filter((c) => fired.has(c));
}

/** The engine's explanation title for `key` ("cap:CAP_CLIPPED"), or "". */
function needTitle(input: EvidenceInput, key: string): string {
  return input.needs.find((n) => n.key === key)?.title ?? "";
}

/** verdictOf's 'provisional for thin design evidence' (lib/gallery.ts's own rule). */
const lowCoverage = (input: EvidenceInput) => lowCoverageProvisional(input);
function sourceOk(input: EvidenceInput): boolean {
  return typeof input.source === "string" && GOOD_SOURCES.includes(input.source);
}

/** The Excellent gate's failed bars (signals.gate), or null when it wasn't evaluated. */
function gateBars(signals: unknown): GateBar[] | null {
  const g = obj(signals)?.gate;
  if (!Array.isArray(g)) return null;
  return GATE_ORDER.filter((b) => g.includes(b));
}

/**
 * The gate held the score at 84: its explanation item is listed (the engine lists it exactly when it
 * binds), or — for summaries cut to their top items — the score is 84, a bar failed and the points
 * add up to more.
 */
function gateHeld(input: EvidenceInput, bars: GateBar[] | null): boolean {
  if (input.score !== GATE_CEILING) return false;
  if (input.needs.some((n) => n.key === GATE_KEY)) return true;
  return (
    bars !== null &&
    bars.length > 0 &&
    input.raw !== null &&
    Math.round(input.raw) > GATE_CEILING &&
    capsOf(input).length === 0
  );
}

/**
 * The email's type now (email.primary_type — what its category chip shows and the unsubscribe rule
 * reads), else the type the score used (signals.primaryType).
 */
function typeOf(input: EvidenceInput): string | null {
  return input.primaryType ?? str(obj(input.signals), "primaryType");
}

// ───────────────────────── formatting ─────────────────────────

/** x with float noise removed (0.29 × 100 = 28.999999999999996 → 29). */
const clean = (x: number) => Math.round(x * 1e6) / 1e6;
const floorTo = (x: number, d: number) => Math.floor(clean(x * 10 ** d)) / 10 ** d;
const ceilTo = (x: number, d: number) => Math.ceil(clean(x * 10 ** d)) / 10 ** d;
// Rounded as lib/gallery.ts rounds the same facts (Math.round on the plain product), so both agree.
const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * `x` rounded to `d` decimals, but never onto the other side of `bar`: the side is decided by `on`
 * ("ge": x ≥ bar counts, "gt": x > bar counts), so a value that misses (or passes) the bar always
 * reads as missing (or passing) it.
 */
function nearBar(x: number, bar: number, on: "ge" | "gt", d = 0): number {
  const r = roundTo(x, d);
  if (on === "ge") {
    if (x < bar && r >= bar) return floorTo(x, d);
    if (x >= bar && r < bar) return ceilTo(x, d);
  } else {
    if (x > bar && r <= bar) return ceilTo(x, d);
    if (x <= bar && r > bar) return floorTo(x, d);
  }
  return r;
}

/** A share as a whole percent, kept on its side of `bar` ("ge": the bar is ≥, "gt": >). */
function pct(share: number, bar: number, on: "ge" | "gt" = "ge"): string {
  const p = share * 100;
  if (p > 0 && p < 1 && bar * 100 >= 1) return "under 1%";
  return `${nearBar(p, bar * 100, on)}%`;
}

/**
 * How much of the email is pictures, worded as the card words the same share and kept on its side
 * of both limits it is held to: under Good's 8% floored as lib/gallery.ts pctBelow does ("7%",
 * "under 1%"), under half never "50%", half or more never "49%".
 */
const picturesPct = (share: number) =>
  share < IMAGERY_SHARE_MIN ? pctBelow(share) : pct(share, IMAGE_TEXT_SHARE_MIN);

/** "16", "12.4" (one decimal at most). */
const decimal = (x: number) => String(roundTo(x, 1));
/** Text size on a phone, kept on its side of the 12.5 px limit. */
const px = (x: number, bar = TINY_PHONE_TEXT_PX) => `${nearBar(x, bar, "ge", 1)} px`;
/** "1,229". */
const count = (x: number) => Math.round(x).toLocaleString("en-US");
/** Contrast ratio, floored to one decimal (4.49 must never read as 4.5). */
const ratioText = (r: number) => `${floorTo(r, 1)}:1`;
/** A headline ratio as the gallery's own lines word it: floored when short of 1.5, else rounded. */
const times = (r: number) =>
  `${r + 1e-9 >= HEADLINE_RATIO_MIN ? decimal(r) : String(floorTo(r, 1))}×`;
/** HTML size in KB, worded as lib/gallery.ts clippedText does past the limit ("just over 102 KB"). */
function kbText(kb: number): string {
  if (kb > GMAIL_CLIP_KB && kb < GMAIL_CLIP_KB + 0.5) return `just over ${GMAIL_CLIP_KB} KB`;
  return `${nearBar(kb, GMAIL_CLIP_KB, "gt")} KB`;
}
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const cap1 = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** The main button's label from H3 ("“Apply now”"), ≤ 30 characters; null when not stored. */
function buttonLabel(input: EvidenceInput): string | null {
  const raw = str(checkValue(input, "H3"), "label");
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  return `“${t.length > 30 ? `${t.slice(0, 29).trimEnd()}…` : t}”`;
}

// ───────────────────────── the facts, worded ─────────────────────────

interface Facts {
  input: EvidenceInput;
  sig: Value | null;
  current: boolean;
  caps: CapId[];
  triggers: SevereTrigger[];
  problems: GalleryProblem[];
  bars: GateBar[] | null;
  held: boolean;
  type: string | null;
}

/** The Gmail cut: the size and what the cut hides (the same facts as lib/gallery.ts clippedText). */
function clipFacts(f: Facts): { kb: number | null; hides: string[] } {
  const x1 = checkValue(f.input, "X1");
  const bytes = num(x1, "bytes");
  const kb = num(f.sig, "htmlKB") ?? (bytes !== null ? roundTo(bytes / 1000, 1) : null);
  const capTitle = needTitle(f.input, "cap:CAP_CLIPPED");
  const hides: string[] = [];
  if (/before the (?:main )?button/i.test(capTitle)) hides.push("the main button");
  if (str(f.sig, "unsubscribeUnion") === "after_clip") hides.push("the unsubscribe link");
  const after = num(x1, "afterShare");
  if (hides.length === 0 && f.caps.includes("CAP_CLIPPED") && after !== null && after > 0.25)
    hides.push(`${pct(after, 0.25, "gt")} of the text`);
  return { kb, hides };
}

/**
 * Pictures that didn't load cover most of the picture area (imagesUnknownShare over half), worded
 * from the loads so it never contradicts the note's count ("2 of its 20 pictures didn't load"):
 * one of several is the biggest picture, most by count is "most of its pictures", else the area.
 */
function unloadedPictures(f: Facts): string {
  const loads = f.input.imageLoads;
  if (loads && loads.length > 0) {
    const missed = loads.filter((l) => l.decoded !== true).length;
    if (missed === loads.length)
      return loads.length === 1 ? "Its one picture didn't load" : "None of its pictures loaded";
    if (missed === 1) return "Its biggest picture didn't load";
    if (missed * 2 > loads.length) return "Most of its pictures didn't load";
  }
  return "Most of its picture area didn't load";
}

/** "they can't count" after "Most of its pictures didn't load", "its pictures can't count" else. */
const cantCount = (lead: string) =>
  /one picture/.test(lead)
    ? "it can't count"
    : /pictures/.test(lead)
      ? "they can't count"
      : "its pictures can't count";

/** Real text: I1's legible characters, else the render's (the same count outside the footer). */
function liveChars(f: Facts): number | null {
  return num(f.sig, "legibleChars") ?? num(f.sig, "liveTextChars");
}

/**
 * The headline as measured ("Headline 28 px, text 16 px (1.8×)", "Headline 1.1× the size of the
 * text", "No headline"), or null when not measured.
 */
function headlineValue(f: Facts): string | null {
  const h6 = checkValue(f.input, "H6");
  const has = bool(f.sig, "hasHeadline") ?? bool(h6, "headline");
  const ratio = num(f.sig, "headlineRatio") ?? num(h6, "ratio");
  if (has === false) {
    const pictures = (num(f.sig, "htmlContentImages") ?? 0) > 0 || bool(h6, "pictures") === true;
    return pictures ? "No headline in real text (it may be in a picture)" : "No headline";
  }
  if (ratio === null) return null;
  const big = num(h6, "largestPx");
  const body = num(h6, "medianPx");
  // The sizes are quoted only when they are the ratio's own (H6 measures the first screen).
  if (big !== null && body !== null && body > 0 && Math.abs(big / body - ratio) < 0.01)
    return `Headline ${decimal(big)} px, text ${decimal(body)} px (${times(ratio)})`;
  return `Headline ${times(ratio)} the size of the text`;
}

/** Why the headline bar failed, as the end of "not Good because …". */
function headlineMiss(f: Facts): string {
  const h6 = checkValue(f.input, "H6");
  const has = bool(f.sig, "hasHeadline") ?? bool(h6, "headline");
  const ratio = num(f.sig, "headlineRatio") ?? num(h6, "ratio");
  const need = `Good needs one at least ${HEADLINE_RATIO_MIN}× the text`;
  if (has === false) {
    const pictures = (num(f.sig, "htmlContentImages") ?? 0) > 0 || bool(h6, "pictures") === true;
    return pictures
      ? `there's no headline in real text — it may be in a picture (${need})`
      : `there's no headline (${need})`;
  }
  if (ratio === null) return `there's no clear headline (${need})`;
  return ratio < 1.25
    ? `the headline is barely bigger than the text (${times(ratio)}; Good needs ${HEADLINE_RATIO_MIN}×)`
    : `the headline is only ${times(ratio)} the size of the text (Good needs ${HEADLINE_RATIO_MIN}×)`;
}

/** The main button as measured (no "salience": what a reader sees). */
function buttonFacts(f: Facts): { value: string | null; miss: string } {
  const salience = num(f.sig, "ctaSalience");
  const top = bool(f.sig, "ctaMostProminent");
  const first = bool(f.sig, "ctaFirstScreen");
  const label = buttonLabel(f.input);
  const named = `the main button${label ? ` ${label}` : ""}`;
  if (salience === null) {
    const has = obj(f.sig) && Object.prototype.hasOwnProperty.call(f.sig, "ctaSalience");
    // What we measured, not a fact about the email: the render misses some real buttons. When a
    // link painted as a button or a button-sized link says it may have (the card then doesn't
    // claim "no main button" at all), say so.
    if (missedButton(f))
      return {
        value: has ? "No main button found, though we may have missed one" : null,
        miss: "we found no main button, though we may have missed one (Good needs one that stands out)",
      };
    return {
      value: has ? "No main button found" : null,
      miss: "we found no main button (Good needs one that stands out)",
    };
  }
  if (salience < CTA_SALIENCE_MIN)
    return {
      value: `${cap1(named)}: its colour is too close to the background`,
      miss: `${named} doesn't stand out — its colour is too close to the background`,
    };
  // G2 (methodology 2026.6): three or more buttons in one look for three or more different
  // actions — none of them is the main one, however prominent.
  if (bool(f.sig, "ctaCompeting") === true)
    return {
      value: "Several buttons look the same and lead to different actions, so none is the main one",
      miss: "several buttons look the same and lead to different actions, so none is the main one (Good needs one that stands out)",
    };
  // "Most prominent" allows a tie (three identical pills): no other link is bigger, which is
  // all it says — never "the most eye-catching" of buttons that look the same.
  if (top === true)
    return {
      value: `${cap1(named)}: a bold colour, and no other link or picture is bigger`,
      miss: "",
    };
  if (first === true)
    return { value: `${cap1(named)}: a bold colour, on the first phone screen`, miss: "" };
  // Filled, but it doesn't lead: not the most prominent link and not up top (G2's other half). The
  // bigger link can be anywhere in the email, above or below it.
  const low = first === false;
  const outweighed = top === false;
  const why =
    low && outweighed
      ? "sits below the first phone screen, and another link or picture is bigger"
      : low
        ? "sits below the first phone screen"
        : "is smaller than another link or picture in the email";
  return {
    value: `${cap1(named)}: a bold colour, but it ${why}`,
    miss: `${named} ${why}`,
  };
}

/** No main button was measured, but the stored render or HTML suggests one it missed. */
function missedButton(f: Facts): boolean {
  return num(f.sig, "ctaSalience") === null && f.input.noButtonBacked === false;
}

/** Share of the text squeezed into narrow columns / at the screen edge on a phone (M3 / M7). */
function phoneShares(f: Facts): { narrow: number | null; edge: number | null } {
  const wide = num(checkValue(f.input, "M3"), "wideShare");
  const ok = num(checkValue(f.input, "M7"), "okShare");
  return { narrow: wide === null ? null : 1 - wide, edge: ok === null ? null : 1 - ok };
}

/** The Good checklist rows each gate bar is shown in (see barRows for imagery_unknown). */
const BAR_ROWS: Record<GateBar, readonly string[]> = {
  headline: ["headline"],
  button: ["button"],
  imagery: ["imagery"],
  imagery_unknown: ["imagery"],
  hero: ["hero"],
  phone_narrow: ["phone"],
  phone_edge: ["phone"],
  plain: ["headline", "button"],
};

/**
 * G3 (pictures on 8% of it) applies: the type the score used isn't exempt — or, that type unknown,
 * the saved bars say G3 ran. Otherwise an `imagery_unknown` miss is G4's (a picture that didn't
 * load could have been the large picture) and is shown in the hero row.
 */
function picturesBarApplies(f: Facts): boolean {
  const type = str(f.sig, "primaryType") ?? f.type;
  if (type !== null) return !IMAGERY_EXEMPT_TYPES.has(type);
  return !!f.bars?.includes("imagery") || (!!f.bars?.includes("imagery_unknown") && !heroJudged(f));
}

/** G4 (a large picture or a headline band, methodology 2026.6) was judged: its facts are saved. */
function heroJudged(f: Facts): boolean {
  return (
    f.bars !== null &&
    (bool(f.sig, "heroPicture") !== null ||
      bool(f.sig, "heroBand") !== null ||
      f.bars.includes("hero"))
  );
}

/**
 * Whose miss `imagery_unknown` is: the picture bar's (G3: most of the picture area wasn't drawn,
 * so its 8% can't be judged) when that bar applies and most of the area wasn't drawn — or G4
 * wasn't judged at all; else G4's (a picture that didn't load could have been the large one).
 */
function unknownIsPictures(f: Facts): boolean {
  if (!picturesBarApplies(f)) return false;
  // G3 missed on its own count ("few pictures"): the unknown miss is G4's.
  if (f.bars?.includes("imagery")) return false;
  if (!heroJudged(f)) return true;
  return (num(f.sig, "imagesUnknownShare") ?? 0) > IMAGES_UNKNOWN_SHARE_MAX + 1e-9;
}

/** The Good checklist rows a gate bar is shown in. */
function barRows(f: Facts, bar: GateBar): readonly string[] {
  return bar === "imagery_unknown" && !unknownIsPictures(f) ? ["hero"] : BAR_ROWS[bar];
}

/** One failed Good check, as the end of "Okay: … not Good because …". */
function barMiss(f: Facts, bar: GateBar): string {
  switch (bar) {
    case "headline":
      return headlineMiss(f);
    case "button":
      return buttonFacts(f).miss || "the main button doesn't stand out";
    case "imagery": {
      const share = num(f.sig, "imgShare");
      const shown = share !== null ? picturesPct(share) : null;
      return shown !== null
        ? `pictures cover ${shown.startsWith("under") ? shown : `only ${shown}`} of it (Good needs ${pct(IMAGERY_SHARE_MIN, IMAGERY_SHARE_MIN)} for this kind of email)`
        : `it has few pictures (Good needs ${pct(IMAGERY_SHARE_MIN, IMAGERY_SHARE_MIN)} for this kind of email)`;
    }
    case "imagery_unknown":
      // G4's: the missing picture could have been the large one.
      return unknownIsPictures(f)
        ? `${lowerFirst(unloadedPictures(f))}, so ${cantCount(unloadedPictures(f))} toward Good`
        : `${lowerFirst(unloadedPictures(f))}, so we can't tell if it has a large picture (Good needs one, or a headline on a coloured band)`;
    case "hero":
      return "there's no large picture and no headline on a coloured band (Good needs one of the two)";
    case "phone_narrow":
    case "phone_edge": {
      const shares = phoneShares(f);
      const share = bar === "phone_narrow" ? shares.narrow : shares.edge;
      const what =
        bar === "phone_narrow"
          ? "is squeezed into narrow columns"
          : "runs right to the screen edge";
      return share !== null
        ? `on a phone, ${pct(share, PHONE_PROBLEM_SHARE)} of the text ${what} (Good needs under ${pct(PHONE_PROBLEM_SHARE, PHONE_PROBLEM_SHARE)})`
        : `on a phone, half or more of the text ${what} (Good needs under half)`;
    }
    case "plain":
      return "nothing stands out: no big headline and no main button that stands out";
  }
}

// ───────────────────────── the verdict sentence ─────────────────────────

/**
 * The rows the verdict sentence states (the deciding rule's): a cap's or severe problem's Problems
 * option (lib/gallery.ts's own maps), the low score, or the Good checks of the bar that held it.
 */
function statedRows(f: Facts, rule: DecidingRule): string[] {
  switch (rule.kind) {
    case "cap":
      return GALLERY_PROBLEMS.filter((p) => PROBLEM_CAP[p] === rule.cap);
    case "severe":
      return GALLERY_PROBLEMS.filter((p) => PROBLEM_TRIGGERS[p]?.includes(rule.trigger));
    case "low_score":
      return ["low_score"];
    case "gate":
      return [...barRows(f, rule.bar)];
    default:
      return [];
  }
}

/** The rule verdictOf used (see VERDICT POLICY), in the order the card names it. */
function decidingRule(f: Facts, verdict: Exclude<Verdict, "unscored">): DecidingRule {
  const { input } = f;
  if (verdict === "bad") {
    if (f.caps[0]) return { kind: "cap", cap: f.caps[0] };
    if (f.triggers[0]) return { kind: "severe", trigger: f.triggers[0] };
    if (input.score! < POOR_SCORE_MAX || input.band === "poor") return { kind: "low_score" };
    return { kind: "capped" };
  }
  if (verdict === "good") return { kind: "good" };
  if (input.score! >= GOOD_SCORE_MIN) {
    // Only these keep an 85+ from Good once nothing is serious (verdictOf).
    return sourceOk(input) ? { kind: "coverage" } : { kind: "source" };
  }
  if (f.held) {
    // The failed bars when saved; an older summary only has the v1.3 rule's "plain design" item.
    // The card's order, except a "no main button" we may have got wrong: like the card, lead
    // with any other bar that held it.
    const bar =
      f.bars !== null
        ? (f.bars.find((b) => !(b === "button" && missedButton(f))) ?? f.bars[0])
        : /plain|nothing stands out/i.test(needTitle(input, GATE_KEY))
          ? "plain"
          : undefined;
    if (bar) return { kind: "gate", bar };
  }
  return { kind: "score" };
}

/** The deciding cap or severe problem in one clause: what's wrong, measured, against its limit. */
function badClause(f: Facts, rule: DecidingRule): string {
  const { input } = f;
  const score = input.score!;
  switch (rule.kind) {
    case "cap":
      switch (rule.cap) {
        case "CAP_IMAGE_ONLY":
          return picturesClause(f, false);
        case "CAP_CONTRAST": {
          const { share, pair } = faintMain(f);
          if (share !== null)
            return `the main text is too faint to read — ${share} of it is${pair ? ` ${pair}` : " too faint"}, and Bad is over ${pct(CONTRAST_CAP_SHARE, CONTRAST_CAP_SHARE)}`;
          return "the main text is too faint to read against its background";
        }
        case "CAP_MERGE_TAG": {
          const tag = /“([^”]{1,60})”/.exec(needTitle(input, "cap:CAP_MERGE_TAG"))?.[1];
          return tag
            ? `it shows placeholder code instead of real text — “${tag}”`
            : "it shows placeholder code instead of real text";
        }
        case "CAP_MOBILE_BROKEN":
          return `it doesn't work on phones — ${mobileBrokenFact(f)}`;
        case "CAP_CLIPPED":
          return clippedClause(f);
        case "CAP_BROKEN_IMAGES": {
          const i3 = checkValue(input, "I3");
          const failed = num(i3, "failed");
          const evaluated = num(i3, "evaluated");
          return failed !== null && evaluated !== null && evaluated > 0
            ? `most of its pictures are broken — ${failed} of ${evaluated} don't load because the sender's links are dead`
            : "most of its pictures are broken links that don't load";
        }
      }
      break;
    case "severe":
      switch (rule.trigger) {
        case "pictures_not_loaded":
          return picturesClause(f, true);
        case "text_in_images":
          return picturesClause(f, false);
        case "tiny_phone_text": {
          const k = num(f.sig, "layoutK");
          const t = num(f.sig, "phoneTextPx");
          const limit = f.current
            ? `Bad is under ${pct(SHRINK_K_MAX, SHRINK_K_MAX)} and under ${TINY_PHONE_TEXT_PX} px`
            : `Bad is any shrinking with text under ${LEGACY_TINY_PHONE_TEXT_PX} px`;
          return k !== null && t !== null
            ? `it doesn't fit phones — the layout shrinks to ${pct(k, f.current ? SHRINK_K_MAX : 0.99)}, so the text is about ${px(t, f.current ? TINY_PHONE_TEXT_PX : LEGACY_TINY_PHONE_TEXT_PX)} (${limit})`
            : `it doesn't fit phones: the text shrinks too small to read (${limit})`;
        }
        case "unsubscribe_clipped":
          return clippedClause(f);
        case "no_unsubscribe":
          return f.current
            ? "there's no unsubscribe link anywhere, and marketing emails must have one"
            : "there's no unsubscribe link anywhere, and subscription emails must have one";
      }
      break;
    case "low_score":
      return `lots of smaller problems add up to a low score — ${score} out of 100, and Bad is under ${POOR_SCORE_MAX}`;
    default:
      break;
  }
  return `a serious problem caps its score at ${score}`;
}

function picturesClause(f: Facts, notLoaded: boolean): string {
  const chars = notLoaded ? num(f.sig, "liveTextChars") : liveChars(f);
  const share = num(f.sig, "imgShare");
  const text =
    chars === null
      ? "very little real text"
      : chars === 0
        ? "no real text at all"
        : `only ${count(chars)} ${plural(Math.round(chars), "character", "characters")} of real text`;
  if (notLoaded) {
    const n = num(f.sig, "htmlContentImages");
    const which =
      n === 1 ? "its one picture" : n !== null ? `none of its ${n} pictures` : "its pictures";
    // Too big for us to load (every stored reason is a size limit): the sender's picture is there.
    const missed = (f.input.imageLoads ?? []).filter((l) => l.decoded !== true);
    const tooBig =
      missed.length > 0 &&
      missed.every((l) => typeof l.reason === "string" && TOO_BIG_REASONS.has(l.reason));
    if (tooBig)
      return `this email is just pictures, and ${n === 1 ? "its one picture is" : "they are"} too big for us to load, leaving ${text} (under ${IMAGE_TEXT_CHARS_MAX} characters is too little)`;
    return `this email is just pictures, and they didn't load — ${which} ${n === 1 ? "didn't show" : "showed"}, leaving ${text} (under ${IMAGE_TEXT_CHARS_MAX} characters is too little)`;
  }
  return share !== null
    ? `most of this email is pictures — they cover ${picturesPct(share)} of it, with ${text} (Bad is half or more pictures with under ${IMAGE_TEXT_CHARS_MAX} characters)`
    : `most of this email is pictures, with ${text} (Bad is under ${IMAGE_TEXT_CHARS_MAX} characters)`;
}

function clippedClause(f: Facts): string {
  const { kb, hides } = clipFacts(f);
  const size = kb !== null ? `it's ${kbText(kb)} and Gmail's limit is ${GMAIL_CLIP_KB} KB` : null;
  const hidden = hides.length
    ? `${hides.join(" and ")} ${hides.length === 1 && !/% of/.test(hides[0]!) ? "is" : "are"} hidden`
    : "readers see “[Message clipped]”";
  return size
    ? `Gmail cuts this email off — ${size}, so ${hidden}`
    : `Gmail cuts this email off, so ${hidden}`;
}

/**
 * How much of the main text is too faint, and its colours. The contrast cap's own title wins when
 * it fired ("43% of the main text is grey on white (3.15:1)": the engine rounds the exact share, the
 * stored 0.435 can't tell 43.49% from 43.5%), so this never disagrees with the full analysis.
 */
function faintMain(f: Facts): { share: string | null; pair: string | null; none: boolean } {
  const a1 = checkValue(f.input, "A1");
  const stored = num(a1, "mainFailShare");
  const title = needTitle(f.input, "cap:CAP_CONTRAST");
  const m = /^(\d+)% of the main text is ([a-z ]+ on [a-z ]+) \((\d+(?:\.\d+)?):1\)/i.exec(title);
  if (m) return { share: `${m[1]}%`, pair: `${m[2]} (${ratioText(Number(m[3]))})`, none: false };
  if (stored === null) return { share: null, pair: null, none: false };
  return {
    share: stored === 0 ? null : pct(stored, CONTRAST_CAP_SHARE, "gt"),
    pair: mainPair(a1),
    none: stored === 0,
  };
}

/** The faint main text's colours, when the faintest run is main text ("grey on white (3.1:1)"). */
function mainPair(a1: Value | null): string | null {
  const w = obj(a1?.worst);
  if (!w || w.fine === true || !["body", "heading"].includes(String(w.role))) return null;
  const fg = typeof w.fg === "string" ? colourName(w.fg) : null;
  const bg = typeof w.bg === "string" ? colourName(w.bg) : null;
  const ratio = num(w, "ratio");
  if (!fg || !bg) return null;
  return `${fg} on ${bg}${ratio !== null ? ` (${ratioText(ratio)})` : ""}`;
}

/** What makes a phone layout genuinely broken (the cap's own reason, from its title or M1). */
function mobileBrokenFact(f: Facts): string {
  const title = needTitle(f.input, "cap:CAP_MOBILE_BROKEN");
  if (/scroll/i.test(title)) return "it's so wide that readers have to scroll sideways";
  const button = /main button to ~(\d+(?:\.\d+)?) ?px/i.exec(title)?.[1];
  if (button)
    return `the main button shrinks to about ${Math.round(Number(button))} px, too small to tap`;
  const k = num(f.sig, "layoutK");
  const t = num(f.sig, "phoneTextPx");
  if (k !== null && t !== null)
    return `the layout shrinks to ${pct(k, 0.5)}, so the text is about ${px(t, 8)} (under 8 px can't be read)`;
  return "the text shrinks too small to read";
}

function sentenceOf(
  f: Facts,
  verdict: Exclude<Verdict, "unscored">,
  rule: DecidingRule,
  good: readonly EvidenceRow[],
): string {
  const { input } = f;
  const score = input.score!;
  // An older analysis without the Good checks' facts can't claim to have passed each of them.
  if (verdict === "good")
    return good.every((r) => r.state === "pass")
      ? "Good: it passed every check below."
      : `Good: it scored ${score} and has no serious problems.`;
  if (verdict === "bad") {
    const more = f.problems.length - 1;
    const tail =
      more > 0 ? ` It has ${more} more serious ${plural(more, "problem", "problems")} below.` : "";
    return `Bad: ${badClause(f, rule)}.${tail}`;
  }
  const lead = "Okay: no serious problems, but not Good because";
  // The crossed Good checks below besides the score itself (and "no serious problem"), so the
  // count always matches the crosses a reader sees when unfolding them.
  const crossed = good.filter((r) => r.state === "fail" && r.id !== "score" && r.id !== "serious");
  const missed = crossed.length;
  switch (rule.kind) {
    case "gate": {
      const named = barRows(f, rule.bar);
      const more = crossed.filter((r) => !named.includes(r.id)).length;
      const extra =
        more > 0 ? ` It misses ${more} more Good ${plural(more, "check", "checks")} below.` : "";
      const points =
        input.raw !== null && Math.round(input.raw) > GATE_CEILING
          ? ` (its points add up to ${Math.round(input.raw)})`
          : "";
      return `${lead} ${barMiss(f, rule.bar)}.${extra} That holds its score at ${GATE_CEILING}${points}.`;
    }
    case "score": {
      const extra =
        missed > 0
          ? ` It also misses ${missed} Good ${plural(missed, "check", "checks")} below.`
          : "";
      return `${lead} it scored ${score} and Good needs ${GOOD_SCORE_MIN}.${extra}`;
    }
    case "coverage": {
      const c = input.coverageConfidence;
      const share =
        typeof c === "number" && Number.isFinite(c)
          ? ` (${pct(c, COVERAGE_CONFIDENCE_MIN)} of the checks could run; Good needs ${pct(COVERAGE_CONFIDENCE_MIN, COVERAGE_CONFIDENCE_MIN)})`
          : "";
      return `Okay: no serious problems and it scored ${score}, but not Good because we couldn't measure enough of it to be sure${share}.`;
    }
    case "source":
      return `Okay: no serious problems and it scored ${score}, but not Good because we only checked its code, not how it looks.`;
    default:
      return `${lead} it scored ${score} and Good needs ${GOOD_SCORE_MIN}.`;
  }
}

// ───────────────────────── what Good needs ─────────────────────────

function goodRows(f: Facts, verdict: Exclude<Verdict, "unscored">): EvidenceRow[] {
  const { input } = f;
  const score = input.score!;
  const rows: EvidenceRow[] = [];
  const bars = f.bars;
  // An older summary without the bars: only its "plain design" item says what held the score.
  const plain =
    bars === null && f.held && /plain|nothing stands out/i.test(needTitle(input, GATE_KEY));
  const barState = (...ids: GateBar[]): EvidenceState =>
    bars === null
      ? plain && ids.includes("plain")
        ? "fail"
        : "unknown"
      : ids.some((b) => bars.includes(b))
        ? "fail"
        : "pass";
  const raw = input.raw !== null ? Math.round(input.raw) : null;

  // The score, and why it isn't its points' total when it was capped or held.
  let scoreValue = String(score);
  if (f.caps.length > 0 && raw !== null && raw > score)
    scoreValue = `${score}: capped by a serious problem (its points add up to ${raw})`;
  else if (f.held)
    scoreValue = `${score}: held there for the checks below${raw !== null && raw > score ? ` (its points add up to ${raw})` : ""}`;
  rows.push({
    id: "score",
    label: `A score of ${GOOD_SCORE_MIN} or more`,
    state: score >= GOOD_SCORE_MIN ? "pass" : "fail",
    value: scoreValue,
    limit: null,
  });

  const headlineState = aiStoodIn(f, "headline") ?? barState("headline", "plain");
  rows.push({
    id: "headline",
    label: `A real headline, at least ${HEADLINE_RATIO_MIN}× the text`,
    state: headlineState,
    value: aiStoodIn(f, "headline")
      ? "The AI review rated the design highly instead"
      : // The gate counts a headline it couldn't measure as missing: say so, not "not measured".
        (headlineValue(f) ?? (headlineState === "fail" ? "We couldn't find a headline" : null)),
    limit: null,
  });

  const button = buttonFacts(f);
  rows.push({
    id: "button",
    label: "A main button that stands out",
    state: aiStoodIn(f, "button") ?? barState("button", "plain"),
    value: aiStoodIn(f, "button") ? "The AI review rated the design highly instead" : button.value,
    limit: null,
  });

  // G3: system and plain mail only; not judged when we don't load pictures for the email.
  if (picturesBarApplies(f)) {
    const off = bool(f.sig, "imagesOff") === true;
    const share = num(f.sig, "imgShare");
    rows.push({
      id: "imagery",
      label: `Pictures on at least ${pct(IMAGERY_SHARE_MIN, IMAGERY_SHARE_MIN)} of it (for this kind of email)`,
      state: off
        ? "neutral"
        : (aiStoodIn(f, "imagery") ??
          (unknownIsPictures(f) ? barState("imagery", "imagery_unknown") : barState("imagery"))),
      value: off
        ? "Not checked: we don't load pictures for this kind of email"
        : bars?.includes("imagery_unknown") && unknownIsPictures(f)
          ? `${unloadedPictures(f)}, so ${cantCount(unloadedPictures(f))}`
          : share !== null
            ? `${cap1(picturesPct(share))} of the email is pictures`
            : null,
      limit: null,
    });
  }

  // G4 (methodology 2026.6), every type: a large picture or a headline on a coloured band.
  if (heroJudged(f)) rows.push(heroRow(f));

  const { narrow, edge } = phoneShares(f);
  const phoneValue =
    narrow !== null && edge !== null
      ? `${cap1(pct(narrow, PHONE_PROBLEM_SHARE))} of the text in narrow columns, ${pct(edge, PHONE_PROBLEM_SHARE)} at the screen edge`
      : narrow !== null
        ? `${cap1(pct(narrow, PHONE_PROBLEM_SHARE))} of the text in narrow columns`
        : edge !== null
          ? `${cap1(pct(edge, PHONE_PROBLEM_SHARE))} of the text at the screen edge`
          : null;
  rows.push({
    id: "phone",
    label: "Room for the text on a phone",
    state: barState("phone_narrow", "phone_edge"),
    value: phoneValue,
    limit: `Good needs under ${pct(PHONE_PROBLEM_SHARE, PHONE_PROBLEM_SHARE)} squeezed or at the edge`,
  });

  // Enough evidence: listed only when it keeps (or would keep) the email from Good.
  if (lowCoverage(input) || !sourceOk(input)) {
    const c = input.coverageConfidence;
    rows.push({
      id: "coverage",
      label: "Measured well enough to be sure",
      state: "fail",
      value: !sourceOk(input)
        ? "Only its code was checked, not how it looks"
        : typeof c === "number" && Number.isFinite(c)
          ? `${pct(c, COVERAGE_CONFIDENCE_MIN)} of the checks could run`
          : "Too few of the checks could run",
      limit: `Good needs ${pct(COVERAGE_CONFIDENCE_MIN, COVERAGE_CONFIDENCE_MIN)}`,
    });
  }

  const n = f.problems.length;
  const bad = verdict === "bad";
  rows.push({
    id: "serious",
    label: "No serious problem",
    state: bad ? "fail" : "pass",
    value: bad
      ? n > 0
        ? `${n} found (below)`
        : "Its score was capped by a serious problem"
      : "None found",
    limit: null,
  });
  return rows;
}

/** G4's row: what was found, or why it wasn't judged. Only when heroJudged. */
function heroRow(f: Facts): EvidenceRow {
  const bars = f.bars ?? [];
  const picture = bool(f.sig, "heroPicture") === true;
  const band = bool(f.sig, "heroBand") === true;
  const stood = aiStoodIn(f, "hero");
  const row = (state: EvidenceState, value: string | null): EvidenceRow => ({
    id: "hero",
    label: "A large picture or a headline on a coloured band",
    state,
    value,
    limit: null,
  });
  if (bool(f.sig, "imagesOff") === true)
    return row("neutral", "Not checked: we don't load pictures for this kind of email");
  if (stood) return row(stood, "The AI review rated the design highly instead");
  if (bars.includes("hero"))
    return row("fail", "Neither: no large picture, and no headline on a coloured band");
  if (picture || band)
    return row(
      "pass",
      picture && band
        ? "A large picture, and a headline on a coloured band"
        : picture
          ? "A large picture"
          : "A headline on a coloured band",
    );
  // A picture that didn't load could have been it: the miss is imagery_unknown — this row's when
  // it is G4's, else the picture bar's (and G4 is simply not known).
  if (bars.includes("imagery_unknown"))
    return unknownIsPictures(f)
      ? row("unknown", `${unloadedPictures(f)}, so we can't tell`)
      : row("fail", `${unloadedPictures(f)}, so we can't tell if it has one`);
  return row("unknown", null);
}

/**
 * An AI rating of 4+ stands in for G1–G4 (the gate then lists no miss for them): "pass" when the
 * measured value alone would have failed the bar, so the tick never sits next to a value that
 * contradicts it; null otherwise (the bar's own state stands).
 */
function aiStoodIn(
  f: Facts,
  bar: "headline" | "button" | "imagery" | "hero",
): EvidenceState | null {
  // Only G1–G4 can be stood in for: a bar the gate still lists failed on its own.
  const listed = bar === "imagery" || bar === "hero" ? [bar, "imagery_unknown"] : [bar];
  if (f.input.aiReviewed !== true || f.bars === null || f.bars.some((b) => listed.includes(b)))
    return null;
  const s = f.sig;
  let fails: boolean;
  if (bar === "headline") {
    const r = num(s, "headlineRatio");
    fails = bool(s, "hasHeadline") === false || r === null || r < HEADLINE_RATIO_MIN - 1e-9;
  } else if (bar === "button") {
    const sal = num(s, "ctaSalience");
    fails =
      sal === null ||
      sal < CTA_SALIENCE_MIN - 1e-9 ||
      bool(s, "ctaCompeting") === true ||
      (bool(s, "ctaMostProminent") !== true && bool(s, "ctaFirstScreen") !== true);
  } else if (bar === "hero") {
    fails = bool(s, "heroPicture") !== true && bool(s, "heroBand") !== true;
  } else {
    fails = (num(s, "imgShare") ?? 0) < IMAGERY_SHARE_MIN - 1e-9;
  }
  return fails ? "pass" : null;
}

// ───────────────────────── serious problems ─────────────────────────

function seriousRows(f: Facts): EvidenceRow[] {
  const ids = [
    ...SERIOUS_ORDER.filter((id) => (GALLERY_PROBLEMS as readonly string[]).includes(id)),
    ...GALLERY_PROBLEMS.filter((id) => !SERIOUS_ORDER.includes(id)),
  ] as GalleryProblem[];
  return ids.map((id) => seriousRow(f, id));
}

function seriousRow(f: Facts, id: GalleryProblem): EvidenceRow {
  const { input } = f;
  const failed = f.problems.includes(id);
  const row = (
    label: string,
    value: string | null,
    limit: string | null,
    state: EvidenceState = failed ? "fail" : value === null ? "unknown" : "pass",
  ): EvidenceRow => ({ id, label, state, value, limit });
  switch (id) {
    case "clipped": {
      const { kb, hides } = clipFacts(f);
      const limit = `Bad when Gmail's ${GMAIL_CLIP_KB} KB cut hides the main button, the unsubscribe link or over a quarter of the text`;
      if (kb === null)
        return row("Gmail doesn't cut off key parts", failed ? "Gmail cuts it off" : null, limit);
      if (failed)
        return row(
          "Gmail doesn't cut off key parts",
          `${kbText(kb)}: Gmail cuts it off${hides.length ? ` and hides ${hides.join(" and ")}` : ""}`,
          limit,
        );
      if (kb <= GMAIL_CLIP_KB)
        return row(
          "Gmail doesn't cut off key parts",
          `${kbText(kb)} of ${GMAIL_CLIP_KB} KB`,
          limit,
        );
      const after = num(checkValue(input, "X1"), "afterShare");
      return row(
        "Gmail doesn't cut off key parts",
        `${kbText(kb)}: Gmail cuts it off, but ${after !== null ? (after === 0 ? "none of the text is" : `only the last ${pct(after, 0.25, "gt")} of the text is`) : "less than a quarter of the text is"} hidden`,
        limit,
        "pass",
      );
    }
    case "image_only": {
      const notLoaded = f.triggers.includes("pictures_not_loaded");
      const share = num(f.sig, "imgShare");
      const chars = notLoaded ? num(f.sig, "liveTextChars") : liveChars(f);
      const text =
        chars !== null
          ? `${chars === 0 ? "no" : count(chars)} ${plural(Math.round(chars), "character", "characters")} of real text`
          : null;
      let value: string | null;
      if (notLoaded) {
        const n = num(f.sig, "htmlContentImages");
        const lead =
          n === 1
            ? "Its one picture didn't load"
            : n !== null
              ? `None of its ${n} pictures loaded`
              : "Its pictures didn't load";
        value = `${lead}${text ? `, and it has ${text}` : ""}`;
      } else if (picturesUnknown(input.signals) && !failed) {
        // Most of the picture area wasn't drawn, so how much of it is pictures isn't known
        // (lib/gallery.ts picturesUnknown). Enough real text passes whatever the pictures cover:
        // the rule needs under 200 characters (I1's count; without it, the render's).
        const legible = num(f.sig, "legibleChars");
        const live = num(f.sig, "liveTextChars");
        const enough =
          legible !== null
            ? legible >= IMAGE_TEXT_CHARS_MAX
            : live !== null && live >= IMAGE_TEXT_CHARS_MAX;
        if (enough && text)
          return row(
            "Real text, not just pictures",
            `${cap1(text)}, so it isn't just pictures`,
            f.current
              ? `Bad with under ${IMAGE_TEXT_CHARS_MAX} characters of real text when pictures cover half of it or more, or when its pictures don't load`
              : `Bad with under ${IMAGE_TEXT_CHARS_MAX} characters of real text when pictures cover half of it or more`,
            "pass",
          );
        // Too little real text to rule it out, and the share isn't known: not judged.
        return row(
          "Real text, not just pictures",
          `${unloadedPictures(f)}, so we can't tell how much of it is pictures${text ? ` (it has ${text})` : ""}`,
          `Bad with under ${IMAGE_TEXT_CHARS_MAX} characters of real text when pictures cover half of it or more`,
          "unknown",
        );
      } else if (share !== null)
        value = `Pictures cover ${picturesPct(share)} of it${text ? `, with ${text}` : ""}`;
      else value = text ? cap1(text) : null;
      const limit = f.current
        ? `Bad with under ${IMAGE_TEXT_CHARS_MAX} characters of real text when pictures cover half of it or more, or when its pictures don't load`
        : `Bad with under ${IMAGE_TEXT_CHARS_MAX} characters of real text when pictures cover half of it or more`;
      return row("Real text, not just pictures", value, limit);
    }
    case "mobile": {
      const k = num(f.sig, "layoutK");
      const t = num(f.sig, "phoneTextPx");
      const textBar = f.current ? TINY_PHONE_TEXT_PX : LEGACY_TINY_PHONE_TEXT_PX;
      let value: string | null =
        k !== null && t !== null
          ? k >= 0.995
            ? `Fits as designed, text ${px(t, textBar)} on a phone`
            : // Shrunk yet passing says why, so the tick never reads as "it fits as designed".
              failed
              ? `Shrinks to ${pct(k, f.current ? SHRINK_K_MAX : 0.99)} to fit, so text is only about ${px(t, textBar)}`
              : t >= textBar
                ? `Shrinks to ${pct(k, f.current ? SHRINK_K_MAX : 0.99)} to fit, but text is still about ${px(t, textBar)}`
                : `Shrinks only a little (to ${pct(k, f.current ? SHRINK_K_MAX : 0.99)}), so text is about ${px(t, textBar)}`
          : t !== null
            ? `Text ${px(t, textBar)} on a phone`
            : null;
      if (f.caps.includes("CAP_MOBILE_BROKEN")) value = cap1(mobileBrokenFact(f));
      const limit = f.current
        ? `Bad when it shrinks below ${pct(SHRINK_K_MAX, SHRINK_K_MAX)} and text ends up under ${TINY_PHONE_TEXT_PX} px, or it's too wide to read or tap`
        : `Bad when it shrinks and text ends up under ${LEGACY_TINY_PHONE_TEXT_PX} px, or it's too wide to read or tap`;
      return row("Fits a phone screen", value, limit);
    }
    case "no_unsubscribe": {
      const where = f.current ? str(f.sig, "unsubscribeUnion") : str(f.sig, "unsubscribe");
      // Whose rule it is: the current rules fault only marketing mail (v1.5: subscription mail).
      const limit = f.current
        ? "Only marketing emails must have one"
        : "Only subscription emails must have one";
      if (failed) return row("Has an unsubscribe link", "None found anywhere in the email", limit);
      switch (where) {
        case "before_clip":
          return row("Has an unsubscribe link", "Found", limit, "pass");
        case "after_clip":
          return row(
            "Has an unsubscribe link",
            "Found, but Gmail's cut hides it (counted above)",
            limit,
            "neutral",
          );
        case "none":
          return row("Has an unsubscribe link", "None found", limit, "neutral");
        default:
          return row(
            "Has an unsubscribe link",
            f.current ? "We couldn't tell" : null,
            limit,
            "unknown",
          );
      }
    }
    case "contrast": {
      const { share, pair, none } = faintMain(f);
      const limit = `Bad when over ${pct(CONTRAST_CAP_SHARE, CONTRAST_CAP_SHARE)} of the main text is too faint`;
      let value: string | null = null;
      if (none) value = "All of it is dark enough";
      else if (share !== null)
        value = `${cap1(share)} of it is too faint${pair ? `: ${pair}` : ""}`;
      else if (failed) value = "Too much of it is too faint to read";
      return row("Main text is dark enough to read", value, limit);
    }
    case "broken_images": {
      const c = input.checks?.I3;
      const i3 = checkValue(input, "I3");
      const limit = "Bad when most of its pictures (2 or more) are broken links";
      const failedN = num(i3, "failed");
      const evaluated = num(i3, "evaluated");
      const svg = num(i3, "svg") ?? 0;
      const svgNote =
        svg > 0
          ? `; ${svg === 1 ? "1 is an SVG file" : `${svg} are SVG files`} Gmail doesn't show`
          : "";
      if (failedN !== null && evaluated !== null) {
        const value =
          evaluated === 0
            ? `None could be checked${svgNote}`
            : failedN === 0
              ? `${evaluated === 1 ? "The one picture we could check loads" : evaluated === 2 ? "Both pictures we could check load" : `All ${evaluated} pictures we could check load`}${svgNote}`
              : `${failedN} of the ${evaluated} we could check ${failedN === 1 ? "is a broken link" : "are broken links"}${svgNote}`;
        return row(
          "Its pictures load",
          value,
          limit,
          failed ? "fail" : evaluated === 0 ? "unknown" : "pass",
        );
      }
      if (c?.status === "not_applicable")
        return row("Its pictures load", "No pictures to check", limit, failed ? "fail" : "neutral");
      if (c?.status === "not_evaluated")
        return row(
          "Its pictures load",
          "We couldn't check them",
          limit,
          failed ? "fail" : "unknown",
        );
      return row(
        "Its pictures load",
        failed ? "Most of its pictures are broken links" : null,
        limit,
      );
    }
    case "merge_tag": {
      const tag = /“([^”]{1,60})”/.exec(needTitle(input, "cap:CAP_MERGE_TAG"))?.[1];
      const limit = "Bad when code like *|FNAME|* shows instead of real text";
      return row(
        "No placeholder code showing",
        failed
          ? tag
            ? `Shows “${tag}”`
            : "Placeholder code shows in the subject or at the top"
          : // The cap's own rule: only a tag in the subject or the first screen fires it.
            input.compacted || input.checks
            ? "None in the subject or at the top"
            : null,
        limit,
      );
    }
    case "low_score":
      return row(
        `A score of at least ${POOR_SCORE_MAX}`,
        String(input.score),
        `Bad under ${POOR_SCORE_MAX}`,
      );
    default:
      return row(GALLERY_PROBLEM_LABELS[id] ?? id, null, null);
  }
}

/** "Treated as a marketing email." and what that means for the unsubscribe rule. */
function treatedAs(f: Facts): string | null {
  const type = f.type;
  if (!type) return null;
  const name = TYPE_NAMES[type] ?? "other mail";
  if (!f.current) return `Treated as ${name}.`;
  return type === UNSUBSCRIBE_REQUIRED_TYPE
    ? `Treated as ${name}, so it must have an unsubscribe link.`
    : `Treated as ${name}, so a missing unsubscribe link doesn't make it Bad.`;
}

// ───────────────────────── areas and notes ─────────────────────────

function areasOf(f: Facts): VerdictEvidence["areas"] {
  const { input } = f;
  const rows = input.pillars
    .filter((p) => Number.isFinite(p.points) && Number.isFinite(p.max) && p.max > 0.05)
    .map((p) => ({
      id: p.id,
      label: AREA_LABELS[p.id as PillarId] ?? p.id,
      points: p.points,
      max: p.max,
    }));
  if (rows.length === 0) return null;
  const notes: string[] = [];
  const shifted = input.pillars.some(
    (p) => typeof p.nominal === "number" && Math.abs(p.max - p.nominal) > 0.05,
  );
  if (input.aiReviewed === false && shifted)
    notes.push("AI review is off, so the other areas count a bit more.");
  const score = input.score!;
  const raw = input.raw !== null ? Math.round(input.raw) : null;
  if (raw !== null && raw > score) {
    if (f.caps.length > 0)
      notes.push(`These add up to ${raw}, but a serious problem caps the score at ${score}.`);
    else if (f.held)
      notes.push(
        `These add up to ${raw}, but the score is held at ${score} because it misses a Good check.`,
      );
  }
  return { rows, notes };
}

/** Why pictures weren't drawn, in plain words (features.render.images.loads `reason`). */
const LOAD_REASONS: Array<[readonly string[], one: string, many: string]> = [
  [["expired"], "the link had expired", "the links had expired"],
  [
    ["per_recipient", "tracker", "pixel", "policy", "not_http"],
    "we block it to protect your privacy",
    "we block them to protect your privacy",
  ],
  [
    ["too_large", "too_many_pixels", "budget"],
    "it was too big to load",
    "they were too big to load",
  ],
  [
    ["images_off"],
    "we don't load pictures for this kind of email",
    "we don't load pictures for this kind of email",
  ],
  [["timeout"], "it took too long to load", "they took too long to load"],
  [["network"], "its server couldn't be reached", "their server couldn't be reached"],
  [
    ["http", "not_image", "undecodable"],
    "the sender's server didn't send a picture",
    "the sender's server didn't send a picture",
  ],
  [
    ["svg"],
    "it's an SVG file, which Gmail doesn't show",
    "they're SVG files, which Gmail doesn't show",
  ],
  [["missing_cid", "not_fetched"], "it couldn't be fetched", "they couldn't be fetched"],
];

function imageNote(f: Facts): string | null {
  const loads = f.input.imageLoads;
  if (loads === null) {
    // Compacted: only the saved share is left.
    const unknown = num(f.sig, "imagesUnknownShare");
    return unknown !== null && unknown > 0
      ? "Some of its pictures didn't load when we checked it, so the picture checks couldn't see them."
      : null;
  }
  const missed = loads.filter((l) => l.decoded !== true);
  if (missed.length === 0 || loads.length === 0) return null;
  const groups: Array<{ n: number; one: string; many: string }> = [];
  for (const [reasons, one, many] of LOAD_REASONS) {
    const n = missed.filter(
      (l) => typeof l.reason === "string" && reasons.includes(l.reason),
    ).length;
    if (n > 0) groups.push({ n, one, many });
  }
  const other = missed.length - groups.reduce((s, g) => s + g.n, 0);
  if (other > 0) groups.push({ n: other, one: "it didn't load", many: "they didn't load" });
  const all = loads.length;
  const head =
    all === 1
      ? "Its one picture didn't load"
      : missed.length === all
        ? `None of its ${all} pictures loaded`
        : `${missed.length} of its ${all} pictures didn't load`;
  if (groups.length === 1) {
    const g = groups[0]!;
    return `${head}: ${missed.length === 1 ? g.one : g.many}.`;
  }
  return `${head}: ${groups.map((g) => `${g.n} because ${g.n === 1 ? g.one : g.many}`).join(", ")}.`;
}

function notesOf(f: Facts, good: readonly EvidenceRow[]): string[] {
  const { input } = f;
  const notes: string[] = [];
  if (bool(f.sig, "imagesOff") === true)
    notes.push(
      "We don't load pictures for this kind of email (account and order emails), so the picture checks were skipped.",
    );
  else {
    const img = imageNote(f);
    if (img) notes.push(img);
  }
  if (input.source === "template")
    notes.push(
      "Measured from another email with the same design (a template), so some values are that email's.",
    );
  const c = input.coverageConfidence;
  if (
    typeof c === "number" &&
    Number.isFinite(c) &&
    c + CONFIDENCE_EPSILON < COVERAGE_CONFIDENCE_MIN &&
    !good.some((r) => r.id === "coverage")
  )
    notes.push(
      `Only ${pct(c, COVERAGE_CONFIDENCE_MIN)} of the checks could run, so this score is less certain.`,
    );
  if (!f.current)
    notes.push("Scored with an older version of our checks, so some measurements weren't saved.");
  else if (input.compacted)
    notes.push(
      "The detailed measurements were cleared to save space, so a few values aren't shown.",
    );
  return notes;
}

// ───────────────────────── the panel ─────────────────────────

/**
 * The evidence for one email's verdict (null when it has no score). Agrees with verdictOf by
 * construction: the verdict is verdictOf's, the serious rows fail exactly for galleryProblemsOf's
 * options, the Good checklist reads the gate's own failed bars, and `rule` is one of verdictOf's.
 */
export function verdictEvidence(input: EvidenceInput): VerdictEvidence | null {
  const verdict = verdictOf({
    score: input.score,
    band: input.band,
    capped: input.capped,
    provisional: input.provisional,
    caps: input.caps,
    issues: input.issues,
    source: input.source,
    coverageConfidence: input.coverageConfidence,
    signals: input.signals,
    primaryType: typeOf(input),
  });
  if (verdict === "unscored") return null;
  const bars = gateBars(input.signals);
  const type = typeOf(input);
  const f: Facts = {
    input,
    sig: obj(input.signals),
    current: currentSignals(input.signals),
    caps: capsOf(input),
    triggers: severeTriggers(input.signals, type),
    problems: galleryProblemsOf({
      score: input.score,
      band: input.band,
      caps: input.caps,
      issues: input.issues,
      signals: input.signals,
      primaryType: type,
    }),
    bars,
    held: false,
    type,
  };
  f.held = gateHeld(input, bars);
  const rule = decidingRule(f, verdict);
  const good = goodRows(f, verdict);
  return {
    verdict,
    rule,
    sentence: sentenceOf(f, verdict, rule, good),
    good,
    serious: seriousRows(f),
    stated: statedRows(f, rule),
    treatedAs: treatedAs(f),
    areas: areasOf(f),
    notes: notesOf(f, good),
  };
}

/**
 * How the detail's problem list (lib/gallery.ts galleryReason) words the statement a failed row
 * already makes, with its value and limit: the deciding rule's line (caps first, then the severe
 * problems, the low-score line, or an Okay's "not Good because" lines) and the checks' own lines
 * for the same fact ("No real headline (…)", "Another link or picture in the email is bigger than …").
 * Precise on purpose: a different statement about the same thing (the button's words are hard to
 * read, the button is too small to tap) stays in the list.
 */
const ROW_LINES: Record<string, RegExp> = {
  // What Good needs.
  headline: /^(no (real )?headline|the headline is barely bigger|a plain design)/i,
  button:
    /^(no main button|no clear button for the main action)|doesn't stand out|is bigger than the main button|another link or picture is bigger|sits below the first phone screen/i,
  imagery: /^(few pictures for this kind of email|most of its pictures couldn't be loaded)/i,
  hero: /^(no large picture and no headline on a coloured band|most of its pictures couldn't be loaded)/i,
  phone:
    /^on phones, \d+% of the text (is squeezed into narrow columns|runs right to the screen edge)/i,
  // Serious problems (GalleryProblem ids).
  clipped: /^gmail cuts this email off/i,
  image_only: /^(most of this email is|mostly pictures)/i,
  mobile: /^(too wide for (a )?phones?|doesn't fit phones)/i,
  no_unsubscribe: /^no (visible )?unsubscribe link/i,
  contrast:
    /^(body text is .*(hard to read|too faint|low contrast)|\d+% of the body text is too faint)/i,
  broken_images:
    /^(none of its \d+ images load|\d+ of \d+ images don't load|its only image doesn't load|most of its images don't load|one image is an svg|\d+ images are svg)/i,
  merge_tag: /merge tag/i,
  low_score: /low score/i,
};

/**
 * The detail's problem list without the statements a failed check above already makes with its
 * value and limit — the deciding rule's line first of all (the verdict sentence says it) — so
 * nothing is said twice. While the checks are folded (`checksShown` false) only the sentence's own
 * statement is left out, so a problem never disappears from view. Everything else (other problems,
 * every strength) is kept.
 */
export function withoutRestatedLines(
  problems: readonly string[],
  evidence: Pick<VerdictEvidence, "good" | "serious" | "stated"> | null,
  checksShown = true,
): string[] {
  if (!evidence) return [...problems];
  const res = [...evidence.good, ...evidence.serious]
    .filter(
      (r) =>
        r.state === "fail" && ROW_LINES[r.id] && (checksShown || evidence.stated.includes(r.id)),
    )
    .map((r) => ROW_LINES[r.id]!);
  return problems.filter((line) => !res.some((re) => re.test(line)));
}
