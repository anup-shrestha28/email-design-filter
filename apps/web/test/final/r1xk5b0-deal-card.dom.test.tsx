/**
 * The deal card's end-date note (R1-11): "No end date was found, so we assume it ends 14 days after
 * the email arrived" belongs only to undated deals (core's UNDATED_CONFIDENCE = 0.2). A deal whose end
 * came from a phrase like "last chance" (confidence 0.4, receipt + 24h) is still marked "about", but
 * must not claim a 14-day fallback that contradicts the date shown beside it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DealCard } from "@/components/email/deal-card";
import type { DealView } from "@/server/queries/types";
import { cleanup, render } from "../support/render";

const NOW = Date.parse("2026-09-01T10:00:00Z");
const FOURTEEN_DAY_NOTE =
  /No end date was found, so we assume it ends 14 days after the email arrived/;

const deal = (over: Partial<DealView>): DealView => ({
  id: "d1",
  kind: "percent_off",
  value: 20,
  currency: null,
  isUpTo: false,
  minSpend: null,
  code: null,
  endsAt: "2026-09-02T10:00:00.000Z",
  endsAtConfidence: 0.9,
  ...over,
});

async function cardText(d: DealView): Promise<string> {
  const r = await render(<DealCard deals={[d]} />, { now: NOW });
  return r.container.textContent ?? "";
}

afterEach(cleanup);

describe("DealCard end-date note", () => {
  it("a phrase-based end date (confidence 0.4) is 'about' the date, with no 14-day note", async () => {
    const text = await cardText(
      deal({ endsAt: "2026-09-02T10:00:00.000Z", endsAtConfidence: 0.4 }),
    );
    expect(text).toContain("about ");
    expect(text).not.toMatch(FOURTEEN_DAY_NOTE);
  });

  it("an undated deal (confidence 0.2) shows the 14-day note", async () => {
    const text = await cardText(
      deal({ endsAt: "2026-09-15T10:00:00.000Z", endsAtConfidence: 0.2 }),
    );
    expect(text).toContain("about ");
    expect(text).toMatch(FOURTEEN_DAY_NOTE);
  });

  it("the undated confidence still matches after a round trip through a float4 (real) column", async () => {
    const text = await cardText(
      deal({ endsAt: "2026-09-15T10:00:00.000Z", endsAtConfidence: Math.fround(0.2) }),
    );
    expect(text).toMatch(FOURTEEN_DAY_NOTE);
  });

  it("a confident end date shows neither 'about' nor the note", async () => {
    const text = await cardText(deal({ endsAtConfidence: 0.8 }));
    expect(text).not.toContain("about ");
    expect(text).not.toMatch(FOURTEEN_DAY_NOTE);
  });
});
