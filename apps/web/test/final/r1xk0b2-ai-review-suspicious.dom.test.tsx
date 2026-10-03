/**
 * R1-15: on a suspicious (failed-DMARC) email that has a score, the re-run bar's "Run AI review" is
 * disabled (suspicious mail is never sent to AI) but said nothing about why, and its status line
 * still read "1 left today", inviting a click the button refuses. The page's data now carries the
 * reason (`actions.aiReason`) and the button shows it, as tooltip and in place of the allowance.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EmailDetail } from "@/server/queries/types";
import { buttonByText, render } from "../support/render";

vi.mock("@/server/actions/email", () => ({ requestAnalyze: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
// The tooltip's text as an attribute (the real popup only renders on hover).
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <span data-tooltip={String(content)}>{children}</span>
  ),
}));

const { RerunBar } = await import("@/components/design/analyze-button");

const REASON =
  "This email failed sender checks, so it is never sent to AI. Design analysis still works.";

const suspicious: EmailDetail["actions"] = {
  canAnalyze: true,
  canRunAiReview: false,
  analyzeRemainingToday: 1,
  aiReviewRemainingToday: 1,
  renderQueued: false,
  reason: null,
  aiReason: REASON,
  rendersPaused: null,
};

describe("Run AI review on a suspicious email", () => {
  it("is disabled with the reason, and doesn't claim an allowance is left", async () => {
    const r = await render(<RerunBar emailId="e1" actions={suspicious} hasAi={false} />);
    const ai = buttonByText(r.container, "Run AI review");
    expect(ai.disabled).toBe(true);
    const wrapper = ai.closest("[data-tooltip]");
    expect(wrapper?.getAttribute("data-tooltip")).toBe(REASON);
    // The disabled button can't take focus; its focusable wrapper carries the reason.
    expect(ai.closest("[tabindex='0']")).not.toBeNull();
    const aiColumn = ai.closest("span.inline-flex")!;
    expect(aiColumn.textContent).toContain(REASON);
    expect(aiColumn.textContent).not.toMatch(/left today/);

    // "Analyze again" still works and still shows its allowance.
    const again = buttonByText(r.container, "Analyze again");
    expect(again.disabled).toBe(false);
    expect(again.closest("[data-tooltip]")).toBeNull();
    expect(again.closest("span.inline-flex")!.textContent).toContain("1 left today");
  });

  it("an email that isn't suspicious keeps the allowance line", async () => {
    const r = await render(
      <RerunBar
        emailId="e1"
        actions={{ ...suspicious, canRunAiReview: true, aiReason: null }}
        hasAi={false}
      />,
    );
    const ai = buttonByText(r.container, "Run AI review");
    expect(ai.disabled).toBe(false);
    expect(ai.closest("span.inline-flex")!.textContent).toContain("1 left today");
  });
});
