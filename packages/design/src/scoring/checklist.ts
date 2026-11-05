/**
 * The design checklist (2026-11-05): the owner's 16 rules for a good email design, from their
 * notes on Designmodo's "Email Design: The Ultimate Guide with Examples" (the "Email Design Cheat
 * Sheet"). The gallery's Good / Okay / Bad verdict follows it strictly (apps/web lib/gallery.ts):
 * Good = every rule checked and passed; Okay = one or two rules missed, or all passed with one we
 * couldn't check; Bad = three or more missed.
 *
 * Each rule reads the engine's measured checks (CheckResult) and the saved signals. A rule is:
 *  - "pass" / "miss" when the measurement decides it;
 *  - "na" when it doesn't apply (no pictures: nothing to load or describe; short copy: nothing to
 *    break up);
 *  - "unknown" when the email's own measurements can't see it — mostly an email made of pictures,
 *    whose headline, body copy and button are inside the images ("imageMade": under 200
 *    characters of real live text). Its dependence on pictures is still judged, by rule 16.
 *
 * What the engine can't measure is said, never guessed: whether the fonts and colours are the
 * brand's own (rules 8–9 check that there are at most two font families and a small palette), and
 * whether the pictures support the message (rule 13 checks that they load and are described).
 *
 * Calibrated on the owner's and a friend's 137 fully measured gallery emails (2026-11-05): 5 pass
 * everything with nothing unchecked (Canva, Booking.com, Remote.co…); letter-style emails with a
 * list of text links and no button miss 7–8 rules. Rules are pure functions of stored data, so
 * the checklist can be recomputed for any email whose checks are still stored.
 */
import type { CheckResult, SummarySignals } from "../types";

export const CHECKLIST_VERSION = "designmodo-2026.11";

export type ChecklistRuleId =
  | "message"
  | "button"
  | "hero"
  | "hierarchy"
  | "scan"
  | "width"
  | "mobile"
  | "fonts"
  | "colors"
  | "body"
  | "cta"
  | "contrast"
  | "images"
  | "whitespace"
  | "clutter"
  | "no_decoration";

export type ChecklistResult = "pass" | "miss" | "na" | "unknown";

export interface ChecklistRule {
  id: ChecklistRuleId;
  result: ChecklistResult;
  /** One plain sentence about this email (measured values, never a guess). */
  why: string;
}

export interface DesignChecklist {
  v: typeof CHECKLIST_VERSION;
  rules: ChecklistRule[];
  /** Rules missed. */
  misses: number;
  /** Rules the measurements couldn't see. */
  unknown: number;
}

/** The rules in the cheat sheet's order, with their plain names. */
export const CHECKLIST_RULES: ReadonlyArray<{ id: ChecklistRuleId; label: string }> = [
  { id: "message", label: "One clear message" },
  { id: "button", label: "One main button" },
  { id: "hero", label: "Strong top section" },
  { id: "hierarchy", label: "Clear order of importance" },
  { id: "scan", label: "Easy to scan" },
  { id: "width", label: "About 600px wide" },
  { id: "mobile", label: "Works on phones" },
  { id: "fonts", label: "Fonts used well" },
  { id: "colors", label: "Colours used well" },
  { id: "body", label: "Readable body text" },
  { id: "cta", label: "Button is specific and visible" },
  { id: "contrast", label: "Good contrast" },
  { id: "images", label: "Pictures load and are described" },
  { id: "whitespace", label: "Right amount of white space" },
  { id: "clutter", label: "Nothing unnecessary" },
  { id: "no_decoration", label: "Works without the pictures" },
];

/** Under this many characters of real live text, the email is made of pictures (rule 16). */
export const IMAGE_MADE_LIVE_CHARS = 200;
/** Rule 4 / 1: the headline at least this many times the body text (H6 ratio). */
export const HEADLINE_RATIO = 1.5;
/** Rule 10: body text on a phone at least this (CSS px × layout scale; the guide: 14–16 px). */
export const BODY_PHONE_PX_MIN = 14;
/** Rule 10: line height at least this × the text size (the guide: about 1.5×). */
export const LINE_HEIGHT_MIN = 1.4;
/** Rule 12: at least this share of the main text passes WCAG AA 4.5:1 (A1 credit). */
export const CONTRAST_CREDIT_MIN = 0.9;
/** H4's credit for a generic button label ("Learn more", "Click here"): rule 11 misses it. */
export const GENERIC_LABEL_CREDIT = 0.4;
/** Rule 8: at most this many font families. */
export const FONT_FAMILIES_MAX = 2;
/** The verdict: this many missed rules or more is Bad. */
export const BAD_MISSES_MIN = 3;

