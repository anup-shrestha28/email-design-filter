/**
 * The Design panel and its Analyze buttons, rendered in a DOM with what the email page passes them
 * (the real getEmailDetail query over a real database) and clicked through to the real
 * requestAnalyze action. Only the true externals are stubbed: the signed-in session (Google OAuth),
 * the Inngest event client, and Next's request-scoped revalidatePath.
 *
 * States (FREE-TIER.md §5.3, §8.2–8.3; DESIGN-SCORE.md §7): not analysed → queued; queued while
 * renders are paused; paused as the page's data says; paused as a stale click finds out (until a
 * refresh brings new data); the re-run bar kept, disabled, with one shared reason; and disabled
 * buttons always described by the visible reason (aria-describedby).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { DesignPanel } from "@/components/design/design-panel";
import type { getPool as getAppPool } from "@/server/db";
import type { EmailDetail } from "@/server/queries/types";
import type { SessionUser } from "@/server/session";
import { HAS_DB } from "../support/env";
import { appPool, ownerPool } from "../support/db";
import { buttonByText, click, describedByText, queryButtonByText, render, waitFor } from "../support/render";
import {
  account,
  detail,
  email,
  EVERYONE,
  FRIENDS,
  governor,
  notAnalysed,
  renderRequests,
  SELF_CAP,
  STATIC_ONLY,
  withFullResult,
  withSummary,
} from "./fixtures";

const state = vi.hoisted(() => ({ user: null as SessionUser | null, events: [] as unknown[] }));
vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => state.user,
}));
vi.mock("@/server/inngest/client", () => ({
  inngest: {
    send: async (event: unknown) => {
      state.events.push(event);
      return { ids: ["evt"] };
    },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

function panel(d: EmailDetail, actions: EmailDetail["actions"] = d.actions) {
  return <DesignPanel emailId={d.id} design={d.design} actions={actions} />;
}

/** role="status" notes (the governor's reason under disabled buttons). */
function notes(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");
}

/** A disabled Analyze button sits in a focusable wrapper that carries the same description. */
function wrapperOf(button: HTMLButtonElement): HTMLElement {
  const w = button.parentElement;
  if (!w || w.getAttribute("tabindex") !== "0") throw new Error("disabled button has no focusable wrapper");
  return w;
}

