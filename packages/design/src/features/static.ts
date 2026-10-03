/**
 * Static design features, computed at ingest from the raw decoded HTML with cheerio (parse5),
 * css-tree and `juice(html)` — no network (DESIGN-SCORE §2 "Static features";
 * FREE-TIER.md §5.4 "Static checks, 22.5 points").
 *
 * Compact by construction (target ≤ 3 KB): counts and flags, a few short labels, never text.
 */
import { z } from "zod";
import { count, shortText, unit } from "./common";

/** Client-compatibility features detected in CSS/HTML (DESIGN-SCORE §5.8 X2). */
export const COMPAT_FEATURES = [
  "flex",
  "grid",
  "position",
  "float",
  "max_width",
  "background_image",
  "border_radius",
  "linear_gradient",
  "box_shadow",
  "svg_image",
  "webp_image",
  "video",
  "picture",
] as const;
export type CompatFeature = (typeof COMPAT_FEATURES)[number];

/** `footer.unsubscribeOffsets` holds at most this many offsets (later links are not recorded). */
export const MAX_STATIC_UNSUBSCRIBE_LINKS = 20;

const dirValue = z.enum(["ltr", "rtl", "auto"]).nullable();

export const staticDesignFeaturesSchema = z.object({
  v: z.literal(1),
  /**
   * ADDED (optional, absent = false): the static pass failed on this HTML (an internal error).
   * Every count below is then 0 and `footer.unsubscribe` "none" only as placeholders: they are not
   * findings, and the checks built on them are `not_evaluated` ("static_unavailable").
   */
  unavailable: z.boolean().optional(),
  /** UTF-8 bytes of the decoded text/html part (X1). */
  htmlBytes: count(50_000_000),
  /** A4: `lang` on `<html>` and on the content wrapper (Gmail strips `<html>` attributes). */
  lang: z.object({ html: shortText(35).nullable(), wrapper: shortText(35).nullable() }),
  /** A11 */
  dir: z.object({ html: dirValue, wrapper: dirValue }),
  script: z.object({ kind: z.enum(["latin", "cjk", "rtl", "other"]), cased: z.boolean() }),
  /** A9: non-empty `<title>`. */
  title: z.boolean(),
  /** A10 */
  aria: z.object({
    roleButtonOnLink: count(),
    vmlWithoutAlt: count(),
    ariaHiddenBody: z.boolean(),
  }),
  /** A5 (static data-table heuristic modelled on axe-core `isDataTable`). */
  tables: z.object({ total: count(), layout: count(), presentational: count() }),
  /** A2 (static; "informative" by the static size/link heuristic). */
  images: z.object({
    total: count(),
    withAlt: count(),
    informative: count(),
    informativeMeaningful: count(),
    pixels: count(),
    content: count(),
  }),
  /** A3 + X3 link facts (visible links only). */
  links: z.object({
    total: count(),
    named: count(),
    generic: count(),
    http: count(),
    https: count(),
    emptyOrHash: count(),
    javascript: count(),
    placeholder: count(),
  }),
  /** X3 class 1 and CAP_MERGE_TAG (subject is checked from the score context). */
  mergeTags: z.object({
    body: count(1000),
    /** A tag appears in the estimated first mobile screen (first ~600 visible chars). */
    firstScreen: z.boolean(),
    /**
     * ADDED (optional, older features lack it): the first tag in the first screen, e.g.
     * "{{ first_name }}" — the tag token only, no surrounding text (explanations quote it).
     */
    sample: shortText(40).optional(),
    /**
     * ADDED (optional, methodology 2026.3): the same tag with a few words around it, as a reader
     * sees it (e.g. "Hi {{ first_name }}"), ≤ 60 characters.
     */
    snippet: shortText(60).optional(),
  }),
  /** X1 static part: visible text after the 102,000-byte clip offset. */
  clip: z.object({ visibleChars: count(), afterClipChars: count(), clipBytes: count(10_000_000) }),
  /**
   * ADDED (optional, methodology 2026.3; absent = false): the visible text contains wording aimed
   * at AI reviewers or scoring tools (the injection pre-scan's patterns). Readers see it too, so it
   * is reported as stray text; it never changes the score.
   */
  instructionText: z.boolean().optional(),
  /**
   * ADDED (optional, methodology 2026.4; absent = 0): links with text that are painted as filled
   * buttons but shrunk to slivers (font-size or height ≤ 3–4px) — stray "button fragments" a
   * reader sees as coloured specks (DESIGN-SCORE §7). Never changes the score.
   */
  strayButtons: count(1000).optional(),
  /** X4 */
  style: z.object({ bytes: count(50_000_000), mediaRules: count(), mediaAfterLimit: z.boolean() }),
  /** X2: features used, and whether a fallback was detected for each. */
  compat: z
    .array(z.object({ id: z.enum(COMPAT_FEATURES), fallback: z.boolean() }))
    .max(COMPAT_FEATURES.length),
  /** U1, U3, U4 and the static footer facts. */
  footer: z.object({
    unsubscribe: z.enum(["before_clip", "after_clip", "none"]),
    /**
     * ADDED (optional, render-2026.6): the UTF-8 byte offsets of the links behind `unsubscribe`
     * (their start tags, the render's `data-o`), document order, first
     * `MAX_STATIC_UNSUBSCRIBE_LINKS`; null when one of them has no source position, which no
     * render offset can match (the static answer then stands as it is). U1 leaves out the ones
     * the email's own render lists in `links.hidden`. Absent = extracted before.
     */
    unsubscribeOffsets: z
      .array(count(50_000_000))
      .max(MAX_STATIC_UNSUBSCRIBE_LINKS)
      .nullable()
      .optional(),
    unsubscribeByHeader: z.boolean(),
    preferences: z.boolean(),
    receiving: z.boolean(),
    postalAddress: z.boolean(),
  }),
  /** H1/H4 static heuristics and template matching. */
  cta: z.object({
    buttonLike: count(),
    /** Normalized labels of button-like links, first 10 in document order. */
    labels: z.array(shortText(60)).max(10),
    primaryLabel: shortText(60).nullable(),
    /** UTF-8 byte offset of the first button-like link (CAP_CLIPPED without an own render). */
    primaryOffset: count(50_000_000).nullable(),
  }),
  /** T7 static heuristic (body-ish text, headings and buttons excluded). */
  caps: z.object({ chars: count(), caps: count() }),
  /** T8: English prose statistics (null when not English prose). */
  prose: z.object({ words: count(), sentences: count(), syllables: count() }).nullable(),
  text: z.object({
    visibleChars: count(),
    words: count(),
    /** Share of visible text that sits inside `<code>`, `<pre>` or monospace. */
    codeShare: unit,
  }),
  /** AMP part is handled by the pipeline; kept here for the info line. */
  hasViewport: z.boolean(),
});
export type StaticDesignFeatures = z.infer<typeof staticDesignFeaturesSchema>;

export const STATIC_FEATURES_VERSION = 1;
