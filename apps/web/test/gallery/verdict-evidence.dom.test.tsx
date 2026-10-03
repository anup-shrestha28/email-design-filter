/**
 * "How we judged this" in the DOM (components/gallery/verdict-evidence.tsx), fed by the Server
 * Action (mocked, with evidence built from synthetic facts by lib/gallery-evidence.ts):
 *  - the verdict sentence always shows; the checks are open for Good and Bad, folded for Okay, and
 *    the toggle is a real button with aria-expanded / aria-controls
 *  - the problem list leaves out only what is in view: the sentence's statement while the checks
 *    are folded, every failed check's once they're shown
 *  - every tick and cross has words for screen readers; unmeasured values say "Not measured"
 *  - loading, a failed request (with Try again) and a design re-scored in between
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
import { verdictEvidence, type EvidenceInput } from "@/lib/gallery-evidence";
import type { GalleryItem } from "@/server/queries/types";
import { buttonByText, cleanup, click, render, waitFor } from "../support/render";

const action = vi.hoisted(() => ({ galleryEvidence: vi.fn() }));
vi.mock("@/server/actions/gallery-evidence", () => action);
vi.mock("@/server/actions/gallery", () => ({ galleryPreviewUrls: vi.fn(async () => ({})) }));

const SIG = (over: Record<string, unknown> = {}) => ({
  imgShare: 0.3,
  legibleChars: 820,
  phoneTextPx: 16,
  layoutK: 1,
  unsubscribe: "before_clip",
  primaryType: "promotional",
  headlineRatio: 1.75,
  hasHeadline: true,
  ctaSalience: 1,
  ctaMostProminent: true,
  ctaFirstScreen: true,
  gate: [],
  htmlContentImages: 4,
  drawnContentImages: 4,
  imagesOff: false,
  imagesUnknownShare: 0,
  unsubscribeUnion: "before_clip",
  liveTextChars: 820,
  htmlKB: 41.3,
  ...over,
});
const facts = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  score: 91,
  band: "excellent",
  capped: false,
  provisional: false,
  caps: [],
  issues: [],
  source: "render",
  coverageConfidence: 0.86,
  signals: SIG(),
  primaryType: "promotional",
  raw: 91.2,
  needs: [],
  pillars: [{ id: "images", points: 7.9, max: 10.2, nominal: 10 }],
  aiReviewed: false,
  checks: null,
  imageLoads: [],
  compacted: false,
  ...over,
});
const BAD = facts({
  score: 78,
  band: "good",
  signals: SIG({ htmlKB: 136.2, unsubscribeUnion: "after_clip" }),
});
const OKAY = facts({
  score: 84,
  band: "good",
  raw: 88.4,
  needs: [{ key: "gate:excellence", title: "Plain design" }],
  signals: SIG({ headlineRatio: 1.149, gate: ["headline"] }),
});

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

const respond = (input: EvidenceInput | null) =>
  action.galleryEvidence.mockResolvedValue({
    ok: true,
    data: input ? verdictEvidence(input) : null,
  });

beforeEach(() => action.galleryEvidence.mockReset());
afterEach(cleanup);

const toggle = (root: HTMLElement) => buttonByText(root, /the checks$/);
const visible = (el: Element | null) => !!el && !el.closest("[hidden]");

describe("How we judged this", () => {
  it("Bad: the sentence with the value and the limit, the checks open, each mark worded", async () => {
    respond(BAD);
    const r = await render(<Panel it={item({ verdict: "bad", score: 78, band: "good" })} />);
    await waitFor(() =>
      expect(r.container.querySelector('[data-evidence="ready"]')).not.toBeNull(),
    );
    expect(action.galleryEvidence).toHaveBeenCalledWith("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    const text = r.container.textContent ?? "";
    expect(text).toContain(
      "Bad: Gmail cuts this email off — it's 136 KB and Gmail's limit is 102 KB, so the unsubscribe link is hidden.",
    );
    const button = toggle(r.container);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panelId = button.getAttribute("aria-controls")!;
    expect(document.getElementById(panelId)).not.toBeNull();
    const clipped = r.container.querySelector('[data-check="clipped"]')!;
    expect(visible(clipped)).toBe(true);
    expect(clipped.getAttribute("data-state")).toBe("fail");
    expect(clipped.querySelector(".sr-only")?.textContent).toBe("Failed: ");
    expect(clipped.textContent).toContain(
      "136 KB: Gmail cuts it off and hides the unsubscribe link",
    );
    expect(r.container.querySelector('[data-check="headline"] .sr-only')?.textContent).toBe(
      "Passed: ",
    );
    // The section is named by its heading.
    const section = r.container.querySelector("section")!;
    expect(document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "How we judged this",
    );
    // Folds and unfolds.
    await click(button);
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("false");
    expect(toggle(r.container).textContent).toContain("Show the checks");
    await click(toggle(r.container));
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("true");
  });

  it("Okay: the sentence shows, the checks start folded", async () => {
    respond(OKAY);
    const r = await render(<Panel it={item({ verdict: "ok", score: 84, band: "good" })} />);
    await waitFor(() =>
      expect(r.container.querySelector('[data-evidence="ready"]')).not.toBeNull(),
    );
    expect(r.container.textContent).toContain(
      "Okay: no serious problems, but not Good because the headline is barely bigger than the text (1.1×; Good needs 1.5×). That holds its score at 84 (its points add up to 88).",
    );
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("false");
    expect(visible(r.container.querySelector('[data-check="headline"]'))).toBe(false);
    await click(toggle(r.container));
    await waitFor(() =>
      expect(visible(r.container.querySelector('[data-check="headline"]'))).toBe(true),
    );
  });

  it("Okay: the problem list keeps what the folded checks say, and drops it once they're shown", async () => {
    respond(
      facts({
        score: 84,
        band: "good",
        raw: 88.4,
        needs: [{ key: "gate:excellence", title: "Plain design" }],
        signals: SIG({
          headlineRatio: 1.149,
          ctaMostProminent: false,
          ctaFirstScreen: false,
          gate: ["headline", "button"],
        }),
      }),
    );
    const problems = [
      "No real headline (the biggest text is 1.1× the body text; Good needs 1.5×)",
      "The main button “Shop now” sits below the first phone screen, and another link or picture is bigger",
      "Body text is a little small on phones (14 px)",
    ];
    const r = await render(
      <NuqsTestingAdapter>
        <VerdictPanel
          item={item({ verdict: "ok", score: 84, band: "good", problems })}
          similar={[]}
          onOpenSimilar={() => {}}
        />
      </NuqsTestingAdapter>,
    );
    await waitFor(() =>
      expect(r.container.querySelector('[data-evidence="ready"]')).not.toBeNull(),
    );
    const list = () =>
      [...r.container.querySelectorAll("section")].find(
        (s) => s.querySelector("h3")?.textContent === "What could be better",
      )?.textContent ?? "";
    // Folded: the sentence states the headline, so only that line is left out.
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("false");
    expect(list()).not.toContain("No real headline");
    expect(list()).toContain("sits below the first phone screen");
    expect(list()).toContain("Body text is a little small on phones (14 px)");
    // Shown: the button check says it with its value, so the list doesn't any more.
    await click(toggle(r.container));
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("true");
    expect(list()).not.toContain("sits below the first phone screen");
    expect(list()).toContain("Body text is a little small on phones (14 px)");
    // Folded again: back in the list.
    await click(toggle(r.container));
    expect(list()).toContain("sits below the first phone screen");
    // Unfolded, then the next design (← / →): it starts from its own default, folded for Okay.
    await click(toggle(r.container));
    await r.rerender(
      <NuqsTestingAdapter>
        <VerdictPanel
          item={item({
            id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d",
            verdict: "ok",
            score: 84,
            band: "good",
            problems,
          })}
          similar={[]}
          onOpenSimilar={() => {}}
        />
      </NuqsTestingAdapter>,
    );
    await waitFor(() =>
      expect(r.container.querySelector('[data-evidence="ready"]')).not.toBeNull(),
    );
    expect(toggle(r.container).getAttribute("aria-expanded")).toBe("false");
    expect(list()).toContain("sits below the first phone screen");
  });

  it("an unmeasured value says so; the score by area has a label for each bar", async () => {
    respond(
      facts({
        signals: {
          imgShare: 0.3,
          legibleChars: 900,
          phoneTextPx: 16,
          layoutK: 1,
          unsubscribe: "before_clip",
        },
      }),
    );
    const r = await render(<Panel it={item()} />);
    await waitFor(() =>
      expect(r.container.querySelector('[data-evidence="ready"]')).not.toBeNull(),
    );
    const headline = r.container.querySelector('[data-check="headline"]')!;
    expect(headline.getAttribute("data-state")).toBe("unknown");
    expect(headline.textContent).toContain("Not measured");
    expect(r.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Pictures: 7.9 of 10.2 points",
    );
  });

  it("loading, a failed request and a design scored again in between", async () => {
    let resolve!: (v: unknown) => void;
    action.galleryEvidence.mockReturnValue(new Promise((r) => (resolve = r)));
    const r = await render(<Panel it={item()} />);
    expect(r.container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading how we judged this",
    );
    resolve({ ok: false, error: "Something went wrong. Please try again." });
    await waitFor(() =>
      expect(r.container.textContent).toContain("We couldn't load the checks just now."),
    );
    respond(facts());
    await click(buttonByText(r.container, "Try again"));
    await waitFor(() =>
      expect(r.container.textContent).toContain("Good: it passed every check below."),
    );
    await cleanup();

    // The card says Okay, the stored analysis now says Bad: never show a sentence that argues.
    respond(BAD);
    const again = await render(
      <Panel it={item({ id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", verdict: "ok", score: 80 })} />,
    );
    await waitFor(() =>
      expect(again.container.textContent).toContain("This design was just scored again."),
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
