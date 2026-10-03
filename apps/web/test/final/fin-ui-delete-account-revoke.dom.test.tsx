/**
 * The delete-account action returns `data.revokeFailed` when Google didn't confirm removing this
 * app's access. The dialog promised the access would be revoked, so the page now says it wasn't
 * confirmed (blocking, since a toast would be lost on the redirect) and where to remove it.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, cleanup, click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({ deleteAccount: vi.fn() }));
vi.mock("@/server/actions/settings", () => ({ deleteAccount: h.deleteAccount }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/settings/reauth", () => ({ useReauth: () => ({ ask: vi.fn(), dialog: null }) }));
// The dialog's body and confirm button, without the portal and animation.
vi.mock("@/components/ui/dialog", () => ({
  ConfirmDialog: ({ onConfirm, children, confirmLabel }: { onConfirm: () => void; children: ReactNode; confirmLabel: string }) => (
    <div>
      {children}
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  ),
}));

const { DataControls } = await import("@/components/settings/data-controls");

describe("delete account: Google access not confirmed removed", () => {
  const assign = vi.fn();
  const alert = vi.fn();
  beforeEach(() => {
    assign.mockReset();
    alert.mockReset();
    vi.stubGlobal("alert", alert);
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  it("says so before leaving the page", async () => {
    h.deleteAccount.mockResolvedValue({ ok: true, data: { revokeFailed: true } });
    const r = await render(<DataControls email="a@b.c" />);
    await click(buttonByText(r.container, "Delete everything"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0]![0])).toMatch(/didn't confirm.*myaccount\.google\.com\/permissions/);
  });

  it("stays quiet when Google confirmed", async () => {
    h.deleteAccount.mockResolvedValue({ ok: true });
    const r = await render(<DataControls email="a@b.c" />);
    await click(buttonByText(r.container, "Delete everything"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(alert).not.toHaveBeenCalled();
  });
});
