/**
 * The Excellent gate (DESIGN-SCORE §3.1 "Excellent needs design substance", methodology 2026.5).
 *
 * The points model rewards compliance: a two-line, unstyled notification that fits a phone, has
 * good contrast and named links can reach 85 without any design at all. "Good design" must be
 * REALLY good, so a score of 85+ (the Excellent band, the gallery's "Good design") also needs
 * every bar below. Without an AI rating of 4/5 or better (H7 / L8 / I6), all of:
 *
 *  - G1 a real headline: heading text exists (H6 `headline`) and the largest first-screen text
 *    is ≥ 1.5× the body text (H6 ratio) — a big button or navigation label is not a headline;
 *  - G2 a main button that stands out: H3's fill salience ≥ 0.9, and the button is the most
 *    prominent link or sits in the first phone screen (H2 passes) — the render's prominence also
 *    weighs image and card links (Canva's template thumbnails), so a filled button up top is
 *    enough. A weak label contrast is H3's own listed problem, not a gate miss;
 *  - G2's "first phone screen" is read from the render for EVERY type (`ctaPlacement`, H2's
 *    credit ≥ 0.9), not from H2's status — H2 is only scored for action types, and a notification
 *    template must not pass or fail on a link further down while its top is the same (2026.6);
 *    and the main button must stand out from the other buttons too: with three or more buttons
 *    in one look-alike style (L6 `buttonStyles` 1) for three or more different actions in the
 *    first two phone screens (H5 `distinct`), none of them is the main one (Google Workspace's
 *    three blue "Try AI in …" pills; 2026.6);
 *  - G3 for system and plain mail (every type but promotional, product update and event):
 *    content images cover ≥ 8% of the email (I1 image share, compared as saved: 3 decimals).
 *    When most of its content images (> 50%) weren't drawn for reasons that say nothing about the
 *    design (our limits, an expired link, the network), the imagery is unknown and G3 can't pass —
 *    worded as such only when the missing images could have reached 8% (`imgShareIfLoaded`), else
 *    it is simply few images. With images off for the email (`imagesOff`: our policy for account
 *    and transactional mail, suspicious mail and privacy mode) nothing was drawn by our choice, so
 *    G3 isn't judged: G1 and G2 decide.
 *  - G4 a designed hero, for every type (2026.6): a real picture — a drawn content image at least
 *    300 px wide on desktop and an image of at least 40,000 px² (e.g. 400 × 100; a logo strip,
 *    avatar, icon or badge row is smaller) — or a large heading painted on a band, panel or dark
 *    theme (its background ≥ 1.15:1 against white: the Betterbrand / Abekus header bands, Remote's
 *    tinted hero, AI Studio's dark theme). A stock template — a logo, a plain headline on white, a
 *    few lines and a button (LinkedIn's "new message", MongoDB's announcements, FlexJobs' "account
 *    created") — has neither: reviewers call these Okay however clean they are. When an image that
 *    wasn't drawn for unknown reasons could have been the hero (≥ 40,000 px² or no known size)
 *    and there is no band, the miss is `imagery_unknown`, not `hero`; with images off for the
 *    email the picture can't be seen, so G4 isn't judged (like G3).
 *
 * An AI rating of 4+ on hierarchy, polish or imagery stands in for G1–G4 (the review judges the
 * design itself). And always: no large phone-layout problem — at most half the body text
 * squeezed into narrow columns (M3) or running to the screen edge (M7) on a 375px phone.
 *
 * Without the facts the bars need (no type / image facts passed, or the headline / button
 * checks not evaluated) the v1.3 rule applies instead: a real headline OR a standout button
 * (H3 passes) OR the AI rating ("plain" when none).
 *
 * An email that misses the gate is held at 84 (the top of the Good band, the gallery's "Okay").
 * The gate is NOT a cap: it isn't a defect, it never makes an email "Bad", and it isn't listed in
 * `caps`. Its explanation item (`gate:excellence`) carries the points it removed so the
 * explanations still reconcile. The gate is evaluated for every rendered email, binding or not,
 * so the saved signals can show each bar (summary.ts `gate`).
 */