type Checks = ReadonlyArray<Pick<CheckResult, "id" | "status" | "s" | "value">>;

/** A check's credit, or "na" (doesn't apply) / "ne" (not measured). */
function credit(checks: Checks, id: string): number | "na" | "ne" {
  const c = checks.find((x) => x.id === id);
  if (!c || c.status === "not_evaluated" || c.status === "needs_review") return "ne";
  if (c.status === "not_applicable") return "na";
  return typeof c.s === "number" && Number.isFinite(c.s) ? c.s : "ne";
}

function value(checks: Checks, id: string): Record<string, unknown> {
  const c = checks.find((x) => x.id === id);
  const v = c?.value;
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function atLeast(x: number | "na" | "ne", min: number): boolean {
  return typeof x === "number" && x >= min - 1e-9;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const px = (x: number) => `${round1(x)}px`;
const quote = (label: unknown) =>
  typeof label === "string" && label.trim()
    ? `“${label.trim().replace(/^button:\s*/i, "")}”`
    : "the main button";

/**
 * The checklist for an email with a render (its own or its template's). Pure: the same checks and
 * signals always give the same answer.
 */
export function designChecklist(
  checks: Checks,
  signals: Partial<SummarySignals> | null | undefined,
): DesignChecklist {
  const sig = signals ?? {};
  const liveChars = num(sig.liveTextChars) ?? num(value(checks, "I1").legibleChars);
  const imageMade = liveChars !== null && liveChars < IMAGE_MADE_LIVE_CHARS;
  const insidePictures = "The text is inside the pictures, so we can't measure it.";
  const rule = (id: ChecklistRuleId, result: ChecklistResult, why: string): ChecklistRule => ({
    id,
    result,
    why,
  });

  const buttonPresent = value(checks, "H1").present === true;
  const competing = sig.ctaCompeting === true;
  const heroPicture = sig.heroPicture ?? null;
  const heroBand = sig.heroBand ?? null;
  const hasHero = heroPicture === true || heroBand === true;
  const heroKnown = heroPicture !== null || heroBand !== null;
  const headlineRatio = num(sig.headlineRatio);
  const strongHeadline =
    sig.hasHeadline === true && headlineRatio !== null && headlineRatio >= HEADLINE_RATIO;
  const distinct = num(value(checks, "H5").distinct);

  const rules: ChecklistRule[] = [];

  // 1. One clear message: a dominant headline or hero up top, pushing one action.
  if (!hasHero && !strongHeadline) {
    rules.push(
      heroKnown || sig.hasHeadline !== undefined
        ? rule(
            "message",
            "miss",
            "The top of the email has no dominant headline or picture to say what it's about.",
          )
        : rule("message", "unknown", "We couldn't measure the top of this email."),
    );
  } else if (distinct !== null && distinct > 1) {
    rules.push(
      rule(
        "message",
        "miss",
        `The first screens push ${distinct} different actions instead of one.`,
      ),
    );
  } else {
    rules.push(rule("message", "pass", "One main message leads the email."));
  }

  // 2. One main button.
  if (!buttonPresent) {
    rules.push(
      imageMade
        ? rule("button", "unknown", "Any button is inside a picture, so we can't see it.")
        : rule("button", "miss", "There's no button, only text links."),
    );
  } else if (competing) {
    rules.push(
      rule("button", "miss", "Three or more look-alike buttons compete for different actions."),
    );
  } else {
    rules.push(rule("button", "pass", "One main button leads to the action."));
  }

  // 3. Strong top section (hero).
  if (hasHero) {
    rules.push(
      rule(
        "hero",
        "pass",
        heroPicture ? "A big picture opens the email." : "A bold headline band opens the email.",
      ),
    );
  } else if (heroKnown) {
    rules.push(rule("hero", "miss", "The first screen has no big picture or bold headline band."));
  } else {
    rules.push(rule("hero", "unknown", "We couldn't measure the top of this email."));
  }

  // 4. Clear visual hierarchy: the headline clearly bigger than the body text.
  const h6 = credit(checks, "H6");
  const h6v = value(checks, "H6");
  const ratio = num(h6v.ratio);
  if (imageMade || h6 === "na" || h6 === "ne") {
    rules.push(
      rule(
        "hierarchy",
        "unknown",
        imageMade ? insidePictures : "We couldn't measure the text sizes.",
      ),
    );
  } else if (atLeast(h6, 0.75)) {
    rules.push(
      rule(
        "hierarchy",
        "pass",
        `The headline is ${ratio !== null ? `${round1(ratio)}×` : "clearly bigger than"} the body text.`,
      ),
    );
  } else if (h6v.pictures === true && heroPicture === true) {
    rules.push(
      rule(
        "hierarchy",
        "unknown",
        "The headline looks to be inside the top picture, so we can't measure it.",
      ),
    );
  } else {
    rules.push(
      rule(
        "hierarchy",
        "miss",
        ratio !== null
          ? `The biggest text is only ${round1(ratio)}× the body text, so nothing stands out (your rule: a clear headline).`
          : "Nothing in the text stands out as the headline.",
      ),
    );
  }

  // 5. Easy to scan: no walls of text.
  const c3 = credit(checks, "C3");
  const c3v = value(checks, "C3");
  if (c3 === "na") rules.push(rule("scan", "na", "Short copy, nothing to break up."));
  else if (c3 === "ne") rules.push(rule("scan", "unknown", "We couldn't measure the paragraphs."));
  else if (atLeast(c3, 0.75))
    rules.push(rule("scan", "pass", "Text comes in short chunks with headings."));
  else {
    const words = num(c3v.maxWordsBetweenHeadings);
    rules.push(
      rule(
        "scan",
        "miss",
        words !== null
          ? `Walls of text: up to ${words} words without a heading.`
          : "Long paragraphs make it hard to scan.",
      ),
    );
  }

  // 6. About 600px wide on desktop.
  const l1 = credit(checks, "L1");
  const width = num(value(checks, "L1").width);
  if (l1 === "na" || l1 === "ne")
    rules.push(rule("width", "unknown", "We couldn't measure the width."));
  else if (atLeast(l1, 0.75))
    rules.push(
      rule(
        "width",
        "pass",
        width !== null ? `${Math.round(width)}px wide on desktop.` : "About 600px wide on desktop.",
      ),
    );
  else
    rules.push(
      rule(
        "width",
        "miss",
        `${width !== null ? `${Math.round(width)}px` : "Not about 600px"} wide on desktop (your rule: about 600px).`,
      ),
    );

  // 7. Works on phones: fits the screen, text not squeezed or at the edge.
  const m1 = credit(checks, "M1");
  const m3 = credit(checks, "M3");
  const m7 = credit(checks, "M7");
  if (m1 === "na" || m1 === "ne")
    rules.push(rule("mobile", "unknown", "We couldn't measure the phone layout."));
  else if (!atLeast(m1, 0.9)) {
    const k = num(value(checks, "M1").k);
    rules.push(
      rule(
        "mobile",
        "miss",
        `Doesn't fit a phone: it shrinks to ${k !== null ? `${Math.round(k * 100)}%` : "a smaller size"}.`,
      ),
    );
  } else if (m3 !== "na" && m3 !== "ne" && !atLeast(m3, 0.75)) {
    rules.push(rule("mobile", "miss", "On phones the text is squeezed into narrow columns."));
  } else if (m7 !== "na" && m7 !== "ne" && !atLeast(m7, 0.75)) {
    rules.push(rule("mobile", "miss", "On phones the text runs to the screen edge."));
  } else {
    rules.push(rule("mobile", "pass", "Fits a phone screen with room around the text."));
  }

  // 8. Fonts: at most two families (whether they're the brand's own isn't checked).
  const t6 = credit(checks, "T6");
  const families = num(value(checks, "T6").families);
  if (t6 === "na" || t6 === "ne" || families === null)
    rules.push(rule("fonts", "unknown", "We couldn't read the fonts."));
  else if (families <= FONT_FAMILIES_MAX)
    rules.push(
      rule("fonts", "pass", `Uses ${families} font ${families === 1 ? "family" : "families"}.`),
    );
  else
    rules.push(
      rule("fonts", "miss", `Uses ${families} font families (your rule: no more than two).`),
    );

  // 9. Colours: a small, consistent palette (whether it's the brand's own isn't checked).
  const l5 = credit(checks, "L5");
  const l5v = value(checks, "L5");
  if (l5 === "na" || l5 === "ne")
    rules.push(rule("colors", "unknown", "We couldn't measure the colours."));
  else if (atLeast(l5, 0.75))
    rules.push(rule("colors", "pass", "A small, consistent set of colours."));
  else {
    const textColours = num(l5v.textColours);
    rules.push(
      rule(
        "colors",
        "miss",
        textColours !== null
          ? `Too many colours: ${textColours} different text colours.`
          : "Too many different colours.",
      ),
    );
  }

  // 10. Readable body copy: 14–16px on a phone, about 1.5× line height.
  const t1 = credit(checks, "T1");
  const bodyPx = num(value(checks, "T1").px);
  const t3 = credit(checks, "T3");
  const lineRatio = num(value(checks, "T3").ratio);
  if (imageMade) rules.push(rule("body", "unknown", insidePictures));
  else if (t1 === "na" || t1 === "ne" || bodyPx === null)
    rules.push(rule("body", "unknown", "We couldn't measure the body text."));
  else if (bodyPx < BODY_PHONE_PX_MIN)
    rules.push(rule("body", "miss", `Body text is ${px(bodyPx)} on phones (your rule: 14–16px).`));
  else if (t3 !== "na" && t3 !== "ne" && lineRatio !== null && lineRatio < LINE_HEIGHT_MIN)
    rules.push(
      rule(
        "body",
        "miss",
        `Lines are packed tight (${round1(lineRatio)}× line height; your rule: about 1.5×).`,
      ),
    );
  else
    rules.push(
      rule(
        "body",
        "pass",
        `Body text is ${px(bodyPx)} on phones${lineRatio !== null ? ` with ${round1(lineRatio)}× line height` : ""}.`,
      ),
    );

  // 11. The button is specific and visible.
  const h3 = credit(checks, "H3");
  const h4 = credit(checks, "H4");
  const label = value(checks, "H3").label ?? value(checks, "H4").label;
  if (!buttonPresent) {
    rules.push(
      imageMade
        ? rule("cta", "unknown", "Any button is inside a picture, so we can't see it.")
        : rule("cta", "miss", "There's no button for the reader to click."),
    );
  } else if (value(checks, "I2").ctaLive === false) {
    rules.push(
      rule(
        "cta",
        "unknown",
        `The button ${quote(label)} is a picture, so we can't measure how it looks.`,
      ),
    );
  } else if (h4 !== "na" && h4 !== "ne" && h4 <= GENERIC_LABEL_CREDIT + 1e-9) {
    // H4 gives a generic label ("Learn more", "Click here") 0.4; long but specific labels get
    // 0.5–0.7, and the guide only asks for specific, action-oriented words.
    rules.push(
      rule(
        "cta",
        "miss",
        `${quote(label)} is too vague (your rule: say what happens, like “Shop the sale”).`,
      ),
    );
  } else if (h3 === "ne" || h3 === "na") {
    rules.push(rule("cta", "unknown", "We couldn't measure how the button looks."));
  } else if (!atLeast(h3, 0.7)) {
    rules.push(
      rule("cta", "miss", `${quote(label)} doesn't stand out from the rest of the email.`),
    );
  } else {
    rules.push(rule("cta", "pass", `${quote(label)} is specific and stands out.`));
  }

  // 12. Good contrast: main text at WCAG AA 4.5:1.
  const a1 = credit(checks, "A1");
  const a1v = value(checks, "A1");
  if (imageMade || a1 === "na" || a1 === "ne")
    rules.push(
      rule(
        "contrast",
        "unknown",
        imageMade ? insidePictures : "We couldn't measure the text colours.",
      ),
    );
  else if (atLeast(a1, CONTRAST_CREDIT_MIN))
    rules.push(rule("contrast", "pass", "Text stands out clearly from its background."));
  else {
    const fail = num(a1v.mainFailShare) ?? num(a1v.failShare);
    rules.push(
      rule(
        "contrast",
        "miss",
        fail !== null
          ? `${Math.round(fail * 100)}% of the text is too faint against its background (your rule: 4.5:1).`
          : "Some text is too faint against its background.",
      ),
    );
  }

  // 13. Pictures load and are described (whether they support the message isn't measured).
  const i3 = credit(checks, "I3");
  const a2v = value(checks, "A2");
  const meaningful = num(a2v.meaningfulShare);
  if (i3 === "na") rules.push(rule("images", "na", "No pictures in this email."));
  else if (i3 === "ne")
    rules.push(rule("images", "unknown", "We couldn't load the pictures to check them."));
  else if (!atLeast(i3, 0.9)) rules.push(rule("images", "miss", "Some pictures don't load."));
  else if (meaningful !== null && meaningful < 0.5)
    rules.push(
      rule(
        "images",
        "miss",
        "Most pictures have no real description (alt text) for people who can't see them.",
      ),
    );
  else rules.push(rule("images", "pass", "Pictures load and are described."));

  // 14. Enough, not too much, white space.
  const l2 = credit(checks, "L2");
  const space = num(value(checks, "L2").whitespace);
  if (l2 === "na" || l2 === "ne")
    rules.push(rule("whitespace", "unknown", "We couldn't measure the spacing."));
  else if (atLeast(l2, 0.75))
    rules.push(rule("whitespace", "pass", "Balanced spacing between sections."));
  else
    rules.push(
      rule(
        "whitespace",
        "miss",
        space !== null && space > 0.85
          ? "Too much empty space between sections."
          : "Too crowded: sections need more room.",
      ),
    );

  // 15. Nothing unnecessary: not cluttered, not overly long.
  const l3 = credit(checks, "L3");
  const c5 = credit(checks, "C5");
  const screens = num(value(checks, "C5").screens);
  if ((l3 === "na" || l3 === "ne") && (c5 === "na" || c5 === "ne"))
    rules.push(rule("clutter", "unknown", "We couldn't measure the layout."));
  else if (l3 !== "na" && l3 !== "ne" && !atLeast(l3, 0.75))
    rules.push(rule("clutter", "miss", "Busy layout: too many small pieces competing."));
  else if (c5 !== "na" && c5 !== "ne" && !atLeast(c5, 0.75))
    rules.push(
      rule(
        "clutter",
        "miss",
        `Very long: ${screens !== null ? `${round1(screens)} phone screens` : "many screens"} of content.`,
      ),
    );
  else rules.push(rule("clutter", "pass", "Focused, without extra clutter."));

  // 16. Works without the pictures: the message isn't only inside images.
  const i1 = credit(checks, "I1");
  const i2 = credit(checks, "I2");
  const i4 = credit(checks, "I4");
  if (imageMade || (i1 !== "na" && i1 !== "ne" && !atLeast(i1, 0.75))) {
    rules.push(
      rule(
        "no_decoration",
        "miss",
        `Mostly pictures: only ${liveChars ?? "a little"} characters of real text, so the message depends on the images.`,
      ),
    );
  } else if (i2 !== "na" && i2 !== "ne" && !atLeast(i2, 0.75)) {
    rules.push(rule("no_decoration", "miss", "The key message or button is only inside pictures."));
  } else if (i4 !== "na" && i4 !== "ne" && !atLeast(i4, 0.75)) {
    rules.push(rule("no_decoration", "miss", "With pictures off, most of the message disappears."));
  } else if (i2 === "ne" && i1 === "ne") {
    rules.push(rule("no_decoration", "unknown", "We couldn't measure the pictures."));
  } else {
    rules.push(
      rule(
        "no_decoration",
        "pass",
        "The message is in real text, so it still works without the pictures.",
      ),
    );
  }

  return {
    v: CHECKLIST_VERSION,
    rules,
    misses: rules.filter((r) => r.result === "miss").length,
    unknown: rules.filter((r) => r.result === "unknown").length,
  };
}

/** The verdict the checklist gives (see the header). */
export function checklistVerdict(
  c: Pick<DesignChecklist, "misses" | "unknown">,
): "good" | "ok" | "bad" {
  if (c.misses >= BAD_MISSES_MIN) return "bad";
  if (c.misses === 0 && c.unknown === 0) return "good";
  return "ok";
}
