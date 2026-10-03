/**
 * Explanations (DESIGN-SCORE §7). Every bullet is a template filled with measured values and
 * carries points taken from the arithmetic, so the full list reconciles exactly:
 * Σ needs-improvement points (all items, before truncation) = 100 − min(raw, cap, gate), where the
 * gate is the Excellent gate's 84 ceiling when it binds (excellence.ts).
 *
 * - Caps come first, most visible first (image-only, main-text contrast, merge tag, phone
 *   layout, Gmail clipping, broken images); each cap absorbs the checks with the same root
 *   cause, and the binding cap also carries the points the cap removed.
 * - The rest are ordered by points lost and deduplicated by root cause (fixed-width layout and
 *   the symptoms only its shrink causes, missing CTA, image-dominated content).
 * - Titles say what a reader can see and check, in plain words with the measured facts
 *   ("Body text is light grey on white (1.98:1)", "Cut off in Gmail: 116 KB, …").
 * - "Good" lists the most distinctive strengths first — hierarchy, CTA, mobile layout, imagery
 *   (combined when short) — and generic baseline passes (contrast, link names) last. Only
 *   passing, user-visible checks with nominal w ≥ 1 (A4, A5, A9, A10, A11 excluded) and AI
 *   levels ≥ 4 are eligible.
 */
import type { RenderFeatures } from "../features/render";
import {
  CAP_DISPLAY_ORDER,
  type CapId,
  type CheckId,
  type CheckResult,
  type ExplanationItem,
  type Region,
} from "../types";
import { describeColour } from "../util/color";
import { isAiCheck } from "./aggregate";
import type { CapHit } from "./caps";
import { drawnImages } from "./checks/images";
import {
  CTA_SALIENCE_MIN,
  EXCELLENCE_CEILING,
  MISS_CHECKS,
  type ExcellenceGate,
} from "./excellence";

const MAX_ITEMS = 5;
const NOT_USER_VISIBLE: ReadonlySet<CheckId> = new Set(["A4", "A5", "A9", "A10", "A11"]);

interface Parts {
  title: string;
  measured?: string;
  target?: string;
  fix?: string;
  source?: string;
}

// ───────────────────────── formatting ─────────────────────────

type Value = Record<string, unknown>;

function val(c: CheckResult | undefined): Value {
  return c && typeof c.value === "object" && c.value !== null ? (c.value as Value) : {};
}

