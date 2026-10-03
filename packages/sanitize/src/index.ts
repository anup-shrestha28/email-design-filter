/**
 * HTML sanitizer profiles (DESIGN.md §11.5, DESIGN-SCORE §2). DOMPurify 3.4.16 on jsdom 30.
 *
 * Modules: sanitizer.ts (profiles and hooks), css.ts (css-tree rewriting), urls.ts (URL rules).
 * Design decisions are recorded in packages/crypto/DECISIONS.md (one file for all security parts).
 */
import { CSS_MAX_BYTES, rewriteDeclarations, rewriteStylesheet } from "./css";

export {
  sanitizeForAnalysis,
  sanitizeForViewer,
  SanitizeInputError,
  VIEWER_MAX_INPUT_CHARS,
  ANALYSIS_MAX_INPUT_CHARS,
  VIEWER_STYLE_BUDGET_BYTES,
  ANALYSIS_STYLE_BUDGET_BYTES,
  type ViewerImageContext,
  type ViewerRewriters,
  type ViewerSanitizeResult,
} from "./sanitizer";
export { CSS_MAX_BYTES, type CssImageRewriter } from "./css";
export { DATA_IMAGE_MAX_BYTES } from "./urls";

/**
 * CSS rewrite with css-tree: every url() and image-set() goes through `image` (dropped if null);
 * @import, @font-face, @namespace, behavior, -moz-binding and expression( are removed;
 * output capped at 64 KB. Returns the rewritten CSS text.
 */
export function rewriteCss(css: string, image: (url: string) => string | null): string {
  return rewriteStylesheet(css, image, CSS_MAX_BYTES);
}

/** Same rules for a `style=""` attribute value (a declaration list). */
export function rewriteStyleAttribute(css: string, image: (url: string) => string | null): string {
  return rewriteDeclarations(css, image, CSS_MAX_BYTES);
}
