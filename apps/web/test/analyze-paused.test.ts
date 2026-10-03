/**
 * "Analyze" while the governor has renders paused (FREE-TIER.md §5.3, §8.2–8.3): at the Sandbox
 * self-cap (or L2) a friend's request is not queued and the result says why, while the owner's still
 * queues; at static-only (or L3), or with no renderer set up, nobody's is queued. The email page disables the buttons with the
 * same reason, keeps the re-run bar, and never invites a click it would refuse. Neither the page nor
 * the action loads the @edf/pipeline barrel to find out.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withUser } from "@edf/db";
import type { getPool as getAppPool } from "@/server/db";
import { RENDERER_NOT_SET_UP, type EmailDetail } from "@/server/queries/types";
import type { SessionUser } from "@/server/session";
import { readFileSync } from "node:fs";
import {
  analyzeNotice,
  fromClick,
  notAnalysedBody,
  rerunBar,
  savedSummaryNote,
  staticOnlyBody,
  waitingState,
} from "@/components/design/analyze-copy";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "./support/db";

const state = vi.hoisted(() => ({ user: null as SessionUser | null, renders: [] as string[] }));
vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => state.user,
}));
vi.mock("@/server/pipeline-client", () => ({
  requestRender: async (userId: string) => {
    state.renders.push(userId);
    return true;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const FRIENDS = /renders for friends are paused/;
const EVERYONE = /paused for everyone/;
const SELF_CAP = { level: 0, actions: { plannedRendersOff: true, samplesOff: true, fillRendersOff: true } };

type Actions = EmailDetail["actions"];
const baseActions: Actions = {
  canAnalyze: true,
  canRunAiReview: true,
  analyzeRemainingToday: 1,
  aiReviewRemainingToday: 1,
  renderQueued: false,
  reason: null,
  rendersPaused: null,
};

describe("what the Design panel says around Analyze", () => {
  it("a paused click is an info notice with the reason, never 'queued'", () => {
    const reason = "Design renders for friends are paused to keep the app within its free limits.";
    for (const withAi of [false, true]) {
      const n = analyzeNotice({ status: "paused", reason }, withAi);
      expect(n.tone).toBe("info");
      expect(n.title).toBe("Design renders are paused");
      expect(n.description).toContain(reason);
      expect(n.description).toMatch(/Nothing was queued/);
      expect(`${n.title} ${n.description}`).not.toMatch(/Analysis queued|AI review requested/);
    }
    expect(analyzeNotice({ status: "queued" }, false)).toMatchObject({ tone: "success", title: "Analysis queued" });
    expect(analyzeNotice({ status: "queued" }, true)).toMatchObject({ tone: "success", title: "AI review requested" });
  });

  it("keeps the re-run bar while paused and hides it only for emails that can't be analysed", () => {
    const paused = "Design renders are paused for everyone.";
    expect(rerunBar(baseActions)).toBe("shown");
    expect(rerunBar({ ...baseActions, canAnalyze: false, canRunAiReview: false, reason: paused, rendersPaused: paused })).toBe("paused");
    expect(rerunBar({ ...baseActions, canAnalyze: false, reason: "Plain-text emails have no design to analyse." })).toBe("hidden");
    expect(
      rerunBar({ ...baseActions, reason: "Security emails are never rendered or sent to AI.", rendersPaused: paused }),
    ).toBe("hidden");
  });

  it("a pause a stale click found out holds only until a refresh brings new data", () => {
    const reason = "Design renders are paused for everyone.";
    const stale = { ...baseActions };
    const click = { value: reason, seen: stale };
    // Same data as when clicked: the click's answer holds, and the re-run bar shows the pause.
    expect(fromClick(click, stale)).toBe(reason);
    expect(rerunBar(stale, fromClick(click, stale))).toBe("paused");
    // A refresh after renders resumed: new data, no pause, the buttons come back.
    const resumed = { ...baseActions };
    expect(fromClick(click, resumed)).toBeNull();
    expect(rerunBar(resumed, resumed.rendersPaused ?? fromClick(click, resumed))).toBe("shown");
    expect(fromClick(null, stale)).toBeNull();
  });

  it("copy around a queued or saved result never invites a click while renders are paused", () => {
    const paused = "Design renders for friends are paused to keep the app within its free limits.";
    const queuedPaused = { ...baseActions, canAnalyze: false, canRunAiReview: false, renderQueued: true, reason: paused, rendersPaused: paused };
    expect(waitingState(queuedPaused)).toBe("queued_paused");
    expect(waitingState({ ...baseActions, renderQueued: true })).toBe("queued");
    expect(waitingState({ ...baseActions, reason: paused, rendersPaused: paused })).toBe("not_analysed");

    // Static-only card: already queued says so (not "you can analyze it"), and when it runs.
    expect(staticOnlyBody(queuedPaused)).toMatch(/queued and runs once design renders resume/);
    expect(staticOnlyBody(queuedPaused)).not.toMatch(/you can analyze|Analyze it/);
    expect(staticOnlyBody({ ...baseActions, renderQueued: true })).toMatch(/Analysis queued/);
    expect(staticOnlyBody({ ...baseActions, reason: paused, rendersPaused: paused })).toMatch(/^So far .* Once design renders resume, you can analyze it/);
    expect(staticOnlyBody(baseActions)).toMatch(/ Analyze it to render it/);

    // Saved summary: "analyze again" only with "once design renders resume" while paused.
    expect(savedSummaryNote(null)).toMatch(/; analyze again for the complete breakdown\.$/);
    expect(savedSummaryNote(paused)).toMatch(/analyze again for the complete breakdown once design renders resume\.$/);
  });

  it("a click also refreshes the inbox preview pane (same react-query key)", () => {
    const src = (rel: string) => readFileSync(new URL(`../src/components/${rel}`, import.meta.url), "utf8");
    const key = /const PREVIEW_QUERY = "([^"]+)"/.exec(src("design/analyze-button.tsx"))?.[1];
    expect(key).toBeTruthy();
    expect(src("inbox/preview-pane.tsx")).toContain(`return ["${key}", id] as const;`);
  });

  it("the empty state never says 'analyze it now' while renders are paused", () => {
    expect(notAnalysedBody(false, null)).toMatch(/analyze it now/);
    for (const failed of [false, true]) {
      const body = notAnalysedBody(failed, "Design renders are paused for everyone.");
      expect(body).not.toMatch(/\bnow\b|try again —/);
      expect(body).toMatch(/once design renders resume/);
    }
  });
});

describe.skipIf(!HAS_DB)("requestAnalyze and the email page while renders are paused", () => {
  const pool = appPool();
  const owner = ownerPool();
  let savedGovernor: unknown = null;
  // One app pool per process (globalThis), shared by fresh module graphs too.
  let appPoolOf: typeof getAppPool | null = null;

  const setGovernor = (value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  async function account(role: "owner" | "friend", over: Parameters<typeof seedEmail>[3] = {}): Promise<{ user: SessionUser; emailId: string }> {
    const u = await createUser(pool, { role });
    const emailId = await seedEmail(pool, u.id, await createMailbox(pool, u.id), over);
    const user = { userId: u.id, email: u.email, name: u.name, image: null, sessionId: "s", sessionCreatedAt: new Date(), role };
    return { user, emailId };
  }

  const requests = (userId: string) =>
    withUser(pool, userId, async (_db, c) => Number((await c.query("SELECT count(*) AS n FROM render_request")).rows[0].n));

  beforeAll(async () => {
    state.renders.length = 0;
    appPoolOf = (await import("@/server/db")).getPool;
    savedGovernor = (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ?? null;
  });
  afterEach(async () => {
    await setGovernor(savedGovernor ?? { level: 0 });
  });
  afterAll(async () => {
    await pool.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  it("at the Sandbox self-cap a friend's request is not queued and says why; the owner's queues", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { getEmailDetail } = await import("@/server/queries/email");
    await setGovernor(SELF_CAP);

    const friend = await account("friend");
    state.user = friend.user;
    for (const withAi of [false, true]) {
      expect(await requestAnalyze(friend.emailId, withAi)).toEqual({ ok: true, data: { status: "paused", reason: expect.stringMatching(FRIENDS) } });
    }
    expect(await requests(friend.user.userId)).toBe(0);
    expect(state.renders).not.toContain(friend.user.userId);
    const detail = await getEmailDetail(friend.user.userId, friend.emailId, "friend");
    expect(detail?.actions).toMatchObject({ canAnalyze: false, canRunAiReview: false, analyzeRemainingToday: 1, renderQueued: false });
    expect(detail?.actions.rendersPaused).toMatch(FRIENDS);
    expect(detail?.actions.reason).toBe(detail?.actions.rendersPaused);
    expect(rerunBar(detail!.actions)).toBe("paused");

    const me = await account("owner");
    state.user = me.user;
    expect(await requestAnalyze(me.emailId)).toEqual({ ok: true, data: { status: "queued" } });
    expect(await requests(me.user.userId)).toBe(1);
    expect(state.renders).toContain(me.user.userId);
    const mine = await getEmailDetail(me.user.userId, me.emailId, "owner");
    expect(mine?.actions.rendersPaused).toBeNull();
    expect(mine?.actions.reason).toBeNull();
  });

  it("a friend's request queued before the pause shows as queued and paused", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { getEmailDetail } = await import("@/server/queries/email");
    const friend = await account("friend");
    state.user = friend.user;
    expect(await requestAnalyze(friend.emailId)).toEqual({ ok: true, data: { status: "queued" } });

    await setGovernor({ level: 2, actions: { plannedRendersOff: true } });
    const detail = await getEmailDetail(friend.user.userId, friend.emailId, "friend");
    expect(detail?.actions).toMatchObject({ renderQueued: true, canAnalyze: false, canRunAiReview: false });
    expect(detail?.actions.rendersPaused).toMatch(FRIENDS);
    // Which panel state that picks: the "waiting for renders to resume" block, or on a static-only
    // result, a card that says it's queued and runs once renders resume.
    expect(waitingState(detail!.actions)).toBe("queued_paused");
    expect(staticOnlyBody(detail!.actions)).toMatch(/queued and runs once design renders resume/);
  });

  it("at static-only nobody's request is queued, the owner's included", async () => {
    const { requestAnalyze } = await import("@/server/actions/email");
    const { getEmailDetail } = await import("@/server/queries/email");
    await setGovernor({ level: 0, actions: { rendersOff: true, plannedRendersOff: true } });
    const me = await account("owner");
    state.user = me.user;
    expect(await requestAnalyze(me.emailId, true)).toEqual({ ok: true, data: { status: "paused", reason: expect.stringMatching(EVERYONE) } });
    expect(await requests(me.user.userId)).toBe(0);
    expect(state.renders).not.toContain(me.user.userId);
    expect((await getEmailDetail(me.user.userId, me.emailId, "owner"))?.actions.rendersPaused).toMatch(EVERYONE);
  });

  it("with no renderer set up (RENDERER=off, or the Sandbox without its snapshot) nothing is queued, and the page says why", async () => {
    for (const env of [{ RENDERER: "off" }, { RENDERER: "sandbox", SANDBOX_SNAPSHOT_ID: undefined }]) {
      vi.resetModules();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      try {
        const { requestAnalyze } = await import("@/server/actions/email");
        const { getEmailDetail } = await import("@/server/queries/email");
        const me = await account("owner");
        state.user = me.user;
        for (const withAi of [false, true]) {
          // A request queued here would never be rendered, and every tick would start a render run for it.
          expect(await requestAnalyze(me.emailId, withAi), JSON.stringify(env)).toEqual({ ok: true, data: { status: "paused", reason: RENDERER_NOT_SET_UP } });
        }
        expect(await requests(me.user.userId)).toBe(0);
        expect(state.renders).not.toContain(me.user.userId);
        const detail = await getEmailDetail(me.user.userId, me.emailId, "owner");
        expect(detail?.actions).toMatchObject({ canAnalyze: false, canRunAiReview: false, rendersPaused: RENDERER_NOT_SET_UP });
        expect(analyzeNotice({ status: "paused", reason: RENDERER_NOT_SET_UP }, false).description).toMatch(/Nothing was queued/);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    }
  });

  it("an email that can never be analysed keeps its own reason, not the pause", async () => {
    const { getEmailDetail } = await import("@/server/queries/email");
    await setGovernor({ level: 3, actions: { rendersOff: true } });
    const friend = await account("friend", { securitySensitive: true, designStatus: "skipped" });
    const detail = await getEmailDetail(friend.user.userId, friend.emailId, "friend");
    expect(detail?.actions.rendersPaused).toBeNull();
    expect(detail?.actions.reason).toMatch(/Security emails/);
    expect(rerunBar(detail!.actions)).toBe("hidden");
  });

  it("neither the email page nor requestAnalyze loads the @edf/pipeline barrel", async () => {
    // The helpers above loaded the pipeline for seeding; start a fresh module graph in which
    // loading it fails, then use the page query and the action end to end.
    const friend = await account("friend");
    await setGovernor(SELF_CAP);
    const loads: string[] = [];
    vi.resetModules();
    vi.doMock("@edf/pipeline", () => {
      loads.push("@edf/pipeline");
      throw new Error("@edf/pipeline was loaded by the email page or the Analyze action");
    });
    try {
      const { getEmailDetail } = await import("@/server/queries/email");
      const { requestAnalyze } = await import("@/server/actions/email");
      state.user = friend.user;
      const detail = await getEmailDetail(friend.user.userId, friend.emailId, "friend");
      expect(detail?.actions.rendersPaused).toMatch(FRIENDS);
      expect(await requestAnalyze(friend.emailId)).toEqual({ ok: true, data: { status: "paused", reason: expect.stringMatching(FRIENDS) } });
      expect(loads).toEqual([]);
    } finally {
      vi.doUnmock("@edf/pipeline");
      vi.resetModules();
    }
  });
});
