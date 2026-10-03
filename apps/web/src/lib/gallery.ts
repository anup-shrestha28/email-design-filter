/**
 * Design gallery model shared by the server (queries/gallery.ts, actions/gallery.ts) and the client:
 * the gallery's categories, the strict Good / Bad verdict (VERDICT POLICY below), the one-line
 * reason on each card and the detail lists (REASON POLICY below) and the URL state (category,
 * design, font, q, sort, pages and the Filters panel). Client-safe: no server imports.
 */
import { z } from "zod";
import { EMAIL_SUBTYPES, EMAIL_TYPES, type EmailType } from "@edf/core/types";
import {
  CAP_DISPLAY_ORDER,
  type CapId,
  type DesignBand,
  type DesignIssue,
  type ScoreSummary,
} from "@edf/design/types";

// ───────────────────────── categories ─────────────────────────

/**
 * The email-type chips, in the order they're shown: the big marketing groups first, then the
 * app mail most inboxes are full of (social updates, notifications), then the smaller kinds.
 * "Other" is what's left: types too rare or vague for a chip of their own (re-engagement and
 * trial-ending mail, "other").
 */
export const GALLERY_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "promotions", label: "Promotions" },
  { id: "newsletters", label: "Newsletters" },
  { id: "social", label: "Social" },
  { id: "notifications", label: "Notifications" },
  { id: "welcome", label: "Welcome" },
  { id: "product_updates", label: "Product updates" },
  { id: "events", label: "Events" },
  { id: "abandoned_cart", label: "Abandoned cart" },
  { id: "receipts", label: "Orders & receipts" },
  { id: "other", label: "Other" },
] as const;

export type GalleryCategory = (typeof GALLERY_CATEGORIES)[number]["id"];
/** A category an email can belong to ("all" is only a filter). */
export type EmailGalleryCategory = Exclude<GalleryCategory, "all">;

export const GALLERY_CATEGORY_IDS = GALLERY_CATEGORIES.map((c) => c.id) as [
  GalleryCategory,
  ...GalleryCategory[],
];
export const EMAIL_GALLERY_CATEGORY_IDS = GALLERY_CATEGORY_IDS.filter(
  (c) => c !== "all",
) as EmailGalleryCategory[];

export const GALLERY_CATEGORY_LABELS = Object.fromEntries(
  GALLERY_CATEGORIES.map((c) => [c.id, c.label]),
) as Record<GalleryCategory, string>;

/** Lifecycle subtypes that are a welcome / getting-started email. */
const WELCOME_SUBTYPES: ReadonlySet<string> = new Set(["welcome", "onboarding"]);

/**
 * The gallery category of an email, from its classification. Total over every primary type and
 * subtype in @edf/core (an unknown subtype gets its type's default category).
 */
export function galleryCategoryOf(
  primaryType: string,
  subtype: string | null,
): EmailGalleryCategory {
  switch (primaryType as EmailType) {
    case "newsletter":
      return "newsletters";
    case "promotional":
      return subtype === "cart_reminder" ? "abandoned_cart" : "promotions";
    case "lifecycle":
      return subtype !== null && WELCOME_SUBTYPES.has(subtype) ? "welcome" : "other";
    case "product_update":
      return "product_updates";
    case "event":
      return "events";
    case "transactional":
      return "receipts";
    // Network and group updates: "X commented", "People you may know", forum and group digests.
    case "social":
    case "community":
      return "social";
    // Messages from an app or an account: activity alerts, reminders, policy and plan notices,
    // surveys, and the sign-in / security mail that isn't kept out of the gallery as sensitive.
    case "notification":
    case "account_notice":
    case "account_security":
    case "survey":
      return "notifications";
    case "other":
      return "other";
    default:
      return "other";
  }
}

/**
 * The (type, subtype) pairs that make up one category, derived from galleryCategoryOf so the SQL
 * filter can never disagree with it. For each type: whether its default (no or unknown subtype)
 * lands in the category, and which listed subtypes do / don't.
 */
export function categoryRules(category: EmailGalleryCategory): Array<{
  primaryType: EmailType;
  /** true: every subtype except `except`; false: only `only`. */
  byDefault: boolean;
  only: string[];
  except: string[];
}> {
  const out: ReturnType<typeof categoryRules> = [];
  for (const t of EMAIL_TYPES) {
    const subtypes = EMAIL_SUBTYPES[t] as readonly string[];
    const byDefault = galleryCategoryOf(t, null) === category;
    const hits = subtypes.filter((s) => galleryCategoryOf(t, s) === category);
    const misses = subtypes.filter((s) => galleryCategoryOf(t, s) !== category);
    if (byDefault) out.push({ primaryType: t, byDefault: true, only: [], except: misses });
    else if (hits.length) out.push({ primaryType: t, byDefault: false, only: hits, except: [] });
  }
  return out;
}

// ───────────────────────── verdict ─────────────────────────
//
// VERDICT POLICY ("really good" / "really bad"; mirrored in SQL by queries/gallery.ts):
//  - BAD      = a severe, visible problem, or a poor overall score:
//               · any design cap the engine found (image-only / text baked into images, main body
//                 text too faint, clipped in Gmail, a visible merge tag, genuinely broken on
//                 phones, and — decided deliberately — most images definitively broken: the
//                 sender's server said 404/410 or not-an-image for ≥ 2 and > 50% of them; DNS
//                 failures, timeouts and proxy blocks never count) — `caps` lists every cap that
//                 fired, binding or not, so a merge tag on an email whose raw score is already
//                 under the cap still counts;
//               · or one of five more clearly visible problems the engine deducts for but doesn't
//                 cap (`severeTriggers`, from score_summary.signals — kept after compaction, see
//                 migration 0015; each leads the card with its own plain reason). The rules were
//                 set on the 2026-10-01 verdict audit (DESIGN-SCORE §3.1) and read the facts the
//                 engine saves since scoring 2026.5 ("current" signals: the `unsubscribeUnion` key
//                 is there, even when null). Rows scored before keep the v1.5 rules (marked "v1.5")
//                 until they are re-scored — their signals can't tell the new rules apart:
//                   - just pictures, and they didn't load: the HTML declares ≥ 1 content image
//                     (htmlContentImages), none was drawn (drawnContentImages = 0 — null when we
//                     didn't ask for images, which never counts) and there are < 200 characters of
//                     real live text (liveTextChars): a 4 MB poster too big to load ("Most of this
//                     email is one huge picture (too big for us to load): only 51 characters of
//                     real text" — why it wasn't drawn comes from the stored render, RenderFacts;
//                     "one picture that didn't load" when its own server failed it);
//                   - text baked into images: images cover ≥ 50% of the email (I1 imgShare ≥ 0.5)
//                     and it has < 200 characters of real live text (I1 legibleChars) — the
//                     image-only cap's own thresholds, without its images-off escape, so alt text
//                     doesn't rescue it ("Most of this email is pictures: only 97 characters of
//                     real text"); the same in both rule sets, except that the current rules
//                     don't trust the share when more than half the picture area wasn't drawn for
//                     reasons that say nothing about the design (imagesUnknownShare > 0.5: our
//                     privacy proxy or size limits; the engine's own "imagery unknown" bar): a
//                     YouTube alert whose blocked thumbnail read as "pictures cover 100%" with its
//                     title and channel in real text isn't Bad for it (decided on the 2026-10-01
//                     review, a departure from the audit's simulation; those emails are Okay);
//                   - doesn't fit phones: the layout is scaled below 80% (layoutK < 0.80) and body
//                     text ends up under 12.5 px on a phone (phoneTextPx = CSS px × k; the cap only
//                     fires under 8 px) ("Doesn't fit phones: text shrinks to about 10.5 px"). v1.5:
//                     any shrink (k < 0.99) with text under 11.5 px;
//                   - Gmail cuts the email off and the unsubscribe link is after the cut
//                     (unsubscribeUnion "after_clip": both passes, whatever the type) ("Gmail cuts
//                     this email off (136 KB; Gmail's limit is 102 KB) and hides the unsubscribe
//                     link"). v1.5: none;
//                   - no unsubscribe link in marketing mail: the email is promotional — its type
//                     now (email.primary_type, VerdictInput.primaryType: the type its category chip
//                     shows, so a type the reader corrects, or the AI settles later, moves the
//                     verdict with the chip without a re-score) — and neither pass found a link
//                     (unsubscribeUnion "none", measured for every type), whether or not it's
//                     flagged as a subscription. Receipts, account notices and app notifications
//                     never trigger it. v1.5: U1 "none" (U1 applies only to subscription mail that
//                     isn't transactional or account mail, as scored);
//               · or a score under 60 (the Poor band, < 50, and the bottom of Needs work).
//               Caps are deterministic defects the pending AI review can never lift, so a capped
//               email is Bad whether or not it is 'provisional'; the same goes for the five
//               measured problems above. A low score is Bad too. Every Bad email matches at least
//               one Problems option (GALLERY_PROBLEMS: one per cap, per measured problem, and
//               "Low score"), so the Problems counts break the Bad count down rule by rule.
//  - GOOD     = score ≥ 85, none of the Bad problems (Bad always wins), and a real design coverage
//               (own render or template render, never static-only). "Really good" is enforced by
//               the engine's Excellent gate (@edf/design scoring/excellence.ts, DESIGN-SCORE §3.1):
//               since 2026.5 a score of 85+ needs a real headline (≥ 1.5× the body text) AND a
//               main button that stands out AND, in app and system mail, pictures on ≥ 8% of the
//               email (or an AI visual rating ≥ 4 instead of the three), and no phone-layout
//               problem on ≥ 50% of the text; an email without that is held at 84, so it is
//               "Okay" here and its number, band and sort position agree (the failed bars are
//               saved as signals.gate and become its "not Good because" lines, `gateLines`).
//               'Provisional' blocks Good only when it comes from low
//               design-coverage confidence (email_analysis.confidence below the engine's Medium
//               floor, 0.70 — e.g. a template render without the AI review, ≈ 0.64). A score of
//               85+ is never within ±3 of the 50/70 band edges, so the only other source of
//               'provisional' there is a low email-TYPE classification confidence, which says
//               nothing about design quality and must not block Good.
//  - OKAY     = every other scored email.
//  - UNSCORED = no score.

export type Verdict = "good" | "bad" | "ok" | "unscored";

export const VERDICT_LABELS: Record<Verdict, string> = {
  good: "Good design",
  bad: "Bad design",
  ok: "Okay",
  unscored: "Not scored yet",
};

/** Score a "Good design" needs (plus: no cap, real coverage, no low-coverage provisional). */
export const GOOD_SCORE_MIN = 85;
/**
 * A score below this is "Bad design": the Poor band (< 50) and the bottom of Needs work (50–59),
 * where real mail with no single fatal flaw has many smaller ones.
 */
export const POOR_SCORE_MAX = 60;
/** Text baked into images: images cover at least this share of the email (I1 imgShare)… */
export const IMAGE_TEXT_SHARE_MIN = 0.5;
/**
 * …and it has fewer than this many characters of real live text (I1 legibleChars). Also the
 * live-text limit of "just pictures that didn't load" (liveTextChars).
 */
export const IMAGE_TEXT_CHARS_MAX = 200;
/**
 * The picture share isn't trusted (current rules) when more than this share of the picture area
 * wasn't drawn for reasons that say nothing about the design (imagesUnknownShare; the engine's
 * Excellent gate calls the imagery unknown from the same share).
 */
export const IMAGES_UNKNOWN_SHARE_MAX = 0.5;
/** Doesn't fit phones: body text on a phone below this (CSS px × layout scale)… */
export const TINY_PHONE_TEXT_PX = 12.5;
/** …because the layout is scaled down below this to fit (layout scale k; 1 = fits as designed). */
export const SHRINK_K_MAX = 0.8;
/** The v1.5 phone rule, for rows scored before 2026.5: text under 11.5 px… */
export const LEGACY_TINY_PHONE_TEXT_PX = 11.5;
/** …with any shrink at all. */
export const LEGACY_SHRINK_K_MAX = 0.99;
/** The only type whose missing unsubscribe link makes it Bad (current signals). */
export const UNSUBSCRIBE_REQUIRED_TYPE = "promotional";
/** Gmail cuts off an email's HTML past this size (KB of 1,000 bytes, as `htmlKB` is saved). */
export const GMAIL_CLIP_KB = 102;
/**
 * The key whose presence marks summary signals saved by scoring 2026.5 or later ("current"):
 * absent on older summaries and in summary_signals(checks), present (maybe null) on every newer
 * one. The SQL twin reads the same key (queries/gallery.ts CURRENT_SIGNALS).
 */
export const CURRENT_SIGNALS_KEY = "unsubscribeUnion";
/**
 * Design-coverage confidence under which the engine calls a score "Low" for lack of evidence
 * (@edf/design CONFIDENCE_MEDIUM; the gallery tests assert they agree).
 */
export const COVERAGE_CONFIDENCE_MIN = 0.7;
/** email_analysis.confidence is a float4: 0.70 comes back as 0.6999999881. */
export const CONFIDENCE_EPSILON = 1e-4;
/** Design sources that measured the email's layout (static-only never earns Good). */
export const GOOD_SOURCES: readonly string[] = ["render", "template"];
/**
 * The Excellent gate's bars (@edf/design scoring/excellence.ts; the gallery tests assert they
 * agree): G1 a headline at least this many times the body text (H6 ratio)…
 */
export const HEADLINE_RATIO_MIN = 1.5;
/** …G2 a main button whose fill salience (H3) is at least this… */
export const CTA_SALIENCE_MIN = 0.9;
/** …and not one of this many look-alike buttons for this many different actions (ctaCompeting)… */
export const COMPETING_BUTTONS_MIN = 3;
/** …G3 pictures on at least this share of app and system mail (I1 imgShare)… */
export const IMAGERY_SHARE_MIN = 0.08;
/** …G4 a hero picture at least this wide on desktop (CSS px) and this large (CSS px²)… */
export const HERO_PICTURE_WIDTH_MIN = 300;
export const HERO_PICTURE_AREA_MIN = 40_000;
/** …or a large headline on a band at least this far from white (contrast ratio)… */
export const HERO_BAND_CONTRAST_MIN = 1.15;
/** …and less than this share of the text squeezed or at the screen edge on phones (M3 / M7). */
export const PHONE_PROBLEM_SHARE = 0.5;

export interface VerdictInput {
  score: number | null;
  band: DesignBand | null;
  capped: boolean | null;
  provisional: boolean | null;
  /** Every cap that fired (email_analysis.caps), binding or not. Any one is a severe problem. */
  caps?: readonly string[] | null;
  /** Issue chips (email.design_issues), derived from caps; any one is a severe problem. */
  issues?: readonly string[] | null;
  /** email.design_source. Good needs "render" or "template"; omitted = not checked. */
  source?: string | null;
  /** email_analysis.confidence: design coverage 0..1 (without the type-confidence drop). */
  coverageConfidence?: number | null;
  /**
   * The measured facts behind `severeTriggers` (score_summary.signals, or the same extracted from
   * the stored checks for older rows — queries/gallery.ts GALLERY_SIGNALS). Omitted = none.
   */
  signals?: unknown;
  /**
   * email.primary_type: the email's type now, which decides whether a missing unsubscribe link
   * makes it Bad (current signals). It can differ from the type the score used (signals
   * .primaryType) once the reader corrects it or the AI classifies a pending email; omitted
   * (undefined) = the type the score used.
   */
  primaryType?: string | null;
}

/** A clearly visible problem that makes an email Bad although the engine doesn't cap it. */
export type SevereTrigger =
  | "pictures_not_loaded"
  | "text_in_images"
  | "tiny_phone_text"
  | "unsubscribe_clipped"
  | "no_unsubscribe";

/** Most visible first: the order the card names them in (the caps' own order, then the footer). */
const SEVERE_ORDER: readonly SevereTrigger[] = [
  "pictures_not_loaded",
  "text_in_images",
  "tiny_phone_text",
  "unsubscribe_clipped",
  "no_unsubscribe",
];

function signalObj(signals: unknown): Record<string, unknown> | null {
  return typeof signals === "object" && signals !== null && !Array.isArray(signals)
    ? (signals as Record<string, unknown>)
    : null;
}

