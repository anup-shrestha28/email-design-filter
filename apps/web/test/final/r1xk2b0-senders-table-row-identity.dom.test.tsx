/**
 * The senders table keeps each sender's row controls (importance stepper, mute button) bound to that
 * sender when the list changes under it — a search swapping the rows, or a server refresh with new
 * values. Rows were keyed by array index, so after a search the controls of the sender formerly at that
 * position showed their bias/mute state on another sender, and a click saved a value computed from it.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SenderRow } from "@/server/queries/types";
import { click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({
  search: vi.fn(),
  setBias: vi.fn(),
  setMuted: vi.fn(),
}));

vi.mock("@/app/(app)/senders/actions", () => ({ searchSenders: h.search }));
vi.mock("@/server/actions/sender", () => ({
  setImportanceBias: h.setBias,
  setSenderMuted: h.setMuted,
  openUnsubscribe: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const { SendersTable } = await import("@/components/senders/senders-table");

function sender(over: Partial<SenderRow> & Pick<SenderRow, "id" | "displayName">): SenderRow {
  return {
    address: `news@${over.id}.example`,
    domain: `${over.id}.example`,
    emailCount: 1,
    unreadCount: 0,
    emailsPerWeek: null,
    frequencyBand: null,
    readRate60d: null,
    avgDesignScore: null,
    oneClickUnsubscribe: null,
    hasUnsubscribe: false,
    trustState: null,
    primaryType: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    isNew: false,
    muted: false,
    importanceBias: 0,
    unsubscribedAt: null,
    stillSending: false,
    topFonts: [],
    ...over,
  } as SenderRow;
}

const acme = sender({ id: "acme", displayName: "Acme", emailCount: 100, importanceBias: 2, muted: true });
const zeta = sender({ id: "zeta", displayName: "Zeta", emailCount: 10, importanceBias: 0, muted: false });

function rowOf(container: HTMLElement, name: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll("tbody tr")].find((tr) =>
    tr.querySelector(`a[href="/senders/${name}"]`),
  );
  if (!row) throw new Error(`no row for ${name}`);
  return row as HTMLTableRowElement;
}

function stepperOf(row: HTMLElement): HTMLElement {
  const g = row.querySelector<HTMLElement>('[role="group"][aria-label^="Importance"]');
  if (!g) throw new Error("no stepper");
  return g;
}

function muteOf(row: HTMLElement): HTMLButtonElement {
  const b = row.querySelector<HTMLButtonElement>("button[aria-pressed]");
  if (!b) throw new Error("no mute button");
  return b;
}

async function typeSearch(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("senders table row identity", () => {
  beforeEach(() => {
    h.search.mockReset();
    h.setBias.mockReset().mockResolvedValue({ ok: true, data: null });
    h.setMuted.mockReset().mockResolvedValue({ ok: true, data: null });
  });

  it("a search result row shows its own sender's bias and mute state, and saves from them", async () => {
    h.search.mockResolvedValue({ ok: true, data: [zeta] });
    const { container } = await render(<SendersTable initial={[acme, zeta]} filter="all" />);
    // Sorted by emails desc: Acme is row 0, Zeta row 1.
    expect(stepperOf(rowOf(container, "acme")).textContent).toContain("+2");
    const zetaRowBefore = rowOf(container, "zeta");

    await typeSearch(container, "zeta");
    await waitFor(() => {
      expect(h.search).toHaveBeenCalledWith("zeta", "all");
      expect(container.querySelector('a[href="/senders/acme"]')).toBeNull();
    });

    const zetaRow = rowOf(container, "zeta");
    // The sender's row (and its controls' state) is the same one, keyed by the sender, not its position.
    expect(zetaRow).toBe(zetaRowBefore);
    const stepper = stepperOf(zetaRow);
    expect(stepper.getAttribute("aria-label")).toBe("Importance: Default importance");
    expect(stepper.textContent).toContain("0");
    expect(stepper.textContent).not.toContain("+2");
    expect(muteOf(zetaRow).getAttribute("aria-pressed")).toBe("false");

    await click(stepper.querySelector('button[aria-label="Lower importance"]')!);
    await waitFor(() => expect(h.setBias).toHaveBeenCalledTimes(1));
    expect(h.setBias).toHaveBeenCalledWith("zeta", -1);

    await click(muteOf(zetaRow));
    await waitFor(() => expect(h.setMuted).toHaveBeenCalledTimes(1));
    expect(h.setMuted).toHaveBeenCalledWith("zeta", true);
  });

  it("controls follow a server refresh that changes the sender's saved values", async () => {
    const r = await render(<SendersTable initial={[acme, zeta]} filter="all" />);
    expect(stepperOf(rowOf(r.container, "zeta")).textContent).toContain("0");
    expect(muteOf(rowOf(r.container, "zeta")).getAttribute("aria-pressed")).toBe("false");

    // e.g. revalidatePath('/senders') after a change made elsewhere: fresh rows, same table instance.
    await r.rerender(
      <SendersTable
        initial={[acme, { ...zeta, importanceBias: -1, muted: true }]}
        filter="all"
      />,
    );
    const zetaRow = rowOf(r.container, "zeta");
    expect(stepperOf(zetaRow).getAttribute("aria-label")).toBe("Importance: Less important");
    expect(muteOf(zetaRow).getAttribute("aria-pressed")).toBe("true");

    await click(stepperOf(zetaRow).querySelector('button[aria-label="Raise importance"]')!);
    await waitFor(() => expect(h.setBias).toHaveBeenCalledTimes(1));
    expect(h.setBias).toHaveBeenCalledWith("zeta", 0);
  });
});
