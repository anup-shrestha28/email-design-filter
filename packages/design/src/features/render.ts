/**
 * Render features measured in Chromium (passes D, D0, M, M-nomq, M-off; FREE-TIER.md §5.2)
 * following the core definitions of DESIGN-SCORE §2.1.
 *
 * These are *measurements*, not credits: the scorer applies ramps, thresholds and weights,
 * so thresholds can move with SCORING_VERSION without a re-render. A few definitional
 * constants of §2.1 are applied at measurement time (legible = ≥ 3:1 and ≥ 10px; the
 * 102,000-byte clip offset, recorded in `clip.clipBytes`).
 *
 * Untrusted when read back from the VM: always validate with `renderFeaturesSchema.safeParse`.
 * No raw DOM, no text except the primary CTA label (≤ 60 chars) and normalized CTA labels.
 */
import { z } from "zod";
import { boxSchema, count, hexColor, length, px, ratio, shortText, unit } from "./common";
import { usedFontsSchema } from "./fonts";

export const TEXT_ROLES = ["body", "heading", "button", "navigation", "footer"] as const;
export type TextRole = (typeof TEXT_ROLES)[number];

export const RENDER_PASSES = ["D", "D0", "M", "M-nomq", "M-off"] as const;

/** `links.hidden` holds at most this many offsets (`links.hiddenMore` beyond). */
export const MAX_HIDDEN_LINKS = 500;

/** Colour pair group for contrast (A1, CAP_CONTRAST, M6, L5). */
export const contrastGroupSchema = z.object({
  /** Effective text colour (alpha × cumulative opacity), `#rrggbb[aa]`. */
  fg: hexColor,
  /** Effective opaque background (colour method) or median D0 pixel (pixel method). */
  bg: hexColor,
  /** Contrast ratio; for the pixel method, the p10 (worst area). Never rounded. */
  ratio,
  /** Pixel method only: the p90. */
  p90: ratio.nullable(),
  method: z.enum(["color", "pixel"]),
  large: z.boolean(),
  role: z.enum(TEXT_ROLES),
  /** Passed the paint test and every visibility rule (DESIGN-SCORE §2.1 "rendered"). */
  rendered: z.boolean(),
  /** Every run in the group has < 20 characters. */
  short: z.boolean(),
  /** Counted characters. */
  chars: count(),
  /**
   * ADDED (render-2026.2, optional so stored features still parse): every run in the group is
   * fine print (< 13px and ≤ 0.9 × the 75th-percentile size outside the footer). Fine print and
   * the footer are not "main content" for CAP_CONTRAST. Absent = false.
   */
  fine: z.boolean().optional(),
});
export type ContrastGroup = z.infer<typeof contrastGroupSchema>;

export const primaryCtaSchema = z.object({
  /** Visible label (≤ 60 chars; alt text for image buttons). */
  label: shortText(60),
  /** `Intl.Segmenter` words in the label. */
  words: count(1000),
  /** The label is live text (not an image). */
  live: z.boolean(),
  /**
   * Target box (union of the `<a>` fragments) at 375, CSS px. From render-2026.4, for a link nested
   * in another link (an `<a>` around the whole button table, LinkedIn's pattern) the outermost
   * enclosing link's box — it takes the taps around the inner link.
   */
  target: boxSchema,
  /**
   * Visual box at 375: the painted button — the `<a>`, a wrapper inside it holding all its text
   * (a pill `<span>`), or a cell around it holding nothing else (render-2026.4; before, only the
   * sole-child parent cell) — grown through same-fill wrappers.
   */
  visual: boxSchema,
  /** Label contrast (never rounded); null for image buttons (not measurable without OCR). */
  labelContrast: ratio.nullable(),
  labelLarge: z.boolean(),
  /** Luminance ratio (≥ 1) between the fill and the surrounding container background. */
  fillLumRatio: z.number().min(0.99).max(21.01).nullable(),
  /** CIEDE2000 between fill and surround. */
  fillDeltaE: z.number().min(0).max(200).nullable(),
  /** It is also the most prominent link overall (hero image links excluded). */
  mostProminent: z.boolean(),
  /**
   * ADDED (render-structure, render-2026.4, optional): the visible button (`visual`) is a painted
   * box around the link — a filled cell or wrapper — and the link itself (`target`) covers under
   * half of it, so only the label text is tappable. M4 should size the button by `visual` and
   * say so when this is true. Absent = rendered before.
   */
  textOnlyTap: z.boolean().optional(),
  /** `data-o` byte offset of the link in the raw HTML (clip mapping), or null. */
  offset: count(50_000_000).nullable(),
});
export type PrimaryCta = z.infer<typeof primaryCtaSchema>;

