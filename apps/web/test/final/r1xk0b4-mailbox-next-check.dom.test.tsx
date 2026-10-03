/**
 * R1-40: the mailbox card never promises a "next check" in the past. A check that is already due
 * reads "check due now"; a paused or needs-reconnecting mailbox (never polled until reconnected,
 * its next_poll_at frozen) shows no next check at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxInfo } from "@/server/queries/types";
import { cleanup, render } from "../support/render";

vi.mock("@/server/actions/settings", () => ({ disconnectMailbox: async () => ({ ok: true }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { MailboxCard } = await import("@/components/settings/mailbox-card");

afterEach(cleanup);

const DAY = 86_400_000;
const mailbox = (over: Partial<MailboxInfo>): MailboxInfo => ({
  id: "m1",
  emailAddress: "a@b.c",
  status: "active",
  statusReason: null,
  lastSyncedAt: new Date(Date.now() - 2 * DAY).toISOString(),
  nextPollAt: null,
  backfill: { state: "done", windowDays: 90, listed: 0, stored: 0, queuedPosition: null },
  health: { pending: 0, stored: 0, skipped: 0, failed: 0 },
  resyncPending: false,
  ...over,
});
const line = (c: HTMLElement) => c.querySelector("h3")?.closest("div.min-w-0")?.querySelector("p")?.textContent ?? "";

describe("mailbox card: next check", () => {
  it("an active mailbox whose check time has passed says 'check due now', not a past date", async () => {
    const r = await render(<MailboxCard mailbox={mailbox({ nextPollAt: new Date(Date.now() - DAY).toISOString() })} />);
    expect(line(r.container)).toContain("check due now");
    expect(line(r.container)).not.toContain("next check");
  });

  it("an active mailbox with a future check still shows it", async () => {
    const r = await render(<MailboxCard mailbox={mailbox({ nextPollAt: new Date(Date.now() + 3_600_000).toISOString() })} />);
    expect(line(r.container)).toContain("next check");
    expect(r.container.querySelectorAll("time")).toHaveLength(2);
  });

  it("a mailbox that needs reconnecting or is paused shows no next check", async () => {
    for (const status of ["needs_reauth", "paused"] as const) {
      const r = await render(<MailboxCard mailbox={mailbox({ status, nextPollAt: new Date(Date.now() - DAY).toISOString() })} />);
      expect(line(r.container)).not.toMatch(/next check|check due/);
      await r.unmount();
    }
  });
});
