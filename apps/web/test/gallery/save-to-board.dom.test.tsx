/**
 * The card's Save button in the DOM (components/gallery/save-to-board.tsx): it opens your boards,
 * ticks the ones holding this design, saves / unsaves with a click, makes a new board with the
 * design already in it, and the button itself says "Saved" while the design is in any board.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { SaveToBoard } from "@/components/gallery/save-to-board";
import type { BoardChoice } from "@/server/queries/boards";
import { buttonByText, cleanup, click, render, waitFor } from "../support/render";

const actions = vi.hoisted(() => ({
  getBoardChoices: vi.fn(),
  setSaved: vi.fn(),
  createBoard: vi.fn(),
}));
vi.mock("@/server/actions/boards", () => actions);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const EMAIL = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const boards = (): BoardChoice[] => [
  { id: "b-welcome", name: "Welcome", count: 3, saved: false },
  { id: "b-sales", name: "Sales", count: 1, saved: true },
];

beforeEach(() => {
  actions.getBoardChoices.mockReset().mockResolvedValue({ ok: true, data: boards() });
  actions.setSaved.mockReset();
  actions.createBoard.mockReset();
});
afterEach(cleanup);

/** The popup (rendered in a portal, so it's under document.body). */
const popup = () => {
  const el = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error("the board list isn't open");
  return el;
};
const trigger = () =>
  document.body.querySelector<HTMLButtonElement>('button[aria-label="Save to a board"], button[aria-label="Saved — change boards"]')!;

describe("SaveToBoard", () => {
  it("lists your boards with this design's ones ticked, and saves with a click", async () => {
    await render(<SaveToBoard emailId={EMAIL} saved={false} />);
    expect(trigger().textContent).toBe("Save");
    await click(trigger());
    const list = await waitFor(() => {
      const p = popup();
      if (!p.querySelector("button[aria-pressed]")) throw new Error("not loaded");
      return p;
    });
    expect(actions.getBoardChoices).toHaveBeenCalledWith(EMAIL);
    const rows = [...list.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(rows.map((r) => [r.textContent, r.getAttribute("aria-pressed")])).toEqual([
      ["Welcome3", "false"],
      ["Sales1", "true"],
    ]);

    actions.setSaved.mockResolvedValue({ ok: true, data: { savedAnywhere: true } });
    await click(rows[0]!);
    await waitFor(() => expect(rows[0]!.getAttribute("aria-pressed")).toBe("true"));
    expect(actions.setSaved).toHaveBeenCalledWith(EMAIL, "b-welcome", true);
    expect(rows[0]!.textContent).toBe("Welcome4");
    expect(trigger().textContent).toBe("Saved");
  });

  it("unsaving from the last board turns the button back into Save", async () => {
    actions.getBoardChoices.mockResolvedValue({
      ok: true,
      data: [{ id: "b-sales", name: "Sales", count: 1, saved: true }],
    });
    await render(<SaveToBoard emailId={EMAIL} saved />);
    expect(trigger().textContent).toBe("Saved");
    await click(trigger());
    const row = await waitFor(() => popup().querySelector<HTMLButtonElement>("button[aria-pressed]")!);
    actions.setSaved.mockResolvedValue({ ok: true, data: { savedAnywhere: false } });
    await click(row);
    await waitFor(() => expect(trigger().textContent).toBe("Save"));
    expect(actions.setSaved).toHaveBeenCalledWith(EMAIL, "b-sales", false);
    expect(row.textContent).toBe("Sales0");
  });

  it("makes a new board with the design already in it", async () => {
    await render(<SaveToBoard emailId={EMAIL} saved={false} />);
    await click(trigger());
    const p = await waitFor(() => {
      const el = popup();
      if (!el.querySelector("button[aria-pressed]")) throw new Error("not loaded");
      return el;
    });
    const input = p.querySelector<HTMLInputElement>("input")!;
    const create = buttonByText(p, "Create");
    expect(create.disabled).toBe(true);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "  Great footers ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(create.disabled).toBe(false);
    actions.createBoard.mockResolvedValue({ ok: true, data: { id: "b-new", name: "Great footers" } });
    await click(create);
    await waitFor(() => expect(p.querySelectorAll("button[aria-pressed]")).toHaveLength(3));
    expect(actions.createBoard).toHaveBeenCalledWith("Great footers", EMAIL);
    const first = p.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect([first.textContent, first.getAttribute("aria-pressed")]).toEqual(["Great footers1", "true"]);
    expect(input.value).toBe("");
    expect(trigger().textContent).toBe("Saved");
  });

  it("says so when the boards can't be loaded, and can try again", async () => {
    actions.getBoardChoices.mockResolvedValueOnce({ ok: false, error: "Something went wrong." });
    await render(<SaveToBoard emailId={EMAIL} saved={false} />);
    await click(trigger());
    const retry = await waitFor(() => buttonByText(popup(), "Try again"));
    await click(retry);
    await waitFor(() => expect(popup().querySelectorAll("button[aria-pressed]")).toHaveLength(2));
  });
});
