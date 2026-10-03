/**
 * "When will it be scored?" (src/lib/gallery-waiting.ts, lib/gallery-copy.ts `waitingCopy`):
 * decided from the real render queue and the governor, mirroring the render planner:
 *  - a running render, or a queued on-demand one → "Scoring now";
 *  - the owner's new mail (≤ 48 h, never tried) the next fresh batch takes → "Scoring soon";
 *  - the owner's mail the nightly batch takes (≤ 14 days, within its ~20) → the run's time, in the
 *    viewer's own zone ("around 10:15 AM" in Kathmandu is 04:30 UTC);
 *  - past the batch's room, or a friend's mail → "Waiting in line" (no promised time);
 *  - governor limits → "paused"; the owner's switch → "switched off"; > 14 days → "Open it";
 *    a disconnected mailbox → "Reconnect Gmail";
 *  - the numbers match @edf/pipeline's (render-policy.ts, render.ts) and the render-batch cron.
 */
import { describe, expect, it, vi } from "vitest";
import * as pipeline from "@edf/pipeline";
import { nextNightlyAfter as cronNextNightly } from "@/server/inngest/functions";
import { calendarDaysFrom, formatTimeOfDay, type DateContext } from "@/lib/format";
import { waitingCopy } from "@/lib/gallery-copy";
import {
  RENDER_SCHEDULE,
  nextNightlyRun,
  waitingFor,
  type RenderSwitches,
  type WaitingInput,
} from "@/lib/gallery-waiting";

// Only the render-batch cron's nextNightlyAfter is needed from the functions module.
vi.mock("@/server/inngest/client", () => ({ inngest: { createFunction: () => ({}) } }));

const NOW = Date.parse("2026-09-30T14:00:00Z");
const H = 3_600_000;

function input(
  over: {
    role?: "owner" | "friend";
    governor?: RenderSwitches | null;
    killed?: boolean;
    user?: Partial<WaitingInput["user"]>;
    item?: Partial<WaitingInput["item"]>;
  } = {},
): WaitingInput {
  return {
    now: NOW,
    role: over.role ?? "owner",
    governor: over.governor === undefined ? { level: 0, actions: {} } : over.governor,
    rendersKilled: over.killed ?? false,
    user: { fillBatches24h: 1, queued: { onDemand: 0, exemplar: 0, fill: 0 }, ...over.user },
    item: {
      receivedAt: new Date(NOW - 2 * H).toISOString(),
      designStatus: "done",
      mailboxActive: true,
      request: null,
      queuedAhead: null,
      everRequested: false,
      freshAhead: 0,
      fillAhead: 0,
      ...over.item,
    },
  };
}
const state = (i: WaitingInput) => waitingFor(i).state;
const tonight = new Date(Date.parse("2026-10-01T04:30:00Z")).toISOString();

