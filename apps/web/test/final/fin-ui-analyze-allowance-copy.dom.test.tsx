/**
 * R1-43: once today's allowance is used, "Analyze" is disabled, but the copy beside it still said
 * "You can analyze it now instead" / "Analyze it to render it…" / "analyze again…", and the reason
 * was only in a hover tooltip. The copy now says when it can be clicked again, and the button shows
 * the reason where it can be read.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWANCE_USED,
  analyzeAllowanceUsed,
  notAnalysedBody,
  savedSummaryNote,
  staticOnlyBody,
} from "@/components/design/analyze-copy";
import type { EmailDetail } from "@/server/queries/types";
import { buttonByText, render } from "../support/render";

vi.mock("@/server/actions/email", () => ({ requestAnalyze: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <span data-tooltip={String(content)}>{children}</span>
  ),
}));

const { AnalyzeButton } = await import("@/components/design/analyze-button");

const usedUp: EmailDetail["actions"] = {
  canAnalyze: false,
  canRunAiReview: false,
  analyzeRemainingToday: 0,
  aiReviewRemainingToday: 0,
  renderQueued: false,
  reason: null,
  rendersPaused: null,
};
const open: EmailDetail["actions"] = { ...usedUp, canAnalyze: true, canRunAiReview: true, analyzeRemainingToday: 3, aiReviewRemainingToday: 1 };
const INVITES = /analyze it now|^.*\. Analyze it|; analyze again for the complete breakdown\.$|try again — it doesn't count/;

describe("copy once today's allowance is used", () => {
  it("is detected only when the allowance alone stops Analyze", () => {
    expect(analyzeAllowanceUsed(usedUp)).toBe(true);
    expect(analyzeAllowanceUsed(open)).toBe(false);
    expect(analyzeAllowanceUsed({ ...usedUp, rendersPaused: "Paused." })).toBe(false);
    expect(analyzeAllowanceUsed({ ...usedUp, renderQueued: true })).toBe(false);
    expect(analyzeAllowanceUsed({ ...usedUp, reason: "Security emails are never rendered." })).toBe(false);
  });

  it("no line invites a click on the disabled button, and each says when it resets", () => {
    const lines = [
      staticOnlyBody(usedUp),
      notAnalysedBody(false, null, true),
      notAnalysedBody(true, null, true),
      savedSummaryNote(null, true),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(INVITES);
      expect(line).toMatch(/midnight UTC/);
    }
  });

  it("with allowance left the copy still invites the click", () => {
    expect(staticOnlyBody(open)).toMatch(/ Analyze it to render it/);
    expect(notAnalysedBody(false, null)).toMatch(/analyze it now/);
    expect(savedSummaryNote(null)).toMatch(/; analyze again for the complete breakdown\.$/);
  });

  it("the disabled button shows the reason visibly, not just '0 left today'", async () => {
    const r = await render(<AnalyzeButton emailId="e1" actions={usedUp} />);
    const button = buttonByText(r.container, "Analyze this email");
    expect(button.disabled).toBe(true);
    const column = button.closest("span.inline-flex")!;
    expect(column.textContent).toContain(ALLOWANCE_USED);
    expect(column.textContent).not.toMatch(/left today/);
  });

  it("with allowance left the button keeps its count", async () => {
    const r = await render(<AnalyzeButton emailId="e1" actions={open} />);
    expect(buttonByText(r.container, "Analyze this email").closest("span.inline-flex")!.textContent).toContain("3 left today");
  });
});