import type { EmailType } from "@edf/core/types";
import type { RenderFeatures } from "../features/render";
import type { CheckId, CheckResult, GateBar } from "../types";
import { WHITE, contrastRatio, fromHex } from "../util/color";

/** Highest score an email that misses the gate can show (top of the Good band). */
export const EXCELLENCE_CEILING = 84;
/** H6 credit for "a real headline": ramp(ratio, 1.1, 1.6) ≥ 0.8 ⇔ ratio ≥ 1.5 (v1.3 rule). */
export const HEADLINE_CREDIT_MIN = 0.8;
/** G1: the headline is at least this many times the body text. */
export const HEADLINE_RATIO_MIN = 1.5;
/** G2: the main button's fill salience (H3 `salience`, 0..1) at least this. */
export const CTA_SALIENCE_MIN = 0.9;
/** G3: content images cover at least this share of the email (I1 `imgShare`)… */
export const IMAGERY_SHARE_MIN = 0.08;
/** …and the imagery is unknown when more than this share of the content images wasn't drawn. */
export const IMAGES_UNKNOWN_SHARE_MAX = 0.5;
/** G4: a drawn content image at least this wide on desktop (CSS px)… */
export const HERO_PICTURE_WIDTH_MIN = 300;
/** …and a drawn image at least this large on desktop (CSS px², e.g. 400 × 100)… */
export const HERO_PICTURE_AREA_MIN = 40_000;
/** …or a large heading on a background at least this far from white (contrast ratio). */
export const HERO_BAND_CONTRAST_MIN = 1.15;
/** A band's heading has at least this many characters (not a "NEW" pill or a one-word tag). */
const HERO_BAND_CHARS_MIN = 10;
/** G2: this many button-like links in one style, for this many different actions, compete. */
export const COMPETING_BUTTONS_MIN = 3;
/** A phone-layout problem blocks Excellent when it affects at least this share of body text. */
export const PHONE_PROBLEM_SHARE = 0.5;

/** G3 applies to every type but these (they carry their own imagery: offers, launches, events). */
const IMAGERY_EXEMPT: ReadonlySet<EmailType> = new Set(["promotional", "product_update", "event"]);

/** G3 applies to this type (system and plain mail). */
export function imageryRequired(t: EmailType): boolean {
  return !IMAGERY_EXEMPT.has(t);
}

/**
 * Why the email can't be Excellent: the bar it fails (types.ts `GateBar`).
 * - `headline` (G1), `button` (G2), `imagery` (G3: images under 8%), `imagery_unknown` (G3: most
 *   images weren't drawn and could have reached 8%, so it can't pass; G4: a large image wasn't
 *   drawn and there is no band, so a hero can't be seen), `hero` (G4: no hero picture or band);
 * - `phone_narrow` (M3), `phone_edge` (M7);
 * - `plain`: the v1.3 rule, only when the bars' facts are missing.
 */
export type ExcellenceMiss = GateBar;