describe("waitingFor", () => {
  it("a running render, or a queued on-demand one → scoring now", () => {
    expect(state(input({ item: { request: { kind: "fill", state: "running" } } }))).toBe("scoring");
    expect(
      state(input({ item: { request: { kind: "on_demand", state: "queued" }, queuedAhead: 0 } })),
    ).toBe("scoring");
    expect(
      state(
        input({
          role: "friend",
          item: { request: { kind: "on_demand", state: "queued" }, queuedAhead: 0 },
        }),
      ),
    ).toBe("scoring");
  });

  it("the owner's fresh mail → scoring soon, while the next fresh batches have room", () => {
    expect(state(input())).toBe("soon");
    expect(state(input({ item: { freshAhead: 39 } }))).toBe("soon"); // within the next 2 batches of 20
    expect(state(input({ item: { freshAhead: 40 } }))).toBe("scheduled"); // later than that: tonight
    expect(
      state(
        input({
          user: { fillBatches24h: RENDER_SCHEDULE.fillBatchesPerDay - 1 },
          item: { freshAhead: 19 },
        }),
      ),
    ).toBe("soon");
    expect(
      state(
        input({
          user: { fillBatches24h: RENDER_SCHEDULE.fillBatchesPerDay - 1 },
          item: { freshAhead: 20 },
        }),
      ),
    ).toBe("scheduled");
    // Today's fill batches used up, tried before, or older than 48 h: the nightly batch.
    expect(state(input({ user: { fillBatches24h: RENDER_SCHEDULE.fillBatchesPerDay } }))).toBe(
      "scheduled",
    );
    expect(state(input({ item: { everRequested: true } }))).toBe("scheduled");
    expect(state(input({ item: { receivedAt: new Date(NOW - 49 * H).toISOString() } }))).toBe(
      "scheduled",
    );
    // Fresh renders' own monthly allowance: soon only while a whole batch still fits (as the planner).
    const room = RENDER_SCHEDULE.freshCpuSPer30Days - RENDER_SCHEDULE.freshBatchMaxCpuS;
    expect(state(input({ user: { freshCpuS30d: room } }))).toBe("soon");
    expect(state(input({ user: { freshCpuS30d: room + 1 } }))).toBe("scheduled");
    expect(state(input({ user: { freshCpuS30d: room - 1 }, item: { freshAhead: 19 } }))).toBe("soon"); // one batch left
    expect(state(input({ user: { freshCpuS30d: room - 1 }, item: { freshAhead: 20 } }))).toBe("scheduled");
    // Queued on-demand work goes first in a fresh batch; queued fill doesn't (it waits for the night).
    expect(state(input({ user: { queued: { onDemand: 30, exemplar: 0, fill: 10 } } }))).toBe(
      "soon",
    );
    expect(state(input({ user: { queued: { onDemand: 40, exemplar: 0, fill: 0 } } }))).toBe(
      "queued",
    );
  });

  it("the nightly batch: its time, within its room (queued work first, then newest first)", () => {
    const w = waitingFor(input({ item: { everRequested: true, fillAhead: 5 } }));
    expect(w).toEqual({ state: "scheduled", at: tonight });
    expect(state(input({ item: { everRequested: true, fillAhead: 19 } }))).toBe("scheduled");
    expect(state(input({ item: { everRequested: true, fillAhead: 20 } }))).toBe("queued");
    expect(
      state(
        input({
          user: { queued: { onDemand: 1, exemplar: 10, fill: 0 } },
          item: { everRequested: true, fillAhead: 9 },
        }),
      ),
    ).toBe("queued");
    // Samples off: queued samples wait, so they don't take the batch's room.
    expect(
      state(
        input({
          governor: { level: 0, actions: { samplesOff: true } },
          user: { queued: { onDemand: 1, exemplar: 10, fill: 0 } },
          item: { everRequested: true, fillAhead: 9 },
        }),
      ),
    ).toBe("scheduled");
    // A queued sample or fill request of the owner's: tonight while it's within the room.
    expect(
      waitingFor(
        input({ item: { request: { kind: "exemplar", state: "queued" }, queuedAhead: 3 } }),
      ),
    ).toEqual({ state: "scheduled", at: tonight });
    expect(
      state(input({ item: { request: { kind: "fill", state: "queued" }, queuedAhead: 25 } })),
    ).toBe("queued");
    // Renders only in the nightly run (Inngest soft cap): even on-demand waits for it.
    const nightlyOnly = { level: 0, actions: { rendersNightlyOnly: true } };
    expect(state(input({ governor: nightlyOnly }))).toBe("scheduled");
    expect(
      state(
        input({
          governor: nightlyOnly,
          item: { request: { kind: "on_demand", state: "queued" }, queuedAhead: 0 },
        }),
      ),
    ).toBe("scheduled");
  });

  it("friends: their batch needs the batching rule, so no promised time", () => {
    expect(state(input({ role: "friend" }))).toBe("queued");
    // Past the fill window nobody's mail is rendered on its own.
    expect(
      state(
        input({ role: "friend", item: { receivedAt: new Date(NOW - 15 * 24 * H).toISOString() } }),
      ),
    ).toBe("manual");
    expect(
      state(
        input({
          role: "friend",
          item: { request: { kind: "exemplar", state: "queued" }, queuedAhead: 0 },
        }),
      ),
    ).toBe("queued");
  });

  it("governor limits pause it; the owner's switch turns it off", () => {
    expect(state(input({ governor: { level: 1, actions: { fillRendersOff: true } } }))).toBe(
      "paused",
    );
    expect(
      state(
        input({
          governor: { level: 2, actions: { plannedRendersOff: true, fillRendersOff: true } },
        }),
      ),
    ).toBe("paused");
    expect(
      state(
        input({
          role: "friend",
          governor: { level: 2, actions: { plannedRendersOff: true } },
          item: { request: { kind: "on_demand", state: "queued" }, queuedAhead: 0 },
        }),
      ),
    ).toBe("paused");
    // At L2 the owner's own on-demand renders still run.
    expect(
      state(
        input({
          governor: { level: 2, actions: { plannedRendersOff: true } },
          item: { request: { kind: "on_demand", state: "queued" }, queuedAhead: 0 },
        }),
      ),
    ).toBe("scoring");
    expect(state(input({ governor: { level: 3, actions: {} } }))).toBe("paused");
    expect(state(input({ governor: { level: 0, actions: { rendersOff: true } } }))).toBe("paused");
    expect(state(input({ killed: true }))).toBe("off");
    // Background jobs paused (Inngest's quota): nothing renders until they're back.
    expect(state({ ...input(), jobsPaused: true })).toBe("paused");
    expect(
      state({
        ...input({ item: { request: { kind: "fill", state: "running" } } }),
        jobsPaused: true,
      }),
    ).toBe("scoring");
    // Stored without its analysis (storage nearly full): only "Analyze this email" scores it.
    expect(state(input({ item: { designStatus: "pending" } }))).toBe("stored");
    expect(
      state(
        input({
          item: {
            designStatus: "pending",
            request: { kind: "on_demand", state: "queued" },
            queuedAhead: 0,
          },
        }),
      ),
    ).toBe("scoring");
    expect(state(input({ governor: null }))).toBe("soon"); // no governor row: nothing is limited
  });

  it("the 14 days count at the nightly run: mail that's too old by then is never promised a time", () => {
    // 04:30 UTC tomorrow is 14.5 h away: 13.5 days old now is 14.1 days old then.
    const old = (days: number) => new Date(NOW - days * 24 * H).toISOString();
    expect(state(input({ item: { receivedAt: old(13.5), everRequested: true } }))).toBe("manual");
    expect(state(input({ item: { receivedAt: old(13.3), everRequested: true } }))).toBe(
      "scheduled",
    );
    // Too old: the owner can still have it scored on demand at L2 (a friend can't).
    const L2 = { level: 2, actions: { plannedRendersOff: true, fillRendersOff: true } };
    expect(state(input({ governor: L2, item: { receivedAt: old(40) } }))).toBe("manual");
    expect(state(input({ role: "friend", governor: L2, item: { receivedAt: old(40) } }))).toBe(
      "paused",
    );
  });

  it("fill off (L1) pauses friends' mail too, not only the owner's", () => {
    const L1 = { level: 1, actions: { fillRendersOff: true } };
    expect(state(input({ role: "friend", governor: L1 }))).toBe("paused");
    expect(state(input({ governor: L1 }))).toBe("paused");
  });

  it("a failed render: tried again tonight, or (too old) up to the viewer; nothing to measure → no score", () => {
    expect(waitingFor(input({ item: { everRequested: true, lastFailed: true } }))).toEqual({
      state: "retry",
      at: tonight,
    });
    expect(
      state(
        input({
          item: {
            receivedAt: new Date(NOW - 20 * 24 * H).toISOString(),
            everRequested: true,
            lastFailed: true,
          },
        }),
      ),
    ).toBe("failed");
    // Rendered, yet no score: another render measures the same.
    expect(state(input({ item: { designSource: "render", everRequested: true } }))).toBe(
      "unscorable",
    );
    // …unless one is already on its way.
    expect(
      state(
        input({
          item: {
            designSource: "render",
            request: { kind: "on_demand", state: "queued" },
            queuedAhead: 0,
          },
        }),
      ),
    ).toBe("scoring");
    expect(state(input({ item: { designSource: "template" } }))).toBe("soon");
  });

  it("no renderer set up: nothing is promised", () => {
    expect(state({ ...input(), rendererOff: true })).toBe("off");
  });

  it("older than 14 days → open it to score it; a disconnected mailbox → reconnect", () => {
    expect(
      state(
        input({
          item: {
            receivedAt: new Date(NOW - 15 * 24 * H).toISOString(),
            freshAhead: null,
            fillAhead: null,
          },
        }),
      ),
    ).toBe("manual");
    expect(state(input({ item: { mailboxActive: false } }))).toBe("mailbox");
  });
});