function num(v: Value, key: string): number | null {
  const x = v[key];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function str(v: Value, key: string): string | null {
  const x = v[key];
  return typeof x === "string" && x.length > 0 ? x : null;
}

export function pct(x: number | null): string {
  return x === null ? "?" : `${Math.round(x * 100)}%`;
}

/**
 * A share under a limit, floored so it never reads as the limit itself (7.95% → "7%"); one
 * decimal under 1% (0.7%, not "0%").
 */
function pctBelow(x: number | null): string {
  if (x === null) return "?";
  return x < 0.01 ? `${Math.floor(x * 1000) / 10}%` : `${Math.floor(x * 100)}%`;
}

export function fmtPx(x: number | null): string {
  return x === null ? "?" : `${Math.round(x * 10) / 10}px`;
}

/** Contrast ratios are floored to 2 decimals for display (4.499 must never read as 4.5). */
export function fmtRatio(x: number | null): string {
  return x === null ? "?" : `${(Math.floor(x * 100) / 100).toFixed(2)}:1`;
}

function quote(label: string | null, max = 40): string {
  if (!label) return "the main button";
  const l = label.trim();
  return `“${l.length <= max ? l : `${l.slice(0, max - 1).trimEnd()}…`}”`;
}

/** Rounded px for titles: one decimal below 10px ("7.5px"), whole pixels above ("16px"). */
function roundPx(x: number | null): string {
  if (x === null) return "?";
  return x < 10 ? `${Math.round(x * 10) / 10}px` : `${Math.round(x)}px`;
}

/** "light grey on white", or the hex pair when a colour can't be named. */
function colourPair(fg: string | null, bg: string | null): string {
  const f = fg ? describeColour(fg) : null;
  const b = bg ? describeColour(bg) : null;
  if (f && b && f !== b) return `${f} on ${b}`;
  return `${fg ?? "?"} on ${bg ?? "?"}`;
}

function kb(bytes: number | null): string {
  return bytes === null ? "?" : `${Math.round(bytes / 1000)} KB`;
}

// ───────────────────────── needs-improvement templates ─────────────────────────

function imageAdaptTitle(v: Value): string {
  const over = num(v, "overflowing") ?? 0;
  const dist = num(v, "distorted") ?? 0;
  const blur = num(v, "blurry") ?? 0;
  const parts: string[] = [];
  if (over > 0) parts.push(`${over} ${over === 1 ? "is" : "are"} wider than a phone`);
  if (dist > 0) parts.push(`${dist} ${dist === 1 ? "is" : "are"} stretched`);
  if (over === 0 && dist === 0 && blur > 0)
    return `${blur === 1 ? "An image looks" : `${blur} images look`} blurry on sharp phone screens (low resolution)`;
  if (blur > 0) parts.push(`${blur} blurry`);
  return parts.length > 0
    ? `On phones, images misbehave: ${parts.join(", ")}`
    : "Images don't adapt to phones";
}

function darkModeTitle(v: Value): string {
  const texts = [num(v, "partialText"), num(v, "fullText")].filter((x): x is number => x !== null);
  const imgs = [num(v, "partialImages"), num(v, "fullImages")].filter(
    (x): x is number => x !== null,
  );
  const text = texts.length > 0 ? Math.min(...texts) : null;
  const img = imgs.length > 0 ? Math.min(...imgs) : null;
  if ((text === null || text >= 0.9) && img !== null && img < 1)
    return "A transparent image (often the logo) gets hard to see in dark mode";
  return `In dark mode only ${pct(text)} of the text stays readable`;
}

function brokenImagesTitle(
  broken: number | null,
  evaluated: number | null,
  missing: number | null,
  notImage: number | null,
): string {
  const n = `${broken ?? "?"} of ${evaluated ?? "?"} images`;
  if (missing !== null && notImage !== null) {
    if (notImage === 0) return `${n} are missing: the sender's server says they don't exist`;
    if (missing === 0) return `${n} don't show: their links return something that isn't an image`;
  }
  return `${n} are broken (missing or not an image)`;
}

const NEEDS: Partial<Record<CheckId, (v: Value, c: CheckResult) => Parts>> = {
  A1: (v) => {
    const w = (v.worst ?? null) as Value | null;
    const fg = w ? str(w, "fg") : null;
    const bg = w ? str(w, "bg") : null;
    const ratio = w ? fmtRatio(num(w, "ratio")) : null;
    // A main-text run names the main text's own share (2026.5: fine print is judged apart).
    const share = pct(
      w && w.fine !== true ? (num(v, "mainFailShare") ?? num(v, "failShare")) : num(v, "failShare"),
    );
    let title = `${share} of the text fails WCAG AA contrast`;
    if (w && w.rendered === false)
      title = `Some text is hidden: it's the same colour as its background (${ratio})`;
    else if (w && w.fine === true)
      // Just under AA (4.0–4.5:1) is "slightly low", not "hard to read".
      title =
        (num(w, "ratio") ?? 0) >= 4
          ? `The small print has slightly low contrast: ${colourPair(fg, bg)} (${ratio})`
          : `The small print is hard to read: ${colourPair(fg, bg)} (${ratio})`;
    else if (w && w.role === "heading")
      title = `The headline is too faint: ${colourPair(fg, bg)} (${ratio})`;
    else if (w && (num(w, "ratio") ?? 0) >= 4)
      title = `${share} of the text has slightly low contrast: ${colourPair(fg, bg)} (${ratio})`;
    else if (w) title = `${share} of the text is too faint: ${colourPair(fg, bg)} (${ratio})`;
    return {
      title,
      measured: w ? `${share} fails; worst ${fg} on ${bg} = ${ratio}` : share,
      target: "≥ 4.5:1 (3:1 for large text)",
      fix: "Darken light-grey text or lighten its background until every run reaches 4.5:1.",
      source: "WCAG 2.2 SC 1.4.3",
    };
  },
  A2: (v) => ({
    title:
      (num(v, "missingAlt") ?? 0) > 0
        ? `${num(v, "missingAlt")} of ${num(v, "images")} images have no alt text`
        : `${(num(v, "informative") ?? 0) - (num(v, "meaningful") ?? 0)} informative images have unhelpful alt text`,
    target: "every image has alt; informative images describe their content",
    fix: 'Add alt text that says what the image shows (alt="" for decorative images).',
    source: "WCAG 2.2 SC 1.1.1",
  }),
  A3: (v) => ({
    title: `${(num(v, "generic") ?? 0) + (num(v, "unnamed") ?? 0)} links are unnamed or say only “click here”`,
    fix: "Name every link after its destination or action.",
    source: "WCAG 2.2 SC 2.4.4",
  }),
  A4: (v) => ({
    title: v.mismatch
      ? `The declared language doesn't match the text (${String(v.wrapper ?? v.html)} vs ${String(v.detected)})`
      : v.html && !v.wrapper
        ? "The language is declared only on <html>, which Gmail strips"
        : "The email doesn't declare its language",
    fix: 'Add lang="…" to the content wrapper (Gmail strips <html> attributes).',
    source: "WCAG 2.2 SC 3.1.1",
  }),
  A5: (v) => ({
    title: `${(num(v, "layoutTables") ?? 0) - (num(v, "presentational") ?? 0)} layout tables lack role="presentation"`,
    fix: 'Add role="presentation" to layout tables.',
    source: "email accessibility (table-role)",
  }),
  A6: (v) => ({
    title: `${(num(v, "visual") ?? 0) - (num(v, "markedUp") ?? 0)} visual headings aren't marked up as headings`,
    fix: "Use h1–h6 (one h1) for visual headings.",
    source: "WCAG 2.2 SC 1.3.1",
  }),
  A7: (v) => ({
    title: `${num(v, "small")} of ${num(v, "targets")} standalone links are smaller than 24×24px on phones`,
    measured: `smallest ${fmtPx(num(v, "smallestPx"))}`,
    target: "≥ 24×24px",
    fix: "Enlarge tap targets with padding or space them apart.",
    source: "WCAG 2.2 SC 2.5.8",
  }),
  A8: (v) => ({
    title: `${num(v, "indistinct")} links in text are distinguished by colour alone`,
    fix: "Underline links in running text or give them ≥ 3:1 contrast with the text.",
    source: "WCAG 2.2 SC 1.4.1",
  }),
  A9: () => ({
    title: "The email has no <title>",
    fix: "Add a descriptive <title>.",
    source: "axe document-title",
  }),
  A10: () => ({
    title: "ARIA is misused (role=button on links, VML without alt, or aria-hidden body)",
    fix: "Remove role=button from links and add alt to VML images.",
    source: "ARIA in email (Parcel)",
  }),
  A11: () => ({
    title: "Text direction isn't declared",
    fix: 'Add dir="ltr" (or dir="rtl") to the content wrapper.',
    source: "email accessibility (body-dir)",
  }),
  A12: (v) => ({
    title: `Reading order differs from the visual order on phones (τ = ${num(v, "tau")})`,
    fix: "Keep source order aligned with the visual order when columns stack.",
    source: "WCAG 2.2 SC 1.3.2",
  }),
  M1: (v) => ({
    title: `The layout is ${num(v, "contentWidth")}px wide, so phones shrink it to ${pct(num(v, "k"))}`,
    target: "fits 375px",
    fix: "Use a fluid layout (width:100%; max-width:600px).",
    source: "WCAG 1.4.10 principle",
  }),
  M2: (v) => ({
    title: `Without media queries the layout shrinks to ${pct(num(v, "kNomq"))}`,
    target: "fluid without @media",
    fix: "Make the layout fluid by default; use media queries only to refine it.",
    source: "caniemail (clients that drop <style>)",
  }),
  M3: (v) => ({
    title: `${pct(1 - (num(v, "wideShare") ?? 1))} of body text sits in columns narrower than 250px on phones`,
    fix: "Stack columns into one on phones.",
    source: "design guideline",
  }),
  M4: (v) => {
    // The visible button is big enough; only its text is a link (render-2026.4 `textOnlyTap`).
    const textOnly = v.textOnlyTap === true && (num(v, "minSidePx") ?? 0) >= 40;
    return {
      title: textOnly
        ? `Only the text of the ${quote(str(v, "label"), 28)} button can be tapped, not the whole button`
        : `The main button ${quote(str(v, "label"), 28)} is only ${roundPx(num(v, "minSidePx"))} tall on phones`,
      measured: textOnly
        ? `button ${fmtPx(num(v, "minSidePx"))}, tappable text ${fmtPx(num(v, "targetPx"))}`
        : fmtPx(num(v, "minSidePx")),
      target: "≥ 44px",
      fix: textOnly
        ? "Put the padding on the link itself so the whole button is tappable."
        : "Give the button more padding.",
      source: "Apple HIG 44pt; WCAG 2.5.5",
    };
  },
  M5: (v) => ({
    title: imageAdaptTitle(v),
    fix: "Use max-width:100%; height:auto and 2× source images.",
    source: "design guideline",
  }),
  M6: (v) => ({
    title: darkModeTitle(v),
    fix: "Avoid pure #000/#FFF pairs and give transparent logos an outline or background.",
    source: "Litmus dark-mode guide",
  }),
  M7: (v) => ({
    title: `${pct(1 - (num(v, "okShare") ?? 1))} of body text touches the screen edge on phones`,
    target: "≥ 12px gutters",
    fix: "Add side padding to text cells.",
    source: "design guideline",
  }),
  T1: (v) => ({
    title: `Body text is ${fmtPx(num(v, "px"))} on phones`,
    measured: fmtPx(num(v, "px")),
    target: "≥ 16px",
    fix: "Set body text to 16px on mobile.",
    source: "Litmus; Mailchimp",
  }),
  T2: (v) => ({
    title: `Body text is ${fmtPx(num(v, "px"))} on desktop`,
    target: "≥ 14px",
    fix: "Use at least 14px body text.",
    source: "Litmus",
  }),
  T3: (v) => ({
    title: `Line spacing is tight (${num(v, "ratio")}× the font size)`,
    target: "≥ 1.4×",
    fix: "Set line-height to about 1.5.",
    source: "Litmus",
  }),
  T4: (v) => ({
    title: `Lines average ${Math.round(num(v, "charsPerLine") ?? 0)} characters`,
    target: v.cjk ? "18–40 characters" : "45–80 characters",
    fix: "Adjust the column width so lines are comfortable to read.",
    source: "Baymard; WCAG 1.4.8",
  }),
  T5: (v) => ({
    title: `${pct(num(v, "badShare"))} of body text is justified or long centred paragraphs`,
    fix: "Left-align paragraphs longer than three lines.",
    source: "WCAG 1.4.8; Litmus",
  }),
  T6: (v) => ({
    title: `The type system is busy (${num(v, "families")} families, ${num(v, "sizes")} sizes)`,
    target: "≤ 2 families, ≤ 6 sizes",
    fix: "Consolidate fonts and sizes.",
    source: "design guideline",
  }),
  T7: (v) => ({
    title: `${pct(num(v, "capsShare"))} of body text is ALL CAPS`,
    target: "≤ 5%",
    fix: "Reserve capitals for short labels.",
    source: "legibility research",
  }),
  T8: (v) => ({
    title: `Copy is hard to read (Flesch ${Math.round(num(v, "fre") ?? 0)})`,
    target: "≥ 60",
    fix: "Use shorter sentences and simpler words.",
    source: "Flesch Reading Ease",
  }),
  H1: () => ({
    title: "There's no clear button for the main action",
    fix: "Add one prominent button (bulletproof, live text).",
    source: "design guideline",
  }),
  H2: (v) => ({
    title:
      v.present === false
        ? "There's no primary call to action to place"
        : `The main button ${quote(str(v, "label"))} ends ${num(v, "screens")} screens down on phones`,
    target: "within the first screen",
    fix: "Move the main button up.",
    source: "NN/g scrolling & attention",
  }),
  H3: (v) => {
    // A button whose fill stands out but whose text is faint is a label problem (2026.5), not
    // "doesn't stand out": the Excellent gate's button bar only reads the fill and rank.
    const contrast = num(v, "labelContrast");
    const filled = (num(v, "salience") ?? 0) >= CTA_SALIENCE_MIN - 1e-9;
    const standsOut = filled && v.mostProminent === true;
    if (standsOut && contrast !== null && contrast < (v.labelLarge === true ? 3 : 4.5))
      return {
        title: `The text on the ${quote(str(v, "label"))} button is hard to read (${fmtRatio(contrast)})`,
        measured: fmtRatio(contrast),
        target: "≥ 4.5:1 (3:1 for large text)",
        fix: "Darken the button or its text until the label reaches 4.5:1.",
        source: "WCAG 2.2 SC 1.4.3",
      };
    // A filled button that a bigger link (a picture, a card) outweighs: it is there, just not first.
    if (filled && v.mostProminent === false)
      return {
        title: `A bigger link or picture outweighs the ${quote(str(v, "label"))} button`,
        fix: "Make the main button the most prominent link, or tone down the competing links.",
        source: "design guideline",
      };
    // It stands out (the gate's bar); only a little fill contrast is missing.
    if (standsOut)
      return {
        title: `The ${quote(str(v, "label"))} button's fill could contrast a little more`,
        fix: "Give the button a fill a little further from the background.",
        source: "design guideline",
      };
    return {
      title: `The main button ${quote(str(v, "label"))} doesn't stand out`,
      fix: "Give it a fill that contrasts with the background and a readable label.",
      source: "WCAG 1.4.3 (label); design guideline",
    };
  },
  H4: (v) => ({
    title: `The button label ${quote(str(v, "label"))} is vague`,
    fix: "Start with a verb that names the action (e.g. “Track my order”).",
    source: "design guideline",
  }),
  H5: (v) => ({
    title: `${num(v, "distinct")} different actions compete in the first two screens`,
    target: "≤ 2",
    fix: "Keep one primary action up top.",
    source: "design guideline",
  }),
  H6: (v) => ({
    // No heading at all (2026.5): say so plainly — "barely larger" implies there is one. With
    // pictures the headline may be set in one (a hero, a banner that didn't load): "in live text".
    title:
      v.headline === false
        ? v.pictures === true
          ? "No headline in live text"
          : "No headline"
        : `The headline is barely larger than the text (${num(v, "ratio")}×)`,
    measured: `largest text ${num(v, "ratio")}× the body text`,
    target: "≥ 1.6×",
    fix:
      v.headline === false
        ? "Lead with a headline that says the key message, clearly larger than the text."
        : "Make the key message clearly larger.",
    source: "design guideline",
  }),
  I1: (v) => ({
    title: `The email is mostly images with only ${num(v, "legibleChars")} characters of live text`,
    target: "≥ 500 characters",
    fix: "Move key text out of images into HTML.",
    source: "Email on Acid; images-off impact",
  }),
  I2: (v) => ({
    title: `The first screen has ${num(v, "firstViewportChars")} characters of live text${v.ctaLive === false ? " and the button is an image" : ""}`,
    fix: "Put the headline and button in live text.",
    source: "Outlook blocks images by default",
  }),
  I3: (v) => {
    const svg = num(v, "svg") ?? 0;
    // Only SVGs (2026.5): Gmail doesn't show them — not broken links.
    if (svg > 0 && (num(v, "failed") ?? 0) === 0)
      return {
        title:
          svg === 1
            ? "An image is an SVG, which Gmail doesn't show"
            : `${svg} images are SVGs, which Gmail doesn't show`,
        fix: "Use PNG or JPG images (Gmail doesn't display SVG).",
        source: "caniemail (SVG images)",
      };
    return {
      title: brokenImagesTitle(
        num(v, "failed"),
        num(v, "evaluated"),
        num(v, "missing"),
        num(v, "notImage"),
      ),
      fix: "Fix or replace broken image URLs.",
      source: "broken images",
    };
  },
  I4: (v) => ({
    title: `With images off only ${pct(num(v, "ratio"))} of the first two screens remains`,
    target: "≥ 80%",
    fix: "Add alt text and live text for key content.",
    source: "Microsoft: Outlook blocks pictures",
  }),
  I5: (v) => ({
    title: `Images weigh ${Math.round(((num(v, "bytes") ?? 0) / 1048576) * 10) / 10} MB`,
    target: "≤ 1 MB",
    fix: "Compress and resize images.",
    source: "design guideline",
  }),
  L1: (v) => ({
    title: `The content column is ${num(v, "width")}px wide on desktop`,
    target: "440–700px",
    fix: "Use a 600–640px container.",
    source: "Email on Acid",
  }),
  L2: () => ({
    title: "Spacing is unbalanced (cramped or very sparse)",
    fix: "Use consistent padding between sections.",
    source: "design guideline (calibrated)",
  }),
  L3: () => ({
    title: "The layout is visually cluttered",
    fix: "Reduce competing elements and busy backgrounds.",
    source: "Reinecke et al. 2013 (calibrated)",
  }),
  L4: (v) => ({
    title: `Text blocks use ${num(v, "anchors")} different alignment edges`,
    target: "≤ 6",
    fix: "Align blocks to a simple grid.",
    source: "design guideline",
  }),
  L5: (v) => ({
    title: `Too many colours (${num(v, "dominantColours") ?? "?"} dominant, ${num(v, "textColours")} text colours)`,
    fix: "Limit the palette.",
    source: "design guideline",
  }),
  L6: (v) => ({
    title: `Components are inconsistent (${num(v, "buttonStyles")} button styles)`,
    fix: "Reuse one button style and a spacing scale.",
    source: "design guideline",
  }),
  L7: (v) => ({
    title:
      v.logoTop === false
        ? "No logo at the top on phones"
        : `Too many accent colours (${num(v, "accentHues")})`,
    fix: "Show the logo at the top and keep accents to one or two hues.",
    source: "design guideline",
  }),
  C1: (v) => ({
    title: v.empty
      ? "The subject line is empty"
      : `The subject line could be tighter (${num(v, "words")} words${v.allCaps ? ", all caps" : ""})`,
    fix: "Keep it under 60 characters and 9 words.",
    source: "Mailchimp subject guidance",
  }),
  C2: (v) => ({
    title: v.boilerplate
      ? "The preview text is boilerplate (e.g. “View in browser”)"
      : `The preview text could work harder (${num(v, "length")} characters)`,
    fix: "Add a 40–130 character preheader that complements the subject.",
    source: "Litmus preheader guidance",
  }),
  C3: () => ({
    title: "Long passages without subheadings or lists",
    fix: "Break up long text with subheadings and short paragraphs.",
    source: "design guideline",
  }),
  C5: (v) => ({
    title: `The email is ${num(v, "screens")} phone screens long`,
    fix: "Trim or link out to secondary content.",
    source: "design guideline",
  }),
  X1: (v) => ({
    title: v.clipped
      ? `HTML is ${kb(num(v, "bytes"))}, so Gmail clips it`
      : `HTML is ${kb(num(v, "bytes"))} — close to Gmail's ~102 KB clipping limit`,
    target: "≤ 90 KB",
    fix: "Remove unused CSS and markup, or shorten the email.",
    source: "Litmus (102 KB)",
  }),
  X2: (v) => ({
    title: `Some code isn't supported by major email apps (${(v.features as string[] | undefined)?.slice(0, 3).join(", ") ?? ""})`,
    fix: "Add fallbacks (VML, ghost tables, font stacks, solid background colours).",
    source: "caniemail",
  }),
  X3: (v) => ({
    title: v.mergeTags
      ? "An unrendered merge tag is visible"
      : v.badHrefs
        ? "Some links are empty or broken"
        : v.placeholder
          ? "Links point to placeholder domains"
          : "Some links use insecure http",
    fix: "Test personalization and link targets before sending.",
    source: "link integrity",
  }),
  X4: (v) => ({
    title: `<style> is ${kb(num(v, "bytes"))}${v.mediaAfterLimit ? ", and media queries start after Gmail's 16 KB cut-off" : ""}`,
    target: "≤ 16 KB",
    fix: "Trim CSS and put media queries first.",
    source: "email-bugs #90",
  }),
  U1: (v) => ({
    title:
      v.unsubscribe === "after_clip"
        ? "The unsubscribe link is hidden behind Gmail's clip"
        : "No visible unsubscribe link",
    fix: "Add a clear unsubscribe link in the footer.",
    source: "Gmail & Yahoo sender rules",
  }),
  U2: (v) => ({
    title: `The unsubscribe link is ${fmtPx(num(v, "px"))} with ${fmtRatio(num(v, "contrast"))} contrast`,
    target: "≥ 12px and ≥ 4.5:1",
    fix: "Make it larger and darker.",
    source: "WCAG 2.2 SC 1.4.3",
  }),
  U3: () => ({
    title: "No link to manage preferences",
    fix: "Offer a preferences or frequency link next to unsubscribe.",
    source: "design guideline",
  }),
  U4: () => ({
    title: "No “why you're receiving this” note",
    fix: "Say why the reader gets this email.",
    source: "design guideline",
  }),
};

const AI_NAMES: Partial<Record<CheckId, string>> = {
  H7: "Visual hierarchy",
  L8: "Visual polish",
  C4: "Copy clarity",
  I6: "Imagery",
};

function aiParts(c: CheckResult): Parts {
  const v = val(c);
  const evidence = str(v, "evidence");
  return {
    title: `${AI_NAMES[c.id] ?? c.id}: rated ${num(v, "level")}/5${evidence ? ` — “${evidence}”` : ""}`,
    source: "AI review",
  };
}

// ───────────────────────── root causes ─────────────────────────

type ById = Map<CheckId, CheckResult>;

interface Group {
  key: string;
  members: (byId: ById) => CheckId[];
  when: (byId: ById) => boolean;
  parts: (byId: ById) => Parts;
}

const FIXED_WIDTH: CheckId[] = ["M1", "M2", "M3", "M7", "T1"];
/**
 * `k`-scaled checks that fail only because the fixed-width layout shrinks (their value carries
 * `shrinkOnly`): a full-size button, a normal-size unsubscribe link or tap targets that become
 * small on a phone are symptoms of that one root cause, not separate problems.
 */
const SHRINK_SYMPTOMS: CheckId[] = ["M4", "U2", "A7"];
const NO_CTA: CheckId[] = ["H1", "H2", "H3"];
const IMAGE_HEAVY: CheckId[] = ["I1", "I2", "I4"];

function fixedWidthMembers(byId: ById): CheckId[] {
  return [...FIXED_WIDTH, ...SHRINK_SYMPTOMS.filter((id) => val(byId.get(id)).shrinkOnly === true)];
}

/** The fixed-width root cause in plain words (k ≥ 0.85 is only "slightly too wide"). */
function fixedWidthParts(byId: ById, cap?: CapHit): Parts {
  const m1 = val(byId.get("M1"));
  const t1 = val(byId.get("T1"));
  const width = num(m1, "contentWidth") ?? (cap ? (cap.value.contentWidth as number | null) : null);
  const k = num(m1, "k") ?? (cap && typeof cap.value.k === "number" ? cap.value.k : null);
  const px =
    num(t1, "px") ?? (cap && typeof cap.value.bodyPx === "number" ? cap.value.bodyPx : null);
  const w = width ?? "?";
  const text = px !== null ? `, body text ~${roundPx(px)}` : "";
  const reason = cap ? cap.value.reason : null;
  let title: string;
  if (reason === "overflow")
    title = `Too wide for phones: the ${w}px layout shrinks to ${pct(k)} or scrolls sideways`;
  else if (reason === "tap")
    title = `Unusable on phones: the ${w}px layout shrinks the main button to ~${roundPx(typeof cap?.value.ctaPx === "number" ? cap.value.ctaPx : null)}`;
  else if (reason === "text")
    title = `Unreadable on phones: the fixed ${w}px layout shrinks to ${pct(k)}${text}`;
  else if (k !== null && k >= 0.85)
    title = `Slightly too wide for phones: the ${w}px layout shrinks to ${pct(k)}${text}`;
  else title = `Not built for phones: the fixed ${w}px layout shrinks to ${pct(k)}${text}`;
  return {
    title,
    measured: `shrinks to ${pct(k)}${px !== null ? `; body text ${fmtPx(px)}` : ""}`,
    target: "fits 375px without shrinking",
    fix: "Use a fluid, single-column layout (width:100%; max-width:600px) and stack columns on phones.",
    source: "WCAG 1.4.10 principle; caniemail",
  };
}

const GROUPS: readonly Group[] = [
  {
    key: "group:fixed-width",
    members: fixedWidthMembers,
    when: (byId) => (num(val(byId.get("M1")), "k") ?? 1) < 0.99,
    parts: (byId) => fixedWidthParts(byId),
  },
  {
    key: "group:no-cta",
    members: () => NO_CTA,
    when: (byId) => byId.get("H1")?.s === 0,
    parts: () => ({
      title: "There's no clear button for the main action",
      fix: "Add one prominent, live-text button near the top.",
      source: "design guideline",
    }),
  },
  {
    key: "group:image-heavy",
    members: () => IMAGE_HEAVY,
    when: (byId) => {
      const i1 = byId.get("I1");
      return !!i1 && i1.s !== null && i1.s < 0.9;
    },
    parts: (byId) => ({
      title: `Mostly images: only ${num(val(byId.get("I1")), "legibleChars") ?? "?"} characters of real text, little left with images off`,
      fix: "Move headlines, offers and the button into live HTML text; add alt text.",
      source: "Email on Acid; Outlook blocks images by default",
    }),
  },
];

/**
 * Symptoms of faint main text: text that fails contrast doesn't count as legible, so the
 * images-off / live-text checks (I1, I2) report "only N characters of real text" although the text
 * is there, and pale greys also fail in dark mode (M6). With CAP_CONTRAST they are one problem.
 */
function contrastSymptoms(byId: ById, render: RenderFeatures | null): CheckId[] {
  const out: CheckId[] = [];
  const chars = render?.text.chars;
  const faintHidesText =
    !!chars && chars.outsideFooter > 0 && chars.legible < chars.outsideFooter * 0.6;
  if (faintHidesText) out.push("I1", "I2");
  const m6 = val(byId.get("M6"));
  const darkText = num(m6, "fullText");
  if (darkText !== null && darkText < 0.9) out.push("M6");
  return out;
}

/** Checks each cap absorbs (same root cause as the cap). */
function capMembers(hit: CapHit, byId: ById, render: RenderFeatures | null): CheckId[] {
  switch (hit.id) {
    case "CAP_IMAGE_ONLY":
      // In an image-only email the "missing" button is baked into the image: same fix.
      return byId.get("H1")?.s === 0 ? [...IMAGE_HEAVY, ...NO_CTA] : IMAGE_HEAVY;
    case "CAP_CONTRAST":
      return ["A1", ...contrastSymptoms(byId, render)];
    case "CAP_BROKEN_IMAGES":
      return ["I3"];
    case "CAP_MOBILE_BROKEN": {
      const members = fixedWidthMembers(byId);
      return hit.value.reason === "tap" && !members.includes("M4") ? [...members, "M4"] : members;
    }
    case "CAP_CLIPPED": {
      // Clipping hides the unsubscribe link and the button: symptoms of the same long email.
      const out: CheckId[] = ["X1"];
      if (val(byId.get("U1")).unsubscribe === "after_clip") out.push("U1");
      if (hit.value.ctaAfterClip === true) out.push("H2");
      out.push("C5");
      return out;
    }
    case "CAP_MERGE_TAG":
      return val(byId.get("X3")).mergeTags === true ? ["X3"] : [];
  }
}

/** Most visible first (shared with the gallery: types.ts CAP_DISPLAY_ORDER). */
const CAP_ORDER: readonly CapId[] = CAP_DISPLAY_ORDER;

function capParts(hit: CapHit, byId: ById): Parts {
  const v = hit.value;
  const n = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : null);
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : null);
  const capNote = `score capped at ${hit.limit}`;
  switch (hit.id) {
    case "CAP_IMAGE_ONLY": {
      const chars = n("legibleChars") ?? 0;
      return {
        title:
          chars < 20
            ? "All images, no real text: it's blank when images are off"
            : `Mostly images: only ${chars} characters of real text, blank with images off`,
        measured: `${chars} characters of live text; ${pct(n("imagesOffRatio"))} left with images off (${capNote})`,
        fix: "Put the message and the button in live text.",
        source: "images-off and screen-reader impact",
      };
    }
    case "CAP_CONTRAST": {
      const share = n("failShare");
      const fg = s("fg");
      const bg = s("bg");
      const ratio = fmtRatio(n("ratio"));
      const who = v.role === "heading" ? "The headline" : "Body text";
      const title =
        v.rendered === false
          ? `${pct(share)} of the main text is hidden: same colour as its background (${ratio})`
          : share !== null && share >= 0.9
            ? `${who} is ${colourPair(fg, bg)} (${ratio}): too faint to read`
            : `${pct(share)} of the main text is ${colourPair(fg, bg)} (${ratio}): too faint`;
      return {
        title,
        measured: `${fg ?? "?"} on ${bg ?? "?"} = ${ratio} (${capNote})`,
        target: "≥ 4.5:1",
        fix: "Darken the text or lighten its background.",
        source: "WCAG 2.2 SC 1.4.3",
      };
    }
    case "CAP_BROKEN_IMAGES":
      return {
        title: brokenImagesTitle(n("broken"), n("evaluated"), n("missing"), n("notImage")),
        measured: `${n("broken")} of ${n("evaluated")} (${capNote})`,
        fix: "Fix the image URLs.",
        source: "renders broken",
      };
    case "CAP_MOBILE_BROKEN": {
      const fw = fixedWidthParts(byId, hit);
      return { ...fw, measured: `${fw.measured ?? ""} (${capNote})` };
    }
    case "CAP_CLIPPED":
      return {
        title: v.ctaAfterClip
          ? `Cut off in Gmail: ${kb(n("bytes"))}, so readers see “[Message clipped]” before the button`
          : `Cut off in Gmail: ${kb(n("bytes"))}, readers see “[Message clipped]” and miss ${pct(n("afterShare"))} of it`,
        measured: `${kb(n("bytes"))} of HTML (${capNote})`,
        target: "≤ 90 KB",
        fix: "Cut the HTML below ~90 KB.",
        source: "Litmus (102 KB)",
      };
    case "CAP_MERGE_TAG": {
      const tag = s("tag");
      const shown = s("snippet") ?? tag;
      // ≤ 80 characters with a typical snippet, so the saved summary keeps "(also in subject)".
      const alsoSubject = v.subject === true ? " (also in subject)" : "";
      return {
        title:
          v.firstScreen === true
            ? shown
              ? `Shows a raw merge tag at the top: “${shown}”${alsoSubject}`
              : `Shows a raw merge tag (like {{first_name}}) at the top of the email${alsoSubject}`
            : `Shows a raw merge tag in the subject${tag ? `: “${tag}”` : ""}`,
        measured: capNote,
        fix: "Fix the personalization field or its fallback.",
        source: "visible production defect",
      };
    }
  }
}

