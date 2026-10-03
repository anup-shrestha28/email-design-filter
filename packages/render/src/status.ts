/**
 * Fixed status codes: the only thing the renderer ever reports about a failed email (never
 * email content; FREE-TIER.md §5.1 "render.js prints only fixed status codes").
 */
export const RENDER_STATUS = [
  "ok",
  "timeout",
  "too_large",
  "too_many_nodes",
  "sanitize_error",
  "parse_error",
  "navigation_error",
  "crash",
  "browser_error",
  "invalid_features",
  "extract_error",
  "deadline",
  "sandbox_error",
] as const;
export type RenderStatus = (typeof RENDER_STATUS)[number];

/**
 * Renderer version (part of `features.meta.rendererVersion`, DESIGN-SCORE §8.11).
 * render-2026.2: short-email footer detection, fine-print flag on contrast groups, "too_large"
 * image status. Features rendered by 2026.1 still parse; re-render to get the new facts.
 * render-2026.3: the visible content extent (`layout.content`, the gallery's card crop). Additive
 * and optional: no re-score (SCORING_VERSION unchanged; nothing scores it) and FEATURES_VERSION
 * stays 1. Earlier features still parse; re-render to get it (apps/web/scripts/rerender-all.ts).
 * render-2026.4 (2026-09-30 visual audit C5–C7, C9, §3 items 2, 3, 9, 13, 16, 17, 19, 20, §4).
 * Text, footer and phone measures: the footer must start in the bottom 40% of the text and hold
 * < 40% of it unless its text is smaller than the body's (a whole-email "footer" is narrowed
 * toward its marker); body size leaves out fine print; T4 line length only over soft-wrapped
 * prose lines (null under 200 characters); `text.proseWidths` (M3 counts only paragraph text as
 * squeezed); the phone passes report a 375×667 screen (`max-device-width` queries match); text
 * with no font renders in Arial, Helvetica, sans-serif (was Times); an unloaded image with a
 * declared width lays out as a sized placeholder (a broken one had widened Booking to 656px);
 * text over an unloaded background image is undecided, not "hidden". Buttons, columns and
 * images: the button's painted box is searched inside (pill spans) and around (filled cells) a
 * standalone link, a filled button outranks an outline one, `cta.primary.textOnlyTap`; L1 takes
 * the text column inside a full-bleed container; `images.loads` has one entry per distinct URL,
 * not-drawn images included, with `reason` and `area` (an SVG is "unsupported", not broken), plus
 * `images.declared` / `images.drawn`; the analysis pre-fetch takes ≤ 5 MB per image (was 2 MB).
 * Review fixes (same version, nothing was stored with it yet): every pass renders the light
 * colour scheme (a dark host had applied emails' `prefers-color-scheme: dark` styles and hidden
 * their copy from the paint test); T4 needs 2 soft-wrapped lines, not 3 (with the 200-character
 * sample); a social-network link to the sender's own network (LinkedIn → linkedin.com) is a
 * content link, an app-store badge never a CTA candidate; a link nested in a link taps through
 * the outer link's box (`cta.primary.target`); inlined backgrounds over ~3.6 MB are read.
 * All additive: older features still parse; re-render to get them.
 * render-2026.5 (engine round 2, DECISIONS.md #66): a painted link's label of more than 7 words
 * is a button when its filled box holds nothing else (a standalone link, the link's own fill, a
 * pill inside it or a cell around it, ≤ 120 px tall, ≤ 80 characters: Docker's "Contact us to
 * get started with AI governance", upGrad's "How is India actually learning AI? Fill out form");
 * the footer never starts at or before a filled live-text button that precedes its marker
 * (Tavily's "See the full results here" sat in the last section with the address and the
 * unsubscribe link); and the footer markers read lex-2026.3's phrasings ("This email was intended
 * for …", "You’re receiving …"). No schema change: older features still parse; re-render to get
 * them.
 * render-2026.6 (2026-10-01 security review, DECISIONS.md #69): `links.hidden` / `hiddenMore`, the
 * `data-o` offsets of the `<a>` elements that draw nothing in pass D nor M (no text that passed the
 * paint test or stands out from a plain background, no visible picture), and the static pass's
 * `footer.unsubscribeOffsets`, so U1 no longer counts a static-pass unsubscribe link hidden by a
 * descendant selector, an @media rule or its colour; the static pass's injection pre-scan
 * (`instructionText`) reads the text as the model does. Additive and optional: older features
 * still parse and score as before (SCORING_VERSION unchanged: 0 of 634 stored rows change);
 * re-render to get them.
 */
export const RENDERER_VERSION = "render-2026.6";
/** Font bundle installed in the render snapshot (DESIGN.md §6.2). */
export const FONT_BUNDLE = "fonts-2026.09";
