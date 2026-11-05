/**
 * "How we judged this" in the DOM (components/gallery/verdict-evidence.tsx), fed by the Server
 * Action (mocked, with evidence built from saved checklists by lib/gallery-evidence.ts):
 *  - the verdict sentence always shows; the 16 rules start open, and the toggle is a real button
 *    with aria-expanded / aria-controls
 *  - every rule shows its mark (with words for screen readers) and what was measured
 *  - the detail view has no separate problem lists: the rules are the reason
 *  - loading, a failed request (with Try again) and a design checked again in between
 *  - the Phone preview shrinks any layout wider than the phone to fit, like phone mail apps
 */
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneCaption, VerdictPanel } from "@/components/gallery/gallery-detail";
import { phoneFit, previewFrameOf } from "@/lib/gallery-preview";
import {
  useChecksOpen,
  useVerdictEvidence,
  VerdictEvidence,
} from "@/components/gallery/verdict-evidence";
import { checklistEvidence } from "@/lib/gallery-evidence";
import type { GalleryItem } from "@/server/queries/types";
import { checklistOf } from "../support/checklist";
import { buttonByText, cleanup, click, render, waitFor } from "../support/render";

const action = vi.hoisted(() => ({ galleryEvidence: vi.fn() }));
vi.mock("@/server/actions/gallery-evidence", () => action);
vi.mock("@/server/actions/gallery", () => ({ galleryPreviewUrls: vi.fn(async () => ({})) }));

const GOOD = checklistOf();
const BAD = checklistOf(
  { button: "miss", cta: "miss", body: "miss", images: "na" },
  {
    button: "There's no button, only text links.",
    body: "Body text is 12.5px on phones (your rule: 14–16px).",
  },
);
const OKAY = checklistOf({ contrast: "unknown" }, { contrast: "The text is inside the pictures, so we can't measure it." });

const item = (over: Partial<GalleryItem> = {}): GalleryItem => ({
  id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  sender: { name: "Tidewell", domain: "tidewell.com" },
  subject: "Rain shells, 25% off this weekend",
  receivedAt: "2026-09-28T09:15:00Z",
  category: "promotions",
  score: 91,
  band: "excellent",
  verdict: "good",
  reason: null,
  problems: [],
  strengths: [],
  fonts: [],
  previewable: false,
  frame: null,
  ...over,
});

function Panel({ it }: { it: GalleryItem }) {
  const query = useVerdictEvidence(it);
  const [open, setOpen] = useChecksOpen(it);
  return <VerdictEvidence key={it.id} item={it} query={query} open={open} onOpenChange={setOpen} />;
}

const respond = (checklist: unknown) =>
  action.galleryEvidence.mockResolvedValue({ ok: true, data: checklistEvidence(checklist) });

beforeEach(() => action.galleryEvidence.mockReset());
afterEach(cleanup);

const toggle = (root: HTMLElement) => buttonByText(root, /the 16 rules$/);
const visible = (el: Element | null) => !!el && !el.closest("[hidden]");
const ready = async (root: HTMLElement) =>
  waitFor(() => expect(root.querySelector('[data-evidence="ready"]')).not.toBeNull());

