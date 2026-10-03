/**
 * SCORING_VERSION = spec + weights + thresholds + priors + confidence rules + caniemail snapshot +
 * font catalog +
 * client table + lexicons + model id + prompt hash (DESIGN-SCORE §8.11; DESIGN.md §8.1 "the
 * client table, platform list and catalog versions are part of SCORING_VERSION").
 * A bump does not re-score stored emails by itself (there is no background re-score job): each
 * keeps the score and version it was saved with until it is rendered again — on demand, by the
 * nightly fill, or for a whole local account with the dev tool apps/web/scripts/rerender-all.ts
 * (DESIGN-SCORE §8.11).
 */
import { AI_MODEL } from "./ai/schema";
import { PROMPT_HASH } from "./ai/prompt";
import { CATALOG_VERSION } from "./fonts/catalog";
import { CLIENT_TABLE_VERSION } from "./fonts/clients";
import {
  CANIEMAIL_SNAPSHOT,
  CONFIDENCE_VERSION,
  PRIORS_VERSION,
  THRESHOLDS_VERSION,
  WEIGHTS_VERSION,
} from "./scoring/weights";
import { LEXICON_VERSION } from "./util/patterns";

/**
 * Methodology version of DESIGN-SCORE.md. 2026.2 = DESIGN-SCORE v1.2 (verdict policy: severe
 * visible caps only, main-content contrast, definitive broken images, root-cause explanations,
 * distinctive strengths). Together with t-2026.2 and conf-2026.3 this changes SCORING_VERSION;
 * stored emails get it when they are rendered again (no background re-score, see above). The
 * footer / fine-print facts need that re-render anyway (RENDERER_VERSION render-2026.2).
 * 2026.3 = DESIGN-SCORE v1.3: the Excellent gate (85+ needs a real headline, a standout button or
 * an AI visual rating ≥ 4, and no large phone-layout problem, else the score is held at 84), faint
 * main text as one root cause, the visible merge tag quoted first. lex-2026.2 (preferences /
 * "you subscribed to" phrasings) needs a re-extraction to reach stored static features.
 * 2026.4 = DESIGN-SCORE v1.4: strengths never contradict a listed problem ("Built for phones" not
 * with text at the screen edge or in narrow columns, whitespace / clean layout not with edge text
 * or an off-size column, tap-friendly links not with a too-small main button, "reads fine with
 * images off" only with images, no typography praise for an image-only email), the headline is
 * "big", never "bold" (weight isn't measured), and stray button fragments are named (static
 * `strayButtons`, which needs a re-extraction). No score changes.
 * 2026.5 = DESIGN-SCORE v1.6 (2026-10-01 verdict audit, thresholds t-2026.3): the Excellent gate
 * needs every bar without an AI rating ≥ 4 — heading text ≥ 1.5× the body, a main button with
 * fill salience ≥ 0.9 that is the most prominent link or in the first phone screen, and for system
 * mail pictures on ≥ 8% of the email (not when more than half the images didn't load; not judged
 * with images off by our policy); U1 and the saved signal are the union of the static pass and
 * the email's own render; fine print weighs ≤ 25% of A1; M4 sizes the visible button
 * (`textOnlyTap`); CAP_BROKEN_IMAGES needs ≥ 20% of the image area, an SVG is a small I3 finding
 * and a load's reason is read before its status; "No headline" ("in live text" with pictures);
 * strengths need a drawn image / a standout button / heading text; and `score_summary.signals`
 * saves the gate bars, both passes' facts, the image counts and whether images were off.
 * Re-scores from stored features (no re-render needed; the render-2026.4 fields sharpen M4, I3,
 * the broken-images cap, the image counts and images off).
 * 2026.6 = DESIGN-SCORE v1.7 (engine round 2 after the 2026-10-01 audit; DECISIONS.md #62–#68):
 * the Excellent gate's G2 reads the main button's first-phone-screen position for every type
 * (`ctaPlacement`; H2 is still scored only for action types), and fails one of ≥ 3 look-alike
 * buttons for ≥ 3 different actions (`ctaCompeting`); new bar G4 needs a designed hero — a drawn
 * picture ≥ 300 px wide and ≥ 40,000 px², or a large heading on a band ≥ 1.15:1 against white
 * (`hero`; `imagery_unknown` when a large image didn't load) — so stock templates (LinkedIn's "new
 * message", MongoDB's announcements, FlexJobs' "account created") are held at 84. Saved signals
 * add `ctaCompeting`, `heroPicture` and `heroBand`; `ctaFirstScreen` is measured for every type.
 * lex-2026.3: footer phrasings (preferences: "Manage recommendations / notifications / alerts";
 * why-you-get-this: "You are receiving … emails", "This email was intended for", "Learn why we
 * included this", typographic apostrophes) and an injection pre-scan that needs text addressed
 * to the reviewer, not words shared with copy ("rank the Top 100", "Software Developer ·
 * Message"). Re-scores from stored features; the static facts (footer statements, stray text)
 * and the render's buttons (render-2026.5) need a re-render, which re-extracts both.
 */
export const METHODOLOGY_VERSION = "2026.6";

/** Shape version of `DesignFeatures` (bump when a feature schema changes). */
export const FEATURES_VERSION = 1;

export const SCORING_VERSION = [
  METHODOLOGY_VERSION,
  WEIGHTS_VERSION,
  THRESHOLDS_VERSION,
  PRIORS_VERSION,
  CONFIDENCE_VERSION,
  `caniemail-${CANIEMAIL_SNAPSHOT}`,
  CATALOG_VERSION,
  CLIENT_TABLE_VERSION,
  LEXICON_VERSION,
  AI_MODEL,
  `prompt-${PROMPT_HASH}`,
].join("+");