function signalNum(signals: unknown, key: string): number | null {
  const x = signalObj(signals)?.[key];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function signalStr(signals: unknown, key: string): string | null {
  const x = signalObj(signals)?.[key];
  return typeof x === "string" ? x : null;
}

/** Signals saved by scoring 2026.5 or later (see CURRENT_SIGNALS_KEY): the current rules apply. */
export function currentSignals(signals: unknown): boolean {
  const s = signalObj(signals);
  return s !== null && Object.prototype.hasOwnProperty.call(s, CURRENT_SIGNALS_KEY);
}

/**
 * Most of the picture area wasn't drawn for reasons that say nothing about the design (current
 * signals: imagesUnknownShare > 0.5), so how much of the email is pictures isn't known.
 */
export function picturesUnknown(signals: unknown): boolean {
  const unknown = signalNum(signals, "imagesUnknownShare");
  return currentSignals(signals) && unknown !== null && unknown > IMAGES_UNKNOWN_SHARE_MAX;
}

/**
 * The severe problems the signals show (see VERDICT POLICY), most visible first. `primaryType` is
 * the email's type now (VerdictInput.primaryType); omitted (undefined) = the type the score used.
 */
export function severeTriggers(signals: unknown, primaryType?: string | null): SevereTrigger[] {
  const lt = (key: string, max: number) => {
    const x = signalNum(signals, key);
    return x !== null && x < max;
  };
  const share = signalNum(signals, "imgShare");
  const current = currentSignals(signals);
  const union = signalStr(signals, "unsubscribeUnion");
  const type = primaryType === undefined ? signalStr(signals, "primaryType") : primaryType;
  const hit: Record<SevereTrigger, boolean> = {
    pictures_not_loaded:
      current &&
      (signalNum(signals, "htmlContentImages") ?? 0) >= 1 &&
      signalNum(signals, "drawnContentImages") === 0 &&
      lt("liveTextChars", IMAGE_TEXT_CHARS_MAX),
    text_in_images:
      share !== null &&
      share >= IMAGE_TEXT_SHARE_MIN &&
      lt("legibleChars", IMAGE_TEXT_CHARS_MAX) &&
      !picturesUnknown(signals),
    tiny_phone_text: current
      ? lt("layoutK", SHRINK_K_MAX) && lt("phoneTextPx", TINY_PHONE_TEXT_PX)
      : lt("phoneTextPx", LEGACY_TINY_PHONE_TEXT_PX) && lt("layoutK", LEGACY_SHRINK_K_MAX),
    unsubscribe_clipped: current && union === "after_clip",
    no_unsubscribe: current
      ? type === UNSUBSCRIBE_REQUIRED_TYPE && union === "none"
      : signalStr(signals, "unsubscribe") === "none",
  };
  return SEVERE_ORDER.filter((t) => hit[t]);
}

/**
 * A severe, visible problem: the engine capped the score, any cap / issue chip fired, or the
 * signals show one of the severe problems in `severeTriggers`.
 */
export function hasSevereProblem(
  d: Pick<VerdictInput, "capped" | "caps" | "issues" | "signals" | "primaryType">,
): boolean {
  return (
    d.capped === true ||
    (Array.isArray(d.caps) && d.caps.length > 0) ||
    (Array.isArray(d.issues) && d.issues.length > 0) ||
    severeTriggers(d.signals, d.primaryType).length > 0
  );
}

/** 'Provisional' because the design evidence itself is thin (not just an unsure email type). */
export function lowCoverageProvisional(d: VerdictInput): boolean {
  if (d.provisional !== true) return false;
  const c = d.coverageConfidence;
  return !(
    typeof c === "number" &&
    Number.isFinite(c) &&
    c + CONFIDENCE_EPSILON >= COVERAGE_CONFIDENCE_MIN
  );
}

/** The verdict (see VERDICT POLICY above). Bad is checked first, so the two can never overlap. */
export function verdictOf(d: VerdictInput): Verdict {
  if (d.score === null || d.score === undefined) return "unscored";
  if (hasSevereProblem(d) || d.score < POOR_SCORE_MAX || d.band === "poor") return "bad";
  const sourceOk =
    d.source === undefined || (typeof d.source === "string" && GOOD_SOURCES.includes(d.source));
  if (d.score >= GOOD_SCORE_MIN && sourceOk && !lowCoverageProvisional(d)) return "good";
  return "ok";
}

// ───────────────────────── reason ─────────────────────────
//
// REASON POLICY (card line + detail lists), from the saved score summary and signals and — while
// the email's full check results are still stored (they're compacted after a while) — from those
// checks. Every line must be true of the email and checkable by looking at it:
//  - BAD  → the rule that made it Bad, in plain, specific words ("Body text is light grey on
//           white (2.1:1) — hard to read", "Gmail cuts this email off (136 KB; Gmail's limit is
//           102 KB) and hides the unsubscribe link"). Caps lead, most visible first (image-only,
//           contrast, merge tag, phone layout, clipping, broken images), not simply the lowest
//           cap; then the verdict's severe problems ("Most of this email is one huge picture
//           (too big for us to load): only 51 characters of real text", "Doesn't fit phones: text
//           shrinks to about 10.5 px", "No unsubscribe link anywhere in this marketing email"),
//           worded from the saved signals so they survive compaction; Bad for its score alone,
//           "Several problems add up to a low score (55 of 100; Bad is under 60)".
//  - GOOD → the most distinctive strengths (hierarchy, button, imagery, phone layout), two combined
//           when short ("A big headline and a standout “Shop now” button"); baseline strengths
//           (contrast, "a restrained colour palette", "a clean layout") never make up a combined
//           line and lead only when nothing more distinctive passed.
//  - OKAY → its main issue, in the plainest checkable words: held at 84 by the Excellent gate, the
//           first "not Good because" line (one per failed bar in signals.gate, with what was
//           measured and what Good needs: "No real headline (the biggest text is 1.1× the body
//           text; Good needs 1.5×)", "Few pictures for this kind of email (3%; Good needs 8%)");
//           a readable non-responsive layout reads "Doesn't resize for phones (text ≈ 10.5 px)"
//           (the measured sentence stays in the detail); an email just over Gmail's size limit
//           whose cut hides nothing that matters reads "Over Gmail's size limit (103 KB; the limit
//           is 102 KB): the last 9% of it is behind “[Message clipped]”" — "Gmail cuts this email
//           off" is the Bad rule's wording only; a filled button that a bigger link elsewhere
//           outweighs, "Another link or picture in the email is bigger than the main button “View
//           message”" (never "comes first": the render compares it with every link). With no
//           problem that may lead, its best strength.
//  - Weak problems (weakProblem: faint small print, narrow columns on under half the text, line
//    length, images without a description, phone styles some apps ignore, "no clear button for
//    the main action") are listed after the others and never lead a card. Not listed at all:
//    "phone styles" for an email that fits, alt text when the only images are pixels, a missing
//    headline outside marketing mail, a missing unsubscribe link outside promotional and
//    newsletter mail (the verdict's own scope), the footer statements the HTML pass matches by set
//    phrases (HTML_PASS_CHECKS: preferences link, "why you get this") and the engine's "stray text
//    addressed to AI" note (HTML_PASS_NOTES) unless they come from the current HTML pass, a
//    methodology 2026.6+ summary with an own render of render-2026.5+ (currentHtmlPass: the older
//    phrases missed "Manage recommendations", the older patterns matched ordinary copy like "rank
//    the Top 100"), how much of the email is pictures when most of the picture area
//    wasn't drawn (picturesUnknown), and "no main button" unless the email's stored render and
//    HTML pass both back it up (no link painted as a button, no link box a button's size:
//    RenderFacts) — the render misses some real buttons (an 8-word label, a cell painted around a
//    short link) — and a letter or a notice needs none, so even a backed-up one never leads,
//    unless it is the Excellent gate's "not Good because" line ("No main button (Good needs one
//    that stands out)").
//  - Numbers are worded the same everywhere: a phone text size to one decimal, never rounded onto
//    the bar it misses ("about 10.5 px" on the card, in the list and in "How we judged this").
//  - Detail: up to 3 problems and up to 3 strengths, each specific, deduplicated by root cause,
//    root cause first; generic baseline strengths only when nothing better passed (never on Bad).
//    Symptoms of one root cause are one problem: a fixed-width layout shrinking on phones also
//    makes the button's tap area, the headline and tap targets small (M4, H6, A7) and squeezes
//    columns / text (M2, M3, M7, T1); those fold into the layout problem, and an email that is just
//    pictures has no separate button, headline or text-size / text-layout problem (they are in
//    its pictures).
//  - Strengths are dropped when a listed problem contradicts them ("fits phones" next to a
//    shrinking layout, button praise next to "doesn't stand out", desktop text called comfortable
//    next to the same size called small on phones) and when the facts don't back them
//    (`unbacked`: the engine's own rules — a "standout" button needs a bold fill that is the most
//    prominent link, "one clear main button at the top" the first phone screen too, no headline
//    praise without heading text, "images resize cleanly" only for pictures that were drawn,
//    typography / palette / grid never for unstyled mail; an email that is just pictures gets no
//    text, layout, picture-button or picture-resizing praise). One of several buttons that look
//    the same is never "the standout “Try AI in Sheets” button" — they are "clear, bold buttons" —
//    and a main button that stands out over buttons of another style isn't "competing" with them.

export interface GalleryReason {
  kind: "problem" | "strength";
  text: string;
}

export const REASON_MAX = 120;
/** Longer limit for the detail view's problem / strength lists. */
export const DETAIL_ITEM_MAX = 200;
const LIST_MAX = 3;
/** A combined two-strength card line must stay this short. */
const COMBINED_MAX = 70;

/**
 * Summaries saved before methodology 2026.2 cut every title at exactly this many characters,
 * mid-word. Since 2026.2 (@edf/design summary.ts briefTitle) a cut title ends at a word boundary
 * with "…", so only legacy summaries need tidying (see `legacySummaryCut`).
 */
const SUMMARY_TITLE_MAX = 80;
/** First methodology whose saved titles are cut at a word boundary ("2026.2"). */
const WORD_CUT_METHODOLOGY = [2026, 2] as const;

type VersionPair = readonly [number, number];

/** A scoring version's methodology ("2026.6+w-2026.1+…" → [2026, 6]); null when it isn't one. */
function methodologyOf(v: unknown): VersionPair | null {
  const m = typeof v === "string" ? /^(\d{4})\.(\d+)(?:\+|$)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** A renderer version ("render-2026.5" → [2026, 5]); null when it isn't one. */
function rendererOf(v: unknown): VersionPair | null {
  const m = typeof v === "string" ? /^render-(\d{4})\.(\d+)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const atLeast = (v: VersionPair | null, min: VersionPair) =>
  v !== null && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));

/**
 * Whether a saved summary predates word-boundary title cuts (its scoringVersion's methodology is
 * older than 2026.2, or unknown). Such rows are re-scored in the background after the version bump.
 */
export function legacySummaryCut(
  summary: { scoringVersion?: unknown } | null | undefined,
): boolean {
  return !atLeast(methodologyOf(summary?.scoringVersion), WORD_CUT_METHODOLOGY);
}

/**
 * The first scoring methodology and renderer whose HTML pass the gallery stands behind for the
 * footer statements (U3 "No link to choose how often you get these emails", U4 "Doesn't say why
 * you're getting this email") and the stray-text note. Methodology 2026.6 ships lex-2026.3: the
 * footer phrasings the older set phrases missed (LinkedIn's "Manage recommendations", "You are
 * receiving … emails"; 99 false cards before) and an injection pre-scan that needs text addressed
 * to the reviewer (the older patterns matched "rank the Top 100" and "Software Developer ·
 * Message"; 0 of 631 real emails flagged now). The HTML pass is only re-read by a render, and
 * render-2026.5 is the first to read it with lex-2026.3: a re-score from stored features (an AI
 * review arriving) moves the scoring version but keeps the old pass's facts.
 */
export const HTML_PASS_METHODOLOGY = "2026.6";
export const HTML_PASS_RENDERER = "render-2026.5";
const HTML_PASS_MIN = methodologyOf(HTML_PASS_METHODOLOGY)!;
const HTML_PASS_RENDER_MIN = rendererOf(HTML_PASS_RENDERER)!;

/**
 * Whether an email's footer statements and stray-text note come from the current HTML pass (see
 * HTML_PASS_METHODOLOGY): its summary was saved by methodology 2026.6 or later (`scoringVersion`)
 * and its own render is render-2026.5 or later (`rendererVersion`: email_analysis.renderer_version
 * for an own render; null for template coverage, whose render is another email's while its own
 * HTML pass may be older). Unknown versions are older.
 */
export function currentHtmlPass(scoringVersion: unknown, rendererVersion: unknown): boolean {
  return (
    atLeast(methodologyOf(scoringVersion), HTML_PASS_MIN) &&
    atLeast(rendererOf(rendererVersion), HTML_PASS_RENDER_MIN)
  );
}
const CAP_NOTE = /\s*\(score capped at \d+\)/gi;
const TRAILING_JUNK = /[\s,;:.\-–—(~]+$/u;

/**
 * Trim to ≤ `max` characters at a word boundary, ending with an ellipsis when cut. Also drops the
 * scoring engine's legacy "(score capped at 59)" note. With `summaryCut` (a title from a legacy
 * summary, see `legacySummaryCut`), a text of exactly 80 characters not already ending in "…" is
 * one the saved summary cut mid-word, so its partial last word or unclosed aside is tidied away.
 * Current summaries and the gallery's own sentences leave it off (the default).
 */
export function trimReason(
  text: string,
  max = REASON_MAX,
  opts: { summaryCut?: boolean } = {},
): string {
  let clean = text.replace(/\s+/g, " ").trim();
  // Length before trimming: the cut can land right after a space.
  const preCut =
    opts.summaryCut === true &&
    Array.from(text).length === SUMMARY_TITLE_MAX &&
    !clean.endsWith("…") &&
    !/\(score capped at \d+\)$/i.test(clean);
  clean = clean.replace(CAP_NOTE, "").trim();
  if (preCut) {
    const space = clean.lastIndexOf(" ");
    if (space >= clean.length * 0.5) clean = clean.slice(0, space);
    const open = clean.lastIndexOf("(");
    if (open > clean.lastIndexOf(")") && open > 0) {
      clean = clean.slice(0, open).replace(TRAILING_JUNK, ""); // an aside that was cut off: drop it whole
    } else {
      clean = `${clean.replace(TRAILING_JUNK, "")}…`;
    }
  }
  if (clean.length <= max) return clean;
  const room = clean.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = space >= max * 0.5 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,;:.\-–—(]+$/u, "")}…`;
}

// ── inputs ──

type Value = Record<string, unknown>;
type SummaryLike =
  | Partial<Pick<ScoreSummary, "needsImprovement" | "good" | "caps" | "scoringVersion" | "signals">>
  | null
  | undefined;

/**
 * A few facts from the email's stored render and HTML pass (email_analysis.features; null once
 * compaction empties it — queries/gallery.ts RENDER_FACTS), read to double-check a statement the
 * checks alone can't back up: "no main button", the one standout button, why a picture wasn't
 * drawn. Each field is null when not stored.
 */
export interface RenderFacts {
  /** Links the HTML pass found painted as a button (features.static.cta.buttonLike). */
  staticButtons: number | null;
  /** Buttons the render found (features.render.cta.buttonLike)… */
  buttons: number | null;
  /** …their different labels (features.render.cta.labels)… */
  buttonLabels: number | null;
  /** …and their different looks (fill, corners, height, text size: render.cta.buttonStyles). */
  buttonStyles: number | null;
  /**
   * Standalone links whose box is at least BIG_LINK_W × BIG_LINK_H px on a phone (render
   * links.targets): a padded button, or a linked picture that may hold one.
   */
  bigLinks: number | null;
  /** Why the content images that weren't drawn weren't (render images.loads `reason`), distinct. */
  missedImageReasons: string[] | null;
}

/** A link box this wide and tall on a 375 px phone is a button's size, not a line of text. */
export const BIG_LINK_W = 120;
export const BIG_LINK_H = 44;

/** One stored check result (email_analysis.checks), reduced to what the reasons need. */
interface CheckFact {
  status: string;
  w: number;
  lost: number;
  value: Value;
}
type Facts = ReadonlyMap<string, CheckFact>;

interface Candidate {
  /** "cap:CAP_X", "group:…", "check:X", "good:X" or "ai:X" (or anything else: shown tidied). */
  key: string;
  /** The engine's title (may be cut at 80 characters), or "" when built from checks. */
  title: string;
}

function isObj(x: unknown): x is Value {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function num(v: Value, key: string): number | null {
  const x = v[key];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function str(v: Value, key: string): string | null {
  const x = v[key];
  return typeof x === "string" && x.trim() !== "" ? x : null;
}

function factsOf(checks: unknown): Map<string, CheckFact> {
  const out = new Map<string, CheckFact>();
  if (!Array.isArray(checks)) return out;
  for (const c of checks) {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.status !== "string") continue;
    out.set(c.id, {
      status: c.status,
      w: typeof c.w === "number" ? c.w : 0,
      lost: typeof c.pointsLost === "number" ? c.pointsLost : 0,
      value: isObj(c.value) ? c.value : {},
    });
  }
  return out;
}

function candidates(items: unknown): Candidate[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((i): Candidate[] =>
    isObj(i) && typeof i.title === "string" && i.title.trim() !== ""
      ? [{ key: typeof i.key === "string" ? i.key : "", title: i.title }]
      : [],
  );
}

/** "check:M4" / "good:M4" / "ai:H7" → "M4"; caps and groups → null. */
function checkIdOf(key: string): string | null {
  const m = /^(?:check|good|ai):([A-Z]\d{1,2})$/.exec(key);
  return m ? m[1]! : null;
}

// ── formatting ──

function cap1(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** A number from the engine's title: the first capture group of `re`. */
function fromTitle(title: string, re: RegExp): number | null {
  const m = re.exec(title);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const round = (x: number) =>
  Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
const pctOf = (share: number | null) => (share === null ? null : Math.round(share * 100));
/** Contrast ratio, floored to one decimal (4.49 must never read as 4.5). */
const ratioText = (r: number) => `${Math.floor(r * 10) / 10}:1`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The button label from a value or a “quoted” title, as “Label” (≤ 30 characters). */
function labelOf(v: Value, title: string): string | null {
  const raw = str(v, "label") ?? /“([^”]+)”?/.exec(title)?.[1] ?? null;
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return `“${t.length > 30 ? `${t.slice(0, 29).trimEnd()}…` : t}”`;
}

/** A plain colour name for a CSS hex / rgb() colour ("light grey", "white", "pale blue"). */
export function colourName(css: string): string | null {
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(css.trim());
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(css.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  } else if (rgb) {
    [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((x) => Math.min(255, Number(x)) / 255) as [
      number,
      number,
      number,
    ];
  } else {
    return null;
  }
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || d < 0.06) {
    if (l >= 0.96) return "white";
    if (l >= 0.8) return "very light grey";
    if (l >= 0.6) return "light grey";
    if (l >= 0.38) return "grey";
    if (l >= 0.12) return "dark grey";
    return "black";
  }
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  let name =
    hue < 15 || hue >= 345
      ? "red"
      : hue < 45
        ? "orange"
        : hue < 70
          ? "yellow"
          : hue < 165
            ? "green"
            : hue < 200
              ? "teal"
              : hue < 255
                ? "blue"
                : hue < 290
                  ? "purple"
                  : "pink";
  if ((name === "orange" || name === "yellow") && l < 0.35) name = "brown";
  const shade = l >= 0.85 ? "pale " : l >= 0.65 ? "light " : l < 0.25 ? "dark " : "";
  return shade + name;
}

/** "(#888888 on #ffffff = 3.54:1)" → colours and ratio. */
function contrastPair(
  v: Value | null,
  title: string,
): { fg: string; bg: string; ratio: number | null } | null {
  if (v && typeof v.fg === "string" && typeof v.bg === "string")
    return { fg: v.fg, bg: v.bg, ratio: num(v, "ratio") };
  const m =
    /\((#[0-9a-f]{3,8}|rgba?\([^)]*\)) on (#[0-9a-f]{3,8}|rgba?\([^)]*\))(?: = ([\d.]+):1)?/i.exec(
      title,
    );
  return m ? { fg: m[1]!, bg: m[2]!, ratio: m[3] ? Number(m[3]) : null } : null;
}

function contrastSentence(
  subject: string,
  pair: { fg: string; bg: string; ratio: number | null } | null,
): string | null {
  if (!pair) return null;
  const fg = colourName(pair.fg);
  const bg = colourName(pair.bg);
  if (!fg || !bg) return null;
  const known = pair.ratio !== null && Number.isFinite(pair.ratio);
  const ratio = known ? ` (${ratioText(pair.ratio!)})` : "";
  // Just under AA (4.0–4.5:1) is slightly low, not "hard to read".
  if (known && pair.ratio! >= 4)
    return `${subject} is ${fg} on ${bg}${ratio} — slightly low contrast`;
  return `${subject} is ${fg} on ${bg}${ratio} — hard to read`;
}

// ── problems ──

/**
 * Caps in the order the card names them: the most visible defect first, not the lowest limit. The
 * engine's own order (so the card and the full analysis always lead with the same cap).
 */
const CAP_ORDER: readonly string[] = CAP_DISPLAY_ORDER;

const CAP_ROOT: Record<string, string> = {
  CAP_IMAGE_ONLY: "images",
  CAP_MERGE_TAG: "merge-tag",
  CAP_CONTRAST: "contrast",
  CAP_MOBILE_BROKEN: "fixed-width",
  CAP_CLIPPED: "clipped",
  CAP_BROKEN_IMAGES: "broken-images",
};
/** The cap each issue chip stands for (email.design_issues; also lib/gallery-evidence.ts). */
export const ISSUE_CAP: Record<DesignIssue, CapId> = {
  image_only: "CAP_IMAGE_ONLY",
  contrast: "CAP_CONTRAST",
  mobile: "CAP_MOBILE_BROKEN",
  clipped: "CAP_CLIPPED",
  broken_images: "CAP_BROKEN_IMAGES",
};

/** What a cap means when neither the summary nor the checks can say more. */
const CAP_FALLBACK: Record<string, string> = {
  CAP_IMAGE_ONLY: "Most of this email is pictures, with very little real text",
  CAP_MERGE_TAG: "Shows a raw merge tag: placeholder code instead of real text",
  CAP_CONTRAST: "Body text is too faint to read against its background",
  CAP_MOBILE_BROKEN: "Too wide for a phone screen: the text shrinks too small to read",
  CAP_CLIPPED: "Gmail cuts this email off: readers see [Message clipped]",
  CAP_BROKEN_IMAGES: "Most of its images don't load (broken links)",
};

/** Root causes: the checks / groups that ARE the problem (not symptoms of another one). */
const PRIMARY_ROOT: Record<string, string> = {
  "group:fixed-width": "fixed-width",
  "group:no-cta": "cta",
  "group:image-heavy": "images",
  M1: "fixed-width",
  H1: "cta",
  I1: "images",
  A1: "contrast",
  I3: "broken-images",
  // The verdict's severe problems (severeTriggers): the same root causes as their checks.
  "severe:pictures_not_loaded": "images",
  "severe:text_in_images": "images",
  "severe:tiny_phone_text": "fixed-width",
  "severe:unsubscribe_clipped": "clipped",
  "severe:no_unsubscribe": "check:U1",
};
/** Symptoms that fold into a root cause when that root cause is present. */
const SYMPTOM_OF: Record<string, string> = {
  M2: "fixed-width",
  M3: "fixed-width",
  M7: "fixed-width",
  T1: "fixed-width",
  H6: "fixed-width",
  H2: "cta",
  H3: "cta",
  H4: "cta",
  I2: "images",
  I4: "images",
};
/**
 * `k`-scaled checks that are symptoms of the fixed-width layout only when the engine says the
 * shrink alone makes them fail (`value.shrinkOnly`, @edf/design explain.ts SHRINK_SYMPTOMS): a
 * full-size button, a normal-size unsubscribe link or tap targets that become small on a phone.
 * A button, link or target that is too small (or too faint) at its own size is its own problem.
 * Rows scored before `shrinkOnly` existed fold M4 / A7 as before (U2 stays its own problem).
 */
const SHRINK_SYMPTOMS: Record<string, "legacy-fold" | "own"> = {
  M4: "legacy-fold",
  A7: "legacy-fold",
  U2: "own",
};

/**
 * An image wider than the phone (M5 "overflowing", nothing stretched or blurry) next to a layout
 * that shrinks to fit: the phone shrinks the whole email to fit that image — one problem, and the
 * shrunk Phone preview shows nothing sticking out that the reader could check.
 */
function overflowOnlyM5(id: string, facts: Facts): boolean {
  if (id !== "M5") return false;
  const v = facts.get("M5")?.value ?? {};
  return (num(v, "overflowing") ?? 0) > 0 && !num(v, "distorted") && !num(v, "blurry");
}

function shrinkSymptom(id: string, facts: Facts): boolean {
  const legacy = SHRINK_SYMPTOMS[id];
  if (!legacy) return false;
  const flag = facts.get(id)?.value.shrinkOnly;
  return flag === true || (flag === undefined && legacy === "legacy-fold");
}
/**
 * Not visible to a reader (code hygiene only): never shown as a gallery problem. X3 is hidden too,
 * except its merge-tag case (a visible defect, folded into the merge tag): placeholder, http or
 * empty link targets can't be seen by looking at the design.
 */
const INVISIBLE: ReadonlySet<string> = new Set(["A4", "A5", "A9", "A10", "A11", "X2", "X3", "X4"]);
/**
 * Footer statements the HTML pass finds by set phrases: before lex-2026.3 common wordings slipped
 * past them — LinkedIn's "Manage recommendations" (a preferences link) and "You are receiving Jobs
 * You Might Be Interested In emails" (why you get it) read as missing on 99 cards — so "No link to
 * choose how often…" (U3) and "Doesn't say why you're getting this email" (U4) are listed only
 * from the current HTML pass (`currentHtmlPass`); for older rows the full analysis still shows
 * the check.
 */
const HTML_PASS_CHECKS: ReadonlySet<string> = new Set(["U3", "U4"]);
/**
 * Engine notes from the HTML pass: "stray text addressed to AI or review software" (static
 * `instructionText`, @edf/design ai/guards.ts) matched ordinary copy before lex-2026.3 ("We
 * analyzed 60,000+ organizations to rank the Top 100 Companies", a "Software Developer" job title
 * above a "Message" button), so it is listed only from the current HTML pass (`currentHtmlPass`).
 */
const HTML_PASS_NOTES: ReadonlySet<string> = new Set(["note:stray-text"]);
/** The Excellent gate's item (engine `gate:excellence`): why a high score is held at 84. */
const GATE_KEY = "gate:excellence";
/** Which check the gate item stands for, from its title (the summary keeps no check ids). */
function gateCheckOf(title: string): string | null {
  if (/plain design|nothing stands out/i.test(title)) return "H6";
  if (/narrow columns/i.test(title)) return "M3";
  if (/screen edge/i.test(title)) return "M7";
  return null;
}
/** One failed bar of the Excellent gate (signals.gate), as its own "not Good because" line. */
export type GateBar =
  "headline" | "button" | "imagery" | "imagery_unknown" | "hero" | "phone_narrow" | "phone_edge";
/** The bars in the order the card names them (also lib/gallery-evidence.ts's order). */
export const GATE_BARS: readonly GateBar[] = [
  "headline",
  "button",
  "imagery",
  "imagery_unknown",
  "hero",
  "phone_narrow",
  "phone_edge",
];
/**
 * The root causes a gate bar's line stands for: the checks it absorbs (a missing headline is the
 * H6 problem, a button that doesn't stand out is the button problem), so neither repeats it.
 */
const GATE_BAR_ROOTS: Record<GateBar, readonly string[]> = {
  headline: ["check:H6"],
  button: ["cta", "check:H1", "check:H2", "check:H3"],
  imagery: ["gate:imagery"],
  imagery_unknown: ["gate:imagery"],
  hero: ["gate:hero"],
  phone_narrow: ["check:M3"],
  phone_edge: ["check:M7"],
};
/**
 * Marks an email that is just pictures (the image-only cap, text baked into pictures, pictures
 * that didn't load) among the root causes present — not merely image-heavy (I1).
 */
const JUST_PICTURES = "just-pictures";
const JUST_PICTURES_KEYS: ReadonlySet<string> = new Set([
  "cap:CAP_IMAGE_ONLY",
  "severe:text_in_images",
  "severe:pictures_not_loaded",
]);
/**
 * Marks an email with some pictures but not mostly pictures (I1's share under half): its I1 line
 * ("Only 242 characters of real text; pictures cover 25% of it") is its own problem, not the
 * "images" root cause whose text and layout live in the pictures.
 */
const PICTURES_MINOR = "pictures-minor";
/** Marks a listed "No headline in real text": the headline may be in a picture. */
const HEADLINE_IN_PICTURE = "headline-in-picture";
/** "gate:headline" → "headline"; anything else → null. */
function gateBarOf(key: string): GateBar | null {
  const bar = key.startsWith("gate:") ? key.slice(5) : "";
  return (GATE_BARS as readonly string[]).includes(bar) ? (bar as GateBar) : null;
}
/** The types a missing unsubscribe link is listed for: marketing and subscribed mail. */
const UNSUBSCRIBE_TYPES: ReadonlySet<string> = new Set(["promotional", "newsletter"]);
/** The types a headline is expected in: marketing mail (not feeds, replies, letters, notices). */
const HEADLINE_TYPES: ReadonlySet<string> = new Set([
  "promotional",
  "newsletter",
  "product_update",
  "event",
  "lifecycle",
]);
const AI_NAMES: Record<string, string> = {
  H7: "Visual hierarchy",
  L8: "Visual polish",
  C4: "Copy clarity",
  I6: "Imagery",
};

function capIdOf(key: string): string | null {
  return key.startsWith("cap:") ? key.slice(4) : null;
}

/**
 * A "no main button" statement: the engine's button group, H1, H2 / H3 with no button, or the
 * Excellent gate's button bar when no button was measured (signals.ctaSalience null).
 */
function noButtonClaim(c: Candidate, facts: Facts, signals: unknown): boolean {
  if (c.key === "group:no-cta" || c.key === "check:H1") return true;
  if (/^check:H[23]$/.test(c.key))
    return facts.get(c.key.slice(6))?.value.present === false || /no primary/i.test(c.title);
  return c.key === "gate:button" && signalNum(signals, "ctaSalience") === null;
}

/**
 * Whether the stored render and HTML pass back up "no main button": no link painted as a button
 * (either pass) and no link box a button's size. false when either suggests a button the render's
 * button finder missed; null when they aren't stored (older rows, compaction).
 */
export function noButtonBackedUp(render: RenderFacts | null): boolean | null {
  if (!render) return null;
  const { staticButtons, buttons, bigLinks } = render;
  if ((staticButtons ?? 0) > 0 || (buttons ?? 0) > 0 || (bigLinks ?? 0) > 0) return false;
  return staticButtons === null || bigLinks === null ? null : true;
}

function isClipX1(title: string, facts: Facts): boolean {
  return facts.get("X1")?.value.clipped === true || /clips it|so gmail clips/i.test(title);
}
function isMergeX3(title: string, facts: Facts): boolean {
  return facts.get("X3")?.value.mergeTags === true || /merge tag/i.test(title);
}
function isUnsubAfterClip(title: string, facts: Facts): boolean {
  return facts.get("U1")?.value.unsubscribe === "after_clip" || /behind gmail's clip/i.test(title);
}

/** The root cause a candidate belongs to, given the root causes present. */
function rootOf(
  c: Candidate,
  facts: Facts,
  present: ReadonlySet<string>,
  gateCheck: string | null = null,
): string {
  const cap = capIdOf(c.key);
  if (cap) return CAP_ROOT[cap] ?? c.key;
  if (c.key === GATE_KEY) return gateCheck ? `check:${gateCheck}` : "gate";
  const bar = gateBarOf(c.key);
  if (bar) return GATE_BAR_ROOTS[bar][0]!;
  // An email that is just pictures has its button in a picture too, if anywhere: "no clear
  // button" is part of that one problem, not a second one.
  if (noButtonClaim(c, facts, null) && present.has(JUST_PICTURES)) return "images";
  // Its button is a picture too: how it stands out, where it sits and what it says are part of
  // the picture, not live problems of their own.
  if (present.has("picture-button") && /^check:(?:H[1-5]|M4)$/.test(c.key)) return "images";
  // …and the size, spacing and layout of its few lines of live text (text size, columns,
  // margins, line length, a live headline) are beside the point: its message is in the pictures.
  if (present.has(JUST_PICTURES) && /^check:(?:T\d|L\d|M3|M7|H6)$/.test(c.key)) return "images";
  if (present.has(PICTURES_MINOR) && (c.key === "group:image-heavy" || c.key === "check:I1"))
    return "check:I1";
  if (PRIMARY_ROOT[c.key]) return PRIMARY_ROOT[c.key]!;
  const id = checkIdOf(c.key);
  if (!id) return c.key;
  if (id === "X1" && isClipX1(c.title, facts)) return "clipped";
  if (id === "U1" && isUnsubAfterClip(c.title, facts) && present.has("clipped")) return "clipped";
  if (id === "X3" && isMergeX3(c.title, facts)) return "merge-tag";
  if (PRIMARY_ROOT[id]) return PRIMARY_ROOT[id]!;
  if ((shrinkSymptom(id, facts) || overflowOnlyM5(id, facts)) && present.has("fixed-width"))
    return "fixed-width";
  const parent = SYMPTOM_OF[id];
  if (parent && present.has(parent)) return parent;
  return `check:${id}`;
}

/**
 * Unrendered merge tags — the same families as @edf/design MERGE_TAG_SOURCES (util/patterns.ts);
 * only the [name] family is case-insensitive. Kept here because this module must stay client-safe.
 */
const MERGE_TAG_RES: readonly RegExp[] = [
  /\*\|[A-Z0-9_:]+\|\*/,
  /\{\{\s*[\w.]+\s*\}\}/,
  /%%[\w=.:-]+%%/,
  /\[(?:first_?name|fname|last_?name|name|email|company)\]/i,
  /\{\$[\w.]+\}/,
  /%recipient\.\w+%/,
];

/** The merge tag in `text` with a few words around it ("Hi *|FNAME|*"), ≤ ~50 characters. */
export function mergeTagSnippet(text: string): string | null {
  let best: RegExpExecArray | null = null;
  for (const re of MERGE_TAG_RES) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = m;
  }
  if (!best) return null;
  const tag = best[0].replace(/\s+/g, " ").slice(0, 40);
  const before = text
    .slice(0, best.index)
    .split(/[,.!?;:|–—]/)
    .pop()!
    .trimStart();
  const after = text.slice(best.index + best[0].length).split(/[,.!?;:|–—]/)[0]!;
  const lead = before.length > 16 ? `…${before.slice(-15).replace(/^\S*\s/, "")}` : before;
  const tail = after.length > 16 ? `${after.slice(0, 15).replace(/\s\S*$/, "")}…` : after.trimEnd();
  return `${lead}${tag}${tail}`.trim();
}

function fixedWidthText(title: string, facts: Facts, capped: boolean): string | null {
  if (/scroll/i.test(title)) return "Too wide for a phone: readers have to scroll sideways";
  const m1 = facts.get("M1")?.value ?? {};
  const width = num(m1, "contentWidth") ?? fromTitle(title, /(?:fixed |is |the )(\d+) ?px/i);
  const k = num(m1, "k") ?? (fromTitle(title, /shrinks? (?:it )?to (\d+)%/i) ?? NaN) / 100;
  const px =
    num(facts.get("T1")?.value ?? {}, "px") ?? fromTitle(title, /becomes ~(\d+(?:\.\d+)?)px/i);
  if (width === null || !Number.isFinite(k)) return capped ? CAP_FALLBACK.CAP_MOBILE_BROKEN! : null;
  const shrink = `the ${width} px layout shrinks to ${Math.round(k * 100)}%`;
  const text = px !== null && k < 0.99 ? `, so body text is about ${round(px)} px` : "";
  if (capped) return `Too wide for a phone: ${shrink}${text}`;
  if (k >= 0.85) return `Slightly too wide for a phone: ${shrink}`;
  return `Doesn't resize for phones: ${shrink}${text}`;
}