/** The facts G3 reads, from the render (score.ts). */
export interface GateFacts {
  primaryType: EmailType;
  /**
   * I1 image share (content images ÷ the email above the footer), rounded to 3 decimals as the
   * saved `imgShare` signal is; null without a render.
   */
  imgShare: number | null;
  /** Share of content images not drawn for unknown reasons (images.ts), null when unmeasured. */
  imagesUnknownShare: number | null;
  /** The share if the not-drawn images had loaded (images.ts `imageShareIfLoaded`). */
  imgShareIfLoaded?: number | null;
  /** Images were off for the email (images.ts `imagesOff`): G3 and G4 aren't judged. */
  imagesOff?: boolean;
  /**
   * G2: the main button sits in the first phone screen (`ctaPlacement` credit ≥ 0.9), measured
   * for every type; null without a main button. Absent: H2's status decides (older callers).
   */
  ctaFirstScreen?: boolean | null;
  /**
   * G2 (`competingButtons`): three or more look-alike buttons for three or more different
   * actions — no main button among them. Absent: not judged (older callers).
   */
  ctaCompeting?: boolean;
  /** G4 (`heroFacts`): a hero picture was drawn; absent = G4 isn't judged (older callers). */
  heroPicture?: boolean;
  /** G4 (`heroFacts`): a large heading sits on a painted band, panel or dark theme. */
  heroBand?: boolean;
  /**
   * G4: an image that wasn't drawn for unknown reasons could have been the hero picture
   * (images.ts `largeImageMissing`): without a hero the miss is `imagery_unknown`, not `hero`.
   */
  heroUnknown?: boolean;
}

/**
 * G2's look-alike buttons (pure): ≥ 3 button-like links (`cta.buttonLike`), one button style (L6
 * `buttonStyles`) and ≥ 3 different actions among them in the first two phone screens (H5
 * `firstTwoViewportsDistinct`: label or target). Three cards with the same "Explore course"
 * button are one action; a filled primary beside outline secondaries is two styles.
 */
export function competingButtons(r: RenderFeatures): boolean {
  return (
    r.cta.buttonLike >= COMPETING_BUTTONS_MIN &&
    r.cta.buttonStyles === 1 &&
    r.cta.firstTwoViewportsDistinct >= COMPETING_BUTTONS_MIN
  );
}

/**
 * G4's facts from a render (pure): a hero picture — a drawn content image ≥ 300 px wide (M5's
 * `adapt` list, loaded) and a drawn image of ≥ 40,000 px² (`loads[].area`; renders before
 * render-2026.4 have no areas: the width decides) — and a heading band: a rendered large heading
 * group of ≥ 10 characters whose background is ≥ 1.15:1 against white.
 */
export function heroFacts(r: RenderFeatures): { heroPicture: boolean; heroBand: boolean } {
  const wide = r.images.adapt.some(
    (a) => a.sharpRatio !== null && a.renderedWidth >= HERO_PICTURE_WIDTH_MIN - EPS,
  );
  const drawn = r.images.loads.filter((l) => l.decoded);
  const measured = drawn.some((l) => typeof l.area === "number");
  const large = !measured || drawn.some((l) => (l.area ?? 0) >= HERO_PICTURE_AREA_MIN - EPS);
  const heroBand = r.contrast.groups.some((g) => {
    if (g.role !== "heading" || !g.large || !g.rendered || g.chars < HERO_BAND_CHARS_MIN)
      return false;
    const bg = fromHex(g.bg);
    return bg !== null && contrastRatio(bg, WHITE) >= HERO_BAND_CONTRAST_MIN - EPS;
  });
  return { heroPicture: wide && large, heroBand };
}

