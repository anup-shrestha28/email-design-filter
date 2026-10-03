/**
 * R1-12: dismissing the import banner stuck only while its text stayed the same. The text of a
 * running import carries a live count ("Importing a@b.c: 1,204 emails so far."), refreshed by the
 * sync poll every 10 s, so the banner came straight back. Dismissal is keyed on the banner's id.
 */
import { describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "@/server/queries/types";
import { click, render } from "../support/render";

const h = vi.hoisted(() => ({ status: null as unknown as SyncStatus }));
vi.mock("@/components/providers/sync", () => ({ useSync: () => ({ status: h.status }) }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  usePathname: () => "/inbox",
}));

const { Banners } = await import("@/components/shell/banners");

const MAILBOX = { id: "m1", emailAddress: "a@b.c" } as SyncStatus["mailboxes"][number];
const status = (banner: SyncStatus["banner"]): SyncStatus => ({ mailboxes: [MAILBOX], syncing: true, lastSyncedAt: null, banner });

describe("Banners dismissal (R1-12)", () => {
  it("stays dismissed while an import's count goes up, and returns for a new situation", async () => {
    h.status = status({ id: "import:m1", level: "info", text: "Importing a@b.c: 10 emails so far." });
    const r = await render(<Banners />);
    expect(r.container.textContent).toContain("10 emails so far");
    await click(r.container.querySelector('button[aria-label="Dismiss"]')!);
    expect(r.container.textContent).toBe("");

    // The next sync poll: same import, a higher count.
    h.status = status({ id: "import:m1", level: "info", text: "Importing a@b.c: 250 emails so far." });
    await r.rerender(<Banners />);
    expect(r.container.textContent).toBe("");

    // A different situation (another banner id) is shown again.
    h.status = status({ id: "queued:m2", level: "info", text: "Import queued (position 2)." });
    await r.rerender(<Banners />);
    expect(r.container.textContent).toContain("Import queued");
  });
});