/**
 * The card's shorter, plainer line for the fixed-width root cause: what the reader notices on a
 * phone, checkable in the Phone preview, short enough for one line where possible. The measured
 * sentence ("the 700 px layout shrinks to 54%, so body text is about 7.5 px") stays in the detail.
 *  - genuinely broken (CAP_MOBILE_BROKEN, "Bad"): "Too wide for phones: text shrinks to about 7 px,
 *    too small to read" (or the main button, too small to tap; or sideways scrolling);
 *  - readable but not responsive ("Okay"): "Doesn't resize for phones (text ≈ 10 px)".
 */
function fixedWidthCard(title: string, facts: Facts, capped = false): string | null {
  if (/scroll/i.test(title))
    return capped ? "Too wide for phones: readers have to scroll sideways" : null;
  const m1 = facts.get("M1")?.value ?? {};
  const k =
    num(m1, "k") ?? (fromTitle(title, /(?:shrinks? (?:it )?to|shown at) (\d+)%/i) ?? NaN) / 100;
  const px =
    num(facts.get("T1")?.value ?? {}, "px") ??
    fromTitle(title, /(?:becomes ~|about |body text ~)(\d+(?:\.\d+)?) ?px/i);
  if (capped) {
    const button = fromTitle(title, /main button to ~(\d+(?:\.\d+)?) ?px/i);
    if (button !== null)
      return `Too wide for phones: the main button shrinks to about ${Math.round(button)} px, too small to tap`;
    if (px !== null)
      return `Too wide for phones: text shrinks to about ${round(px)} px, too small to read`;
    return Number.isFinite(k)
      ? `Too wide for phones: it shrinks to ${Math.round(k * 100)}%, so the text is too small to read`
      : CAP_FALLBACK.CAP_MOBILE_BROKEN!;
  }
  if (!Number.isFinite(k)) return null;
  if (k >= 0.85) return "Slightly too wide for phones: everything shrinks a little";
  // Rounded as the detail's measured sentence rounds it (fixedWidthText), so the two agree.
  return px !== null
    ? `Doesn't resize for phones (text ≈ ${round(px)} px)`
    : "Doesn't resize for phones: everything gets small";
}

/**
 * A problem in plain, specific words. Values come from the stored checks when present, else from
 * the numbers in the engine's title. null → no rule (the caller shows the tidied title).
 */