describe("waitingCopy: plain words, the viewer's own clock", () => {
  const ctx = (timeZone: string, now = NOW): DateContext => ({ locale: "en-US", timeZone, now });

  it("the nightly run's time in the viewer's zone, today or tomorrow", () => {
    // 04:30 UTC tomorrow is 10:15 AM tomorrow in Kathmandu (UTC+5:45), 9:30 PM today in Los Angeles.
    const w = { state: "scheduled" as const, at: tonight };
    expect(waitingCopy(w, ctx("Asia/Kathmandu"))).toEqual({
      badge: "Not scored yet",
      line: "Gets its score tomorrow around 10:15 AM",
      detail: "It gets its score in the daily scoring run, tomorrow around 10:15 AM.",
    });
    expect(waitingCopy(w, ctx("America/Los_Angeles")).line).toBe("Gets its score around 9:30 PM");
    expect(waitingCopy(w, ctx("America/Los_Angeles")).detail).toBe(
      "It gets its score in the daily scoring run, today around 9:30 PM.",
    );
    // A page older than the run: it's on its way.
    expect(waitingCopy(w, ctx("UTC", Date.parse(tonight) + 1)).badge).toBe("Scoring soon");
    // After a failed try: the same run, said as a retry.
    expect(waitingCopy({ state: "retry", at: tonight }, ctx("Asia/Kathmandu"))).toEqual({
      badge: "Not scored yet",
      line: "Trying again tomorrow around 10:15 AM",
      detail:
        "Scoring it didn't work last time. It's tried again in the daily scoring run, tomorrow around 10:15 AM.",
    });
  });

  it("every state has short, friendly words; nothing vague", () => {
    const c = ctx("UTC");
    const all = (
      [
        "scoring",
        "soon",
        "queued",
        "paused",
        "off",
        "manual",
        "failed",
        "stored",
        "unscorable",
        "mailbox",
      ] as const
    ).map((s) => waitingCopy({ state: s }, c));
    expect(all.map((x) => x.badge)).toEqual([
      "Scoring now",
      "Scoring soon",
      "Not scored yet",
      "Not scored yet",
      "Not scored yet",
      "Not scored yet",
      "Not scored yet",
      "Not scored yet",
      "No score",
      "Not scored yet",
    ]);
    expect(all.map((x) => x.line)).toEqual([
      "Ready in a few minutes",
      "Usually within the hour",
      "Waiting in line to be scored",
      "Scoring is paused for now",
      "Scoring is switched off",
      "Open it to get a score",
      "Scoring didn't work",
      "Open it to get a score",
      "Can't be scored",
      "Reconnect Gmail to score it",
    ]);
    for (const x of all) {
      expect(x.line.length).toBeLessThanOrEqual(45);
      expect(`${x.line} ${x.detail}`).not.toMatch(
        /checking|render|governor|sandbox|batch|quota|queue/i,
      );
    }
    expect(waitingCopy(null, c)).toEqual({
      badge: "Not scored yet",
      line: "",
      detail: "This design doesn't have a score yet.",
    });
  });

  it("time helpers", () => {
    expect(formatTimeOfDay("2026-10-01T04:30:00Z", ctx("Asia/Kathmandu"))).toBe("10:15 AM");
    expect(calendarDaysFrom("2026-10-01T04:30:00Z", ctx("Asia/Kathmandu"))).toBe(1);
    expect(calendarDaysFrom("2026-10-01T04:30:00Z", ctx("America/Los_Angeles"))).toBe(0);
    expect(calendarDaysFrom("2026-09-29T23:00:00Z", ctx("UTC"))).toBe(-1);
  });
});