describe.skipIf(!HAS_DB)("Design panel and Analyze buttons (DOM)", () => {
  const pool = appPool();
  const owner = ownerPool();
  const gov = governor(owner);
  let appPoolOf: typeof getAppPool | null = null;

  beforeAll(async () => {
    appPoolOf = (await import("@/server/db")).getPool;
    await gov.save();
  });
  beforeEach(async () => {
    state.events.length = 0;
    await gov.set({ level: 0 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await gov.restore();
  });
  afterAll(async () => {
    await pool.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  it("not analysed: Analyze is enabled with today's allowance, and a click queues it", async () => {
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const id = await email(pool, friend, notAnalysed());
    const d = await detail(friend, id);
    const success = vi.spyOn(toast, "success");
    const r = await render(panel(d));

    expect(r.container.textContent).toContain("Design not analysed yet");
    expect(r.container.textContent).toContain("You can analyze it now instead.");
    const analyze = buttonByText(r.container, "Analyze this email");
    expect(analyze.disabled).toBe(false);
    expect(analyze.hasAttribute("aria-describedby")).toBe(false);
    expect(r.container.textContent).toContain("1 left today");
    expect(notes(r.container)).toEqual([]);

    await click(analyze);
    const queued = await waitFor(() => buttonByText(r.container, "Queued"));
    expect(queued.hasAttribute("aria-busy")).toBe(false);
    expect(queued.disabled).toBe(true);
    // Queued isn't a pause: the button isn't described by a governor note, and none is shown.
    expect(queued.hasAttribute("aria-describedby")).toBe(false);
    expect(wrapperOf(queued).hasAttribute("aria-describedby")).toBe(false);
    expect(notes(r.container)).toEqual([]);
    expect(success).toHaveBeenCalledWith("Analysis queued", expect.anything());
    expect(r.router.calls).toContain("refresh");
    expect(await renderRequests(pool, friend.user.userId)).toBe(1);
    expect(state.events).toEqual([expect.objectContaining({ name: "render/requested", data: { userId: friend.user.userId } })]);

    // The refresh brings the queued request: the panel says so and offers no button.
    await r.rerender(panel(await detail(friend, id)));
    expect(r.container.textContent).toContain("Analysis queued");
    expect(r.container.textContent).toContain("Results usually arrive within a couple of minutes.");
    expect(r.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("queued before a pause: 'waiting for renders to resume' with the reason, no button", async () => {
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const id = await email(pool, friend, notAnalysed());
    const { requestAnalyze } = await import("@/server/actions/email");
    expect(await requestAnalyze(id)).toEqual({ ok: true, data: { status: "queued" } });
    await gov.set({ level: 2, actions: { plannedRendersOff: true } });

    const d = await detail(friend, id);
    const r = await render(panel(d));
    expect(r.container.textContent).toContain("Queued, waiting for renders to resume");
    expect(r.container.textContent).toMatch(FRIENDS);
    expect(r.container.textContent).toContain("Your request stays in the queue and runs once they resume.");
    expect(r.container.textContent).not.toContain("Analysis queued");
    expect(r.container.querySelectorAll("button")).toHaveLength(0);
  });

  it("paused by the server: disabled, the reason shown and described, nothing invites a click", async () => {
    await gov.set(SELF_CAP);
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const id = await email(pool, friend, notAnalysed());
    const d = await detail(friend, id);
    expect(d.actions.rendersPaused).toMatch(FRIENDS);
    const r = await render(panel(d));

    expect(r.container.textContent).toContain("It hasn't been rendered yet. You can analyze it once design renders resume.");
    expect(r.container.textContent).not.toMatch(/analyze it now|left today/);
    const analyze = buttonByText(r.container, "Analyze this email");
    expect(analyze.disabled).toBe(true);
    expect(notes(r.container)).toEqual([d.actions.rendersPaused]);
    expect(describedByText(analyze)).toEqual([d.actions.rendersPaused]);
    // The focusable wrapper is what keyboard and screen-reader users reach; it carries the reason too.
    expect(describedByText(wrapperOf(analyze))).toEqual([d.actions.rendersPaused]);

    await click(analyze);
    expect(await renderRequests(pool, friend.user.userId)).toBe(0);
    expect(r.router.calls).toEqual([]);
  });

  it("at static-only the owner's button is paused too, with the everyone-wide reason", async () => {
    await gov.set(STATIC_ONLY);
    const me = await account(pool, "owner");
    state.user = me.user;
    const d = await detail(me, await email(pool, me, notAnalysed()));
    const r = await render(panel(d));
    const analyze = buttonByText(r.container, "Analyze this email");
    expect(analyze.disabled).toBe(true);
    expect(describedByText(analyze)).toEqual([expect.stringMatching(EVERYONE)]);
  });

  it("paused by a stale click: the click's answer holds until a refresh brings new data", async () => {
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const id = await email(pool, friend, notAnalysed());
    const stale = await detail(friend, id);
    expect(stale.actions.rendersPaused).toBeNull();
    const r = await render(panel(stale));
    const info = vi.spyOn(toast, "info");

    // Renders pause after the page loaded; the click finds out.
    await gov.set(SELF_CAP);
    await click(buttonByText(r.container, "Analyze this email"));
    // (While the action runs the button is disabled as loading; wait for the settled state.)
    await waitFor(() => {
      if (notes(r.container).length === 0) throw new Error("no pause note yet");
    });
    const analyze = buttonByText(r.container, "Analyze this email");
    expect(analyze.disabled).toBe(true);
    expect(analyze.hasAttribute("aria-busy")).toBe(false);
    const [reason] = notes(r.container);
    expect(reason).toMatch(FRIENDS);
    expect(describedByText(analyze)).toEqual([reason]);
    expect(describedByText(wrapperOf(analyze))).toEqual([reason]);
    expect(r.container.textContent).not.toContain("left today");
    expect(queryButtonByText(r.container, "Queued")).toBeNull();
    expect(info).toHaveBeenCalledWith("Design renders are paused", {
      description: expect.stringMatching(/Nothing was queued/),
    });
    expect(r.router.calls).toContain("refresh");
    expect(await renderRequests(pool, friend.user.userId)).toBe(0);
    expect(state.events).toEqual([]);

    // Re-rendering with the same data (no refresh yet) keeps what the click learned.
    await r.rerender(panel(stale, stale.actions));
    expect(buttonByText(r.container, "Analyze this email").disabled).toBe(true);
    expect(notes(r.container)).toEqual([reason]);

    // The refresh arrives after renders resumed: the server's answer wins and the button is back.
    await gov.set({ level: 0 });
    await r.rerender(panel(await detail(friend, id)));
    const back = buttonByText(r.container, "Analyze this email");
    expect(back.disabled).toBe(false);
    expect(back.hasAttribute("aria-describedby")).toBe(false);
    expect(notes(r.container)).toEqual([]);
    expect(r.container.textContent).toContain("1 left today");
  });

  it("re-run bar: both buttons with today's allowance while renders run", async () => {
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const d = await detail(friend, await email(pool, friend, withSummary()));
    expect(d.design.summary?.coverage).toBe("render");
    const r = await render(panel(d));

    expect(r.container.textContent).toContain("Saved summary.");
    expect(r.container.textContent).toContain("analyze again for the complete breakdown.");
    const ai = buttonByText(r.container, "Run AI review");
    const again = buttonByText(r.container, "Analyze again");
    for (const b of [ai, again]) {
      expect(b.disabled).toBe(false);
      expect(b.hasAttribute("aria-describedby")).toBe(false);
    }
    expect(r.container.textContent?.match(/1 left today/g)).toHaveLength(2);
    expect(notes(r.container)).toEqual([]);
  });

  it("re-run bar while paused: kept, both disabled, one shared reason that each button is described by", async () => {
    await gov.set(SELF_CAP);
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const d = await detail(friend, await email(pool, friend, withSummary()));
    const r = await render(panel(d));

    expect(r.container.textContent).toContain("you can analyze again for the complete breakdown once design renders resume.");
    const reason = d.actions.rendersPaused!;
    expect(notes(r.container)).toEqual([reason]);
    const note = r.container.querySelector('[role="status"]')!;
    for (const label of ["Run AI review", "Analyze again"]) {
      const b = buttonByText(r.container, label);
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-describedby")).toBe(note.id);
      expect(wrapperOf(b).getAttribute("aria-describedby")).toBe(note.id);
    }
    expect(r.container.textContent).not.toContain("left today");
  });

  it("re-run bar, stale click: one button's click pauses both and shows the shared reason once", async () => {
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const d = await detail(friend, await email(pool, friend, withSummary()));
    const r = await render(panel(d));

    await gov.set(SELF_CAP);
    await click(buttonByText(r.container, "Analyze again"));
    await waitFor(() => {
      if (notes(r.container).length === 0) throw new Error("no pause note yet");
    });
    const [reason, ...rest] = notes(r.container);
    expect(rest).toEqual([]);
    expect(reason).toMatch(FRIENDS);
    for (const label of ["Run AI review", "Analyze again"]) {
      const b = buttonByText(r.container, label);
      expect(b.disabled).toBe(true);
      expect(describedByText(b)).toEqual([reason]);
    }
    expect(await renderRequests(pool, friend.user.userId)).toBe(0);
  });

  it("full result: 'Run fresh AI review' once an AI review is in, 'Run AI review' before", async () => {
    await gov.set(SELF_CAP);
    const friend = await account(pool, "friend");
    state.user = friend.user;
    for (const ai of [true, false]) {
      const d = await detail(friend, await email(pool, friend, await withFullResult({ ai })));
      expect(d.design.result?.coverage).toBe("render");
      expect(d.design.result?.score).toEqual(expect.any(Number));
      const r = await render(panel(d));
      expect(r.container.textContent).toContain("Where the points come from");
      const label = ai ? "Run fresh AI review" : "Run AI review";
      const note = r.container.querySelector('[role="status"]')!;
      expect(note.textContent).toMatch(FRIENDS);
      for (const b of [buttonByText(r.container, label), buttonByText(r.container, "Analyze again")]) {
        expect(b.disabled).toBe(true);
        expect(b.getAttribute("aria-describedby")).toBe(note.id);
      }
      await r.unmount();
    }
  });

  it("security email: never scored, and no Analyze or re-run button even while renders are paused", async () => {
    await gov.set(STATIC_ONLY);
    const friend = await account(pool, "friend");
    state.user = friend.user;
    const d = await detail(
      friend,
      await email(pool, friend, {
        securitySensitive: true,
        primaryType: "account_security",
        designStatus: "skipped",
        designSource: "none",
        designAiState: "not_applicable",
        snippet: null,
        deals: [],
      }),
    );
    const r = await render(panel(d));
    expect(r.container.textContent).toContain("Security emails aren't scored");
    expect(r.container.textContent).toContain("never rendered, screenshotted or sent to AI");
    expect(r.container.querySelectorAll("button")).toHaveLength(0);
    expect(notes(r.container)).toEqual([]);
    expect(r.container.textContent).not.toMatch(/paused/);
  });
});