function problemText(
  c: Candidate,
  facts: Facts,
  subject: string | null,
  signals: unknown = null,
  render: RenderFacts | null = null,
): string | null {
  const t = c.title;
  // Built by severeProblems / gateLines, already plain.
  if (c.key.startsWith("severe:") || gateBarOf(c.key)) return t || null;
  const cap = capIdOf(c.key);
  if (cap) {
    switch (cap) {
      case "CAP_IMAGE_ONLY": {
        // The same words as the measured problem (picturesText), from the cap's own numbers.
        const chars =
          num(facts.get("I1")?.value ?? {}, "legibleChars") ??
          fromTitle(t, /(\d+) characters of (?:real|live) text/i) ??
          (/^all images, no real text/i.test(t) ? 0 : null);
        return picturesText(signals, chars, render) ?? CAP_FALLBACK.CAP_IMAGE_ONLY!;
      }
      case "CAP_MERGE_TAG": {
        // The tag the reader sees in the email itself leads ("Hi {{ first_name }}"); a tag that is
        // only in the subject is quoted from the subject.
        const tag = /“([^”]{1,60})”/.exec(t)?.[1];
        const atTop = /at the top/i.test(t);
        const alsoSubject = /(?:and|also) in (?:the )?subject/i.test(t);
        if (atTop && tag)
          return `Shows a raw merge tag: “${tag}”${alsoSubject ? " (also in the subject line)" : ""}`;
        const inSubject = /in the subject/i.test(t);
        const snippet = (inSubject || !t) && subject ? mergeTagSnippet(subject) : null;
        if (snippet) return `Shows a raw merge tag in the subject: “${snippet}”`;
        if (tag) return `Shows a raw merge tag${inSubject ? " in the subject" : ""}: “${tag}”`;
        return inSubject
          ? "Shows a raw merge tag in the subject line: placeholder code instead of real text"
          : CAP_FALLBACK.CAP_MERGE_TAG!;
      }
      case "CAP_CONTRAST": {
        const pair =
          contrastPair(null, t) ??
          contrastPair((facts.get("A1")?.value.worst as Value | undefined) ?? null, "");
        const share = fromTitle(t, /^(\d+)% of body text/i);
        return (
          contrastSentence("Body text", pair) ??
          (share !== null
            ? `${share}% of the body text is too faint to read against its background`
            : CAP_FALLBACK.CAP_CONTRAST!)
        );
      }
      case "CAP_MOBILE_BROKEN":
        return fixedWidthText(t, facts, true);
      case "CAP_CLIPPED":
        return clippedText(t, facts, signals);
      case "CAP_BROKEN_IMAGES":
        return brokenImagesText(t, facts) ?? CAP_FALLBACK.CAP_BROKEN_IMAGES!;
      default:
        return null;
    }
  }
  if (c.key === GATE_KEY) return gateText(t, facts);
  if (c.key === "group:fixed-width") return fixedWidthText(t, facts, false);
  if (c.key === "group:no-cta") return noButtonText(facts);
  if (c.key === "group:image-heavy") return imageHeavyText(t, facts, signals);
  const id = checkIdOf(c.key);
  if (!id) return null;
  if (AI_NAMES[id]) {
    const m = /rated (\d)\/5(?: — “([^”]+)”?)?/.exec(t);
    const level = m?.[1] ?? (num(facts.get(id)?.value ?? {}, "level") ?? "?").toString();
    const evidence = m?.[2] ?? str(facts.get(id)?.value ?? {}, "evidence");
    return `${AI_NAMES[id]} rated ${level}/5 by the AI review${evidence ? `: “${evidence}”` : ""}`;
  }
  const v = facts.get(id)?.value ?? {};
  const n = (key: string, re?: RegExp) => num(v, key) ?? (re ? fromTitle(t, re) : null);
  switch (id) {
    case "A1": {
      const worst = isObj(v.worst) ? v.worst : null;
      // Same distinctions as the engine's A1 title: hidden text isn't "hard to read" (it's
      // invisible on purpose or by mistake), fine print and a faint headline are named as such.
      if (worst?.rendered === false || /^some text is hidden/i.test(t))
        return "Some text is hidden: it's the same colour as its background";
      const share = pctOf(num(v, "failShare")) ?? fromTitle(t, /^(\d+)% of (?:the )?text/i);
      const pair = contrastPair(worst, t);
      // Small print (disclaimers, grey metadata lines) is a lesser problem than faint body text:
      // it never leads the card (weakProblem), and says "faint", not "hard to read". Not "footer":
      // A1 never measures the detected footer, so this small text sits above it.
      if (worst?.fine === true || /^the small print/i.test(t)) return finePrintText(pair);
      if (worst?.role === "heading" || /^the headline is too faint/i.test(t))
        return contrastSentence("The headline", pair);
      const who = share !== null && share < 100 ? `${share}% of the text` : "The text";
      return (
        contrastSentence(who, pair) ??
        (share !== null ? `${share}% of the text is too faint to read` : null)
      );
    }
    case "A2": {
      const missing = n("missingAlt", /^(\d+) of \d+ images have no alt/i);
      const images = n("images", /^\d+ of (\d+) images/i);
      if (missing && images)
        return images === 1
          ? "Its only image has no description for people who can't see it"
          : `${missing} of ${images} images ${plural(missing, "has", "have")} no description for people who can't see them`;
      const informative = num(v, "informative");
      const meaningful = num(v, "meaningful");
      const unhelpful =
        fromTitle(t, /^(\d+) informative images/i) ??
        (informative !== null && meaningful !== null ? informative - meaningful : null);
      return unhelpful
        ? `${unhelpful} ${plural(unhelpful, "image has an unhelpful description", "images have unhelpful descriptions")} for people who can't see them`
        : null;
    }
    case "A3": {
      const k =
        fromTitle(t, /^(\d+) links/i) ??
        ((num(v, "generic") ?? 0) + (num(v, "unnamed") ?? 0) || null);
      return k
        ? `${k} ${plural(k, "link just says", "links just say")} “click here” or ${plural(k, "has", "have")} no name`
        : null;
    }
    case "A6": {
      const k = fromTitle(t, /^(\d+) visual headings/i);
      return k
        ? `${k} ${plural(k, "heading isn't", "headings aren't")} marked as a heading for screen readers`
        : null;
    }
    case "A7": {
      const small = n("small", /^(\d+) of/i);
      const targets = n("targets", /of (\d+) standalone/i);
      return small && targets
        ? `${small} of ${targets} links are too small to tap on a phone`
        : null;
    }
    case "A8": {
      const k = n("indistinct", /^(\d+) links/i);
      return k
        ? `${k} ${plural(k, "link in the text is", "links in the text are")} shown by colour alone`
        : null;
    }
    case "A12":
      return "On phones, screen readers read it in a different order than it looks";
    case "M1":
      return fixedWidthText(t, facts, false);
    case "M2": {
      const k = pctOf(num(v, "kNomq")) ?? fromTitle(t, /shrinks to (\d+)%/i);
      return k !== null
        ? `In email apps that ignore phone styles, the layout shrinks to ${k}%`
        : null;
    }
    case "M3": {
      const wide = num(v, "wideShare");
      const p =
        wide !== null ? Math.round((1 - wide) * 100) : fromTitle(t, /^(\d+)% of body text/i);
      return p !== null ? `On phones, ${p}% of the text is squeezed into narrow columns` : null;
    }
    case "M4": {
      // Sized by the button a reader sees (2026.5); when only its words are a link, that's the
      // problem, not the size (the engine's own distinction).
      const px = n("minSidePx", /(?:tap area is|only) ([\d.]+) ?px/i);
      const label = labelOf(v, t);
      if ((v.textOnlyTap === true && (px ?? 0) >= 40) || /only the text of/i.test(t))
        return `Only the words on the main button${label ? ` ${label}` : ""} can be tapped, not the whole button`;
      // 44 px is the comfortable size; a little under it is "small", well under it "hard to tap".
      if (px === null) return null;
      return px < 30
        ? `The main button is only ${round(px)} px tall on a phone — hard to tap`
        : `The main button is a little small to tap on a phone (${round(px)} px tall)`;
    }
    case "M5": {
      const o = n("overflowing", /\((\d+) overflow/i) ?? 0;
      const d = n("distorted", /(\d+) distorted/i) ?? 0;
      const b = n("blurry", /(\d+) blurry/i) ?? 0;
      const parts = [
        o > 0
          ? `${o} ${plural(o, "image sticks", "images stick")} out past the phone screen`
          : null,
        d > 0 ? `${d} ${plural(d, "image looks", "images look")} stretched on phones` : null,
        b > 0
          ? `${b} ${plural(b, "image looks", "images look")} blurry on sharp (Retina) screens`
          : null,
      ].filter((x): x is string => x !== null);
      return parts.length ? cap1(parts.join("; ")) : null;
    }
    case "M6": {
      const p = pctOf(num(v, "fullText")) ?? fromTitle(t, /\((\d+)% of text/i);
      if (p === null) return null;
      if (p >= 100) return "Parts of it, like a transparent logo, can vanish in dark mode";
      return p === 0
        ? "In dark mode the text becomes hard to read"
        : `In dark mode, ${100 - p}% of the text becomes hard to read`;
    }
    case "M7": {
      const ok = num(v, "okShare");
      const p = ok !== null ? Math.round((1 - ok) * 100) : fromTitle(t, /^(\d+)% of body text/i);
      return p !== null ? `On phones, ${p}% of the text runs right to the screen edge` : null;
    }
    case "T1": {
      const px = n("px", /is ([\d.]+)px on phones/i);
      if (px === null) return null;
      return px >= 14
        ? `Body text is a little small on phones (${round(px)} px)`
        : `Body text is only ${round(px)} px on phones`;
    }
    case "T2": {
      const px = n("px", /is ([\d.]+)px on desktop/i);
      return px !== null ? `Body text is only ${round(px)} px on desktop` : null;
    }
    case "T3": {
      const r = n("ratio", /\(([\d.]+)× the font/i);
      // T3's comfortable spacing is 1.4× or more: just under it is "a little close".
      if (r === null) return "Lines of text are close together";
      return r < 1.2
        ? `Lines of text are squeezed together (line spacing ${round(r)}×)`
        : `Lines of text are a little close together (line spacing ${round(r)}×)`;
    }
    case "T4": {
      const k = n("charsPerLine", /average (\d+) characters/i);
      if (k === null) return null;
      const long = v.cjk === true ? k > 40 : k > 80;
      // T4's comfortable range is 45–80 characters; "very" only well below it.
      return long
        ? `Lines are long (about ${Math.round(k)} characters), which tires the eye`
        : `Lines are ${k < 25 ? "very " : ""}short (about ${Math.round(k)} characters)`;
    }
    case "T5": {
      const p = pctOf(num(v, "badShare")) ?? fromTitle(t, /^(\d+)%/);
      return p !== null
        ? `${p}% of the body text is justified or centred in long paragraphs`
        : null;
    }
    case "T6": {
      const f = n("families", /\((\d+) families/i);
      const s = n("sizes", /(\d+) sizes/i);
      return f !== null && s !== null
        ? `Too many text styles: ${f} fonts and ${s} sizes`
        : "Too many text styles";
    }
    case "T7": {
      const p = pctOf(num(v, "capsShare")) ?? fromTitle(t, /^(\d+)%/);
      return p !== null ? `${p}% of the body text is in ALL CAPS` : null;
    }
    case "T8":
      return "The wording is hard to read: long sentences and complex words";
    case "H1":
      return noButtonText(facts);
    case "H2": {
      if (v.present === false || /no primary call to action/i.test(t)) return noButtonText(facts);
      const screens = n("screens", /ends ([\d.]+) screens/i);
      const label = labelOf(v, t);
      return screens !== null
        ? `The main button${label ? ` ${label}` : ""} is ${round(screens)} screens down on a phone`
        : null;
    }
    case "H3": {
      // No main button at all: say so, not "it doesn't stand out".
      if (v.present === false) return noButtonText(facts);
      // The engine's distinctions (2026.5): a button that stands out (a bold fill, the most
      // prominent link) can still have faint words, or a fill a little short of ideal; a bold
      // button that a bigger link outweighs isn't "not standing out" either. That link can be
      // anywhere in the email (the render compares the button with every link, above or below
      // it), so the line never says it comes first.
      const label = labelOf(v, t);
      const button = `the main button${label ? ` ${label}` : ""}`;
      const salience = num(v, "salience") ?? signalNum(signals, "ctaSalience");
      const top =
        typeof v.mostProminent === "boolean"
          ? v.mostProminent
          : (signalObj(signals)?.ctaMostProminent ?? null);
      const contrast = num(v, "labelContrast");
      const filled = salience !== null && salience >= CTA_SALIENCE_MIN;
      if (
        /is hard to read/i.test(t) ||
        (filled &&
          top === true &&
          contrast !== null &&
          contrast < (v.labelLarge === true ? 3 : 4.5))
      )
        return `The words on ${button} are hard to read${contrast !== null ? ` (${ratioText(contrast)})` : ""}`;
      if (/outweighs/i.test(t) || (filled && top === false))
        return `Another link or picture in the email is bigger than ${button}`;
      if (/could contrast a little more/i.test(t) || (filled && top === true))
        return `${cap1(button)}'s colour could stand out a little more`;
      return `${cap1(button)} doesn't stand out`;
    }
    case "H4": {
      const label = labelOf(v, t);
      return label ? `The button label ${label} is vague` : "The button label is vague";
    }
    case "H5": {
      // H5 counts the different actions among the buttons in the first two phone screens.
      const k = n("distinct", /^(\d+) different/i);
      return k !== null
        ? `${k} different buttons compete for attention in the first two phone screens`
        : null;
    }
    case "H6": {
      // No heading text at all (2026.5): "No headline" — "barely bigger" would imply there is one.
      if (v.headline === false || /^no headline/i.test(t))
        return v.pictures === true || /in live text/i.test(t)
          ? "No headline in real text (it may be in a picture)"
          : "No headline";
      const r = n("ratio", /\(([\d.]+)×\)/);
      // No bigger text at all at the top: there's no headline to call "barely bigger".
      if (r !== null && r < 1.15)
        return "No headline that stands out: the biggest text at the top is the size of the body text";
      return `The headline is barely bigger than the body text${r !== null ? ` (${round(r)}×)` : ""}`;
    }
    case "I1":
      return imageHeavyText(t, facts, signals);
    case "I2": {
      const chars = n("firstViewportChars", /has (\d+) characters/i);
      const imgButton = v.ctaLive === false || /button is an image/i.test(t);
      if (chars === null) return null;
      if (chars === 0)
        return `The top of the email is all picture, no real text${imgButton ? ", and the button is a picture" : ""}`;
      return `The top of the email has only ${chars} characters of real text${imgButton ? ", and the button is a picture" : ""}`;
    }
    case "I3":
      return brokenImagesText(t, facts);
    case "I4": {
      const p = pctOf(num(v, "ratio")) ?? fromTitle(t, /only (\d+)%/i);
      return p !== null
        ? `With images turned off, only ${p}% of the top of the email is left`
        : null;
    }
    case "I5": {
      const bytes = num(v, "bytes");
      const mb =
        bytes !== null
          ? Math.round((bytes / 1048576) * 10) / 10
          : fromTitle(t, /weigh ([\d.]+) MB/i);
      return mb !== null ? `Images are heavy (${mb} MB), so it loads slowly` : null;
    }
    case "L1": {
      const w = n("width", /is (\d+)px wide/i);
      if (w === null) return null;
      return w < 440
        ? `The content column is narrow on desktop (${w} px)`
        : `The content column is very wide on desktop (${w} px)`;
    }
    case "L2":
      return "Spacing feels unbalanced: cramped in places or very sparse";
    case "L3":
      return "The layout looks cluttered";
    case "L4": {
      const k = n("anchors", /use (\d+) different/i);
      return k !== null ? `Text blocks don't line up (${k} different edges)` : null;
    }
    case "L5": {
      const k = num(v, "textColours") ?? fromTitle(t, /(\d+) text colours/i);
      return k !== null ? `Too many colours (${k} text colours)` : "Too many colours";
    }
    case "L6": {
      const k = n("buttonStyles", /\((\d+) button styles/i);
      return k !== null ? `Buttons look inconsistent (${k} different styles)` : null;
    }
    case "L7":
      if (v.logoTop === false || /no logo/i.test(t)) return "No logo at the top on phones";
      return "Too many accent colours";
    case "C1": {
      if (v.empty === true || /empty/i.test(t)) return "The subject line is empty";
      const words = n("words", /\((\d+) words/i);
      const caps = v.allCaps === true || /all caps/i.test(t);
      return words !== null
        ? `The subject line is long (${words} words${caps ? ", in capitals" : ""})`
        : null;
    }
    case "C2": {
      if (v.boilerplate === true || /boilerplate/i.test(t))
        return "The inbox preview text is boilerplate, like “View in browser”";
      const len = n("length", /\((\d+) characters/i);
      if (len === null) return null;
      // Engine credit bands (C2): best at 40–130 characters, −0.3 when it repeats the subject.
      if (len > 130)
        return `The inbox preview text is too long (${len} characters), so it gets cut off`;
      if (len < 40) return `The inbox preview text is very short (${len} characters)`;
      if ((num(v, "similarity") ?? 0) > 0.8)
        return "The inbox preview text just repeats the subject";
      return `The inbox preview text could work harder (${len} characters)`;
    }
    case "C3":
      return "Long passages with no subheadings or lists";
    case "C5": {
      const k = n("screens", /is ([\d.]+) phone screens/i);
      return k !== null ? `Very long: ${round(k)} phone screens` : null;
    }
    case "X1": {
      const bytes = num(v, "bytes");
      const kb = bytes !== null ? bytes / 1000 : fromTitle(t, /(\d+(?:\.\d+)?) KB/i);
      if (kb === null) return null;
      return isClipX1(t, facts)
        ? clippedText(t, facts, signals, false)
        : `At ${Math.round(kb)} KB it's close to the size where Gmail cuts emails off (${GMAIL_CLIP_KB} KB)`;
    }
    case "X2":
      return "Uses code that some email apps don't support, so it may look different there";
    case "X3":
      if (isMergeX3(t, facts))
        return "Shows a raw merge tag: placeholder code instead of real text";
      if (v.badHrefs === true || /empty or broken/i.test(t))
        return "Some links are empty or broken";
      if (v.placeholder === true || /placeholder/i.test(t))
        return "Some links point to placeholder addresses";
      return "Some links use insecure http";
    case "U1":
      return isUnsubAfterClip(t, facts)
        ? "The unsubscribe link is hidden by Gmail's cut-off"
        : "No visible unsubscribe link";
    case "U2": {
      // Worded by the visible cause, at the size a reader sees on desktop (cssPx): a link that is
      // small only on phones is the fixed-width layout's symptom and folded into it (rootOf).
      const own = num(v, "cssPx");
      const contrast = num(v, "contrast");
      const faint = contrast !== null && contrast < 4.5;
      const tiny = own !== null && own < 12;
      if (faint && tiny)
        return `The unsubscribe link is tiny (${round(own)} px) and faint (${ratioText(contrast)} contrast)`;
      if (faint)
        return `The unsubscribe link is faint (${ratioText(contrast)} contrast) and hard to see`;
      if (tiny) return `The unsubscribe link is tiny (${round(own)} px)`;
      const px = n("px", /is ([\d.]+)px/i);
      return px !== null
        ? `The unsubscribe link is tiny or faint (${round(px)} px)`
        : "The unsubscribe link is tiny or faint";
    }
    case "U3":
      return "No link to choose how often you get these emails";
    case "U4":
      return "Doesn't say why you're getting this email";
    default:
      return null;
  }
}

/**
 * The Excellent gate's reason in plain words, for summaries without the per-bar signals
 * (`gateLines` words those): the v1.3 rule's "plain design" (no real headline and no button that
 * stands out). "Doesn't stand out" only when there is a button and its fill really is weak: a
 * bold button whose only fault is faint words is H3's own problem, not this one.
 */
function gateText(title: string, facts: Facts): string | null {
  const check = gateCheckOf(title);
  if (check === "H6") {
    const ratio =
      num(facts.get("H6")?.value ?? {}, "ratio") ?? fromTitle(title, /headline ([\d.]+)×/i);
    const h3 = facts.get("H3")?.value ?? {};
    const salience = num(h3, "salience");
    const weak = /weak button/i.test(title) || h3.present === true;
    const button = !weak
      ? "no main button"
      : salience !== null && salience >= CTA_SALIENCE_MIN
        ? "a main button that a bigger link outweighs"
        : "a main button that doesn't stand out";
    const head =
      ratio === null
        ? "no headline"
        : ratio < 1.15
          ? "a headline no bigger than the text"
          : `a headline only ${round(ratio)}× the text size`;
    return `A plain design: ${head}, and ${button}`;
  }
  return null; // the phone-layout titles are already plain ("On phones, 100% of the text …")
}

/** "100%"-style share, never rounded up to the bar it misses (7.9% of a needed 8% reads "7%"). */
export function pctBelow(share: number): string {
  const p = share * 100;
  return p > 0 && p < 1 ? "under 1%" : `${Math.floor(p)}%`;
}

/**
 * The Excellent gate's failed bars (signals.gate, current summaries) as "not Good because" lines,
 * each with what was measured and what Good needs, in the gate's order: headline, button,
 * imagery, hero, phone layout. [] when the signals don't say (older summaries: `gateText` then words
 * the engine's single item).
 */
function gateLines(signals: unknown, facts: Facts, gateTitle: string): Candidate[] {
  const bars = signalObj(signals)?.gate;
  if (!Array.isArray(bars)) return [];
  const failed = GATE_BARS.filter((b) => bars.includes(b));
  const h3 = facts.get("H3")?.value ?? {};
  const label = labelOf(h3, "");
  const button = `the main button${label ? ` ${label}` : ""}`;
  const out: Candidate[] = [];
  for (const bar of failed) {
    let text: string | null = null;
    switch (bar) {
      case "headline": {
        const ratio = signalNum(signals, "headlineRatio");
        const pictures =
          facts.get("H6")?.value.pictures === true ||
          (signalNum(signals, "htmlContentImages") ?? 0) > 0;
        if (signalObj(signals)?.hasHeadline === false)
          text = `No headline${pictures ? " in real text" : ""} (Good needs one at least ${HEADLINE_RATIO_MIN}× the body text)`;
        else
          text =
            ratio !== null
              ? `No real headline (the biggest text is ${round(Math.floor(ratio * 10) / 10)}× the body text; Good needs ${HEADLINE_RATIO_MIN}×)`
              : `No real headline (Good needs one at least ${HEADLINE_RATIO_MIN}× the body text)`;
        break;
      }
      case "button": {
        const salience = signalNum(signals, "ctaSalience");
        if (salience === null)
          text = noButtonText(facts).startsWith("No real button")
            ? "No real button: any button here is part of a picture (Good needs one that stands out)"
            : "No main button (Good needs one that stands out)";
        else if (salience < CTA_SALIENCE_MIN)
          text = `${cap1(button)} doesn't stand out enough: its colour is close to the background's`;
        // G2 (methodology 2026.6): three or more look-alike buttons for different actions.
        else if (signalObj(signals)?.ctaCompeting === true)
          text =
            "No main button: several buttons look the same and lead to different actions (Good needs one that stands out)";
        else {
          // Filled and bold, but it doesn't lead: not the most prominent link, not up top. The
          // bigger link can be anywhere in the email, above or below the button.
          const low = signalObj(signals)?.ctaFirstScreen === false;
          const outweighed = signalObj(signals)?.ctaMostProminent === false;
          text =
            low && outweighed
              ? `${cap1(button)} sits below the first phone screen, and another link or picture is bigger`
              : low
                ? `${cap1(button)} sits below the first phone screen`
                : `Another link or picture in the email is bigger than ${button}`;
        }
        break;
      }
      case "imagery": {
        const share = signalNum(signals, "imgShare") ?? 0;
        text = `Few pictures for this kind of email (${pctBelow(share)}; Good needs ${Math.round(IMAGERY_SHARE_MIN * 100)}%)`;
        break;
      }
      case "imagery_unknown":
        text = "Most of its pictures couldn't be loaded, so they can't count toward Good";
        break;
      // G4 (methodology 2026.6): a stock template look — a logo, a plain headline, a button.
      case "hero":
        text = "No large picture and no headline on a coloured band (Good needs one of the two)";
        break;
      case "phone_narrow":
      case "phone_edge": {
        const narrow = bar === "phone_narrow";
        const v = facts.get(narrow ? "M3" : "M7")?.value ?? {};
        const okShare = num(v, narrow ? "wideShare" : "okShare");
        const p =
          okShare !== null
            ? Math.round((1 - okShare) * 100)
            : fromTitle(
                gateTitle,
                narrow ? /(\d+)% of the text is squeezed/i : /(\d+)% of the text runs/i,
              );
        const what = narrow ? "is squeezed into narrow columns" : "runs right to the screen edge";
        text =
          p !== null
            ? `On phones, ${p}% of the text ${what} (Good needs under ${Math.round(PHONE_PROBLEM_SHARE * 100)}%)`
            : `On phones, much of the text ${what}`;
        break;
      }
    }
    if (text) out.push({ key: `gate:${bar}`, title: text });
  }
  return out;
}

/**
 * No main button in live text. When the main action is itself a picture (I2 found it isn't live
 * text: Betterbrand's "Shop Betterbrand", Chanty's "Shop my bike"), "no clear button" would read as
 * false: say it isn't a real button instead. Pictures covering most of the email aren't enough on
 * their own — Naasa's background pictures sit behind live-text links.
 */
function noButtonText(facts: Facts): string {
  return facts.get("I2")?.value.ctaLive === false
    ? "No real button for the main action: any button here is part of a picture"
    : "No clear button for the main action";
}

/** The picture share I1 measured (else the saved signal), or null. */
function pictureShare(facts: Facts, signals: unknown): number | null {
  return num(facts.get("I1")?.value ?? {}, "imgShare") ?? signalNum(signals, "imgShare");
}

/**
 * Little real text next to the pictures (I1), as measured: "Pictures cover 25% of it, with only
 * 242 characters of real text". Never "Mostly pictures" — that is the Problems option the Bad rule
 * lists (an email that is pictures with under 200 characters of real text, worded "Most of this
 * email is pictures: …" by its own line), and an email with a banner over a full text section
 * isn't mostly pictures. The share is kept under the half it may miss (0.499 never reads "50%").
 */
function imageHeavyText(title: string, facts: Facts, signals: unknown): string | null {
  const chars =
    num(facts.get("I1")?.value ?? {}, "legibleChars") ??
    signalNum(signals, "legibleChars") ??
    fromTitle(title, /(\d+) characters/i);
  const share = pictureShare(facts, signals);
  const text =
    chars !== null
      ? `only ${chars} ${plural(chars, "character", "characters")} of real text`
      : "very little real text";
  if (share === null) return `${cap1(text)} next to the pictures`;
  const half = Math.round(IMAGE_TEXT_SHARE_MIN * 100);
  const p = Math.round(share * 100);
  return `Pictures cover ${share < IMAGE_TEXT_SHARE_MIN ? Math.min(p, half - 1) : Math.max(p, half)}% of it, with ${text}`;
}

/**
 * What Gmail does with an email past its size limit, with the size and the limit, and what the
 * cut hides: the unsubscribe link (signals.unsubscribeUnion / U1 "after_clip") and / or the main
 * button (the clip cap's "before the button"), else the share of the email it hides. Those are the
 * Bad rule ("Gmail cuts this email off …", the "Gmail cuts off key parts" Problems option); an
 * email just past the limit whose cut hides none of that (`cap` false: X1 alone) reads "Over
 * Gmail's size limit …", so only Bad designs carry the option's words.
 */
function clippedText(title: string, facts: Facts, signals: unknown, cap = true): string {
  const x1 = facts.get("X1")?.value ?? {};
  const bytes = num(x1, "bytes");
  const kb =
    signalNum(signals, "htmlKB") ??
    (bytes !== null ? bytes / 1000 : fromTitle(title, /(\d+(?:\.\d+)?) KB/i));
  // "102 KB; Gmail's limit is 102 KB" would read as no problem at all.
  const sizeOf = (limit: string) =>
    kb === null
      ? ""
      : ` (${kb >= GMAIL_CLIP_KB + 0.5 ? `${Math.round(kb)} KB` : `just over ${GMAIL_CLIP_KB} KB`}; ${limit} is ${GMAIL_CLIP_KB} KB)`;
  const size = sizeOf("Gmail's limit");
  const unsub =
    signalStr(signals, "unsubscribeUnion") === "after_clip" ||
    facts.get("U1")?.value.unsubscribe === "after_clip";
  const button = /before the (?:main )?button/i.test(title);
  const hidden = [button ? "the main button" : null, unsub ? "the unsubscribe link" : null].filter(
    (x): x is string => x !== null,
  );
  if (hidden.length) return `Gmail cuts this email off${size} and hides ${hidden.join(" and ")}`;
  const miss = fromTitle(title, /miss (\d+)% of it/i);
  if (miss !== null) return `Gmail cuts this email off${size}, hiding ${miss}% of it`;
  if (cap) return `Gmail cuts this email off${size}: readers see [Message clipped]`;
  const after = num(x1, "afterShare");
  const tail =
    after !== null && after > 0
      ? `the last ${Math.max(1, Math.round(after * 100))}% of it is behind “[Message clipped]”`
      : "the end of it is behind “[Message clipped]”";
  return `Over Gmail's size limit${sizeOf("the limit")}: ${tail}`;
}

/** Load reasons that mean a picture was too large for our renderer (render images.loads). */
export const TOO_BIG_REASONS: ReadonlySet<string> = new Set([
  "too_large",
  "too_many_pixels",
  "budget",
]);

/**
 * "Most of this email is pictures": when the pictures weren't drawn at all (signals
 * drawnContentImages = 0), that they didn't load, which is what the preview shows — and whose
 * side that was on: too big for us to load (every reason the stored render gives is a size
 * limit), something else on our side (imagesUnknownShare: reasons that say nothing about the
 * design), else they didn't load (the sender's server failed them). `chars` is the real text left
 * (null = not known: no sentence).
 */
function picturesText(
  signals: unknown,
  chars: number | null,
  render: RenderFacts | null = null,
): string | null {
  const notLoaded = severeTriggers(signals).includes("pictures_not_loaded");
  const live = notLoaded ? signalNum(signals, "liveTextChars") : chars;
  if (live === null) return null;
  const n = Math.round(live);
  let what = "pictures";
  if (notLoaded) {
    const one = signalNum(signals, "htmlContentImages") === 1;
    const reasons = render?.missedImageReasons ?? [];
    const ours = (signalNum(signals, "imagesUnknownShare") ?? 0) > IMAGES_UNKNOWN_SHARE_MAX;
    what =
      reasons.length > 0 && reasons.every((r) => TOO_BIG_REASONS.has(r))
        ? one
          ? "one huge picture (too big for us to load)"
          : "huge pictures (too big for us to load)"
        : ours
          ? one
            ? "one picture we couldn't load"
            : "pictures we couldn't load"
          : one
            ? "one picture that didn't load"
            : "pictures that didn't load";
  }
  return n === 0
    ? `Most of this email is ${what}, with no real text at all`
    : `Most of this email is ${what}: only ${n} ${plural(n, "character", "characters")} of real text`;
}

/**
 * Text size on a phone to one decimal, as "How we judged this" words it (lib/gallery-evidence.ts
 * px), never rounded onto the bar it is under (12.46 under 12.5 reads "12.4"): "10.5", "11".
 */
function phonePx(px: number, bar: number): string {
  const r = Math.round(px * 10) / 10;
  return String(px < bar && r >= bar ? Math.floor(px * 10) / 10 : r);
}

/** Faint small print, in the colours a reader can check ("The small print is faint: …"). */
function finePrintText(pair: { fg: string; bg: string; ratio: number | null } | null): string {
  const fg = pair ? colourName(pair.fg) : null;
  const bg = pair ? colourName(pair.bg) : null;
  const ratio = pair?.ratio ?? null;
  const how = ratio !== null && ratio >= 4 ? "a little faint" : "faint";
  if (!fg || !bg) return `The small print is ${how}`;
  return `The small print is ${how}: ${fg} on ${bg}${ratio !== null ? ` (${ratioText(ratio)})` : ""}`;
}

function brokenImagesText(title: string, facts: Facts): string | null {
  const v = facts.get("I3")?.value ?? {};
  // SVG images only (2026.5): Gmail doesn't show SVG, so they're not broken links.
  const svg =
    num(v, "svg") ??
    fromTitle(title, /^(\d+) images are svgs/i) ??
    (/^an image is an svg/i.test(title) ? 1 : 0);
  if (svg > 0 && !num(v, "failed"))
    return svg === 1
      ? "One image is an SVG file, which Gmail doesn't show"
      : `${svg} images are SVG files, which Gmail doesn't show`;
  const broken = num(v, "failed") ?? fromTitle(title, /^(\d+) of \d+ images/i);
  const evaluated = num(v, "evaluated") ?? fromTitle(title, /^\d+ of (\d+) images/i);
  if (!broken || !evaluated) return null;
  if (evaluated === 1) return "Its only image doesn't load (broken link)";
  if (broken >= evaluated) return `None of its ${evaluated} images load (broken links)`;
  return `${broken} of ${evaluated} images don't load (broken links)`;
}

/** A verdict's severe problem (severeTriggers) in plain words: the detail line and the card line. */
interface SevereProblem {
  key: `severe:${SevereTrigger}`;
  detail: string;
  card: string;
}

/**
 * The severe problems the signals show, in the words the reader can check: the numbers come from
 * the same saved signals the verdict read, so they are there after compaction too.
 */
function severeProblems(
  signals: unknown,
  primaryType?: string | null,
  render: RenderFacts | null = null,
): SevereProblem[] {
  return severeTriggers(signals, primaryType).map((t): SevereProblem => {
    switch (t) {
      case "pictures_not_loaded":
      case "text_in_images": {
        const text =
          picturesText(signals, signalNum(signals, "legibleChars") ?? 0, render) ??
          CAP_FALLBACK.CAP_IMAGE_ONLY!;
        return { key: `severe:${t}`, detail: text, card: text };
      }
      case "tiny_phone_text": {
        const px = phonePx(
          signalNum(signals, "phoneTextPx") ?? 0,
          currentSignals(signals) ? TINY_PHONE_TEXT_PX : LEGACY_TINY_PHONE_TEXT_PX,
        );
        const k = signalNum(signals, "layoutK") ?? 1;
        return {
          key: `severe:${t}`,
          detail: `Doesn't fit phones: the layout shrinks to ${Math.round(k * 100)}%, so body text is only about ${px} px`,
          card: `Doesn't fit phones: text shrinks to about ${px} px`,
        };
      }
      case "unsubscribe_clipped": {
        const text = clippedText("", new Map(), signals);
        return { key: `severe:${t}`, detail: text, card: text };
      }
      case "no_unsubscribe": {
        // Current rules: only marketing mail needs one, so the line says why it matters.
        const text = currentSignals(signals)
          ? "No unsubscribe link anywhere in this marketing email"
          : "No unsubscribe link anywhere in the email";
        return { key: `severe:${t}`, detail: text, card: text };
      }
    }
  });
}

/** The main button stands out: a bold fill (H3 salience ≥ 0.9) and the most prominent link. */
function mainButtonLeads(facts: Facts, signals: unknown): boolean {
  const h3 = facts.get("H3")?.value ?? {};
  const salience = num(h3, "salience") ?? signalNum(signals, "ctaSalience");
  const top =
    typeof h3.mostProminent === "boolean" ? h3.mostProminent : signalObj(signals)?.ctaMostProminent;
  return salience !== null && salience >= CTA_SALIENCE_MIN && top === true;
}

/** How many different looks its buttons have (L6, else the stored render), or null. */
function buttonStylesOf(facts: Facts, render: RenderFacts | null): number | null {
  return num(facts.get("L6")?.value ?? {}, "buttonStyles") ?? render?.buttonStyles ?? null;
}

/**
 * The main button is one of several that look the same — one button look, and two or more
 * different actions (H5 in the first two phone screens, or the render's labels) or three or more
 * buttons — so it doesn't stand out from the others (Google's three blue "Try AI in …" pills,
 * three navy "Explore course" buttons). A button repeated at the end ("Try Flux 3" twice) is one.
 */
function equalButtons(facts: Facts, render: RenderFacts | null): boolean {
  if (buttonStylesOf(facts, render) !== 1) return false;
  const distinct = num(facts.get("H5")?.value ?? {}, "distinct");
  return (distinct ?? 0) >= 2 || (render?.buttonLabels ?? 0) >= 2 || (render?.buttons ?? 0) >= 3;
}

/**
 * The main button is a picture (its words aren't live text): I2's `ctaLive` false, or H3 measured a
 * button without a label contrast (the engine's sign of an image button).
 */
function pictureButton(facts: Facts, signals: unknown): boolean {
  if (facts.get("I2")?.value.ctaLive === false) return true;
  const h3 = facts.get("H3")?.value;
  if (h3 && h3.present === true) return h3.labelContrast === null;
  return (
    signalNum(signals, "ctaSalience") !== null && signalObj(signals)?.ctaLabelContrast === null
  );
}

/** What problemList knows about the email besides its explanation items. */
interface ProblemContext {
  subject: string | null;
  /** The verdict's signals (VerdictInput.signals). */
  signals: unknown;
  /** The email's type now (email.primary_type; else the type the score used), or null. */
  primaryType: string | null;
  /** Facts from the stored render and HTML pass (null once compacted, or not given). */
  render: RenderFacts | null;
  /** The footer statements and stray-text note come from the current HTML pass (currentHtmlPass). */
  htmlPass: boolean;
}

/**
 * Problems a reader may not notice on their own, or that a measurement can overstate: listed in
 * the detail, but never the card's one line (`weakProblem`), where the next problem leads instead.
 *  - faint small print (disclaimers, grey metadata), never the main text;
 *  - text in narrow columns on under half the text (a logo next to a job title, a card grid);
 *  - line length (a sample of table labels reads "about 5 characters");
 *  - images without a description (the count can't tell a photo from an icon);
 *  - phone styles some apps ignore (only listed when the email doesn't fit phones anyway);
 *  - no main button (only listed when backed up, and a letter or a notice needs none) — except
 *    the Excellent gate's "No main button (Good needs one that stands out)", which says why the
 *    email isn't Good, true of any email without one.
 */
function weakProblem(c: Candidate, facts: Facts, text: string, signals: unknown): boolean {
  if (noButtonClaim(c, facts, signals)) return gateBarOf(c.key) === null;
  const id = checkIdOf(c.key);
  if (id === "A1") return /^the small print/i.test(text);
  if (id === "M3") {
    const wide = num(facts.get("M3")?.value ?? {}, "wideShare");
    const p = wide !== null ? (1 - wide) * 100 : fromTitle(text, /(\d+)% of the text/i);
    return p === null || p < PHONE_PROBLEM_SHARE * 100;
  }
  return id === "T4" || id === "A2" || id === "M2";
}

/**
 * Problems, root cause first, one per root cause, in plain words (up to `LIST_MAX`), plus every
 * root cause present (to drop strengths that contradict them). Caps lead, then the verdict's
 * severe problems (`severe`), then everything else in the engine's order — the Excellent gate's
 * item first, as one "not Good because" line per failed bar when the signals name them. `card`
 * is the card's line when it isn't simply the first problem: a shorter wording, or the first
 * problem that isn't weak (`weakProblem`); undefined when no problem may lead the card.
 */
function problemList(
  summary: SummaryLike,
  facts: Facts,
  capIds: readonly string[],
  ctx: ProblemContext,
  severe: readonly SevereProblem[] = [],
): { texts: string[]; roots: Set<string>; card: string | null | undefined } {
  const fromSummary = candidates(summary?.needsImprovement);
  const summaryCut = legacySummaryCut(summary);
  const all: Candidate[] = [];
  for (const c of fromSummary) {
    // The gate's single item → one line per failed bar, when the saved signals name them.
    const lines = c.key === GATE_KEY ? gateLines(ctx.signals, facts, c.title) : [];
    all.push(...(lines.length ? lines : [c]));
  }
  const keys = new Set(all.map((c) => c.key));
  // Caps the summary doesn't explain (older rows, or caps list only).
  for (const cap of capIds) {
    if (keys.has(`cap:${cap}`)) continue;
    all.push({ key: `cap:${cap}`, title: "" });
    keys.add(`cap:${cap}`);
  }
  const severeCard = new Map<string, string>();
  for (const s of severe) {
    all.push({ key: s.key, title: s.detail });
    keys.add(s.key);
    severeCard.set(s.key, s.card);
  }
  // Further problems from the stored checks (the summary keeps only its top 3).
  const lostChecks = [...facts.entries()]
    .filter(([id, f]) => f.lost >= 0.05 && !keys.has(`check:${id}`) && !keys.has(`ai:${id}`))
    .sort((a, b) => b[1].lost - a[1].lost || a[0].localeCompare(b[0]));
  for (const [id] of lostChecks) all.push({ key: `check:${id}`, title: "" });

  const layoutK = num(facts.get("M1")?.value ?? {}, "k") ?? signalNum(ctx.signals, "layoutK");
  const noButtonOk = noButtonBackedUp(ctx.render) === true;
  const visible = all.filter((c) => {
    const id = checkIdOf(c.key);
    // The stray-text note and the footer statements only from the current HTML pass.
    if (HTML_PASS_NOTES.has(c.key) && !ctx.htmlPass) return false;
    if (id && HTML_PASS_CHECKS.has(id) && !ctx.htmlPass) return false;
    // "No main button" only when the stored render and HTML pass back it up (noButtonBackedUp).
    if (noButtonClaim(c, facts, ctx.signals) && !noButtonOk) return false;
    // How much of it is pictures isn't known when most of the picture area wasn't drawn.
    if ((id === "I1" || c.key === "group:image-heavy") && picturesUnknown(ctx.signals))
      return false;
    // A main button that stands out over buttons of another look (a filled "Get started" above
    // outline "Start sharing" / "Search for jobs") isn't competing with them.
    if (
      id === "H5" &&
      mainButtonLeads(facts, ctx.signals) &&
      (buttonStylesOf(facts, ctx.render) ?? 0) >= 2
    )
      return false;
    if (id === "X3") return isMergeX3(c.title, facts);
    if (id === "H6") {
      // A headline 1.5× the body text or more is a real headline (the engine's Excellent gate
      // counts it); a small shortfall from the ideal isn't a problem worth naming.
      const r = num(facts.get("H6")?.value ?? {}, "ratio") ?? fromTitle(c.title, /\(([\d.]+)×\)/);
      if (r !== null && r >= HEADLINE_RATIO_MIN) return false;
      // Feeds, replies, letters and notices have no headline by design: only marketing mail is
      // faulted for it (the gate's line still says why such an email isn't Good).
      if (ctx.primaryType !== null && !HEADLINE_TYPES.has(ctx.primaryType)) return false;
    }
    // "In apps that ignore phone styles…" is a what-if: not a problem for an email that fits.
    if (id === "M2" && layoutK !== null && layoutK >= LEGACY_SHRINK_K_MAX) return false;
    // Images without a description when the email has no real pictures (tracking pixels, spacers).
    if (id === "A2" && signalNum(ctx.signals, "htmlContentImages") === 0) return false;
    // A missing unsubscribe link is a fault in marketing mail (the verdict's own rule); account,
    // app and welcome mail is often transactional ("This is a transactional email") and needs none.
    if (
      id === "U1" &&
      currentSignals(ctx.signals) &&
      !isUnsubAfterClip(c.title, facts) &&
      signalStr(ctx.signals, "unsubscribeUnion") !== "after_clip" &&
      ctx.primaryType !== null &&
      !UNSUBSCRIBE_TYPES.has(ctx.primaryType)
    )
      return false;
    return !(id && INVISIBLE.has(id));
  });
  const gateItem = visible.find((c) => c.key === GATE_KEY);
  const gateCheck = gateItem ? gateCheckOf(gateItem.title) : null;
  const capRank = (c: Candidate) => {
    const cap = capIdOf(c.key);
    if (!cap) {
      const s = SEVERE_ORDER.indexOf(c.key.replace(/^severe:/, "") as SevereTrigger);
      return c.key.startsWith("severe:") && s >= 0 ? CAP_ORDER.length + 1 + s : Infinity;
    }
    const i = CAP_ORDER.indexOf(cap);
    return i < 0 ? CAP_ORDER.length : i;
  };
  // Caps first (most visible first), then the severe problems; everything else keeps the engine's
  // order (points lost).
  const ordered = visible
    .map((c, i) => ({ c, i }))
    .sort((a, b) => capRank(a.c) - capRank(b.c) || a.i - b.i)
    .map((x) => x.c);

  const present = new Set<string>();
  if (ordered.some((c) => JUST_PICTURES_KEYS.has(c.key))) present.add(JUST_PICTURES);
  const share = pictureShare(facts, ctx.signals);
  if (share !== null && share < IMAGE_TEXT_SHARE_MIN) present.add(PICTURES_MINOR);
  if (present.has(JUST_PICTURES) && pictureButton(facts, ctx.signals))
    present.add("picture-button");
  for (const c of ordered) {
    const cap = capIdOf(c.key);
    if (cap && CAP_ROOT[cap]) present.add(CAP_ROOT[cap]!);
    const id = checkIdOf(c.key) ?? c.key;
    if (present.has(PICTURES_MINOR) && (id === "I1" || id === "group:image-heavy")) continue;
    if (PRIMARY_ROOT[id]) {
      // M1 is the root only when the layout really shrinks; a stored M1 at ~100% isn't a problem.
      if (id === "M1") {
        const k = num(facts.get("M1")?.value ?? {}, "k");
        const kPct = k !== null ? k * 100 : fromTitle(c.title, /shrinks to (\d+)%/i);
        if (kPct !== null && kPct >= 99) continue;
      }
      present.add(PRIMARY_ROOT[id]!);
    }
    if (c.key === "check:X1" && isClipX1(c.title, facts)) present.add("clipped");
  }

  // One line per root cause; weak ones (weakProblem) after the rest, so they never crowd out a
  // problem that can lead the card.
  const seen = new Set<string>();
  const lines: Array<{ text: string; weak: boolean; card: string | null }> = [];
  for (const c of ordered) {
    const root = rootOf(c, facts, present, gateCheck);
    if (seen.has(root)) continue;
    const plain = problemText(c, facts, ctx.subject, ctx.signals, ctx.render);
    const text = plain
      ? trimReason(plain, DETAIL_ITEM_MAX, { summaryCut: false })
      : c.title
        ? trimReason(tidyTitle(c.title), DETAIL_ITEM_MAX, { summaryCut })
        : null;
    if (!text) continue;
    seen.add(root);
    const bar = gateBarOf(c.key);
    if (bar) for (const r of GATE_BAR_ROOTS[bar]) seen.add(r);
    if (lines.some((l) => l.text === text)) continue;
    const short = severeCard.has(c.key)
      ? severeCard.get(c.key)!
      : root === "fixed-width"
        ? fixedWidthCard(c.title, facts, capIdOf(c.key) === "CAP_MOBILE_BROKEN")
        : null;
    lines.push({ text, weak: weakProblem(c, facts, text, ctx.signals), card: short });
  }
  const strong = lines.filter((l) => !l.weak);
  const listed = [...strong, ...lines.filter((l) => l.weak)].slice(0, LIST_MAX);
  // Weak problems stay in the root cause's own order when nothing strong is listed above them.
  const out = (strong.length ? listed : lines.slice(0, LIST_MAX)).map((l) => l.text);
  const lead = strong[0];
  const card: string | null | undefined = lead ? (lead.card ?? lead.text) : undefined;
  for (const c of ordered) present.add(rootOf(c, facts, present, gateCheck));
  for (const c of ordered) {
    const bar = gateBarOf(c.key);
    if (bar) present.add(`gate:${bar}`);
  }
  // The main text is too faint (the cap), or the problem named is the headline's own colour —
  // not merely some faint heading-styled label elsewhere in the email.
  if (
    ordered.some((c) => c.key === "cap:CAP_CONTRAST") ||
    lines.some((l) => /^The headline is (?!barely).* on /.test(l.text))
  )
    present.add("faint-headline");

  if (gateItem && gateCheck === "H6") present.add("plain");
  if (lines.some((l) => /^no headline in real text/i.test(l.text)))
    present.add(HEADLINE_IN_PICTURE);
  return { texts: out, roots: present, card };
}

/** An engine title with no plain rule: drop the technical asides (the cap note, "WCAG AA"). */
function tidyTitle(title: string): string {
  return title.replace(/\bWCAG AA\s*/g, "");
}

// ── strengths ──

interface StrengthRule {
  /** Theme: strengths of one theme are one strength (the most distinctive one wins). */
  theme: string;
  /** 1 = distinctive design strength, 2 = supporting, 3 = baseline hygiene. */
  tier: 1 | 2 | 3;
  text: (v: Value, title: string) => string;
  /** Lower-case noun phrase for a combined card line ("a bold headline"). */
  np?: (v: Value, title: string) => string;
}

const aiLevel = (v: Value, title: string) => num(v, "level") ?? fromTitle(title, /rated (\d)\/5/);
/** H6 passes (credit ≥ 0.9) from about this ratio: "a big headline". */
const HEADLINE_BOLD_RATIO = 1.55;

/** Distinctiveness order: the first passing strength in this list leads a Good card. */
const STRENGTHS: ReadonlyArray<[string, StrengthRule]> = [
  [
    "H7",
    {
      theme: "headline",
      tier: 1,
      text: (v, t) => `${aiLevel(v, t) === 5 ? "Excellent" : "Strong"} visual hierarchy`,
      np: (v, t) => `${aiLevel(v, t) === 5 ? "excellent" : "strong"} visual hierarchy`,
    },
  ],
  [
    "H6",
    {
      theme: "headline",
      tier: 1,
      // Size is measured, weight isn't: never "bold" (a 30 px weight-300 headline is big, not bold).
      text: (v) => {
        const r = num(v, "ratio");
        if (r === null) return "A big headline that clearly stands out";
        return r < HEADLINE_BOLD_RATIO
          ? `A clear headline, ${round(r)}× the size of the text`
          : `A big headline, ${round(r)}× the size of the text`;
      },
      np: (v) => {
        const r = num(v, "ratio");
        return r !== null && r < HEADLINE_BOLD_RATIO ? "a clear headline" : "a big headline";
      },
    },
  ],
  [
    "H3",
    {
      theme: "cta",
      tier: 1,
      text: (v, t) =>
        labelOf(v, t) ? `A standout ${labelOf(v, t)} button` : "A main button that stands out",
      np: (v, t) =>
        labelOf(v, t) ? `a standout ${labelOf(v, t)} button` : "a standout main button",
    },
  ],
  [
    "H5",
    {
      theme: "cta",
      tier: 1,
      // Claimed only for a main button that stands out and sits up top (strengthList); "one"
      // only when it is the only action there (H5 passes with up to two).
      text: (v) =>
        num(v, "distinct") === 1
          ? "One clear main button at the top"
          : "A main button that leads at the top, with little competing with it",
      np: (v) => (num(v, "distinct") === 1 ? "one clear main button" : "a main button that leads"),
    },
  ],
  [
    "H2",
    {
      theme: "cta",
      tier: 1,
      text: (v, t) =>
        `The main button${labelOf(v, t) ? ` ${labelOf(v, t)}` : ""} is on the first screen of a phone`,
      np: () => "the main button right on the first screen",
    },
  ],
  [
    "L8",
    {
      theme: "layout",
      tier: 1,
      text: (v, t) =>
        aiLevel(v, t) === 5 ? "Beautifully polished visual design" : "Polished visual design",
      np: () => "polished visuals",
    },
  ],
  [
    "I6",
    {
      theme: "imagery",
      tier: 1,
      text: (v, t) => (aiLevel(v, t) === 5 ? "Excellent imagery" : "Strong imagery"),
      np: () => "strong imagery",
    },
  ],
  [
    "M1",
    {
      theme: "mobile",
      tier: 1,
      text: () => "Fits a phone screen without shrinking",
      np: () => "a phone-friendly layout",
    },
  ],
  // I2 and L3 pass on nearly every email: supporting / baseline only, never a Good card line.
  [
    "I2",
    {
      theme: "imagery",
      tier: 2,
      // Says what I2 measures; "button" only when there is a live-text button.
      text: (v) =>
        v.ctaLive === true
          ? "The text and the button are real text, so they read fine with images off"
          : "All the text is real text, so it reads fine with images off",
    },
  ],
  ["L3", { theme: "layout", tier: 3, text: () => "A clean, uncluttered layout" }],
  [
    "M4",
    {
      theme: "cta",
      tier: 1,
      text: (v, t) => {
        const px = num(v, "minSidePx") ?? fromTitle(t, /is ([\d.]+)px tall/i);
        return px !== null
          ? `A big, easy-to-tap button (${round(px)} px)`
          : "A big, easy-to-tap button";
      },
      np: () => "a big, easy-to-tap button",
    },
  ],
  [
    "M2",
    {
      theme: "mobile",
      tier: 1,
      text: () => "Stays phone-friendly even in apps that ignore phone styles",
      np: () => "a layout that adapts to any phone",
    },
  ],
  [
    "L2",
    {
      theme: "layout",
      tier: 1,
      text: () => "Balanced whitespace",
      np: () => "balanced whitespace",
    },
  ],
  // T6, L5 and L4 pass on nearly any plain email (one font, black text, one column): baseline,
  // never a Bad email's strength, and never claimed for unstyled mail (strengthList).
  [
    "T6",
    {
      theme: "type",
      tier: 3,
      text: () => "Disciplined typography: few fonts and sizes",
      np: () => "disciplined typography",
    },
  ],
  [
    "H4",
    {
      theme: "cta",
      tier: 1,
      text: (v, t) =>
        `The button${labelOf(v, t) ? ` ${labelOf(v, t)}` : ""} says exactly what it does`,
      np: () => "a button that says what it does",
    },
  ],
  [
    "H1",
    {
      theme: "cta",
      tier: 1,
      text: () => "A clear button for the main action",
      np: () => "a clear main button",
    },
  ],
  [
    "L5",
    {
      theme: "colour",
      tier: 3,
      text: () => "A restrained colour palette",
      np: () => "a restrained palette",
    },
  ],
  [
    "C4",
    {
      theme: "copy",
      tier: 1,
      text: () => "Clear, well-written copy",
      np: () => "clear, well-written copy",
    },
  ],
  [
    "L4",
    {
      theme: "layout",
      tier: 3,
      text: () => "Neatly aligned to a simple grid",
      np: () => "a tidy grid",
    },
  ],
  ["I1", { theme: "imagery", tier: 2, text: () => "Plenty of real text alongside the images" }],
  ["I4", { theme: "imagery", tier: 2, text: () => "Still makes sense with images turned off" }],
  ["M5", { theme: "mobile", tier: 2, text: () => "Images resize cleanly on phones" }],
  ["M6", { theme: "colour", tier: 2, text: () => "Looks right in dark mode" }],
  ["M3", { theme: "mobile", tier: 2, text: () => "Text columns stay readable on phones" }],
  ["M7", { theme: "mobile", tier: 2, text: () => "Comfortable side margins on phones" }],
  ["T3", { theme: "type", tier: 2, text: () => "Comfortable line spacing" }],
  ["T4", { theme: "type", tier: 2, text: () => "Comfortable line length" }],
  ["T5", { theme: "type", tier: 2, text: () => "Paragraphs are left-aligned and easy to follow" }],
  ["T7", { theme: "type", tier: 2, text: () => "Capitals used sparingly" }],
  ["T8", { theme: "copy", tier: 2, text: () => "Clear, easy-to-read wording" }],
  [
    "L1",
    {
      theme: "layout",
      tier: 2,
      text: (v, t) => {
        const w = num(v, "width") ?? fromTitle(t, /comfortable (\d+)px/i);
        return w !== null ? `A comfortable ${w} px content column` : "A comfortable content column";
      },
    },
  ],
  [
    "T1",
    {
      theme: "text",
      tier: 2,
      text: (v, t) => {
        const px = num(v, "px") ?? fromTitle(t, /is ([\d.]+)px/i);
        return px !== null
          ? `Comfortable ${round(px)} px text on phones`
          : "Comfortable text size on phones";
      },
    },
  ],
  [
    "T2",
    {
      theme: "text",
      tier: 2,
      text: (v, t) => {
        const px = num(v, "px") ?? fromTitle(t, /is ([\d.]+)px/i);
        return px !== null
          ? `Comfortable ${round(px)} px text on desktop`
          : "Comfortable text size on desktop";
      },
    },
  ],
  ["A13", { theme: "imagery", tier: 2, text: () => "No important text hidden in images" }],
  ["A1", { theme: "text", tier: 3, text: () => "Text is easy to read (good contrast)" }],
  [
    "A2",
    { theme: "access", tier: 3, text: () => "Images are described for people who can't see them" },
  ],
  ["A3", { theme: "access", tier: 3, text: () => "Links say where they go" }],
  ["A6", { theme: "access", tier: 3, text: () => "Headings are marked up for screen readers" }],
  ["A7", { theme: "access", tier: 3, text: () => "Links are easy to tap on phones" }],
  ["A8", { theme: "access", tier: 3, text: () => "Links in the text are easy to spot" }],
  ["I3", { theme: "images-load", tier: 3, text: () => "Every image loads" }],
  ["U1", { theme: "footer", tier: 3, text: () => "Easy to unsubscribe" }],
  ["U2", { theme: "footer", tier: 3, text: () => "The unsubscribe link is easy to read" }],
  ["X1", { theme: "tech", tier: 3, text: () => "Small enough that Gmail shows the whole email" }],
  ["X2", { theme: "tech", tier: 3, text: () => "Code works in all major email apps" }],
  ["X3", { theme: "tech", tier: 3, text: () => "Links and personalization are clean" }],
];
const STRENGTH_RULES = new Map(STRENGTHS);
const STRENGTH_RANK = new Map(STRENGTHS.map(([id], i) => [id, i]));

/**
 * The engine's grouped strength items (@edf/design explain.ts `distinctive`), for summaries whose
 * checks were compacted away: the engine applied its conflict rules when it wrote them, so their
 * titles are safe to show, reworded where they carry render jargon ("a 375px screen"). While the
 * checks are stored the per-check rules above say the same things, so these are skipped then.
 */
const ENGINE_GROUP_STRENGTHS: Record<string, StrengthRule> = {
  "good:hierarchy-cta": {
    theme: "headline",
    tier: 1,
    text: (_v, t) => t.replace(/(\d+)px\b/g, "$1 px"),
  },
  "good:hierarchy": {
    theme: "headline",
    tier: 1,
    text: (_v, t) => {
      const r = fromTitle(t, /([\d.]+)×/);
      return r !== null
        ? `A clear headline, ${round(r)}× the size of the text`
        : "A clear headline that stands out";
    },
  },
  "good:cta": { theme: "cta", tier: 1, text: (_v, t) => t },
  "good:mobile": {
    theme: "mobile",
    tier: 1,
    text: (_v, t) => {
      const px = fromTitle(t, /with (\d+(?:\.\d+)?)px body text/i);
      return px !== null
        ? `Fits a phone screen without shrinking, with ${round(px)} px text`
        : "Fits a phone screen without shrinking";
    },
  },
  "good:imagery": { theme: "imagery", tier: 2, text: (_v, t) => t },
  "good:type": { theme: "type", tier: 3, text: (_v, t) => t },
};

/** Typography and readability strengths: meaningless for an email whose text is mostly pixels. */
const TEXT_STRENGTHS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "A1"] as const;
/** Layout strengths: likewise meaningless when the layout is one big picture. */
const LAYOUT_STRENGTHS = ["M1", "M2", "M3", "M7", "L1", "L2", "L3", "L4", "L5", "L6"] as const;
/** Button strengths: never next to a button that doesn't stand out (or no button at all). */
const BUTTON_STRENGTHS = ["H1", "H3", "H5"] as const;

/** Strength themes a problem's root cause contradicts ("fits phones" next to a shrinking layout). */
const CONTRADICTS: Record<string, readonly string[]> = {
  "fixed-width": ["M1", "M2", "M3", "M7", "M4", "T1", "A7"],
  // Pale text doesn't "look right in dark mode".
  contrast: ["A1", "M6"],
  // A big headline in faint grey doesn't stand out: the main text is too faint (the contrast cap)
  // or the faintest text is the headline itself — not some slightly light grey text elsewhere.
  "faint-headline": ["H6"],
  // The Excellent gate's "plain design" (nothing stands out).
  plain: ["H6", "L3"],
  // The gate's own bars: no headline praise without a real headline, no button praise when the
  // main button doesn't stand out.
  "gate:headline": ["H6"],
  "gate:button": BUTTON_STRENGTHS,
  // Image-only / image-heavy: the visible "text" and layout are in the pictures, so there is no
  // live typography, readability or layout to praise (and "reads fine with images off" is false).
  images: ["I1", "I2", "I4", "I6", "A13", "M6", ...TEXT_STRENGTHS, ...LAYOUT_STRENGTHS],
  // …and when its button is a picture too, no button praise either ("The main button “Button:
  // Save Up to 55% Off”" is an image's alt text).
  "picture-button": ["H1", "H2", "H3", "H4", "H5", "M4"],
  // …and an email that is just pictures has no picture layout to praise either ("Images resize
  // cleanly on phones" was the only praise on a Bad text-in-pictures email).
  [JUST_PICTURES]: ["M5"],
  // A headline that may be in a picture: the email doesn't all "read fine with images off".
  [HEADLINE_IN_PICTURE]: ["I2", "I4"],
  "broken-images": ["I3"],
  clipped: ["X1"],
  "merge-tag": ["X3"],
  cta: ["H1", "H2", "H3", "H4", "H5", "M4"],
};

/** Strengths a problem check (by id) undermines. */
const CHECK_CONTRADICTS: Record<string, readonly string[]> = {
  U2: ["U1"],
  // "Fits a phone screen" next to "100% of the text is squeezed / runs to the edge" reads as a
  // contradiction to a non-technical reader, even though the layout itself doesn't shrink.
  M3: ["M1", "M2", "L2", "L3"],
  // Text running into the screen edge isn't "balanced whitespace" or "a clean layout", nor are
  // its "text columns readable on phones".
  M7: ["M1", "M2", "M3", "L2", "L3"],
  // …nor is a content column that is much too wide (or narrow) on desktop.
  L1: ["L2", "L3"],
  // "Links are easy to tap" next to "the main button is only 25 px tall" contradicts itself.
  M4: ["A7"],
  // "Body text is a little small on phones (14 px)" next to "Comfortable 14 px text on desktop"
  // reads as the same text called small and comfortable (the phone and desktop bars differ).
  T1: ["T2"],
  T2: ["T1"],
  // "The top of the email is all picture" next to "still makes sense with images off" / "plenty
  // of real text" contradicts itself.
  I2: ["I1", "I4"],
  // …and so does "Only 242 characters of real text" next to "still makes sense with images off".
  I1: ["I4"],
};

/** The strength checks the listed problems' root causes contradict. */
function blockedStrengths(problemRoots: ReadonlySet<string>): Set<string> {
  return new Set(
    [...problemRoots].flatMap((r) => {
      // A check listed as a problem can't also be a strength, nor can a check it undermines
      // ("Easy to unsubscribe" next to "The unsubscribe link is tiny").
      const id = /^check:([A-Z]\d{1,2})$/.exec(r)?.[1];
      return [...(CONTRADICTS[r] ?? []), ...(id ? [id, ...(CHECK_CONTRADICTS[id] ?? [])] : [])];
    }),
  );
}

/** Whether the email has content images (I4 applies), when the checks are known; null = unknown. */
function hasContentImages(facts: Facts): boolean | null {
  if (facts.size === 0) return null;
  const i4 = facts.get("I4");
  return !!i4 && i4.status !== "not_applicable" && i4.status !== "not_evaluated";
}

/**
 * The full analysis page's "Good" list (the engine's own strength items), with the gallery's
 * conflict rules applied, so a strength never contradicts a listed problem there either: an item
 * is dropped when any check it stands for is contradicted by a problem's root cause (e.g. "Built
 * for phones" next to "100% of body text touches the screen edge"), when it claims text reads fine
 * with images off for an email with no images, or typography for an unstyled email.
 */
export function compatibleStrengthItems<T extends { key: string; checkIds?: readonly string[] }>(
  good: readonly T[],
  needsImprovement: readonly { key: string; title: string }[],
  opts: {
    caps?: readonly string[] | null;
    checks?: unknown;
    fontsMeasured?: boolean;
    /** score_summary.signals: the gate's failed bars and the severe problems contradict too. */
    signals?: unknown;
  } = {},
): T[] {
  const facts = factsOf(opts.checks);
  const caps = (opts.caps ?? []).filter((x): x is string => typeof x === "string");
  const summary = {
    needsImprovement: needsImprovement.map((i) => ({
      key: i.key,
      title: i.title,
      points: 0,
      ai: false,
    })),
  };
  const signals = opts.signals ?? null;
  const { roots } = problemList(
    summary,
    facts,
    caps,
    // No strength contradicts the footer statements or the stray-text note: htmlPass is moot.
    {
      subject: null,
      signals,
      primaryType: signalStr(signals, "primaryType"),
      render: null,
      htmlPass: false,
    },
    severeProblems(signals),
  );
  const blocked = blockedStrengths(roots);
  const images = hasContentImages(facts);
  return good.filter((item) => {
    const ids = item.checkIds?.length
      ? item.checkIds
      : [checkIdOf(item.key) ?? item.key.replace(/^good:/, "")];
    if (ids.some((id) => blocked.has(id))) return false;
    if (images === false && ids.includes("I2")) return false;
    if (opts.fontsMeasured === false && ids.includes("T6")) return false;
    return true;
  });
}

interface Strength {
  id: string;
  rule: StrengthRule;
  v: Value;
  title: string;
}

/** What the strengths may claim, beyond the listed problems (the engine's own conflict rules). */
interface StrengthContext {
  signals: unknown;
  /** email.font_families non-empty (undefined = not checked). */
  fontsMeasured?: boolean;
  /** Facts from the stored render and HTML pass (null once compacted, or not given). */
  render?: RenderFacts | null;
}

/** H3's strength when the main button is one of several that look the same (equalButtons). */
const EQUAL_BUTTONS_RULE: StrengthRule = {
  theme: "cta",
  tier: 1,
  text: () => "Clear, bold buttons",
  np: () => "clear, bold buttons",
};

/**
 * Strengths the facts don't back up, whatever the problem list says (@edf/design explain.ts
 * `conflictsWith`, applied here too because the gallery reads the checks directly):
 *  - a button "stands out" (H3) only with a bold fill that is the most prominent link, and "one
 *    clear main button at the top" (H5) only when such a button is also on the first phone screen;
 *    nor is a button whose fill doesn't stand out "a clear button for the main action" (H1);
 *  - no headline praise (H6) when the email has no heading text at all;
 *  - "images resize cleanly" / "still makes sense with images off" (M5 / I4) only when its
 *    pictures were drawn: not when none loaded, most didn't, or images were off for it;
 *  - "disciplined typography", "a restrained palette", "a simple grid" (T6 / L5 / L4) never for
 *    unstyled mail: no font of its own, or a single text size throughout.
 * Unknown facts (older rows, compacted checks) don't rule a strength out.
 */
function unbacked(id: string, facts: Facts, ctx: StrengthContext): boolean {
  const sig = ctx.signals;
  switch (id) {
    case "H1": {
      // "A clear button" for one whose colour doesn't stand out from the background.
      const salience =
        num(facts.get("H3")?.value ?? {}, "salience") ?? signalNum(sig, "ctaSalience");
      return salience !== null && salience < CTA_SALIENCE_MIN;
    }
    case "H3":
    case "H5": {
      const h3 = facts.get("H3")?.value ?? {};
      const salience = num(h3, "salience") ?? signalNum(sig, "ctaSalience");
      const top =
        typeof h3.mostProminent === "boolean"
          ? h3.mostProminent
          : (signalObj(sig)?.ctaMostProminent ?? null);
      if (salience === null && top === null) return false;
      const standsOut = salience !== null && salience >= CTA_SALIENCE_MIN && top === true;
      if (!standsOut) return true;
      if (id === "H3") return false;
      const h2 = facts.get("H2");
      return !(h2 ? h2.status === "pass" : signalObj(sig)?.ctaFirstScreen === true);
    }
    case "H6": {
      const h = facts.get("H6")?.value.headline ?? signalObj(sig)?.hasHeadline;
      return h === false;
    }
    case "M5":
    case "I4":
      return (
        signalNum(sig, "drawnContentImages") === 0 ||
        signalObj(sig)?.imagesOff === true ||
        (signalNum(sig, "imagesUnknownShare") ?? 0) > 0.5
      );
    case "T6":
    case "L5":
    case "L4":
      return ctx.fontsMeasured === false || (num(facts.get("T6")?.value ?? {}, "sizes") ?? 2) <= 1;
    default:
      return false;
  }
}

function strengthList(
  summary: SummaryLike,
  facts: Facts,
  problemRoots: ReadonlySet<string>,
  ctx: StrengthContext = { signals: null },
): Strength[] {
  const found = new Map<string, Strength>();
  const add = (id: string, v: Value, title: string) => {
    if (found.has(id) || unbacked(id, facts, ctx)) return;
    // A strength with no plain rule (e.g. a newer engine check) still shows, tidied, last. One of
    // several buttons that look the same isn't "the standout" one.
    const rule =
      (id === "H3" && equalButtons(facts, ctx.render ?? null) ? EQUAL_BUTTONS_RULE : null) ??
      STRENGTH_RULES.get(id) ??
      (title ? { theme: `other:${id}`, tier: 3 as const, text: () => tidyTitle(title) } : null);
    if (rule) found.set(id, { id, rule, v, title });
  };
  // I2 ("reads fine with images off") only means something when the email has content images.
  const hasImages = hasContentImages(facts) === true;
  for (const [id, f] of facts) {
    if (id === "I2" && !hasImages) continue;
    if (AI_NAMES[id]) {
      const level = num(f.value, "level");
      if ((f.status === "pass" || f.status === "partial") && level !== null && level >= 4)
        add(id, f.value, "");
    } else if (f.status === "pass" && f.w >= 1) {
      add(id, f.value, "");
    } else if (
      id === "H6" &&
      f.status === "partial" &&
      (num(f.value, "ratio") ?? 0) >= HEADLINE_RATIO_MIN
    ) {
      add(id, f.value, ""); // a real headline (≥ 1.5×) just short of "bold"
    }
  }
  for (const c of candidates(summary?.good)) {
    const group = ENGINE_GROUP_STRENGTHS[c.key];
    if (group) {
      // Compacted: the engine's grouped item is all there is (see ENGINE_GROUP_STRENGTHS).
      if (facts.size === 0 && !found.has(c.key))
        found.set(c.key, { id: c.key, rule: group, v: {}, title: c.title });
      continue;
    }
    const id = checkIdOf(c.key) ?? c.key;
    if (id === "I2" && facts.size > 0 && !hasImages) continue;
    add(id, facts.get(id)?.value ?? {}, c.title);
  }
  const blocked = blockedStrengths(problemRoots);
  return [...found.values()]
    .filter((s) => !blocked.has(s.id))
    .sort((a, b) => (STRENGTH_RANK.get(a.id) ?? 999) - (STRENGTH_RANK.get(b.id) ?? 999));
}

/**
 * The detail view's strengths: up to 3 distinctive or supporting ones (tiers 1–2). Baseline hygiene
 * (tier 3: "Every image loads", "Small enough that Gmail shows the whole email") is filler, not a
 * reason a design works: it is shown only when nothing better passed, at most one, and never for
 * a Bad design — fewer (or no) strengths beat generic ones.
 */
function detailStrengths(ranked: readonly Strength[], verdict: Verdict): Strength[] {
  const real = ranked.filter((s) => s.rule.tier < 3).slice(0, LIST_MAX);
  if (real.length > 0 || verdict === "bad") return real;
  return ranked.slice(0, 1);
}

/** One strength per theme, most distinctive first. */
function byTheme(list: readonly Strength[]): Strength[] {
  const themes = new Set<string>();
  return list.filter((s) => (themes.has(s.rule.theme) ? false : (themes.add(s.rule.theme), true)));
}

/**
 * The card's strength line: the most distinctive strength, with a second one when both are short.
 * Baseline hygiene (tier 3: "A restrained colour palette") leads only when nothing distinctive or
 * supporting passed — a Good email (which passed the Excellent gate) always has better.
 */
function strengthLine(all: readonly Strength[]): string | null {
  const real = all.filter((s) => s.rule.tier < 3);
  const list = real.length > 0 ? real : all;
  const [first, second] = list;
  if (!first) return null;
  const alone = first.rule.text(first.v, first.title);
  if (first.rule.tier === 1 && second?.rule.tier === 1 && first.rule.np && second.rule.np) {
    const combined = cap1(
      `${first.rule.np(first.v, first.title)} and ${second.rule.np(second.v, second.title)}`,
    );
    // A shortened button label reads badly mid-sentence: only whole phrases are combined.
    if (combined.length <= COMBINED_MAX && !combined.includes("…")) return combined;
  }
  return alone;
}

/**
 * The card's one-line reason plus up to 3 problems and 3 strengths for the detail view (see
 * REASON POLICY above). `opts.checks` is `email_analysis.checks` (empty once compacted);
 * `opts.caps` / `opts.issues` name caps the summary may not explain.
 */
export function galleryReason(
  verdict: Verdict,
  summary: SummaryLike,
  opts: {
    capped?: boolean | null;
    caps?: readonly string[] | null;
    issues?: readonly DesignIssue[] | null;
    checks?: unknown;
    /** The email's subject, to quote a merge tag the engine found there. */
    subject?: string | null;
    /**
     * Whether any font was measured (email.font_families non-empty). An unstyled email (the mail
     * app's default font) has nothing to call "disciplined typography"; omitted = not checked.
     */
    fontsMeasured?: boolean;
    /**
     * The verdict's signals (VerdictInput.signals; default: summary.signals): each severe problem
     * they show leads right after the caps, in its own plain words, and the Excellent gate's
     * failed bars become the "not Good because" lines.
     */
    signals?: unknown;
    /**
     * email.primary_type: the email's type now (VerdictInput.primaryType), which the verdict's
     * unsubscribe rule and the lists' type rules read; omitted = the type the score used.
     */
    primaryType?: string | null;
    /** The design score: a Bad design with no cap or severe problem is Bad for its low score. */
    score?: number | null;
    /** Facts from the stored render and HTML pass (queries/gallery.ts RENDER_FACTS). */
    render?: RenderFacts | null;
    /**
     * The renderer of the email's own render (email_analysis.renderer_version; null for template
     * coverage): with a summary of methodology 2026.6+, render-2026.5+ lists the footer
     * statements and the stray-text note (currentHtmlPass). Omitted = an older render.
     */
    rendererVersion?: string | null;
  } = {},
): { reason: GalleryReason | null; problems: string[]; strengths: string[] } {
  if (verdict === "unscored") return { reason: null, problems: [], strengths: [] };
  const signals = opts.signals !== undefined ? opts.signals : (summary?.signals ?? null);
  const render = opts.render ?? null;
  const htmlPass = currentHtmlPass(summary?.scoringVersion, opts.rendererVersion ?? null);
  const primaryType =
    opts.primaryType !== undefined ? opts.primaryType : signalStr(signals, "primaryType");
  const severe = severeProblems(signals, primaryType, render);
  const facts = factsOf(opts.checks);
  const capIds = [
    ...new Set([
      ...(Array.isArray(summary?.caps)
        ? summary.caps.filter((x): x is CapId => typeof x === "string")
        : []),
      ...(opts.caps ?? []).filter((x) => typeof x === "string"),
      ...(opts.issues ?? []).flatMap((i) => (ISSUE_CAP[i] ? [ISSUE_CAP[i]] : [])),
    ]),
  ];
  const subject =
    typeof opts.subject === "string" && opts.subject.trim() !== "" ? opts.subject : null;
  const listed = problemList(
    summary,
    facts,
    capIds,
    { subject, signals, primaryType, render, htmlPass },
    severe,
  );
  const { roots } = listed;
  let { texts: problems, card } = listed;
  // Bad with no cap and no severe problem: the rule that decided it is the score itself.
  if (
    verdict === "bad" &&
    capIds.length === 0 &&
    severe.length === 0 &&
    typeof opts.score === "number"
  ) {
    // No single check is worth more than a few points, so a score this low is always several.
    const low = `Several problems add up to a low score (${Math.round(opts.score)} of 100; Bad is under ${POOR_SCORE_MAX})`;
    problems = [low, ...problems].slice(0, LIST_MAX);
    card = low;
  }
  const ranked = byTheme(
    strengthList(summary, facts, roots, { signals, fontsMeasured: opts.fontsMeasured, render }),
  );
  const strengths = detailStrengths(ranked, verdict).map((s) =>
    trimReason(s.rule.text(s.v, s.title), DETAIL_ITEM_MAX, { summaryCut: false }),
  );
  const line = strengthLine(ranked);
  const asProblem = (t: string | undefined) =>
    t ? { kind: "problem" as const, text: trimReason(t, REASON_MAX, { summaryCut: false }) } : null;
  // The card's problem: the first one that may lead it (`card`: a shorter wording, never a weak
  // problem — an Okay card with only weak ones names its best strength, or nothing); a Bad card
  // always names a problem.
  const problem = asProblem(card ?? undefined);
  const strength = line
    ? { kind: "strength" as const, text: trimReason(line, REASON_MAX, { summaryCut: false }) }
    : null;
  const reason =
    verdict === "good"
      ? (strength ?? problem)
      : verdict === "bad"
        ? (problem ?? asProblem(problems[0]))
        : (problem ?? strength);
  return { reason, problems, strengths };
}

// ───────────────────────── URL state ─────────────────────────

export const GALLERY_DESIGNS = ["all", "good", "bad"] as const;
export type GalleryDesign = (typeof GALLERY_DESIGNS)[number];
export const GALLERY_SORTS = ["newest", "best", "worst"] as const;
export type GallerySort = (typeof GALLERY_SORTS)[number];

export const GALLERY_SORT_LABELS: Record<GallerySort, string> = {
  newest: "Newest",
  best: "Best design first",
  worst: "Worst design first",
};

export const GALLERY_Q_MAX = 100;
export const GALLERY_FONT_MAX = 512;

/** Cards per page the viewer can pick (`?size=`); the first is the default. */
export const GALLERY_PAGE_SIZES = [24, 48, 96] as const;
export type GalleryPageSize = (typeof GALLERY_PAGE_SIZES)[number];
/** The highest `?page=` a link may carry (the server clamps it to the last page anyway). */
export const GALLERY_PAGE_MAX = 10_000;
/** Most senders one filter may pick (`?sender=`). */
export const GALLERY_SENDERS_MAX = 20;

/** "Date received" (`?date=`); "custom" reads `?since=` / `?until=` (YYYY-MM-DD, inclusive). */
export const GALLERY_DATES = ["any", "7d", "30d", "90d", "custom"] as const;
export type GalleryDate = (typeof GALLERY_DATES)[number];
export const GALLERY_DATE_DAYS: Record<Exclude<GalleryDate, "any" | "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const GALLERY_DATE_LABELS: Record<GalleryDate, string> = {
  any: "Any time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Pick dates",
};

/** Web fonts (`?webfonts=`): "yes" = uses a web font, "no" = system fonts only. */
export const GALLERY_WEB_FONTS = ["any", "yes", "no"] as const;
export type GalleryWebFonts = (typeof GALLERY_WEB_FONTS)[number];
export const GALLERY_WEB_FONT_LABELS: Record<GalleryWebFonts, string> = {
  any: "Any",
  yes: "Uses web fonts",
  no: "System fonts only",
};

/**
 * The Problems options (`?problem=`): one per rule that makes a design Bad (VERDICT POLICY), so the
 * counts break the Bad count down rule by rule — every Bad design has at least one, and only Bad
 * designs have any (galleryProblemsOf; the SQL twin is queries/gallery.ts problemCondition):
 *  - "Mostly pictures": the image-only cap, text baked into images, or pictures that didn't load
 *  - "Hard-to-read text": the main-text contrast cap
 *  - "Visible merge tags": the merge-tag cap
 *  - "Doesn't fit phones": the broken-phone-layout cap, or text that shrinks too small on phones
 *  - "Gmail cuts off key parts": the clipping cap (the cut hides the main button or over a
 *    quarter of the text), or the unsubscribe link after Gmail's cut — not every email over
 *    Gmail's size limit: one whose cut hides none of that is Okay and its line says "Over
 *    Gmail's size limit …" (clippedText)
 *  - "Broken images": the broken-images cap
 *  - "No unsubscribe link": marketing mail (its type now) without one (v1.5 rows: subscription
 *    mail)
 *  - "Low score": a score under 60
 * The ids are the ones links used before ("image_only", "mobile", …), so old links still work.
 */
export const GALLERY_PROBLEMS = [
  "image_only",
  "contrast",
  "merge_tag",
  "mobile",
  "clipped",
  "broken_images",
  "no_unsubscribe",
  "low_score",
] as const satisfies readonly (DesignIssue | "merge_tag" | "no_unsubscribe" | "low_score")[];
export type GalleryProblem = (typeof GALLERY_PROBLEMS)[number];
export const GALLERY_PROBLEM_LABELS: Record<GalleryProblem, string> = {
  image_only: "Mostly pictures",
  contrast: "Hard-to-read text",
  merge_tag: "Visible merge tags",
  mobile: "Doesn't fit phones",
  clipped: "Gmail cuts off key parts",
  broken_images: "Broken images",
  no_unsubscribe: "No unsubscribe link",
  low_score: `Low score (under ${POOR_SCORE_MAX})`,
};

/** The cap behind each Problems option, if any (its issue chip has the option's id). */
export const PROBLEM_CAP: Partial<Record<GalleryProblem, CapId>> = {
  image_only: "CAP_IMAGE_ONLY",
  contrast: "CAP_CONTRAST",
  merge_tag: "CAP_MERGE_TAG",
  mobile: "CAP_MOBILE_BROKEN",
  clipped: "CAP_CLIPPED",
  broken_images: "CAP_BROKEN_IMAGES",
};
/** The severe problems (severeTriggers) each Problems option also covers. */
export const PROBLEM_TRIGGERS: Partial<Record<GalleryProblem, readonly SevereTrigger[]>> = {
  image_only: ["text_in_images", "pictures_not_loaded"],
  mobile: ["tiny_phone_text"],
  clipped: ["unsubscribe_clipped"],
  no_unsubscribe: ["no_unsubscribe"],
};

/**
 * The Problems options a scored design has: the caps and issue chips that fired, the severe
 * problems its signals show (the same facts the verdict and the card read) and a score under 60.
 * An unscored design has none. Non-empty exactly when verdictOf says "bad" (the gallery tests
 * check it, and that the SQL twin, queries/gallery.ts problemCondition, agrees).
 */
export function galleryProblemsOf(
  d: Pick<VerdictInput, "score" | "band" | "caps" | "issues" | "signals" | "primaryType">,
): GalleryProblem[] {
  if (d.score === null || d.score === undefined) return [];
  const issues = new Set<string>(Array.isArray(d.issues) ? d.issues : []);
  const caps = new Set<string>(Array.isArray(d.caps) ? d.caps : []);
  const triggers = new Set(severeTriggers(d.signals, d.primaryType));
  return GALLERY_PROBLEMS.filter((x) => {
    if (x === "low_score") return d.score! < POOR_SCORE_MAX || d.band === "poor";
    const cap = PROBLEM_CAP[x];
    // An issue chip is its cap's (email.design_issues): only cap-backed options have one.
    return (
      (cap !== undefined && (issues.has(x) || caps.has(cap))) ||
      (PROBLEM_TRIGGERS[x] ?? []).some((t) => triggers.has(t))
    );
  });
}

const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().regex(UUID_PARAM_RE))
  .transform((s) => s.toLowerCase());

/** One of `values`, in any case and with stray spaces ("Promotions" is "promotions"). */
const enumParam = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(values));

/**
 * Control characters (NUL included) → spaces. Postgres rejects a NUL in any text value, so one
 * typed into a link (`?q=a%00b`, `?font=Arial%00`) would otherwise break the page.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, " ");
}

/**
 * `?page=`: a whole number. One past GALLERY_PAGE_MAX is read as GALLERY_PAGE_MAX (the server then
 * shows the real last page), never as page 1; 0 is page 1.
 */
const pageParam = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{1,32}$/)
      .transform(Number),
  ])
  // Not .int(): that also caps at the largest "safe" integer, and a longer run of digits is still
  // a page past the end.
  .pipe(z.number().min(0).refine(Number.isInteger))
  .transform((n) => Math.min(Math.max(n, 1), GALLERY_PAGE_MAX));

