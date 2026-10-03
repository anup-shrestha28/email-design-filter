/**
 * Definitional constants of DESIGN-SCORE §2.1 and §5.8 shared by extraction and scoring.
 */

/** Gmail clip offset in UTF-8 bytes of the decoded text/html part (X1, conservative). */
export const CLIP_BYTES = 102_000;
/** "Near the clip" threshold (X1). */
export const NEAR_CLIP_BYTES = 90_000;
/** Visible viewport height in a phone mail app at 667px (DESIGN-SCORE §2.1, design choice). */
export const VIEWPORT_V = 600;
/** Mobile layout viewport width (DESIGN-SCORE §2 render passes). */
export const MOBILE_WIDTH = 375;
/** Desktop viewport width. */
export const DESKTOP_WIDTH = 800;
/** Legible text: contrast ≥ 3:1 and effective size ≥ 10px (DESIGN-SCORE §2.1). */
export const LEGIBLE_MIN_CONTRAST = 3;
export const LEGIBLE_MIN_PX = 10;
/** Sub-1.3:1 runs count as failing contrast (monotonic rule), except runs < 20 chars. */
export const INVISIBLE_CONTRAST = 1.3;
export const SHORT_RUN_CHARS = 20;
/** Body text below this many characters falls back to all text outside the footer. */
export const BODY_FALLBACK_CHARS = 100;
/** Footer markers qualify only at or below max(300px, 0.25 × contentHeight) at 375. */
export const FOOTER_MIN_TOP = 300;
export const FOOTER_MIN_SHARE = 0.25;
/**
 * Fine print (CAP_CONTRAST "main content"): text smaller than 13 CSS px **and** at most 0.9× the
 * 75th-percentile size of the text outside the footer. A 12px grey disclaimer under 16px copy is
 * fine print; an email set entirely in 12px grey is not (its main text is 12px).
 */
export const FINE_PRINT_MAX_PX = 13;
export const FINE_PRINT_REL = 0.9;
/** Estimated characters in the first mobile screen for static merge-tag detection. */
export const STATIC_FIRST_SCREEN_CHARS = 400;
