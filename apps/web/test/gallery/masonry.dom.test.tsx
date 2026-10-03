/**
 * The masonry in the DOM (components/gallery/masonry.tsx): one list for assistive tech, every card
 * exactly once, as many columns as the screen's breakpoint, each card in the shortest column.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Masonry } from "@/components/gallery/masonry";
import { cleanup, render } from "../support/render";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const items = ["a", "b", "c", "d", "e", "f"];
const ratios = [3, 1, 1, 1, 1, 1];

async function at(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const r = await render(
    <Masonry
      items={items}
      ratios={ratios}
      getKey={(x) => x}
      label="Email designs"
      renderItem={(x) => <span data-x={x}>{x}</span>}
    />,
  );
  const list = r.container.querySelector('[role="list"]')!;
  const columns = [...list.children].map((c) =>
    c.getAttribute("role") === "listitem" ? null : [...c.querySelectorAll("[data-x]")].map((e) => e.textContent),
  );
  return { list, columns };
}

describe("Masonry", () => {
  it("lays cards into the breakpoint's columns, shortest column first", async () => {
    const wide = await at(1440);
    expect(wide.list.getAttribute("aria-label")).toBe("Email designs");
    expect(wide.list.querySelectorAll('[role="listitem"]')).toHaveLength(6);
    // 4 columns: a (tall), b, c, d on the first row; e and f under the short ones.
    expect(wide.columns).toEqual([["a"], ["b", "e"], ["c", "f"], ["d"]]);
    await cleanup();

    const phone = await at(390);
    expect(phone.columns).toEqual([["a", "b", "c", "d", "e", "f"]]);
    await cleanup();

    // 2 columns, each card's footer (and gap) counted: a = 3 widths + footer; b, c, d stack
    // beside it until that side is taller, then e goes under a, and f back to the right.
    const tablet = await at(800);
    expect(tablet.columns).toEqual([["a", "e"], ["b", "c", "d", "f"]]);
  });
});