/** A whole number from the URL ("48") or from an object (48); "1e2", "4.5" or " 7" are invalid. */
const intParam = (min: number, max: number) =>
  z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(min).max(max));

/** A real calendar day, YYYY-MM-DD, between 2000 and 2100. */
function isCalendarDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s < "2000-01-01" || s > "2100-12-31") return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dayParam = z.string().refine(isCalendarDay).nullable().default(null);

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** How far `timeZone`'s clock is ahead of UTC at the instant `at` (ms; +05:45 = 20,700,000). */
function zoneOffsetMs(at: number, timeZone: string): number {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneFormats.set(timeZone, f);
  }
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(at)))
    if (p.type !== "literal") v[p.type] = Number(p.value);
  const wall = Date.UTC(v.year!, v.month! - 1, v.day!, v.hour!, v.minute!, v.second!);
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/**
 * The instant the calendar day `day` (YYYY-MM-DD) starts in `timeZone` — its midnight there — so
 * "Pick dates" means the same days the cards are dated in. An unknown zone counts as UTC.
 */
export function zonedDayStart(day: string, timeZone: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  try {
    // The offset at the first guess can differ from the one at midnight itself (a clock change
    // that day): asking once more at the guess settles it.
    const guess = wall - zoneOffsetMs(wall, timeZone);
    const start = wall - zoneOffsetMs(guess, timeZone);
    const dayAt = (t: number) => new Date(t + zoneOffsetMs(t, timeZone)).toISOString().slice(0, 10);
    if (dayAt(start) >= day) return new Date(start);
    // Midnight itself doesn't exist there that day (Santiago, Havana: the clocks jump from 23:59:59
    // straight to 01:00), so `start` is still the day before. The day begins at that jump: the
    // first instant whose date there is `day`, found by halving (a jump is at most a few hours on).
    let lo = start;
    let hi = start + 6 * 3_600_000;
    if (dayAt(hi) < day) return new Date(start);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (dayAt(mid) >= day) hi = mid;
      else lo = mid;
    }
    return new Date(hi);
  } catch {
    return new Date(wall);
  }
}

