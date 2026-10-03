/**
 * Score and band badges (DESIGN.md §9; DESIGN-SCORE.md §7): the band is always said in words (never
 * colour alone), provisional scores are marked and never shown with a band's colour, a capped
 * score says so, and emails without a score say why instead of showing a number.
 */
import { DESIGN_BANDS, type DesignBand } from "@edf/design/types";
import { describe, expect, it } from "vitest";
import { BandPill, BAND_STYLES } from "@/components/ui/band-pill";
import { ScoreBadge, SnapshotScore } from "@/components/ui/score-badge";
import { BAND_LABELS } from "@/lib/labels";
import type { DesignSnapshot } from "@/server/queries/types";
import { render } from "../support/render";

async function badge(ui: React.ReactNode): Promise<HTMLElement> {
  const r = await render(ui);
  const el = r.container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("nothing rendered");
  return el;
}

const snapshot = (over: Partial<DesignSnapshot>): DesignSnapshot => ({
  status: "done",
  source: "render",
  aiState: "done",
  score: 82,
  band: "good",
  provisional: false,
  capped: false,
  issues: [],
  confidence: "high",
  ...over,
});

describe("ScoreBadge", () => {
  it.each(DESIGN_BANDS.map((b) => [b]))("a %s score: the number, the band in its label, the band's colours", async (band: DesignBand) => {
    const el = await badge(<ScoreBadge score={71} band={band} />);
    expect(el.textContent).toBe("71");
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe(`Design score 71, ${BAND_LABELS[band]}`);
    expect(el.getAttribute("title")).toBe(el.getAttribute("aria-label"));
    expect(el.classList).toContain(BAND_STYLES[band].soft);
    expect(el.classList).toContain(BAND_STYLES[band].ink);
  });

  it("provisional: says so, dashed, and never wears the band's colour", async () => {
    const el = await badge(<ScoreBadge score={69} band="good" provisional />);
    expect(el.getAttribute("aria-label")).toBe("Design score 69, Solid, provisional");
    expect(el.className).toMatch(/border-dashed/);
    for (const s of Object.values(BAND_STYLES)) expect(el.classList).not.toContain(s.soft);
  });

  it("capped: the label says capped and a marker is drawn (decorative, hidden from AT)", async () => {
    const el = await badge(<ScoreBadge score={59} band="needs_work" capped />);
    expect(el.getAttribute("aria-label")).toBe("Design score 59, Needs work, capped");
    const svg = el.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(el.textContent).toBe("59");
  });

  it("a score of 0 is still a score (not 'Not analysed')", async () => {
    const el = await badge(<ScoreBadge score={0} band="poor" />);
    expect(el.textContent).toBe("0");
    expect(el.getAttribute("aria-label")).toBe("Design score 0, Poor");
  });

  it("a score without a band is shown neutral, with no band in its label", async () => {
    const el = await badge(<ScoreBadge score={64} band={null} />);
    expect(el.getAttribute("aria-label")).toBe("Design score 64");
    expect(el.className).toMatch(/border-dashed/);
  });

  it("no score: says why in words and never shows a number", async () => {
    const cases = [
      { status: "skipped" as const, title: /Security emails are never rendered or scored/ },
      { status: "plain_text" as const, title: /Plain-text email: no design to score/ },
      { status: "pending" as const, title: /Design not analysed yet/ },
      { status: "failed" as const, title: /Design not analysed yet/ },
    ];
    for (const c of cases) {
      const el = await badge(<ScoreBadge score={null} band={null} status={c.status} />);
      expect(el.getAttribute("title")).toMatch(c.title);
      expect(el.textContent).not.toMatch(/\d/);
      expect(el.getAttribute("role")).toBeNull();
    }
  });

  it("a security email's chip never shows a score, even if one were stored", async () => {
    const el = await badge(<SnapshotScore design={snapshot({ status: "skipped", score: 90, band: "excellent" })} />);
    expect(el.textContent).not.toMatch(/\d/);
    expect(el.getAttribute("title")).toMatch(/Security emails/);
  });

  it("SnapshotScore passes the snapshot through (provisional + capped)", async () => {
    const el = await badge(<SnapshotScore design={snapshot({ score: 58, band: "needs_work", provisional: true, capped: true })} />);
    expect(el.getAttribute("aria-label")).toBe("Design score 58, Needs work, provisional, capped");
  });
});

describe("BandPill", () => {
  it.each(DESIGN_BANDS.map((b) => [b]))("%s: the band in words, colour dot decorative", async (band: DesignBand) => {
    const el = await badge(<BandPill band={band} />);
    expect(el.textContent).toBe(BAND_LABELS[band]);
    expect(el.querySelector("[aria-hidden]")).not.toBeNull();
    expect(el.classList).toContain(BAND_STYLES[band].soft);
  });

  it("provisional reads 'Provisional' and drops the band's colour; no band reads 'Not analysed'", async () => {
    const p = await badge(<BandPill band="excellent" provisional />);
    expect(p.textContent).toBe("Provisional");
    for (const s of Object.values(BAND_STYLES)) expect(p.classList).not.toContain(s.soft);
    const n = await badge(<BandPill band={null} />);
    expect(n.textContent).toBe("Not analysed");
  });
});
