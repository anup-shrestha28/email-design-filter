/**
 * The public "How we judge designs" page states the rules the gallery ships: Good / Okay / Bad from
 * the 16-rule design checklist (@edf/design scoring/checklist.ts, lib/gallery.ts VERDICT POLICY),
 * every rule once in the cheat sheet's order, and the score as a separate measure whose "held at"
 * number is the engine's own.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HowWeScorePage from "@/app/(site)/how-we-score/page";
import { BAD_MISSES_MIN, CHECKLIST_RULES } from "@edf/design/checklist";
import { CHECKLIST_RULE_COUNT, VERDICT_LABELS } from "@/lib/gallery";
import * as ENGINE from "../../../../packages/design/src/scoring/excellence";

function page(): Document {
  return new DOMParser().parseFromString(renderToString(<HowWeScorePage />), "text/html");
}

const text = (el: Element) => el.textContent!.replace(/\s+/g, " ");

function section(doc: Document, id: string): string {
  const h = doc.getElementById(id);
  expect(h, id).toBeTruthy();
  const parts: string[] = [];
  for (let el = h!.nextElementSibling; el && el.tagName !== "H2"; el = el.nextElementSibling)
    parts.push(text(el));
  return parts.join(" ");
}

describe("How we judge designs: the shipped rules", () => {
  it("Good / Okay / Bad follow the checklist's own thresholds", () => {
    const verdicts = section(page(), "verdicts");
    expect(verdicts).toContain(`against the same ${CHECKLIST_RULE_COUNT} rules`);
    expect(verdicts).toContain(`${VERDICT_LABELS.good} — it passes every rule`);
    expect(verdicts).toContain("every rule that does must be checked and passed");
    expect(verdicts).toContain(`${VERDICT_LABELS.ok} — it misses one or two rules`);
    expect(verdicts).toContain(`${VERDICT_LABELS.bad} — it misses ${BAD_MISSES_MIN} or more rules`);
  });

  it("lists every rule once, in the cheat sheet's order, saying what can't be measured", () => {
    const doc = page();
    const items = [...doc.getElementById("rules")!.nextElementSibling!.children].map(text);
    expect(items.map((t) => t.split(" — ")[0])).toEqual(CHECKLIST_RULES.map((r) => r.label));
    expect(CHECKLIST_RULES).toHaveLength(CHECKLIST_RULE_COUNT);
    const of = (label: string) => items.find((t) => t.startsWith(`${label} — `))!;
    expect(of("Fonts used well")).toContain("brand's own fonts isn't something we can measure");
    expect(of("Colours used well")).toContain("brand's own colours isn't something we can measure");
    expect(of("Pictures load and are described")).toContain(
      "support the message isn't something we can measure",
    );
    expect(of("Readable body text")).toContain("at least 14px on a phone");
  });

  it("the score is a separate measure, and its hold is the engine's", () => {
    const doc = page();
    expect(section(doc, "pillars")).toContain("doesn't decide Good, Okay or Bad");
    expect(text(doc.body)).toContain(`shown as “held at ${ENGINE.EXCELLENCE_CEILING}”`);
    expect(section(doc, "not-checked")).toContain("measured again in the nightly run");
  });
});
