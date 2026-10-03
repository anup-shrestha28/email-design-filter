/**
 * R1-10: the font picker let a 21st font (or a font name over the server's old 64-char limit) into
 * the URL; the server then rejected the filter while the chip still showed it. The rail now offers
 * only names the server accepts (every realistic stored name) and caps the selection.
 */
import { describe, expect, it, vi } from "vitest";
import type { FacetCounts, FontOption } from "@/server/queries/types";
import { MAX_FONT_NAME, MAX_FONTS } from "@/lib/filters";
import { render } from "../support/render";

interface ComboProps {
  options: { value: string }[];
  onValueChange: (v: string[]) => void;
}
const h = vi.hoisted(() => ({ setParams: vi.fn(), combo: null as ComboProps | null }));

vi.mock("@/components/ui/combobox", () => ({
  MultiCombobox: (p: ComboProps) => {
    h.combo = p;
    return null;
  },
}));
vi.mock("@/components/inbox/use-inbox-filters", async () => {
  const { DEFAULT_FILTERS } = await import("@/lib/filters");
  // webFonts on keeps the (default-closed) font group open, so its panel renders.
  return {
    useInboxFilters: () => ({
      params: { ...DEFAULT_FILTERS, webFonts: true },
      setParams: h.setParams,
      pending: false,
    }),
  };
});

const { FacetRail } = await import("@/components/inbox/facet-rail");

const counts: FacetCounts = {
  total: 0,
  types: {},
  importance: {},
  design: {},
  issues: {},
  deals: {},
  unread: 0,
  suspicious: 0,
};

describe("FacetRail font picker stays inside the server's limits", () => {
  it("hides over-long font names and ignores picks past the cap", async () => {
    const long = "y".repeat(72);
    const tooLong = "z".repeat(MAX_FONT_NAME + 1);
    const fonts: FontOption[] = [
      { key: "arial", label: "Arial", count: 3 },
      { key: long, label: long, count: 2 },
      { key: tooLong, label: tooLong, count: 1 },
    ];
    await render(<FacetRail counts={counts} fonts={fonts} />);
    expect(h.combo?.options.map((o) => o.value)).toEqual(["arial", long]);
    const picks = Array.from({ length: MAX_FONTS + 1 }, (_, i) => `font${i}`);
    h.combo?.onValueChange(picks);
    expect(h.setParams).toHaveBeenLastCalledWith({ fonts: picks.slice(0, MAX_FONTS) });
  });
});
