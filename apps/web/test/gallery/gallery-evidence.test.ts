/**
 * "How we judged this" (lib/gallery-evidence.ts checklistEvidence): from the saved design checklist
 * alone, always agreeing with the badge (lib/gallery.ts verdictOf):
 *  - one sentence with the count that decided the verdict and what each verdict needs;
 *  - all 16 rules in the cheat sheet's order, each with its mark and measured sentence;
 *  - what the rules can't measure (brand fonts and colours, whether pictures support the message);
 *  - nothing for a design without a checklist of the current version.
 */
import { describe, expect, it } from "vitest";
import { CHECKLIST_RULES, CHECKLIST_VERSION } from "@edf/design/checklist";
import { verdictOf } from "@/lib/gallery";
import { BRAND_NOTE, checklistEvidence, PICTURES_NOTE } from "@/lib/gallery-evidence";
import { checklistOf } from "../support/checklist";

describe("checklistEvidence", () => {
  it("Good: every rule passed, or every rule that applies", () => {
    const all = checklistEvidence(checklistOf())!;
    expect(all.verdict).toBe("good");
    expect(all.sentence).toBe("Good: passes all 16 rules.");
    expect(all.rows.map((r) => r.id)).toEqual(CHECKLIST_RULES.map((r) => r.id));
    expect(all.rows.every((r) => r.state === "pass")).toBe(true);
    expect(all.notes).toEqual([BRAND_NOTE, PICTURES_NOTE]);
    const noPictures = checklistEvidence(checklistOf({ images: "na", scan: "na" }))!;
    expect(noPictures.verdict).toBe("good");
    expect(noPictures.sentence).toBe("Good: passes all 14 rules that apply to it.");
  });

  it("Okay: one or two missed, or none missed with one unchecked", () => {
    const one = checklistEvidence(checklistOf({ width: "miss" }))!;
    expect(one.verdict).toBe("ok");
    expect(one.sentence).toBe("Okay: misses 1 rule (Good needs none missed; 3 or more is Bad).");
    const two = checklistEvidence(checklistOf({ width: "miss", fonts: "miss", body: "unknown" }))!;
    expect(two.sentence).toBe("Okay: misses 2 rules (Good needs none missed; 3 or more is Bad).");
    const unchecked = checklistEvidence(checklistOf({ contrast: "unknown", body: "unknown" }))!;
    expect(unchecked.verdict).toBe("ok");
    expect(unchecked.sentence).toBe(
      "Okay: passes every rule we could check, but 2 couldn't be checked (Good needs every rule checked and passed).",
    );
    expect(unchecked.rows.find((r) => r.id === "contrast")?.state).toBe("unknown");
  });

  it("Bad: three or more missed, each with what was measured", () => {
    const ev = checklistEvidence(
      checklistOf(
        { button: "miss", cta: "miss", contrast: "miss", width: "miss", images: "na" },
        { contrast: "40% of the text is too faint against its background (your rule: 4.5:1)." },
      ),
    )!;
    expect(ev.verdict).toBe("bad");
    expect(ev.sentence).toBe("Bad: misses 4 of the 16 rules (3 or more is Bad).");
    expect(ev.misses).toBe(4);
    expect(ev.rows.find((r) => r.id === "contrast")).toEqual({
      id: "contrast",
      label: "Good contrast",
      state: "fail",
      value: "40% of the text is too faint against its background (your rule: 4.5:1).",
    });
    expect(ev.rows.find((r) => r.id === "images")?.state).toBe("neutral");
  });

  it("always agrees with the badge, and says nothing without a current checklist", () => {
    for (const c of [
      checklistOf(),
      checklistOf({ hero: "miss" }),
      checklistOf({ hero: "miss", body: "miss", scan: "miss" }),
      checklistOf({ fonts: "unknown" }),
    ])
      expect(checklistEvidence(c)!.verdict).toBe(verdictOf({ checklist: c }));
    expect(checklistEvidence(null)).toBeNull();
    expect(checklistEvidence({ ...checklistOf(), v: "designmodo-2026.10" })).toBeNull();
    expect(checklistEvidence({ v: CHECKLIST_VERSION, rules: [], misses: "3", unknown: 0 })).toBeNull();
  });

  it("a rule missing from stored data shows as couldn't be checked, a blank sentence gets words", () => {
    const c = checklistOf({ hero: "miss" });
    const stored = {
      ...c,
      rules: c.rules.filter((r) => r.id !== "fonts").map((r) => (r.id === "hero" ? { ...r, why: " " } : r)),
    };
    const ev = checklistEvidence(stored)!;
    expect(ev.rows).toHaveLength(16);
    expect(ev.rows.find((r) => r.id === "fonts")).toMatchObject({ state: "unknown" });
    expect(ev.rows.find((r) => r.id === "hero")).toMatchObject({ state: "fail", value: "Missed." });
  });
});