/** The calendar day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A comma-separated list ("a,b") or an array. Invalid items and repeats are dropped and the rest
 * kept, up to the first `max` (a hand-edited link never loses its good items to one bad one).
 */
const listParam = <T extends string>(item: z.ZodType<T>, max: number) =>
  z
    .union([
      z.array(z.string()).transform((a) => a.flatMap((s) => s.split(","))),
      z.string().transform((s) => s.split(",")),
    ])
    .transform((a): T[] => {
      const out: T[] = [];
      for (const s of a) {
        if (out.length >= max) break;
        const r = item.safeParse(s);
        if (r.success && !out.includes(r.data)) out.push(r.data);
      }
      return out;
    })
    .default([]);

export const gallerySearchSchema = z.object({
  category: enumParam(GALLERY_CATEGORY_IDS).default("all"),
  design: enumParam(GALLERY_DESIGNS).default("all"),
  font: z
    .string()
    .transform(stripControlChars)
    .pipe(z.string().trim().min(1).max(GALLERY_FONT_MAX))
    .nullable()
    .default(null),
  // Longer searches are cut to 100 characters (trim first, then cut), exactly as the search box and
  // useGalleryParams do, so the query shown is always the query applied.
  q: z
    .string()
    .transform((s) => stripControlChars(s).trim().slice(0, GALLERY_Q_MAX))
    .default(""),
  sort: enumParam(GALLERY_SORTS).default("newest"),
  // ── pages ──
  page: pageParam.default(1),
  size: intParam(1, 1000).pipe(z.literal(GALLERY_PAGE_SIZES)).default(GALLERY_PAGE_SIZES[0]),
  // ── advanced filters (the Filters panel) ──
  /** Design score range, inclusive; 0–100 is "any" (unscored designs only show then). */
  smin: intParam(0, 100).default(0),
  smax: intParam(0, 100).default(100),
  date: enumParam(GALLERY_DATES).default("any"),
  since: dayParam,
  until: dayParam,
  sender: listParam(uuidParam, GALLERY_SENDERS_MAX),
  problem: listParam(enumParam(GALLERY_PROBLEMS), GALLERY_PROBLEMS.length),
  mailbox: uuidParam.nullable().default(null),
  webfonts: enumParam(GALLERY_WEB_FONTS).default("any"),
  /** Only the designs saved in this board (one of the user's own; see server/actions/boards.ts). */
  board: uuidParam.nullable().default(null),
});