export interface ExcellenceGate {
  /** Why the email can't be Excellent (empty = the gate is open), G1–G4 first. */
  misses: ExcellenceMiss[];
  /** "bars": G1–G4 were judged; "legacy": their facts were missing, the v1.3 rule decided. */
  rule: "bars" | "legacy";
  /** An AI rating ≥ 4 (H7 / L8 / I6) stood in for G1–G4. */
  ai: boolean;
  /** Headline size ÷ body size (H6), when measured. */
  headlineRatio: number | null;
  /** H6 found a heading at all (`headline`); false = "No headline", null when not measured. */
  hasHeadline: boolean | null;
  /** H6: the email has content images, so a missing live-text headline may sit in a picture. */
  headlinePictures: boolean;
  /** A primary button exists (whether or not it stands out). */
  hasButton: boolean;
  /** H3 fill salience 0..1 of the main button, when it has one. */
  ctaSalience: number | null;
  /** H3: the main button is the most prominent link, when it has one. */
  ctaMostProminent: boolean | null;
  /**
   * The main button sits in the first phone screen (H2's credit ≥ 0.9, measured for every type),
   * when it has one.
   */
  ctaFirstScreen: boolean | null;
  /** H3 label contrast (null for an image button or without a button). */
  ctaLabelContrast: number | null;
  /** G2: look-alike buttons for different actions compete (`competingButtons`); null unjudged. */
  ctaCompeting: boolean | null;
  /** I1 image share (3 decimals), when measured. */
  imgShare: number | null;
  /** G3 and G4 weren't judged: images were off for the email. */
  imagesOff: boolean;
  /** G4: a hero picture was drawn; null when G4's facts weren't passed. */
  heroPicture: boolean | null;
  /** G4: a large heading sits on a painted band; null when G4's facts weren't passed. */
  heroBand: boolean | null;
  /** Share of body text squeezed into narrow columns (1 − M3 wideShare), when measured. */
  narrowShare: number | null;
  /** Share of body text at the screen edge (1 − M7 okShare), when measured. */
  edgeShare: number | null;
}

type Value = Record<string, unknown>;

function val(c: Pick<CheckResult, "value"> | undefined): Value {
  return c && typeof c.value === "object" && c.value !== null ? (c.value as Value) : {};
}