describe("How we judged this", () => {
  it("Bad: the sentence with the count, every rule open with its mark and measurement", async () => {
    respond(BAD);
    const r = await render(<Panel it={item({ verdict: "bad" })} />);
    await ready(r.container);
    expect(action.galleryEvidence).toHaveBeenCalledWith("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    expect(r.container.textContent).toContain("Bad: misses 3 of the 16 rules (3 or more is Bad).");
    const button = toggle(r.container);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
    expect(r.container.querySelectorAll("[data-check]")).toHaveLength(16);
    const missed = r.container.querySelector('[data-check="button"]')!;
    expect(visible(missed)).toBe(true);
    expect(missed.getAttribute("data-state")).toBe("fail");
    expect(missed.querySelector(".sr-only")?.textContent).toBe("Missed: ");
    expect(missed.textContent).toContain("One main button");
    expect(missed.textContent).toContain("There's no button, only text links.");
    expect(r.container.querySelector('[data-check="hero"] .sr-only')?.textContent).toBe("Passed: ");
    expect(r.container.querySelector('[data-check="images"] .sr-only')?.textContent).toBe(
      "Doesn't apply: ",
    );
    // What the rules can't measure is said.
    expect(r.container.textContent).toContain("Whether they match the brand's own isn't something we can measure.");
    // The section is named by its heading.
    const section = r.container.querySelector("section")!;
    expect(document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "How we judged this",
    );
    // Folds and unfolds.
    await click(button);
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(r.container).textContent).toContain("Show the 16 rules");
    await click(toggle(r.container));
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("true");
  });

  it("Okay with a rule we couldn't check: says so, and marks it", async () => {
    respond(OKAY);
    const r = await render(<Panel it={item({ verdict: "ok" })} />);
    await ready(r.container);
    expect(r.container.textContent).toContain(
      "Okay: passes every rule we could check, but 1 couldn't be checked (Good needs every rule checked and passed).",
    );
    const unknown = r.container.querySelector('[data-check="contrast"]')!;
    expect(unknown.getAttribute("data-state")).toBe("unknown");
    expect(unknown.querySelector(".sr-only")?.textContent).toBe("Couldn't be checked: ");
    expect(unknown.textContent).toContain("inside the pictures");
  });

  it("the detail view shows the rules instead of separate problem lists", async () => {
    respond(BAD);
    const r = await render(
      <NuqsTestingAdapter>
        <VerdictPanel
          item={item({ verdict: "bad", problems: ["There's no button, only text links."] })}
          similar={[]}
          onOpenSimilar={() => {}}
        />
      </NuqsTestingAdapter>,
    );
    await ready(r.container);
    const headings = [...r.container.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toContain("How we judged this");
    expect(headings).not.toContain("What's wrong");
    expect(headings).not.toContain("What works");
    // The next design (← / →) starts open too.
    await click(toggle(r.container));
    await r.rerender(
      <NuqsTestingAdapter>
        <VerdictPanel
          item={item({ id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d", verdict: "bad" })}
          similar={[]}
          onOpenSimilar={() => {}}
        />
      </NuqsTestingAdapter>,
    );
    await ready(r.container);
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("true");
  });

  it("loading, a failed request and a design checked again in between", async () => {
    let resolve!: (v: unknown) => void;
    action.galleryEvidence.mockReturnValue(new Promise((r) => (resolve = r)));
    const r = await render(<Panel it={item()} />);
    expect(r.container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading how we judged this",
    );
    resolve({ ok: false, error: "Something went wrong. Please try again." });
    await waitFor(() =>
      expect(r.container.textContent).toContain("We couldn't load the rules just now."),
    );
    respond(GOOD);
    await click(buttonByText(r.container, "Try again"));
    await waitFor(() => expect(r.container.textContent).toContain("Good: passes all 16 rules."));
    await cleanup();

    // The card says Okay, the saved checklist now says Bad: never show a sentence that argues.
    respond(BAD);
    const again = await render(
      <Panel it={item({ id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", verdict: "ok" })} />,
    );
    await waitFor(() =>
      expect(again.container.textContent).toContain("This design was just checked again."),
    );
    expect(again.container.textContent).not.toContain("Bad:");
  });
});

describe("the Phone preview fits the screen", () => {
  it("shrinks any layout wider than the phone to fit, however wide", () => {
    // The saved layout's phone width, as the detail view reads it (a phone-width layout fits).
    const fitOf = (mobileContentWidth: number | undefined) =>
      phoneFit(previewFrameOf({ desktopHeight: 1200, mobileHeight: 2000, mobileContentWidth }));
    expect(fitOf(undefined)).toEqual({ layoutWidth: 375, scale: 1 });
    expect(fitOf(375)).toEqual({ layoutWidth: 375, scale: 1 });
    expect(fitOf(672)).toEqual({ layoutWidth: 672, scale: 375 / 672 });
    // Wider than twice the phone: still shrunk to fit, never scrolling off the screen.
    expect(fitOf(900)).toEqual({ layoutWidth: 900, scale: 375 / 900 });
    expect(phoneCaption({ scale: 375 / 390 })).toBe(
      "Shown at 96%: a little wider than a phone screen",
    );
    expect(phoneCaption({ scale: 375 / 672 })).toBe(
      "Not built for phones: shown shrunk to 56%, as phone mail apps do",
    );
    expect(phoneCaption({ scale: 375 / 900 })).toBe(
      "Far too wide for phones: shown shrunk to 42%, as phone mail apps do, so it's hard to read",
    );
  });
});