export type GalleryParams = z.infer<typeof gallerySearchSchema>;
export const DEFAULT_GALLERY_PARAMS: GalleryParams = gallerySearchSchema.parse({});
/** A change to the params; null puts a field back to its default. */
export type GalleryPatch = Partial<{ [K in keyof GalleryParams]: GalleryParams[K] | null }>;

type SearchParamsLike =
  | URLSearchParams
  | Record<string, string | string[] | undefined | null>
  | Partial<GalleryParams>
  | null
  | undefined;

/** Fields whose value is a list: repeated keys and commas both add items. */
const LIST_KEYS = new Set<string>(["sender", "problem"]);
/** Fields where an empty value means "not set". */
const NULLABLE_KEYS = new Set<string>(["font", "since", "until", "mailbox", "board"]);

function readParam(input: SearchParamsLike, key: string): unknown {
  if (!input) return undefined;
  const list = LIST_KEYS.has(key);
  if (input instanceof URLSearchParams) {
    if (list) return input.has(key) ? input.getAll(key) : undefined;
    return input.get(key) ?? undefined;
  }
  const v = (input as Record<string, unknown>)[key];
  return Array.isArray(v) && !list ? v[0] : v;
}

/**
 * URL search params (or an already-parsed object, e.g. from a Server Action) → validated gallery
 * params. Each invalid field falls back to its own default; the other fields are kept. Then the
 * fields that go together are made consistent: a score range given high–low is swapped, dates
 * only count with "Pick dates" (a link with dates but no `date` means "Pick dates"; swapped when
 * given backwards; with neither, it's "Any time"), and problems are kept in one fixed order.
 */