/**
 * ADDED (render-structure, render-2026.4): why a content image was not drawn, recorded on its
 * `images.loads` entry (and passed from the pre-fetch in `RenderJob.imageLog`):
 * - our limits: `too_large` (over the per-image byte limit), `too_many_pixels` (over 25
 *   megapixels), `budget` (the email's 15 MB image budget was spent);
 * - the image policy: `tracker`, `pixel`, `per_recipient` (a URL carrying the recipient's
 *   address), `policy` (another refusal), `images_off` (no images for this email), `not_http`;
 * - the sender's server: `expired` (a 401/403/410 on a signed URL whose expiry has passed, e.g.
 *   LinkedIn's media links), `http` (another non-2xx answer), `not_image` (a 2xx body that isn't
 *   an image), `svg` (an SVG, which Gmail doesn't show either);
 * - the fetch: `timeout`, `network` (DNS, connection, redirects, SSRF refusal);
 * - the render: `undecodable` (fetched but the browser couldn't decode it), `missing_cid` (no
 *   such inline part), `not_fetched` (never fetched: past the 60-image cap or a relative URL).
 */
export const IMAGE_LOAD_REASONS = [
  "too_large",
  "too_many_pixels",
  "budget",
  "tracker",
  "pixel",
  "per_recipient",
  "policy",
  "images_off",
  "not_http",
  "expired",
  "http",
  "not_image",
  "svg",
  "timeout",
  "network",
  "undecodable",
  "missing_cid",
  "not_fetched",
] as const;
export type ImageLoadReason = (typeof IMAGE_LOAD_REASONS)[number];

export const imageLoadSchema = z.object({
  status: z.union([
    z.number().int().min(0).max(999),
    // "too_large": the image exceeded our per-image byte or pixel limit (our budget, not a
    // broken image). Added in render-2026.2; not evaluated for I3 / CAP_BROKEN_IMAGES.
    // "unsupported" (render-structure, render-2026.4): the server sent a format Gmail doesn't
    // show (an SVG, `reason: "svg"`) — a finding of its own, not a broken image; not evaluated
    // for I3 / CAP_BROKEN_IMAGES.
    z.enum(["blocked", "timeout", "error", "missing", "too_large", "unsupported"]),
  ]),
  /** The browser decoded it (naturalWidth > 0). */
  decoded: z.boolean(),
  /** ADDED (render-structure, render-2026.4, optional): why it wasn't drawn; absent when it was. */
  reason: z.enum(IMAGE_LOAD_REASONS).optional(),
  /**
   * ADDED (render-structure, render-2026.4, optional): desktop area in CSS px² summed over the
   * elements showing this URL (laid-out box, or the declared width × height of one that wasn't
   * drawn) — for weighing broken images against the imagery.
   */
  area: z.number().min(0).max(1e12).optional(),
});

export const regionSchema = z.object({
  key: shortText(24),
  pass: z.enum(["desktop", "mobile"]),
  x: z.number().min(-100_000).max(1_000_000),
  y: z.number().min(-100_000).max(1_000_000),
  w: length,
  h: length,
});

