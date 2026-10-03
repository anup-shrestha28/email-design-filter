/**
 * The public "How we judge designs" page states the rules the gallery ships, with the numbers the
 * code uses: one Bad line per Problems option (lib/gallery.ts GALLERY_PROBLEMS), every Good bar
 * of the engine's Excellent gate (@edf/design scoring/excellence.ts) at the engine's own limits.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HowWeScorePage from "@/app/(site)/how-we-score/page";
import {
  GALLERY_PROBLEM_LABELS,
  GALLERY_PROBLEMS,
  GMAIL_CLIP_KB,
  GOOD_SCORE_MIN,
  IMAGE_TEXT_CHARS_MAX,
  POOR_SCORE_MAX,
  SHRINK_K_MAX,
  TINY_PHONE_TEXT_PX,
  VERDICT_LABELS,
} from "@/lib/gallery";
import * as ENGINE from "../../../../packages/design/src/scoring/excellence";
import { CONTRAST_CAP_SHARE } from "../../../../packages/design/src/scoring/weights";

function page(): Document {
  return new DOMParser().parseFromString(renderToString(<HowWeScorePage />), "text/html");
}

/** The list right after the verdict's own heading. */
function listAfter(doc: Document, heading: string): HTMLUListElement {
  const h = [...doc.querySelectorAll("h3")].find((x) => x.textContent === heading);
  expect(h, heading).toBeTruthy();
  let el = h!.nextElementSibling;
  while (el && el.tagName !== "UL") el = el.nextElementSibling;
  return el as HTMLUListElement;
}

const text = (el: Element) => el.textContent!.replace(/\s+/g, " ");

describe("How we judge designs: the shipped rules", () => {
  it("one Bad line per Problems option, each with the gallery's own numbers", () => {
    const doc = page();
    const items = [...listAfter(doc, VERDICT_LABELS.bad).children].map(text);
    // Every option once, no other line (in the "How we judged this" panel's order, most common first).
    expect(items.map((t) => t.split(" — ")[0]).sort()).toEqual(
      GALLERY_PROBLEMS.map((p) => GALLERY_PROBLEM_LABELS[p]).sort(),
    );
    const of = (p: (typeof GALLERY_PROBLEMS)[number]) =>
      items.find((t) => t.startsWith(`${GALLERY_PROBLEM_LABELS[p]} — `))!;
    expect(of("clipped")).toContain(`over ${GMAIL_CLIP_KB} KB`);
    expect(of("image_only")).toContain(`fewer than ${IMAGE_TEXT_CHARS_MAX} characters`);
    expect(of("image_only")).toContain("at least 50%");
    expect(of("image_only")).toMatch(/didn't load for us don't count against the sender/);
    expect(of("mobile")).toContain(`below ${Math.round(SHRINK_K_MAX * 100)}%`);
    expect(of("mobile")).toContain(`smaller than ${TINY_PHONE_TEXT_PX} px`);
    expect(of("no_unsubscribe")).toMatch(/Only promotional emails/);
    expect(of("contrast")).toContain(`more than ${Math.round(CONTRAST_CAP_SHARE * 100)}%`);
    expect(of("low_score")).toContain(`under ${POOR_SCORE_MAX}`);
  });

  it("Good: the score, no Bad problem, a real render and every bar of the engine's gate", () => {
    const doc = page();
    const good = text(listAfter(doc, VERDICT_LABELS.good));
    expect(good).toContain(`It scores ${GOOD_SCORE_MIN} or more`);
    expect(good).toContain("none of the Bad problems");
    expect(good).toContain("real render");
    expect(good).toContain(`at least ${ENGINE.HEADLINE_RATIO_MIN}× the size of the body text`);
    expect(good).toContain(
      `If ${ENGINE.COMPETING_BUTTONS_MIN} or more buttons look the same and lead to ${ENGINE.COMPETING_BUTTONS_MIN} or more different places`,
    );
    expect(good).toContain("first phone screen");
    expect(good).toContain(`at least ${Math.round(ENGINE.IMAGERY_SHARE_MIN * 100)}% of the email`);
    expect(good).toContain(
      `at least ${ENGINE.HERO_PICTURE_WIDTH_MIN} px wide and ${ENGINE.HERO_PICTURE_AREA_MIN.toLocaleString("en-US")} px²`,
    );
    expect(good).toContain(`${ENGINE.HERO_BAND_CONTRAST_MIN}:1 against white`);
    expect(good).toContain(
      `less than ${Math.round(ENGINE.PHONE_PROBLEM_SHARE * 100)}% of the text`,
    );
    // The bars are named in the engine's order: headline, button, pictures, designed top, phone.
    const bars = [...doc.querySelectorAll("li li strong")].map((s) => s.textContent);
    expect(bars).toEqual([
      "A real headline",
      "A main button that stands out",
      "Pictures",
      "A designed top",
      "Room on a phone",
    ]);
  });

  it("Okay says why it isn't Good, and the hold is the engine's", () => {
    const doc = page();
    const okay = text(listAfter(doc, VERDICT_LABELS.ok));
    expect(okay).toContain("misses one of the Good bars");
    expect(okay).toContain(`holds the score at ${ENGINE.EXCELLENCE_CEILING} or below`);
    expect(okay).toContain(`(${POOR_SCORE_MAX}–${GOOD_SCORE_MIN - 1})`);
    expect(text(doc.body)).toContain(`shown as “held at ${ENGINE.EXCELLENCE_CEILING}”`);
  });
});
