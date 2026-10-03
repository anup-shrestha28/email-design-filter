/**
 * The gallery's fixed wording (src/lib/gallery-copy.ts) and which banners the gallery shows:
 *  - badge words and the not-scored line; reasons are NOT rewritten client-side any more (they
 *    arrive plain and specific from lib/gallery.ts galleryReason, measured facts included)
 *  - only actionable banners (connect / reconnect / an app-wide stop) count as actionable
 */
import { describe, expect, it } from "vitest";
import { isActionableBanner } from "@/components/shell/banners";
import * as copy from "@/lib/gallery-copy";

describe("gallery wording", () => {
  it("has short badge words and a friendly not-scored line", () => {
    expect(copy.VERDICT_SHORT).toEqual({
      good: "Good",
      bad: "Bad",
      ok: "Okay",
      unscored: "Not scored yet",
    });
    // Plain and true: no "still checking" (nothing is being checked while it waits).
    expect(copy.UNSCORED_LINE).toBe("This design doesn't have a score yet.");
    expect(copy.UNSCORED_LINE).not.toMatch(/checking/i);
  });

  it("no longer exports a rewriter that would strip the measured facts from reasons", () => {
    expect(Object.keys(copy).sort()).toEqual(["UNSCORED_LINE", "VERDICT_SHORT", "waitingCopy"]);
  });
});

describe("which banners are actionable", () => {
  it("connect, reconnect and app-wide stops are; status notes are not", () => {
    expect(isActionableBanner({ id: "connect", level: "info", text: "" })).toBe(true);
    expect(isActionableBanner({ id: "reauth:m1", level: "error", text: "" })).toBe(true);
    expect(isActionableBanner({ id: "governor:3", level: "error", text: "" })).toBe(true);
    expect(isActionableBanner({ id: "inngest:paused", level: "warning", text: "" })).toBe(false);
    expect(isActionableBanner({ id: "import:m1", level: "info", text: "" })).toBe(false);
    expect(isActionableBanner({ id: "governor:1", level: "info", text: "" })).toBe(false);
  });
});
