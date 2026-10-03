/**
 * The Design panel's "Information only — not scored" facts (R1-36) are labelled in plain English,
 * keyed on the field names scoreEmail's info() actually reports (htmlKb, linkCount, imageCount,
 * words, imageToTextRatio, readingTimeSec, colourfulness, renderedAtK), never the raw camelCase key
 * split into words ("html Kb", "rendered At K 0.6").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreEmail, type ScoreResult } from "@edf/design";
import { DesignPanel } from "@/components/design/design-panel";
import type { EmailDetail } from "@/server/queries/types";
import { baseCtx, baseFeatures } from "../../../../packages/design/test/helpers/factory";
import { cleanup, render } from "../support/render";

vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => null,
}));
vi.mock("@/server/inngest/client", () => ({ inngest: { send: async () => ({ ids: ["evt"] }) } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions: EmailDetail["actions"] = {
  canAnalyze: true,
  canRunAiReview: true,
  analyzeRemainingToday: 5,
  aiReviewRemainingToday: 5,
  renderQueued: false,
  reason: null,
  rendersPaused: null,
};

function design(result: ScoreResult): EmailDetail["design"] {
  return {
    snapshot: {
      status: "done",
      source: "render",
      aiState: "done",
      score: result.score,
      band: result.band,
      provisional: result.provisional,
      capped: result.capped,
      issues: [],
      confidence: result.confidenceBand,
    } as EmailDetail["design"]["snapshot"],
    result,
    summary: null,
    renderRef: null,
    analyzedAt: "2026-09-26T12:00:00.000Z",
    layout: null,
  };
}

/** The rendered facts as [label, value] pairs. */
async function facts(result: ScoreResult): Promise<Array<[string, string]>> {
  const r = await render(<DesignPanel emailId="e1" design={design(result)} actions={actions} />);
  const section = [...r.container.querySelectorAll("section")].find(
    (n) => n.querySelector("h3")?.textContent === "Information only — not scored",
  );
  expect(section).toBeDefined();
  const infoDl = section!.querySelector("dl")!;
  return [...infoDl.querySelectorAll(":scope > div")].map((d) => [
    d.querySelector("dt")!.textContent ?? "",
    d.querySelector("dd")!.textContent ?? "",
  ]);
}

afterEach(cleanup);

describe("Design panel information-only facts", () => {
  it("labels every fact the scorer reports in plain English, with units", async () => {
    const result = scoreEmail(baseFeatures(), baseCtx());
    expect(Object.keys(result.info).sort()).toEqual(
      [
        "colourfulness",
        "htmlKb",
        "imageCount",
        "imageToTextRatio",
        "linkCount",
        "readingTimeSec",
        "renderedAtK",
        "words",
      ].sort(),
    );
    const shown = Object.fromEntries(await facts(result));
    expect(Object.keys(shown).sort()).toEqual(
      [
        "Colourfulness",
        "HTML size",
        "Image area vs text",
        "Images",
        "Links",
        "Reading time",
        "Size on phones",
        "Words",
      ].sort(),
    );
    expect(shown["HTML size"]).toBe(`${result.info.htmlKb} KB`);
    expect(shown["Links"]).toBe(String(result.info.linkCount));
    expect(shown["Reading time"]).toBe("about 1 min"); // the factory's 78 seconds
    expect(shown["Image area vs text"]).toBe(`${result.info.imageToTextRatio} : 1`);
    expect(shown["Size on phones"]).toBe("Full size"); // k = 1
  });

  it("says how far a fixed-width layout shrinks on phones, not the raw scale factor", async () => {
    const result = scoreEmail(baseFeatures({ render: { layout: { k: 0.62 } } }), baseCtx());
    const shown = Object.fromEntries(await facts(result));
    expect(shown["Size on phones"]).toBe("Shrunk to 62%");
    const labels = Object.keys(shown).join(" | ");
    expect(labels).not.toMatch(
      /rendered At K|html Kb|reading Time Sec|image To Text Ratio|link Count/,
    );
  });

  it("an unknown fact still reads as a sentence-case label", async () => {
    const result = scoreEmail(baseFeatures(), baseCtx());
    const shown = Object.fromEntries(await facts({ ...result, info: { brandDrift: 3 } }));
    expect(shown).toEqual({ "Brand drift": "3" });
  });
});