function num(v: Value, key: string): number | null {
  const x = v[key];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

const evaluated = (c: Pick<CheckResult, "status"> | undefined) =>
  !!c && (c.status === "pass" || c.status === "partial" || c.status === "fail");

const AI_DISTINCTIVE: readonly CheckId[] = ["H7", "L8", "I6"];

const EPS = 1e-9;

/** Evaluate the gate from the check results and, for G1–G4, the render facts (pure). */
export function excellenceGate(
  checks: ReadonlyArray<Pick<CheckResult, "id" | "status" | "s" | "value">>,
  facts?: GateFacts | null,
): ExcellenceGate {
  const byId = new Map(checks.map((c) => [c.id, c] as const));
  const h6 = byId.get("H6");
  const h3 = byId.get("H3");
  const ai = AI_DISTINCTIVE.some((id) => {
    const c = byId.get(id);
    const level = num(val(c), "level");
    return !!c && (c.status === "pass" || c.status === "partial") && level !== null && level >= 4;
  });
  const headlineRatio = evaluated(h6) ? num(val(h6), "ratio") : null;
  const hasHeadline =
    evaluated(h6) && typeof val(h6).headline === "boolean" ? (val(h6).headline as boolean) : null;
  // H3 only runs with a primary CTA (`present`); not applicable = a type without a button.
  const cta = evaluated(h3) && val(h3).present !== false ? val(h3) : null;
  const ctaSalience = cta ? num(cta, "salience") : null;
  const ctaMostProminent = cta && typeof cta.mostProminent === "boolean" ? cta.mostProminent : null;
  const h2 = byId.get("H2");
  const ctaFirstScreen = !cta
    ? null
    : facts && facts.ctaFirstScreen !== undefined
      ? facts.ctaFirstScreen
      : evaluated(h2)
        ? h2!.status === "pass"
        : null;
  const m3 = byId.get("M3");
  const m7 = byId.get("M7");
  const wide = evaluated(m3) ? num(val(m3), "wideShare") : null;
  const ok = evaluated(m7) ? num(val(m7), "okShare") : null;
  const narrowShare = wide === null ? null : 1 - wide;
  const edgeShare = ok === null ? null : 1 - ok;
  // Images off for the email (our policy): its imagery isn't measured, so G3 isn't judged.
  const imagery = facts ? imageryRequired(facts.primaryType) && facts.imagesOff !== true : false;
  // G4 for every type, when its facts were passed; not with images off (nothing drawn by choice).
  const hero = !!facts && facts.heroPicture !== undefined && facts.imagesOff !== true;
  // The bars need the type, the headline and button checks run (N/A counts: no headline / no
  // button), and for G3 the image share; else the v1.3 rule decides.
  const ran = (c: Pick<CheckResult, "status"> | undefined) => !c || c.status !== "not_evaluated";
  const bars = !!facts && !!h6 && ran(h6) && ran(h3) && (!imagery || facts.imgShare !== null);
  const misses: ExcellenceMiss[] = [];
  if (bars && !ai) {
    // G1: heading text must exist — a 28px button label alone is not a headline.
    if (hasHeadline === false || headlineRatio === null || headlineRatio < HEADLINE_RATIO_MIN - EPS)
      misses.push("headline");
    // G2: a filled button that stands out — first among the links, or first on the phone screen
    // — and isn't one of several look-alike buttons for different actions.
    const filled = ctaSalience !== null && ctaSalience >= CTA_SALIENCE_MIN - EPS;
    const competing = cta !== null && facts!.ctaCompeting === true;
    if (!filled || competing || (ctaMostProminent !== true && ctaFirstScreen !== true))
      misses.push("button");
    if (imagery) {
      const share = facts!.imgShare ?? 0;
      const unknown = facts!.imagesUnknownShare;
      const mostlyUnknown = unknown !== null && unknown > IMAGES_UNKNOWN_SHARE_MAX + EPS;
      if (share < IMAGERY_SHARE_MIN - EPS) {
        // Few images — blamed on loading only when the missing ones could have reached the bar.
        const couldReach = (facts!.imgShareIfLoaded ?? share) >= IMAGERY_SHARE_MIN - EPS;
        misses.push(mostlyUnknown && couldReach ? "imagery_unknown" : "imagery");
      } else if (mostlyUnknown) misses.push("imagery_unknown");
    }
    // G4: a designed hero — a real picture or a headline band (not judged with images off).
    if (hero && facts!.heroPicture !== true && facts!.heroBand !== true) {
      if (facts!.heroUnknown !== true) misses.push("hero");
      else if (!misses.includes("imagery_unknown")) misses.push("imagery_unknown");
    }
  } else if (!bars) {
    const headline = evaluated(h6) && (h6!.s ?? 0) >= HEADLINE_CREDIT_MIN - EPS;
    const button = !!h3 && h3.status === "pass" && val(h3).present !== false;
    if (!headline && !button && !ai) misses.push("plain");
  }
  if (narrowShare !== null && narrowShare >= PHONE_PROBLEM_SHARE - EPS) misses.push("phone_narrow");
  if (edgeShare !== null && edgeShare >= PHONE_PROBLEM_SHARE - EPS) misses.push("phone_edge");
  const h1 = byId.get("H1");
  const hasButton = cta !== null || (!!h1 && h1.status === "pass");
  return {
    misses,
    rule: bars ? "bars" : "legacy",
    ai,
    headlineRatio,
    hasHeadline,
    headlinePictures: evaluated(h6) && val(h6).pictures === true,
    hasButton,
    ctaSalience,
    ctaMostProminent,
    ctaFirstScreen,
    ctaLabelContrast: cta ? num(cta, "labelContrast") : null,
    ctaCompeting: cta && facts && facts.ctaCompeting !== undefined ? facts.ctaCompeting : null,
    imgShare: facts?.imgShare ?? null,
    imagesOff: facts?.imagesOff === true,
    heroPicture: facts?.heroPicture ?? null,
    heroBand: facts?.heroBand ?? null,
    narrowShare,
    edgeShare,
  };
}

/** The checks behind a miss (absorbed into the gate's explanation item). */
export const MISS_CHECKS: Readonly<Record<ExcellenceMiss, readonly CheckId[]>> = {
  headline: ["H6"],
  button: ["H3"],
  imagery: [],
  imagery_unknown: [],
  hero: [],
  plain: ["H6"],
  phone_narrow: ["M3"],
  phone_edge: ["M7"],
};
