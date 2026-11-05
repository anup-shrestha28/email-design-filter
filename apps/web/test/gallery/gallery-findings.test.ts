/**
 * The engine findings' wording helpers (lib/gallery.ts FINDINGS WORDING), no database: the HTML-pass
 * version rule that decides which footer statements are listed, the category mapping's app-mail
 * chips, and the bars and limits the wording quotes, which must be the scoring engine's own. The
 * gallery's verdict itself is the design checklist (gallery-lib.test.ts, gallery-checklist-sql.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  CLIP_BYTES,
  excellenceGate,
  METHODOLOGY_VERSION,
  PHONE_PROBLEM_SHARE as ENGINE_PHONE_SHARE,
  SCORING_VERSION,
} from "@edf/design";
import { RENDERER_VERSION } from "@edf/render";
import {
  CTA_SALIENCE_MIN,
  GMAIL_CLIP_KB,
  HEADLINE_RATIO_MIN,
  HTML_PASS_METHODOLOGY,
  HTML_PASS_RENDERER,
  IMAGERY_SHARE_MIN,
  PHONE_PROBLEM_SHARE,
  currentHtmlPass,
  galleryCategoryOf,
} from "@/lib/gallery";

describe("footer statements: only from the current HTML pass", () => {
  // As saved: the summary's scoring version and the email's own render (renderer_version).
  const NEW = "2026.6+w-2026.1+t-2026.3+priors-2026.1+conf-2026.3+lex-2026.3+claude-opus-5";
  const OLD = "2026.5+w-2026.1+t-2026.3+priors-2026.1+conf-2026.3+lex-2026.2+claude-opus-5";

  it("currentHtmlPass needs both: a 2026.6+ summary and a render-2026.5+ render", () => {
    expect(currentHtmlPass(NEW, "render-2026.5")).toBe(true);
    expect(currentHtmlPass("2026.6", "render-2026.5")).toBe(true);
    expect(currentHtmlPass("2026.10+w", "render-2026.12")).toBe(true); // numbers, not text
    expect(currentHtmlPass("2027.1+w", "render-2027.0")).toBe(true);
    // A re-score from stored features (an AI review arriving) keeps the older render's facts.
    expect(currentHtmlPass(NEW, "render-2026.4")).toBe(false);
    expect(currentHtmlPass(OLD, "render-2026.5")).toBe(false);
    expect(currentHtmlPass(NEW, null)).toBe(false); // template coverage, or no render
    expect(currentHtmlPass(undefined, "render-2026.5")).toBe(false);
    expect(currentHtmlPass("test", "render-2026.5")).toBe(false);
    expect(currentHtmlPass(NEW, "render-latest")).toBe(false);
  });

  it("what the engine saves today passes; the minimums are the round that fixed the HTML pass", () => {
    expect(currentHtmlPass(SCORING_VERSION, RENDERER_VERSION)).toBe(true);
    expect(currentHtmlPass(METHODOLOGY_VERSION, RENDERER_VERSION)).toBe(true);
    expect(currentHtmlPass(HTML_PASS_METHODOLOGY, HTML_PASS_RENDERER)).toBe(true);
  });
});

describe("categories", () => {
  it("app mail has chips of its own, so 'Other' holds only the rare kinds", () => {
    expect(galleryCategoryOf("social", null)).toBe("social");
    expect(galleryCategoryOf("community", "forum")).toBe("social");
    expect(galleryCategoryOf("notification", "activity")).toBe("notifications");
    expect(galleryCategoryOf("account_notice", "terms")).toBe("notifications");
    expect(galleryCategoryOf("survey", null)).toBe("notifications");
    expect(galleryCategoryOf("other", null)).toBe("other");
    expect(galleryCategoryOf("lifecycle", "trial_ending")).toBe("other");
  });
});

describe("the findings' bars and limits are the engine's", () => {
  const gate = (h6: number, salience: number, imgShare: number) =>
    excellenceGate(
      [
        { id: "H6", status: "pass", s: 1, value: { ratio: h6, headline: true } },
        { id: "H3", status: "pass", s: 1, value: { present: true, salience, mostProminent: true } },
        { id: "H2", status: "pass", s: 1, value: {} },
      ],
      { primaryType: "notification", imgShare, imagesUnknownShare: 0 },
    ).misses;

  it("headline, button and imagery bars", () => {
    expect(gate(HEADLINE_RATIO_MIN, CTA_SALIENCE_MIN, IMAGERY_SHARE_MIN)).toEqual([]);
    expect(gate(HEADLINE_RATIO_MIN - 0.01, CTA_SALIENCE_MIN, IMAGERY_SHARE_MIN)).toEqual([
      "headline",
    ]);
    expect(gate(HEADLINE_RATIO_MIN, CTA_SALIENCE_MIN - 0.01, IMAGERY_SHARE_MIN)).toEqual([
      "button",
    ]);
    expect(gate(HEADLINE_RATIO_MIN, CTA_SALIENCE_MIN, IMAGERY_SHARE_MIN - 0.001)).toEqual([
      "imagery",
    ]);
    expect(PHONE_PROBLEM_SHARE).toBe(ENGINE_PHONE_SHARE);
  });

  it("Gmail's clipping limit", () => {
    expect(GMAIL_CLIP_KB * 1000).toBe(CLIP_BYTES);
  });
});