export function parseGalleryParams(input: SearchParamsLike | unknown): GalleryParams {
  const src = (typeof input === "object" && input !== null ? input : undefined) as SearchParamsLike;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(gallerySearchSchema.shape)) {
    let value = readParam(src, key);
    if (NULLABLE_KEYS.has(key) && typeof value === "string" && value.trim() === "") value = null;
    const r = (field as z.ZodType).safeParse(value ?? undefined);
    const fallback = DEFAULT_GALLERY_PARAMS[key as keyof GalleryParams];
    out[key] = r.success ? r.data : Array.isArray(fallback) ? [...fallback] : fallback;
  }
  const p = out as GalleryParams;
  if (p.smin > p.smax) [p.smin, p.smax] = [p.smax, p.smin];
  if (p.date === "any" && (p.since || p.until)) p.date = "custom";
  if (p.date !== "custom") {
    p.since = null;
    p.until = null;
  } else if (!p.since && !p.until) {
    p.date = "any";
  } else if (p.since && p.until && p.since > p.until) {
    [p.since, p.until] = [p.until, p.since];
  }
  p.problem = GALLERY_PROBLEMS.filter((x) => p.problem.includes(x));
  return p;
}

/**
 * A gallery link for a (partial) param state; defaults are left out, so the plain gallery is just
 * `base`. `base` is the gallery's route (default "/gallery"). Lists are comma-separated.
 */
export function galleryHref(params: Partial<GalleryParams> = {}, base = "/gallery"): string {
  const p = parseGalleryParams(params);
  const sp = new URLSearchParams();
  if (p.category !== "all") sp.set("category", p.category);
  if (p.design !== "all") sp.set("design", p.design);
  if (p.font) sp.set("font", p.font);
  if (p.q) sp.set("q", p.q);
  if (p.sort !== "newest") sp.set("sort", p.sort);
  if (p.smin !== 0) sp.set("smin", String(p.smin));
  if (p.smax !== 100) sp.set("smax", String(p.smax));
  if (p.date !== "any") sp.set("date", p.date);
  if (p.since) sp.set("since", p.since);
  if (p.until) sp.set("until", p.until);
  if (p.sender.length) sp.set("sender", p.sender.join(","));
  if (p.problem.length) sp.set("problem", p.problem.join(","));
  if (p.mailbox) sp.set("mailbox", p.mailbox);
  if (p.webfonts !== "any") sp.set("webfonts", p.webfonts);
  if (p.board) sp.set("board", p.board);
  if (p.size !== GALLERY_PAGE_SIZES[0]) sp.set("size", String(p.size));
  if (p.page !== 1) sp.set("page", String(p.page));
  // Commas are safe in a query string; keeping them readable keeps shared links short.
  const qs = sp.toString().replace(/%2C/gi, ",");
  return qs ? `${base}?${qs}` : base;
}

// ── advanced filters and pages (pure helpers for the UI) ──

/** Resetting every Filters-panel field (the main bar's filters are left alone). */
export const CLEAR_ADVANCED: GalleryPatch = {
  smin: null,
  smax: null,
  date: null,
  since: null,
  until: null,
  sender: null,
  problem: null,
  mailbox: null,
  webfonts: null,
  board: null,
};

/** How many Filters-panel filters are on (the Filters button's badge); each chip counts once. */
export function advancedFilterCount(p: GalleryParams): number {
  return activeFilterChips(p).length;
}

export interface FilterChip {
  key: string;
  label: string;
  /** The change that removes this filter. */
  remove: GalleryPatch;
}

const dayFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
/** "Sep 1, 2026" for "2026-09-01". */
export function formatDay(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00Z`));
}

/**
 * The names (lowercased) that more than one of `senders` goes by: LinkedIn, say, sends from four
 * addresses, and those rows would look identical. Such a sender is shown with its address.
 */
export function sharedSenderNames(senders: ReadonlyArray<{ name: string }>): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const s of senders) {
    const k = s.name.trim().toLowerCase();
    if (seen.has(k)) shared.add(k);
    seen.add(k);
  }
  return shared;
}

/**
 * Each sender's chip label: its name, and its address too when another sender in the list has the
 * same name ("LinkedIn (jobs-noreply@linkedin.com)"), so two chips never read the same.
 */
export function senderChipLabels(
  senders: ReadonlyArray<{ id: string; name: string; address: string }>,
): Map<string, string> {
  const shared = sharedSenderNames(senders);
  return new Map(
    senders.map((s) => [
      s.id,
      shared.has(s.name.trim().toLowerCase()) ? `${s.name.trim()} (${s.address})` : s.name,
    ]),
  );
}

/**
 * The removable chips under the filter bar, one per Filters-panel filter that's on. `names` gives
 * sender, mailbox and board labels (from the facets); an unknown one reads "1 sender" / "Mailbox"
 * / "Board".
 */
export function activeFilterChips(
  p: GalleryParams,
  names: {
    senders?: ReadonlyMap<string, string>;
    mailboxes?: ReadonlyMap<string, string>;
    boards?: ReadonlyMap<string, string>;
  } = {},
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (p.smin !== 0 || p.smax !== 100)
    chips.push({
      key: "score",
      label: `Score ${p.smin}–${p.smax}`,
      remove: { smin: null, smax: null },
    });
  if (p.date === "custom") {
    const label =
      p.since && p.until
        ? `${formatDay(p.since)} – ${formatDay(p.until)}`
        : p.since
          ? `Since ${formatDay(p.since)}`
          : `Until ${formatDay(p.until!)}`;
    chips.push({ key: "date", label, remove: { date: null, since: null, until: null } });
  } else if (p.date !== "any") {
    chips.push({ key: "date", label: GALLERY_DATE_LABELS[p.date], remove: { date: null } });
  }
  for (const id of p.sender)
    chips.push({
      key: `sender:${id}`,
      label: names.senders?.get(id) ?? "1 sender",
      remove: { sender: p.sender.filter((x) => x !== id) },
    });
  for (const issue of p.problem)
    chips.push({
      key: `problem:${issue}`,
      label: GALLERY_PROBLEM_LABELS[issue],
      remove: { problem: p.problem.filter((x) => x !== issue) },
    });
  if (p.mailbox)
    chips.push({
      key: "mailbox",
      label: names.mailboxes?.get(p.mailbox) ?? "Mailbox",
      remove: { mailbox: null },
    });
  if (p.webfonts !== "any")
    chips.push({
      key: "webfonts",
      label: GALLERY_WEB_FONT_LABELS[p.webfonts],
      remove: { webfonts: null },
    });
  if (p.board)
    chips.push({
      key: "board",
      label: `Board: ${names.boards?.get(p.board) ?? "a board"}`,
      remove: { board: null },
    });
  return chips;
}

/** How many pages `total` designs make at `size` per page (at least 1, so page 1 always exists). */
export function pageCountOf(total: number, size: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** `page` kept within 1..the last page. */
export function clampPage(page: number, total: number, size: number): number {
  return Math.min(Math.max(1, Math.floor(page) || 1), pageCountOf(total, size));
}

/** "Showing first–last of total": the 1-based positions on this page (0–0 when empty). */
export function pageBounds(
  page: number,
  size: number,
  total: number,
): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 };
  const first = (clampPage(page, total, size) - 1) * size + 1;
  return { first, last: Math.min(total, first + size - 1) };
}

/**
 * The page buttons to show: always the first and last page and the pages next to the current one,
 * with "gap" for a run of hidden pages (1 … 4 5 6 … 12). A gap never hides just one page — that
 * page is shown instead.
 */
export function pageWindow(page: number, pageCount: number, around = 1): Array<number | "gap"> {
  const last = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), last);
  const keep = new Set<number>([1, last]);
  for (let i = current - around; i <= current + around; i++) if (i >= 1 && i <= last) keep.add(i);
  const pages = [...keep].sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  for (const [i, n] of pages.entries()) {
    const prev = pages[i - 1];
    if (prev !== undefined && n - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && n - prev > 2) out.push("gap");
    out.push(n);
  }
  return out;
}