// ───────────────────────── assembly ─────────────────────────

function regionsFor(render: RenderFeatures | null, ids: CheckId[]): Region[] | undefined {
  if (!render) return undefined;
  const out: Region[] = [];
  for (const r of render.regions) {
    if (ids.includes(r.key as CheckId) && out.length < 3)
      out.push({ pass: r.pass, x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return out.length > 0 ? out : undefined;
}

function item(
  key: string,
  kind: ExplanationItem["kind"],
  ids: CheckId[],
  parts: Parts,
  points: number,
  render: RenderFeatures | null,
): ExplanationItem {
  const out: ExplanationItem = {
    key,
    kind,
    checkIds: ids,
    title: parts.title,
    points: Math.round(points * 10) / 10,
    ai: kind === "ai",
  };
  if (parts.measured) out.measured = parts.measured;
  if (parts.target) out.target = parts.target;
  if (parts.fix) out.fix = parts.fix;
  if (parts.source) out.source = parts.source;
  const regions = regionsFor(render, ids);
  if (regions) out.regions = regions;
  return out;
}

export interface Explanations {
  needsImprovement: ExplanationItem[];
  good: ExplanationItem[];
  /** Untruncated needs-improvement list with exact (unrounded) points, for reconciliation. */
  all: Array<{ key: string; points: number }>;
}

/** One failed G1–G4 bar in a few words ("headline 1.1× the body", "no standout button"). */
function barPhrase(g: ExcellenceGate, miss: ExcellenceGate["misses"][number]): string | null {
  switch (miss) {
    case "headline":
      if (g.hasHeadline === false)
        return g.headlinePictures ? "no live-text headline" : "no headline";
      return g.headlineRatio === null
        ? "no headline"
        : `headline ${Math.round(g.headlineRatio * 10) / 10}× the body`;
    case "button":
      if (g.ctaSalience === null) return "no main button";
      // Filled, but one of several look-alike buttons for different actions (G2, 2026.6).
      if (g.ctaCompeting === true && g.ctaSalience >= CTA_SALIENCE_MIN - 1e-9)
        return "look-alike buttons, none the main one";
      // A filled button that a bigger link or picture outweighs (further down than the first
      // screen) isn't "no standout button".
      return g.ctaSalience >= CTA_SALIENCE_MIN - 1e-9 && g.ctaMostProminent === false
        ? "a bigger link outweighs the button"
        : "no standout button";
    case "imagery":
      return `few images (${pctBelow(g.imgShare)})`;
    case "imagery_unknown":
      return "its images didn't load";
    case "hero":
      return "no large picture or headline band";
    default:
      return null;
  }
}

/** Why an email misses the Excellent gate, in words a reader can check (excellence.ts). */
function gateParts(g: ExcellenceGate): Parts {
  const miss = g.misses[0];
  let title: string;
  // ≤ 80 characters: the saved summary keeps titles whole up to that length.
  if (miss === "plain") {
    const r = g.headlineRatio;
    const head = r !== null ? `headline ${Math.round(r * 10) / 10}× the body text` : "no headline";
    title = `Plain design, nothing stands out: ${head}, ${g.hasButton ? "weak button" : "no button"}`;
  } else if (miss === "headline" || miss === "button") {
    const parts = g.misses.map((m) => barPhrase(g, m)).filter((p): p is string => p !== null);
    title = `Plain design: ${parts.join(", ")}`;
  } else if (miss === "imagery") {
    title = `Little imagery for this kind of email: pictures cover only ${pctBelow(g.imgShare)} of it`;
  } else if (miss === "imagery_unknown") {
    title = "Most of its images didn't load, so its imagery can't be judged";
  } else if (miss === "hero") {
    title = "No large picture and no headline on a coloured band: a stock template look";
  } else if (miss === "phone_narrow") {
    title = `On phones, ${pct(g.narrowShare)} of the text is squeezed into narrow columns`;
  } else {
    title = `On phones, ${pct(g.edgeShare)} of the text runs right to the screen edge`;
  }
  const bars = g.rule === "bars";
  return {
    title,
    measured: bars
      ? `held at ${EXCELLENCE_CEILING}: Excellent needs a real headline, a standout main button, imagery in system mail, a hero picture or headline band, and a clean phone layout`
      : `held at ${EXCELLENCE_CEILING}: Excellent needs a real headline, a standout button or strong visuals, and a clean phone layout`,
    target: bars
      ? "a headline ≥ 1.5× the body text, a filled button that leads (most prominent, or in the first screen) and isn't one of 3+ look-alike buttons for different actions, pictures on ≥ 8% of system mail, a picture ≥ 300 px wide and ≥ 40,000 px² or a headline on a coloured band; ≤ 50% of text cramped on phones"
      : "a headline ≥ 1.5× the body text or a standout button; ≤ 50% of text cramped on phones",
    fix:
      miss === "plain" || miss === "headline" || miss === "button"
        ? "Give the email a clear headline (at least 1.5× the body text) and one standout button."
        : miss === "imagery"
          ? "Add a picture, illustration or branded header that supports the message."
          : miss === "imagery_unknown"
            ? "Not necessarily a design fault: most images couldn't be loaded for the analysis (limits, expired links, the network)."
            : miss === "hero"
              ? "Lead with a real picture (a hero image or illustration) or set the headline on a coloured header band."
              : "Stack columns on phones and keep at least 12px of margin on each side of the text.",
    source: "design guideline (Excellent gate)",
  };
}

/** Build the explanation lists from the arithmetic (DESIGN-SCORE §7). */
export function explain(
  checks: readonly CheckResult[],
  caps: readonly CapHit[],
  raw: number | null,
  render: RenderFeatures | null,
  /** The Excellent gate, when it binds (the score is held at 84). */
  gate: ExcellenceGate | null = null,
  /** Visible text aimed at AI reviewers / scoring tools (static `instructionText`). */
  strayText = false,
  /** Links painted as buttons but shrunk to slivers (static `strayButtons`). */
  strayButtons = 0,
  /** Text baked into pictures (images.ts `textInImages`): no text or layout strengths. */
  imageText = false,
  /** Most content images weren't drawn (images.ts `imagesUnknownShare` > 0.5): no image praise. */
  imagesMissing = false,
): Explanations {
  if (raw === null) return { needsImprovement: [], good: [], all: [] };
  const byId: ById = new Map(checks.map((c) => [c.id, c] as const));
  const lost = new Map(checks.filter((c) => c.pointsLost > 1e-9).map((c) => [c.id, c] as const));
  const used = new Set<CheckId>();
  const capItems: Array<{ item: ExplanationItem; exact: number }> = [];
  const bindingLimit = caps.length > 0 ? Math.min(...caps.map((c) => c.limit)) : Infinity;
  const reduction = Math.max(0, raw - Math.min(raw, bindingLimit));
  let reductionGiven = false;
  const ordered_caps = [...caps].sort(
    (a, b) => CAP_ORDER.indexOf(a.id) - CAP_ORDER.indexOf(b.id) || a.limit - b.limit,
  );
  for (const hit of ordered_caps) {
    const members = capMembers(hit, byId, render).filter((id) => lost.has(id) && !used.has(id));
    for (const id of members) used.add(id);
    let exact = members.reduce((s, id) => s + lost.get(id)!.pointsLost, 0);
    if (!reductionGiven && hit.limit === bindingLimit) {
      exact += reduction;
      reductionGiven = true;
    }
    capItems.push({
      item: item(`cap:${hit.id}`, "cap", [...members], capParts(hit, byId), exact, render),
      exact,
    });
  }
  const rest: Array<{ item: ExplanationItem; exact: number }> = [];
  // The Excellent gate leads the rest: it is why an otherwise high score is held at 84.
  let gateItem: { item: ExplanationItem; exact: number } | null = null;
  if (gate && gate.misses.length > 0) {
    const limited = Math.min(raw, bindingLimit);
    const held = Math.max(0, limited - Math.min(limited, EXCELLENCE_CEILING));
    // Only the check behind the miss the title names; another miss (e.g. text at the screen edge
    // next to a plain design) stays its own item, so it's still listed.
    const members = MISS_CHECKS[gate.misses[0]!].filter((id) => lost.has(id) && !used.has(id));
    for (const id of members) used.add(id);
    const exact = held + members.reduce((s, id) => s + lost.get(id)!.pointsLost, 0);
    gateItem = {
      item: item("gate:excellence", "group", members, gateParts(gate), exact, render),
      exact,
    };
  }
  for (const g of GROUPS) {
    if (!g.when(byId)) continue;
    const members = g.members(byId).filter((id) => lost.has(id) && !used.has(id));
    if (members.length < 2) continue;
    for (const id of members) used.add(id);
    const exact = members.reduce((s, id) => s + lost.get(id)!.pointsLost, 0);
    rest.push({ item: item(g.key, "group", members, g.parts(byId), exact, render), exact });
  }
  for (const c of lost.values()) {
    if (used.has(c.id)) continue;
    used.add(c.id);
    const ai = isAiCheck(c.id);
    const tpl = NEEDS[c.id];
    const parts = ai ? aiParts(c) : tpl ? tpl(val(c), c) : { title: `${c.id} could be improved` };
    rest.push({
      item: item(`check:${c.id}`, ai ? "ai" : "check", [c.id], parts, c.pointsLost, render),
      exact: c.pointsLost,
    });
  }
  rest.sort((a, b) => b.exact - a.exact || a.item.key.localeCompare(b.item.key));
  // Stray instruction text costs no points (the AI safeguard handles the review) but a reader
  // sees it, so it is named — right after the caps and the gate, so the top 5 always keep it.
  const stray = strayText
    ? {
        item: item(
          "note:stray-text",
          "check",
          [],
          {
            title: "Shows stray text addressed to AI or review software, which readers see too",
            fix: "Remove text meant for software from the visible email.",
            source: "visible production defect",
          },
          0,
          render,
        ),
        exact: 0,
      }
    : null;
  // Stray button fragments (methodology 2026.4): links painted as buttons but shrunk to coloured
  // slivers with unreadable text. No points (the H3 fake-button rule already keeps them out of the
  // CTA checks), but a designer sees them at once, so they are named like stray text.
  const fragments =
    strayButtons >= 2
      ? {
          item: item(
            "note:stray-buttons",
            "check",
            [],
            {
              title: `Shows ${strayButtons} stray button fragments: coloured slivers with unreadable text`,
              measured: `${strayButtons} links styled as buttons at ≤ 4px`,
              fix: "Remove the leftover button code, or give each button a readable size.",
              source: "visible production defect",
            },
            0,
            render,
          ),
          exact: 0,
        }
      : null;
  const ordered = [
    ...capItems,
    ...(gateItem ? [gateItem] : []),
    ...(stray ? [stray] : []),
    ...(fragments ? [fragments] : []),
    ...rest,
  ];
  // Bullets that would display as 0.0 points are noise; they stay in `all` for reconciliation.
  const needsImprovement = ordered
    .filter(
      (x) =>
        x.item.kind === "cap" ||
        x === gateItem ||
        x === stray ||
        x === fragments ||
        x.exact >= 0.05,
    )
    .slice(0, MAX_ITEMS)
    .map((x) => x.item);
  const all = ordered.map((x) => ({ key: x.item.key, points: x.exact }));
  const h3v = val(byId.get("H3"));
  const ctaStandsOut =
    (num(h3v, "salience") ?? 0) >= CTA_SALIENCE_MIN - 1e-9 && h3v.mostProminent === true;
  const conflicts: Conflicts = {
    faint: caps.some((c) => c.id === "CAP_CONTRAST"),
    noHeadline: val(byId.get("H6")).headline === false,
    imageOnly: imageText || caps.some((c) => c.id === "CAP_IMAGE_ONLY"),
    noImages: render !== null && render.images.content === 0,
    noDrawnImages: render !== null && (drawnImages(render) === 0 || imagesMissing),
    ctaStandsOut,
    ctaUpTop: ctaStandsOut && byId.get("H2")?.status === "pass",
    lost: (id) => (byId.get(id)?.pointsLost ?? 0) >= 0.05,
  };
  return { needsImprovement, good: strengths(checks, byId, render, conflicts), all };
}

// ───────────────────────── strengths ─────────────────────────

/** A check counts as a strength: passing, user-visible, nominal weight ≥ 1. */
function passes(byId: ById, id: CheckId): CheckResult | null {
  const c = byId.get(id);
  if (!c || c.status !== "pass" || c.w < 1 || NOT_USER_VISIBLE.has(id)) return null;
  return c;
}

interface Strength {
  key: string;
  ids: CheckId[];
  title: string;
  ai?: boolean;
}

function labelOf(byId: ById): string | null {
  for (const id of ["H3", "H2", "H4", "M4"] as const) {
    const l = str(val(byId.get(id)), "label");
    if (l) return l;
  }
  return null;
}

/** "a “Shop rain shells” button", or "one clear button" when the label is long. */
function buttonPhrase(label: string | null, one: boolean): string {
  if (label && label.trim().length <= 24)
    return `${one ? "one clear" : "a standout"} ${quote(label, 24)} button`;
  return one ? "one clear button" : "a standout button";
}

/**
 * Distinctive strengths first (DECISIONS.md #26, "Strengths"): what makes this design better than a merely
 * compliant one — hierarchy, the call to action, a real phone layout, imagery — each with its
 * measured facts, combined into one line when short. Generic baseline passes (contrast, link
 * names, alt text, unsubscribe…) only fill the remaining slots.
 */
/**
 * What the listed problems rule out as strengths (methodology 2026.4): a strength must never
 * contradict a problem the same explanation names.
 *  - "Built for phones" needs the phone layout to hold up: not with text squeezed into narrow
 *    columns or running to the screen edge (M3 / M7 losing points);
 *  - "Balanced whitespace" / "a clean layout" (L2 / L3) not with edge-to-edge text or an off-size
 *    content column (M7 / L1);
 *  - "Links are easy to tap" (A7) not next to a main button too small to tap (M4);
 *  - "reads fine with images off" (I2) only when there are content images at all;
 *  - an image-only email (CAP_IMAGE_ONLY, or text baked into pictures: `textInImages`) has no
 *    live typography, readability or layout to praise (2026.5);
 *  - "images scale cleanly" / "still reads with images off" (M5 / I4) only when at least one
 *    content image was drawn and most did (2026.5: not for pictures that never loaded, nor next
 *    to "Most of its images didn't load");
 *  - no headline strength without heading text (H6 `headline: false`: the largest text is then a
 *    button or a label, 2026.5);
 *  - a button strength ("stands out", "one focused call to action up top") only for a button
 *    that clears the Excellent gate's bar — fill salience ≥ 0.9 and the most prominent link —
 *    and, for "up top", sits in the first phone screen (2026.5).
 */
interface Conflicts {
  faint: boolean;
  noHeadline: boolean;
  imageOnly: boolean;
  noImages: boolean;
  noDrawnImages: boolean;
  ctaStandsOut: boolean;
  ctaUpTop: boolean;
  lost: (id: CheckId) => boolean;
}

const TEXT_STRENGTH_IDS: ReadonlySet<CheckId> = new Set([
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "T7",
  "T8",
  "A1",
]);

const LAYOUT_STRENGTH_IDS: ReadonlySet<CheckId> = new Set([
  "M1",
  "M2",
  "M3",
  "M7",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
]);

function conflictsWith(id: CheckId, x: Conflicts): boolean {
  if (x.faint && (id === "H6" || id === "A1")) return true;
  if (x.noHeadline && id === "H6") return true;
  if (x.imageOnly && (TEXT_STRENGTH_IDS.has(id) || LAYOUT_STRENGTH_IDS.has(id))) return true;
  if (x.noImages && id === "I2") return true;
  if (x.noDrawnImages && (id === "M5" || id === "I4")) return true;
  if (id === "H3" && !x.ctaStandsOut) return true;
  if (id === "H5" && !x.ctaUpTop) return true;
  if ((id === "L2" || id === "L3") && (x.lost("M7") || x.lost("L1"))) return true;
  if (id === "A7" && x.lost("M4")) return true;
  if ((id === "M1" || id === "M2") && (x.lost("M3") || x.lost("M7"))) return true;
  return false;
}

function distinctive(byId: ById, x: Conflicts): Strength[] {
  const out: Strength[] = [];
  const h3 = conflictsWith("H3", x) ? null : passes(byId, "H3");
  const h2 = passes(byId, "H2");
  const h5 = conflictsWith("H5", x) ? null : passes(byId, "H5");
  // A big headline in faint grey doesn't "stand out": with CAP_CONTRAST it isn't a strength; nor
  // is the largest text of an email without heading text (a button label).
  const h6 = conflictsWith("H6", x) ? null : passes(byId, "H6");
  const label = labelOf(byId);
  const one = !!h5 && num(val(h5), "distinct") === 1;
  const h6v = val(h6 ?? undefined);
  const headPx = num(h6v, "largestPx");
  const ratio = num(h6v, "ratio");
  const ctaIds = [h3, h2, h5].filter((c): c is CheckResult => c !== null).map((c) => c.id);

  // Hierarchy + CTA, combined when both are strong. The headline's size is measured, its weight
  // isn't: "big", never "bold" (a 30px weight-300 headline is big but visibly light).
  if (h6 && h3 && h2) {
    out.push({
      key: "good:hierarchy-cta",
      ids: ["H6", ...ctaIds],
      title: `A big ${roundPx(headPx)} headline and ${buttonPhrase(label, one)} up top`,
    });
  } else {
    if (h6)
      out.push({
        key: "good:hierarchy",
        ids: ["H6"],
        title: `Clear hierarchy: a ${roundPx(headPx)} headline, ${ratio !== null ? `${Math.round(ratio * 10) / 10}×` : "well above"} the body text`,
      });
    if (h3) {
      const where = h2 ? " in the first screen" : "";
      out.push({
        key: "good:cta",
        ids: ctaIds,
        title: `${one ? "One clear" : "A standout"} ${quote(label, 28)} button${where}`,
      });
    }
  }
  // A real phone layout: fits 375px, columns stay wide, text a comfortable size.
  const m1 = conflictsWith("M1", x) ? null : passes(byId, "M1");
  const m3 = passes(byId, "M3");
  const t1 = passes(byId, "T1");
  if (m1) {
    const px = num(val(t1 ?? undefined), "px");
    out.push({
      key: "good:mobile",
      ids: [m1, m3, t1].filter((c): c is CheckResult => c !== null).map((c) => c.id),
      title: t1
        ? `Built for phones: fits a 375px screen with ${roundPx(px)} body text`
        : "Built for phones: fits a 375px screen without shrinking",
    });
  }
  // Imagery: sizes cleanly on phones and the message survives images-off.
  const m5 = conflictsWith("M5", x) ? null : passes(byId, "M5");
  const i4 = conflictsWith("I4", x) ? null : passes(byId, "I4");
  const a2 = passes(byId, "A2");
  if (m5 && i4)
    out.push({
      key: "good:imagery",
      ids: ["M5", "I4", ...(a2 ? (["A2"] as CheckId[]) : [])],
      title: "Images scale cleanly on phones and the message still reads with images off",
    });
  else if (m5)
    out.push({
      key: "good:imagery",
      ids: ["M5"],
      title: "Sharp images that scale cleanly on phones",
    });
  else if (i4 && (byId.get("I1")?.status === "pass" || byId.get("I1")?.status === "not_applicable"))
    out.push({
      key: "good:imagery",
      ids: ["I4"],
      title: "The message still reads with images turned off",
    });
  // Type craft (L2/L3 whitespace and clutter use wide priors that nearly every email passes, so
  // they are not distinctive and stay baseline).
  const t6 = x.imageOnly ? null : passes(byId, "T6");
  const t3 = passes(byId, "T3");
  const fam = num(val(t6 ?? undefined), "families");
  const lh = num(val(t3 ?? undefined), "ratio");
  if (t6 && t3 && fam !== null && fam >= 1 && fam <= 2 && lh !== null) {
    out.push({
      key: "good:type",
      ids: ["T6", "T3"],
      title: `Disciplined type: ${fam === 1 ? "one font family" : "two font families"}, ${Math.round(lh * 10) / 10}× line spacing`,
    });
  }
  return out;
}

function strengths(
  checks: readonly CheckResult[],
  byId: ById,
  render: RenderFeatures | null,
  x: Conflicts,
): ExplanationItem[] {
  const picked: Array<{ s: Strength; points: number }> = [];
  const covered = new Set<CheckId>();
  const points = (ids: CheckId[]) => ids.reduce((sum, id) => sum + (byId.get(id)?.points ?? 0), 0);
  const push = (s: Strength) => {
    picked.push({ s, points: points(s.ids) });
    for (const id of s.ids) covered.add(id);
  };
  const found = distinctive(byId, x);
  const craft = (s: Strength) => s.key === "good:type";
  for (const s of found) if (!craft(s)) push(s);
  // AI levels ≥ 4 carry the reviewer's own evidence: specific by construction.
  for (const c of checks) {
    if (!isAiCheck(c.id)) continue;
    const level = num(val(c), "level");
    if ((c.status === "pass" || c.status === "partial") && level !== null && level >= 4) {
      const evidence = str(val(c), "evidence");
      push({
        key: `good:${c.id}`,
        ids: [c.id],
        title: `${AI_NAMES[c.id] ?? c.id}: rated ${level}/5${evidence ? ` — “${evidence}”` : ""}`,
        ai: true,
      });
    }
  }
  for (const s of found) if (craft(s)) push(s);
  // Baseline passes fill the rest, by points.
  const baseline: Array<{ s: Strength; points: number }> = [];
  for (const c of checks) {
    if (isAiCheck(c.id) || covered.has(c.id) || !passes(byId, c.id)) continue;
    if (conflictsWith(c.id, x)) continue;
    const text = GOOD[c.id]?.(val(c));
    if (!text) continue;
    baseline.push({ s: { key: `good:${c.id}`, ids: [c.id], title: text }, points: c.points });
  }
  baseline.sort((a, b) => b.points - a.points || a.s.key.localeCompare(b.s.key));
  const all = [...picked, ...baseline].slice(0, MAX_ITEMS);
  return all.map(({ s, points: p }) =>
    item(
      s.key,
      s.ai ? "ai" : "check",
      s.ids,
      { title: s.title, ...(s.ai ? { source: "AI review" } : {}) },
      p,
      s.ai ? render : null,
    ),
  );
}

// ───────────────────────── good templates ─────────────────────────

const GOOD: Partial<Record<CheckId, (v: Value) => string>> = {
  A1: () => "Text meets WCAG AA contrast",
  A2: () => "Images have meaningful alt text",
  A3: () => "Links describe where they go",
  A6: () => "Headings are marked up as headings",
  A7: () => "Links are easy to tap on phones",
  A8: () => "Links in text are easy to spot",
  A13: () => "No important text is baked into images",
  M1: () => "Fits a 375px phone without shrinking",
  M2: () => "Stays fluid even where media queries are ignored",
  M3: () => "Text columns stay readable on phones",
  M4: (v) => `The main button is ${fmtPx(v.minSidePx as number)} tall — easy to tap`,
  M5: () => "Images scale cleanly on phones",
  M6: () => "Holds up in dark mode",
  M7: () => "Comfortable side margins on phones",
  T1: (v) => `Body text is ${fmtPx(v.px as number)} on phones`,
  T2: (v) => `Body text is ${fmtPx(v.px as number)} on desktop`,
  T3: (v) => `Comfortable line spacing (${v.ratio}×)`,
  T4: () => "Comfortable line length",
  T5: () => "Paragraphs are left-aligned",
  T6: () => "A disciplined type system",
  T7: () => "Capitals are used sparingly",
  T8: () => "Copy reads easily",
  H1: () => "Has a clear button for the main action",
  H2: (v) =>
    `The main button ${quote(typeof v.label === "string" ? v.label : null)} is in the first screen on phones`,
  H3: (v) => `The main button ${quote(typeof v.label === "string" ? v.label : null)} stands out`,
  H4: (v) =>
    `The button label ${quote(typeof v.label === "string" ? v.label : null)} names the action`,
  H5: () => "One focused call to action up top",
  H6: () => "The headline clearly outranks body text",
  I1: () => "Plenty of live text alongside images",
  I2: (v) =>
    v.ctaLive === true
      ? "The text and the button are real text, so they read fine with images off"
      : "All the text is real text, so it reads fine with images off",
  I3: () => "All images load",
  I4: () => "Still makes sense with images off",
  L1: (v) => `A comfortable ${v.width}px content column`,
  L2: () => "Balanced whitespace",
  L3: () => "Clean, uncluttered layout",
  L4: () => "Blocks align to a simple grid",
  L5: () => "A restrained colour palette",
  U1: () => "Clear unsubscribe link",
  U2: () => "The unsubscribe link is easy to read",
  X1: () => "Well under Gmail's clipping limit",
  X2: () => "Code works across major email apps",
  X3: () => "Links and personalization are clean",
};
