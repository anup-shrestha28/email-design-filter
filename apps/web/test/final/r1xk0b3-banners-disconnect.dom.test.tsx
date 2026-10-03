/**
 * R1-20 (shell): app-wide banners render — a Frozen app's banner shows even on /today with no
 * mailbox connected (only the plain "connect" nudge is left to that page), and an error that isn't
 * about a mailbox offers no misleading "Reconnect" link.
 * R1-25 (settings): a disconnect whose Google revoke failed never says "Access was revoked"; it
 * tells the user where to remove the access themselves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxInfo, SyncStatus } from "@/server/queries/types";
import { buttonByText, cleanup, click, render, waitFor } from "../support/render";

const h = vi.hoisted(() => ({
  status: null as unknown as SyncStatus,
  pathname: "/today",
  disconnect: { ok: true } as { ok: true; data?: { revokeFailed: true } },
  toasts: [] as Array<{ kind: string; title: string; description?: string }>,
}));
vi.mock("@/components/providers/sync", () => ({ useSync: () => ({ status: h.status }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), usePathname: () => h.pathname }));
vi.mock("@/server/actions/settings", () => ({ disconnectMailbox: async () => h.disconnect }));
vi.mock("sonner", () => {
  const rec = (kind: string) => (title: string, o?: { description?: string }) => {
    h.toasts.push({ kind, title, description: o?.description });
  };
  return { toast: { success: rec("success"), warning: rec("warning"), error: rec("error"), info: rec("info") } };
});

const { Banners } = await import("@/components/shell/banners");
const { MailboxCard } = await import("@/components/settings/mailbox-card");

afterEach(async () => {
  await cleanup();
  h.toasts = [];
});

const MAILBOX: MailboxInfo = {
  id: "m1",
  emailAddress: "a@b.c",
  status: "active",
  statusReason: null,
  lastSyncedAt: null,
  nextPollAt: null,
  backfill: { state: "done", windowDays: 90, listed: 0, stored: 0, queuedPosition: null },
  health: { pending: 0, stored: 0, skipped: 0, failed: 0 },
  resyncPending: false,
};

describe("app-wide banners (R1-20)", () => {
  it("a frozen app's banner shows on /today even with no mailbox, with no Connect/Reconnect link", async () => {
    h.pathname = "/today";
    h.status = {
      mailboxes: [],
      syncing: false,
      lastSyncedAt: null,
      banner: { id: "governor:3", level: "error", text: "Frozen to stay within the free limits." },
    };
    const r = await render(<Banners />);
    expect(r.container.textContent).toContain("Frozen to stay within the free limits.");
    expect(r.container.querySelector("a")).toBeNull();
    expect(r.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("the plain connect nudge still stays off /today; a reauth error keeps its Reconnect link", async () => {
    h.pathname = "/today";
    h.status = { mailboxes: [], syncing: false, lastSyncedAt: null, banner: { id: "connect", level: "info", text: "Connect your Gmail to get started." } };
    const r = await render(<Banners />);
    expect(r.container.textContent).toBe("");
    h.pathname = "/inbox";
    h.status = {
      mailboxes: [MAILBOX],
      syncing: false,
      lastSyncedAt: null,
      banner: { id: "reauth:m1", level: "error", text: "Reconnect a@b.c: Google access expired or was revoked." },
    };
    await r.rerender(<Banners />);
    expect(r.container.querySelector("a")?.textContent).toBe("Reconnect");
  });
});

describe("disconnect toast (R1-25)", () => {
  const disconnect = async () => {
    const r = await render(<MailboxCard mailbox={MAILBOX} />);
    await click(buttonByText(r.container, "Disconnect"));
    await click(await waitFor(() => buttonByText(document.body, "Disconnect and delete")));
    return waitFor(() => {
      expect(h.toasts).toHaveLength(1);
      return h.toasts[0]!;
    });
  };

  it("a failed revoke warns and points to Google's permissions page instead of claiming success", async () => {
    h.disconnect = { ok: true, data: { revokeFailed: true } };
    const t = await disconnect();
    expect(t.kind).toBe("warning");
    expect(t.description).toContain("myaccount.google.com/permissions");
    expect(t.description).not.toMatch(/Access was revoked/);
  });

  it("a confirmed revoke says so", async () => {
    h.disconnect = { ok: true };
    const t = await disconnect();
    expect(t).toMatchObject({ kind: "success", description: "Access was revoked. Its stored data is being deleted." });
  });
});