export const renderFeaturesSchema = z.object({
  v: z.literal(1),
  meta: z.object({
    chromium: shortText(80),
    rendererVersion: shortText(80),
    fontBundle: shortText(40),
    lite: z.boolean(),
    passes: z.array(z.enum(RENDER_PASSES)).max(5),
    domNodes: count(1_000_000),
    /** The desktop screenshot was clipped at 8,000 CSS px. */
    screenshotClipped: z.boolean(),
  }),
  /** Layout facts; `desktopHeight`/`mobileHeight` size the viewer iframe. */
  layout: z.object({
    desktopHeight: length,
    mobileHeight: length,
    desktopContentWidth: length,
    mobileContentWidth: length,
    nomqContentWidth: length.nullable(),
    /** Mobile fit factor `min(1, 375 / contentWidth@M)` (DESIGN-SCORE §2.1). */
    k: unit,
    kNomq: unit.nullable(),
    /**
     * Main container on desktop (L1), or null. From render-2026.4 (render-structure), when the
     * container is full-bleed (≥ 95% of the page) its x/w are the main text column inside it (the
     * median of the text's narrower boxes), not the full-width background row; y/h stay the
     * container's.
     */
    mainContainer: boxSchema.nullable(),
    /**
     * ADDED (render-2026.3, optional so stored features still parse): the extent of everything a
     * reader can see on desktop, whole document, whole CSS px — left/right = the horizontal span
     * (floored / ceiled), bottom = the lowest bottom edge. Counts rendered text with a visible
     * character, images (not tracking pixels) and painted boxes (background image, a background
     * colour that shows, a visible border) ≥ 4 px both ways, minus page-wide backgrounds (≥ 98% of
     * the page width) and anything hidden or clipped away. null = nothing visible found; absent =
     * rendered before it existed. The gallery crops its card preview to it.
     */
    content: z.object({ left: length, right: length, bottom: length }).nullable().optional(),
  }),
  text: z.object({
    script: z.enum(["latin", "cjk", "rtl", "other"]),
    cased: z.boolean(),
    chars: z.object({
      /** Rendered, preheader excluded, footer included. */
      total: count(),
      outsideFooter: count(),
      body: count(),
      heading: count(),
      button: count(),
      navigation: count(),
      footer: count(),
      /** L_legible: ≥ 3:1 and ≥ 10px, outside the footer, CJK ×2. */
      legible: count(),
    }),
    medianAll: z.object({ desktop: px.nullable(), mobile: px.nullable() }),
    /**
     * Median body size (falls back to all text outside the footer when body < 100 chars). From
     * render-2026.4 the median leaves out fine print (< 13px and ≤ 0.9 × the sample's p75 size).
     */
    body: z.object({ desktop: px.nullable(), mobile: px.nullable(), fallback: z.boolean() }),
    /** T3: median measured line pitch ÷ font size. */
    lineRatio: z.number().min(0).max(20).nullable(),
    /** Lines of paragraph text (T3–T5 need ≥ 3). */
    paragraphLines: count(),
    /**
     * T4: median characters per line, excluding each paragraph's last line. From render-2026.4:
     * soft-wrapped lines only, of body blocks of ≥ 12 words (lines ended by `<br>`, single-line
     * label cells and wrapped data cells don't count); null under 2 such lines or 200 characters
     * of them (2 lines need ≥ 100 characters each: a letter whose paragraphs wrap once).
     */
    charsPerLine: z.number().min(0).max(10_000).nullable(),
    /** T5 */
    alignment: z.object({ chars: count(), badChars: count() }),
    /** T6 sizes: [size rounded to 0.5px, chars] on desktop. */
    sizes: z.array(z.tuple([px, count()])).max(40),
    /** T7 render measure; null for caseless scripts. */
    caps: z.object({ chars: count(), caps: count() }).nullable(),
    /** A6 */
    headings: z.object({ visual: count(), markedUp: count(), h1: count() }),
    /** H6: largest text size in the first mobile viewport. */
    firstViewportMaxPx: px.nullable(),
    /** I2(a): legible chars in the first mobile viewport, navigation and preheader excluded. */
    firstViewportLegible: count(),
    /** M3: [block width at 375 (CSS px, 10px buckets), body chars]. */
    blockWidths: z.array(z.tuple([length, count()])).max(60),
    /**
     * ADDED (render-text, render-2026.4, optional): `blockWidths` for paragraph text only — prose
     * blocks at 375 (≥ 3 lines wrapping at least twice, ≥ 24 words). M3 counts only these as
     * squeezed, never a 2-up card grid, a logo + job-title row or a label. Absent = older render.
     */
    proseWidths: z
      .array(z.tuple([length, count()]))
      .max(60)
      .optional(),
    /** M7: [min distance to a viewport edge at 375 (CSS px, 2px buckets, capped 40), body chars]. */
    gutters: z.array(z.tuple([length, count()])).max(30),
    /** A12: Kendall τ between DOM and visual order of text blocks at 375. */
    readingOrderTau: z.number().min(-1).max(1).nullable(),
    /** C3 */
    words: count(),
    avgParagraphLines: z.number().min(0).max(10_000).nullable(),
    maxWordsBetweenHeadings: count().nullable(),
    /** L4: distinct alignment anchors of text blocks on desktop (4px clusters). */
    alignmentAnchors: count(),
  }),
  contrast: z.object({ groups: z.array(contrastGroupSchema).max(80) }),
  links: z.object({
    total: count(),
    standalone: count(),
    inline: count(),
    /** A8: inline links with a non-colour cue or ≥ 3:1 against the surrounding text. */
    inlineDistinguishable: count(),
    /** A7: standalone link targets at 375, [w, h, spacingExceptionMet]. */
    targets: z.array(z.tuple([length, length, z.boolean()])).max(80),
    /**
     * ADDED (render-2026.6, optional): the `data-o` byte offsets of the `<a>` elements a reader
     * can't see — they draw nothing in pass D nor in pass M: no geometrically visible text that
     * passed the paint test or stands out from a plain background (≥ 1.3:1; on a background
     * picture it counts as drawn) and no visible picture (render extract/hidden-links.ts) —
     * ascending, first `MAX_HIDDEN_LINKS`. U1 drops a static-pass unsubscribe link at one of them
     * (the HTML pass can't see descendant selectors, @media rules or text the colour of its
     * background). Only links carrying their own `data-o` are listed. Absent = rendered before.
     */
    hidden: z.array(count(50_000_000)).max(MAX_HIDDEN_LINKS).optional(),
    /** ADDED (render-2026.6, optional): more hidden links than `hidden` holds. */
    hiddenMore: z.boolean().optional(),
  }),
  cta: z.object({
    primary: primaryCtaSchema.nullable(),
    buttonLike: count(),
    /** Normalized labels of all button-like CTAs (first 10). */
    labels: z.array(shortText(60)).max(10),
    /** H5: distinct actions among button-like CTAs in the first two mobile viewports. */
    firstTwoViewportsDistinct: count(),
    /** Distinct button styles (L6). */
    buttonStyles: count(),
  }),
  images: z.object({
    content: count(),
    informative: count(),
    /** L7: a logo in the top 200px at 375. */
    logoTop: z.boolean(),
    /** img_share: content-image area ÷ rendered area above the footer (mobile). */
    share: unit,
    /**
     * I3 / CAP_BROKEN_IMAGES, one entry per content image (first 60). From render-2026.4
     * (render-structure): one entry per distinct image URL (an image used twice loads or fails
     * once), including declared content images that weren't drawn (too large, blocked, broken —
     * they used to be missing when they laid out flat), each with its `reason`.
     */
    loads: z.array(imageLoadSchema).max(60),
    /**
     * ADDED (render-structure, render-2026.4, optional): distinct content images declared in the
     * HTML (`<img>` and CSS backgrounds that aren't tracking pixels, hidden or blocked as pixels),
     * drawn or not…
     */
    declared: count().optional(),
    /**
     * …and how many of them were drawn from a decoded picture (placeholders don't count). With
     * images off for the email (`loads[].reason = "images_off"`: sensitive or transactional types,
     * privacy setting) nothing is drawn, which says nothing about the design.
     */
    drawn: count().optional(),
    /** I5: bytes of loaded content images. */
    bytes: count(100_000_000),
    /** M5: content images ≥ 200px wide on desktop (first 30). */
    adapt: z
      .array(
        z.object({
          withinViewport: z.boolean(),
          /** |rendered aspect ÷ natural aspect − 1|; null when the natural size is unknown. */
          aspectDev: z.number().min(0).max(1000).nullable(),
          /** naturalWidth ÷ rendered CSS width (desktop); null when unknown (not loaded). */
          sharpRatio: z.number().min(0).max(1000).nullable(),
          renderedWidth: length,
        }),
      )
      .max(30),
    /** A2 refinement with rendered sizes. */
    alt: z.object({
      total: count(),
      withAlt: count(),
      informative: count(),
      informativeMeaningful: count(),
    }),
    /** M6: transparent images — share of opaque pixels ≥ 3:1 under partial / full inversion. */
    darkMode: z.array(z.object({ partial: unit, full: unit })).max(10),
  }),
  /** I4: legible + alt chars in the first two viewports, images on (M) vs off (M-off). */
  imagesOff: z.object({ on: count(), off: count() }).nullable(),
  footer: z.object({
    present: z.boolean(),
    top: length.nullable(),
    /** U2: the unsubscribe link at 375 (font size CSS px, contrast). */
    unsubscribe: z.object({ px, contrast: ratio }).nullable(),
    postalAddress: z.boolean(),
    receiving: z.boolean(),
  }),
  /** X1 render part and CAP_CLIPPED. */
  clip: z.object({
    clipBytes: count(10_000_000),
    visibleChars: count(),
    afterClipChars: count(),
    ctaAfterClip: z.boolean().nullable(),
    unsubscribeAfterClip: z.boolean().nullable(),
  }),
  /** Merge tags visible in the first mobile viewport (CAP_MERGE_TAG), code excluded. */
  mergeTagFirstViewport: z.boolean(),
  pixels: z.object({
    /** L2: share of 8×8 blocks with luminance SD < 0.02 (container, images excluded). */
    whitespace: unit.nullable(),
    /** L3 components. */
    edgeDensity: unit.nullable(),
    pngBytesPerPixel: z.number().min(0).max(64).nullable(),
    xyLeaves: count().nullable(),
    /** L5: non-image colours covering ≥ 1% of area, merged at ΔE < 5. */
    dominantColours: count().nullable(),
    /** Information only (Hasler & Süsstrunk, signed opponent channels, 0–255 scale). */
    colourfulness: z.number().min(0).max(500).nullable(),
  }),
  components: z.object({
    /** L6: clusters of vertical gaps between blocks (2px). */
    gapClusters: count(),
    /** L7: accent hues on buttons, links and headings. */
    accentHues: count(),
  }),
  /** axe-core in pass D (isolated world): layout tables by `isDataTable`, and violation counts. */
  axe: z
    .object({
      layoutTables: count(),
      presentationalLayoutTables: count(),
      violations: z.array(z.tuple([shortText(48), count()])).max(30),
    })
    .nullable(),
  /** Issue boxes for overlays (≤ 20). */
  regions: z.array(regionSchema).max(20),
  info: z.object({
    linkCount: count(),
    imageArea: z.number().min(0).max(1e12),
    textArea: z.number().min(0).max(1e12),
    readingTimeSec: count(),
  }),
  /** Used font stacks (moved to `DesignFeatures.fonts.used` by `buildDesignFeatures`). */
  fonts: usedFontsSchema.optional(),
});
export type RenderFeatures = z.infer<typeof renderFeaturesSchema>;

export const RENDER_FEATURES_VERSION = 1;
