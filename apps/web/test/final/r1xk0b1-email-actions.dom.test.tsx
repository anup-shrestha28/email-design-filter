/**
 * EmailActions (inside EmailDetailView):
 * - R1-09: Done / Pin / type were copied from props once, on mount. Pressing e or p in the inbox list
 *   on the email being previewed refetched the preview, but its buttons still said "Mark done".
 * - R1-13: "This is personal" in the preview pane always did router.push("/inbox"), dropping the
 *   inbox filters (they live in the URL); in the pane it now hands the removal to the parent.
 * - R1-14: the full email page's tooltips advertised e / p, hotkeys only the inbox registers.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EmailDetail } from "@/server/queries/types";
import { buttonByText, click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({ markPersonal: vi.fn(async () => ({ ok: true, data: undefined })) }));

vi.mock("@/server/actions/email", () => ({
  correctType: vi.fn(),
  markPersonal: h.markPersonal,
  setDone: vi.fn(),
  setPinned: vi.fn(),
}));
vi.mock("@/server/actions/sender", () => ({ openUnsubscribe: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
// The shortcut each tooltip would show, as an attribute (the real popup only renders on hover).
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children, shortcut }: { children: ReactNode; shortcut?: string }) => (
    <span data-shortcut={shortcut ?? ""}>{children}</span>
  ),
}));
vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuGroup: Pass,
    DropdownMenuLabel: () => null,
    DropdownMenuSeparator: () => null,
    DropdownMenuSubmenu: Pass,
    DropdownMenuSubmenuTrigger: () => null,
    DropdownMenuSubmenuContent: Pass,
    DropdownMenuCheckboxItem: () => null,
    DropdownMenuRadioGroup: ({ value }: { value: string }) => <span data-type={value} />,
    DropdownMenuRadioItem: () => null,
    DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("@/components/ui/dialog", () => ({
  ConfirmDialog: ({ open, onConfirm, confirmLabel }: { open: boolean; onConfirm: () => void; confirmLabel: string }) =>
    open ? (
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
    ) : null,
  Dialog: () => null,
  DialogBody: () => null,
  DialogContent: () => null,
}));
for (const [path, name] of [
  ["@/components/design/design-panel", "DesignPanel"],
  ["@/components/design/fonts-card", "FontsCard"],
  ["@/components/email/classification-card", "ClassificationCard"],
  ["@/components/email/deal-card", "DealCard"],
  ["@/components/email/email-header", "EmailHeader"],
  ["@/components/email/email-viewer", "EmailViewer"],
  ["@/components/email/mark-opened", "MarkOpened"],
  ["@/components/email/trust-card", "TrustCard"],
] as const) {
  vi.doMock(path, () => ({ [name]: () => null }));
}

const { EmailDetailView } = await import("@/components/email/email-detail");

function detail(over: { doneAt?: string | null; pinnedAt?: string | null; type?: string } = {}): EmailDetail {
  return {
    id: "0b8f8c52-6a4e-4d1c-9a57-2f5a3c2d1e10",
    fromName: "Shop",
    fromAddress: "news@shop.test",
    senderId: "s1",
    unsubscribe: { https: null, mailto: null },
    state: { doneAt: over.doneAt ?? null, pinnedAt: over.pinnedAt ?? null, openedInAppAt: null },
    classification: { primaryType: over.type ?? "promotional", securitySensitive: false, suspicious: false },
    design: { result: null, renderRef: null, layout: null },
    viewer: null,
    deals: [],
    fonts: [],
    actions: {},
  } as unknown as EmailDetail;
}

const shortcuts = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>("[data-shortcut]")].map((el) => el.dataset.shortcut);

describe("EmailActions", () => {
  it("follows a refetched detail when the email changed elsewhere (R1-09)", async () => {
    const r = await render(<EmailDetailView detail={detail()} compact onChanged={() => {}} />);
    expect(buttonByText(r.container, "Mark done").getAttribute("aria-pressed")).toBe("false");
    expect(buttonByText(r.container, "Pin").getAttribute("aria-pressed")).toBe("false");

    // 'e' and 'p' in the inbox list, then the preview's refetch: same email, new state.
    const at = new Date().toISOString();
    await r.rerender(
      <EmailDetailView detail={detail({ doneAt: at, pinnedAt: at, type: "newsletter" })} compact onChanged={() => {}} />,
    );
    expect(buttonByText(r.container, "Done").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText(r.container, "Pinned").getAttribute("aria-pressed")).toBe("true");
    expect(r.container.querySelector<HTMLElement>("[data-type]")?.dataset.type).toBe("newsletter");

    // And back (the list's Undo).
    await r.rerender(<EmailDetailView detail={detail()} compact onChanged={() => {}} />);
    expect(buttonByText(r.container, "Mark done").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the e / p hints only in the inbox preview, where those hotkeys exist (R1-14)", async () => {
    const page = await render(<EmailDetailView detail={detail()} />);
    expect(shortcuts(page.container).filter(Boolean)).toEqual([]);
    await page.unmount();
    const pane = await render(<EmailDetailView detail={detail()} compact />);
    expect(shortcuts(pane.container).filter(Boolean)).toEqual(["e", "p"]);
  });

  it("'This is personal' in the preview hands the removal to the pane, keeping the URL (R1-13)", async () => {
    const onRemoved = vi.fn();
    const r = await render(<EmailDetailView detail={detail()} compact onRemoved={onRemoved} />);
    await click(buttonByText(r.container, /This is personal/));
    await click(buttonByText(r.container, "Delete and stop storing"));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(r.router.calls).toEqual([]);
  });

  it("the full page still goes back to the inbox after 'This is personal'", async () => {
    const r = await render(<EmailDetailView detail={detail()} />);
    await click(buttonByText(r.container, /This is personal/));
    await click(buttonByText(r.container, "Delete and stop storing"));
    await waitFor(() => expect(r.router.calls).toEqual(["push:/inbox"]));
  });
});