describe("the numbers match the render planner's", () => {
  it("the fresh allowance meters a render VM's real size", async () => {
    // render.ts records a fresh batch's VM time as RENDER_VM_VCPUS × wall seconds.
    const { SANDBOX_VCPUS } = await import("@edf/render");
    expect(pipeline.RENDER_VM_VCPUS).toBe(SANDBOX_VCPUS);
    expect(pipeline.FRESH_BATCH_MAX_CPU_S).toBe(SANDBOX_VCPUS * 250);
  });

  it("fresh window, fill window, daily fill batches, batch room and the nightly time", () => {
    expect(RENDER_SCHEDULE.freshWindowHours).toBe(pipeline.FRESH_WINDOW_HOURS);
    expect(RENDER_SCHEDULE.fillWindowDays).toBe(pipeline.FILL_WINDOW_DAYS);
    expect(RENDER_SCHEDULE.fillBatchesPerDay).toBe(pipeline.FILL_BATCHES_PER_DAY);
    expect(RENDER_SCHEDULE.batchCapacity).toBe(pipeline.RENDER_BATCH_CAPACITY);
    expect(RENDER_SCHEDULE.nightlyUtc).toEqual(pipeline.NIGHTLY_RENDER_UTC);
    expect(RENDER_SCHEDULE.freshCpuSPer30Days).toBe(pipeline.FRESH_CPU_S_PER_30_DAYS);
    expect(RENDER_SCHEDULE.freshBatchMaxCpuS).toBe(pipeline.FRESH_BATCH_MAX_CPU_S);
    expect(RENDER_SCHEDULE.freshCpuResource).toBe(pipeline.FRESH_CPU_RESOURCE);
    for (const iso of [
      "2026-09-30T04:29:59Z",
      "2026-09-30T04:30:00Z",
      "2026-12-31T23:59:59Z",
      "2027-03-01T00:00:00Z",
    ]) {
      const t = Date.parse(iso);
      expect(nextNightlyRun(t)).toBe(pipeline.nextNightlyAfter(t));
      expect(nextNightlyRun(t)).toBe(cronNextNightly(t));
    }
  });
});
