/**
 * The coarse Inngest functions of the free edition (FREE-TIER.md §4.7). Payloads carry IDs only.
 * Job bodies are plain functions from @edf/pipeline, imported lazily inside steps (cold starts).
 */
import { inngest } from "./client";
import { isSkipped, runStep } from "./job";

const TICK_TRIGGERS = [
  { cron: "TZ=UTC 0 * * * *" },
  // The :30 cron exists only when TICK_EVERY=30 (deploy-time; no runtime flag, no Vercel API token).
  ...(process.env.TICK_EVERY === "60" ? [] : [{ cron: "TZ=UTC 30 * * * *" }]),
  { event: "pipeline/kick" },
];

/** One function, two schedules + kicks; one global singleton covers every trigger (§4.2). */
export const pipelineTick = inngest.createFunction(
  { id: "pipeline-tick", triggers: TICK_TRIGGERS, singleton: { key: '"global"', mode: "skip" }, retries: 2 },
  async ({ step, runId }) => {
    const poll = await step.run("poll", () =>
      runStep("tick.poll", async (deps) => {
        const p = await import("@edf/pipeline");
        const { runGovernor } = await import("@edf/budget");
        // Sandbox VMs: stop orphans older than 250 s and meter finished VMs from the API (FREE-TIER §5.1).
        // Before the governor, so this tick's Sandbox switches (§8.3) already count the VMs metered now.
        // Runs even when frozen (stopping orphans only saves budget); a Sandbox API failure never fails the tick.
        await p.sweepAndMeterSandboxes(deps).catch((err: unknown) => p.recordAppError(deps, "tick.sandbox_sweep", err));
        const gov = await runGovernor(deps.pool).catch(() => null);
        if (gov && gov.alerts.length) {
          for (const a of gov.alerts) await p.raiseAlert(deps.pool, deps.alerts ?? { token: undefined, repo: undefined }, a as never);
        }
        if (gov?.result.level === 3) return { frozen: true, eligible: 0, nextBackfill: null, newSenderChecks: 0, renderDue: false };
        const polled = await p.pollDueMailboxes(deps, 60_000);
        await p.sweepImportance(deps).catch(() => 0);
        const nextBackfill = await p.releaseFinishedBackfill(deps).catch(() => null);
        const eligible = await p.drainEligibleCount(deps);
        // Imports that have drained (their senders now exist) and still owe the new-sender check.
        const newSenderChecks = (await p.listNewSenderChecks(deps, 1).catch(() => [])).length;
        // On-demand renders still queued: their render/requested event was dropped while a render run
        // was active (singleton skip), or arrived as it finished. Not while renders are nightly-only.
        const renderDue = gov?.result.actions.rendersNightlyOnly ? false : await p.onDemandRenderDue(deps).catch(() => false);
        return { frozen: false, polled: polled.polled, inserted: polled.inserted, eligible, nextBackfill, newSenderChecks, renderDue };
      }),
    );
    if (isSkipped(poll) || poll.frozen) return poll;
    if (poll.renderDue) {
      await step.sendEvent("render-sweep", { id: `render-sweep-${runId}`, name: "render/requested", data: { reason: "sweep" } });
    }
    if (poll.nextBackfill) {
      await step.sendEvent("start-next-backfill", {
        name: "backfill/requested",
        data: { mailboxId: poll.nextBackfill.mailboxId, userId: poll.nextBackfill.userId },
      });
    }

    let eligible = poll.eligible;
    let drained = 0;
    for (let i = 1; i <= 5 && eligible > 0; i++) {
      const r = await step.run(`drain-${i}`, () =>
        runStep(`tick.drain`, async (deps) => {
          const p = await import("@edf/pipeline");
          const d = await p.drainStep(deps);
          return { drained: d.stored + d.skipped, remaining: await p.drainEligibleCount(deps), stopped: d.stoppedReason };
        }),
      );
      if (isSkipped(r)) break;
      drained += r.drained;
      eligible = r.drained > 0 ? r.remaining : 0;
      if (r.stopped === "database" || r.stopped === "global_incident" || r.stopped === "daily_limit") break;
    }

    // New-sender check (DESIGN.md §5.4 step 4) once an import has drained; resumes on later ticks.
    if (poll.newSenderChecks > 0) {
      await step.run("new-senders", () =>
        runStep("tick.new_senders", async (deps) => (await import("@edf/pipeline")).runNewSenderChecks(deps, 45_000)),
      );
    }

    // AI step: only when a Claude batch is outstanding or classification work is waiting (§4.2).
    // The count is the same queue submitClassificationBatch reads (active mailboxes, ≥ 20 min old).
    const aiWork = await step.run("ai-check", () =>
      runStep("tick.ai_check", async (deps) => {
        const { withSystem } = await import("@edf/db");
        return withSystem(deps.pool, async (_db, c) => {
          const r = await c.query<{ open: string; pending: string }>(
            `SELECT (SELECT count(*) FROM ai_batch WHERE state IN ('submitting', 'submitted')) AS open,
                    (SELECT count(*) FROM list_pending_classification(500)) AS pending`,
          );
          return { open: Number(r.rows[0]?.open ?? 0), pending: Number(r.rows[0]?.pending ?? 0) };
        });
      }),
    );
    if (!isSkipped(aiWork) && (aiWork.open > 0 || aiWork.pending > 0)) {
      await step.run("ai", () =>
        runStep("tick.ai", async (deps) => {
          const p = await import("@edf/pipeline");
          // The classification prep budget counts from the start of the step, collection included,
          // so a slow collect plus a full prep stays well inside the function's maxDuration.
          const startedAt = Date.now();
          const collected = await p.collectBatches(deps);
          const submitted = aiWork.pending > 0 ? await p.submitClassificationBatch(deps, { startedAt }) : null;
          return { collected, submitted };
        }),
      );
    }

    const finish = await step.run("finish", () =>
      runStep("tick.finish", async (deps) => {
        const p = await import("@edf/pipeline");
        await p.heartbeat(deps, "last_tick_at");
        const kick = await p.takeContinuationKick(deps, drained);
        // Fresh renders (§5.3): after the drain, so this tick's new mail counts.
        let fresh = false;
        try {
          fresh = await p.freshRenderDue(deps);
        } catch {
          // A failed check never fails the tick: the next one checks again.
        }
        return { kick, fresh };
      }),
    );
    if (!isSkipped(finish) && finish.kick) {
      await step.sendEvent("continuation-kick", { id: `kick-cont-${runId}`, name: "pipeline/kick", data: { reason: "continuation" } });
    }
    // Dropped while a render run is active (singleton skip): that run plans fresh work in its next
    // round, and the next tick sends this again.
    if (!isSkipped(finish) && finish.fresh) {
      await step.sendEvent("render-fresh", { id: `render-fresh-${runId}`, name: "render/requested", data: { reason: "fresh" } });
    }
    return { drained, eligible };
  },
);

/**
 * First import: admission, newest-first slices, Q1/Q2 listing pages (§4.5). The new-sender check
 * runs later, from the tick, once the drain has stored the import and so created its senders.
 */
export const mailboxBackfill = inngest.createFunction(
  {
    id: "mailbox-backfill",
    triggers: [{ event: "mailbox/connected" }, { event: "backfill/requested" }],
    singleton: { key: "event.data.mailboxId", mode: "skip" },
    cancelOn: [{ event: "mailbox/disconnected", if: "async.data.mailboxId == event.data.mailboxId" }],
    retries: 3,
  },
  async ({ event, step }) => {
    const mb = { mailboxId: String(event.data.mailboxId), userId: String(event.data.userId) };
    const admit = await step.run("admit", () => runStep("backfill.admit", async (deps) => (await import("@edf/pipeline")).admitBackfill(deps, mb)));
    if (isSkipped(admit) || admit.kind !== "admitted") return admit;

    for (let s = 0; s < admit.slices.length; s++) {
      const slice = admit.slices[s];
      if (!slice) continue;
      for (const query of ["q1", "q2"] as const) {
        let pageToken: string | null = null;
        let page = 0;
        let waits = 0;
        do {
          const r = await step.run(`list-${s}-${query}-${page}-${waits}`, () =>
            runStep("backfill.list", async (deps) =>
              (await import("@edf/pipeline")).backfillListPage(deps, mb, { slice: { after: slice.after, before: slice.before }, query, pageToken, sliceIndex: s }),
            ),
          );
          if (isSkipped(r)) return r;
          if ("waitMs" in r) {
            waits++;
            await step.sleep(`quota-wait-${s}-${query}-${page}-${waits}`, `${Math.ceil(Math.min(r.waitMs, 60_000) / 1000)}s`);
            continue;
          }
          pageToken = r.nextPageToken;
          page++;
        } while (pageToken);
      }
      // Newest slices first: let yesterday's mail start flowing before older slices are listed.
      if (s === 0) await step.sendEvent("kick-after-first-slice", { name: "pipeline/kick", data: { reason: "connect" } });
    }

    await step.run("finish", () =>
      runStep("backfill.finish", async (deps) => {
        const p = await import("@edf/pipeline");
        const windowStart = Math.floor(Date.now() / 1000) - admit.windowDays * 86_400;
        // Marks the new-sender check as due; the tick runs it after the drain (runNewSenderChecks).
        await p.finishBackfillListing(deps, mb, windowStart);
        return { windowStart };
      }),
    );
    await step.sendEvent("kick-after-listing", { name: "pipeline/kick", data: { reason: "connect" } });
    return { listed: true };
  },
);

/** Daily maintenance (§4.7): purges, retention/compaction, aggregates, samples, governor. */
export const dailyMaintenance = inngest.createFunction(
  { id: "daily-maintenance", triggers: [{ cron: "TZ=UTC 17 3 * * *" }], retries: 1 },
  async ({ step }) => {
    const purges = await step.run("purges", () => runStep("maintenance.purges", async (deps) => (await import("@edf/pipeline")).runPurges(deps, 120_000)));
    const maintenance = await step.run("maintenance", () =>
      runStep("maintenance.run", async (deps) => {
        const { runGovernor } = await import("@edf/budget");
        const gov = await runGovernor(deps.pool).catch(() => null);
        const storageMb = gov?.result.neonStorageMb ?? 0;
        return (await import("@edf/pipeline")).runMaintenance(deps, {
          budgetMs: 200_000,
          storageL1: storageMb >= 250,
          storageL2: storageMb >= 300,
        });
      }),
    );
    return { purges, maintenance };
  },
);

/** Bulk delete after a disconnect, after a 10-minute grace for in-flight steps (§4.7, §4.9). */
export const mailboxDisconnect = inngest.createFunction(
  { id: "mailbox-disconnect", triggers: [{ event: "mailbox/disconnected" }], retries: 3 },
  async ({ event, step }) => {
    await step.sleep("grace", "10m");
    const mb = { mailboxId: String(event.data.mailboxId), userId: String(event.data.userId) };
    for (let i = 0; i < 10; i++) {
      const done = await step.run(`purge-${i}`, () => runStep("disconnect.purge", async (deps) => (await import("@edf/pipeline")).purgeMailbox(deps, mb, 200_000)));
      if (done === true || isSkipped(done)) return { done };
    }
    return { done: false };
  },
);

/** Planning rounds per render run: the budget of the "loop until the queue is empty" rule (§4.7). */
export const MAX_RENDER_ROUNDS = 10;

/**
 * How long before a run's first plan the nightly cron counts as still ahead of it: a cron that fires
 * a few seconds late, while this run was starting, is dropped by the singleton just the same.
 */
export const NIGHTLY_CRON_GRACE_MS = 60_000;

/** The first nightly cron time (04:30 UTC, the render-batch cron) strictly after `ms`. */
export function nextNightlyAfter(ms: number): number {
  const d = new Date(ms);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 4, 30);
  return at > ms ? at : at + 86_400_000;
}

/**
 * Renders (FREE-TIER.md §5.1): the nightly batch plus on-demand requests and the owner's fresh
 * batches (render/requested from a click or the tick; @edf/pipeline render-policy.ts). One `render-user-{u}` step
 * per user, each with its own VM and a 230 s budget; errors are caught inside the step (the function
 * has retries 0, so a render is never paid for twice). While a run is active, new render/requested
 * events are dropped (singleton skip), so the run re-plans until no on-demand work remains, a round
 * picks nothing up, or MAX_RENDER_ROUNDS is used up; the tick re-sends the event for anything left.
 * The nightly cron is dropped the same way: an on-demand run still active at 04:30 UTC makes its
 * next round (or one extra round after its last) a nightly one, so that day's batch is not lost.
 */
export const renderBatch = inngest.createFunction(
  {
    id: "render-batch",
    triggers: [{ cron: "TZ=UTC 30 4 * * *" }, { event: "render/requested" }],
    singleton: { key: '"global"', mode: "skip" },
    retries: 0,
  },
  async ({ event, step }) => {
    const trigger = event.name === "render/requested" ? "on_demand" : "nightly";
    const results: unknown[] = [];
    let nightlyDone = trigger === "nightly";
    let startedAt: number | null = null; // the first plan's time (step results are memoized, so replays agree)
    const nightlyMissed = (now: number) =>
      !nightlyDone && startedAt !== null && now >= nextNightlyAfter(startedAt - NIGHTLY_CRON_GRACE_MS);
    /** One planning round and its render steps; null when the plan was empty (or skipped). */
    const round = async (label: string, next: (now: number) => "nightly" | "on_demand") => {
      const planned = await step.run(`plan-${label}`, () =>
        runStep("render.plan", async (deps) => {
          const now = Date.now();
          const kind = next(now);
          return { kind, at: now, plan: await (await import("@edf/pipeline")).planRenders(deps, kind) };
        }),
      );
      if (isSkipped(planned)) return null;
      startedAt ??= planned.at;
      if (planned.kind === "nightly") nightlyDone = true;
      if (planned.plan.length === 0) return null;
      let picked = 0;
      for (const item of planned.plan) {
        const r = await step.run(`render-user-${label}-${item.userId}`, () =>
          runStep("render.user", async (deps) => (await import("@edf/pipeline")).renderForUser(deps, item.userId, item.options)),
        );
        results.push(r);
        // A RenderSummary with `skipped: null` rendered; one with a reason (no renderer, the
        // governor, a renderer error) or runStep's own skip made no progress.
        if (!isSkipped(r)) picked += r.picked;
      }
      return { kind: planned.kind, picked };
    };

    for (let i = 0; i < MAX_RENDER_ROUNDS; i++) {
      const r = await round(String(i), (now) => (i === 0 ? trigger : nightlyMissed(now) ? "nightly" : "on_demand"));
      if (!r) break;
      // An on-demand round that picked nothing up (renderer down, governor stop) would re-plan the same users.
      if (r.picked === 0 && r.kind === "on_demand") break;
    }
    const endedAt = await step.run("heartbeat", () =>
      runStep("render.heartbeat", async (deps) => {
        await (await import("@edf/pipeline")).heartbeat(deps, "last_render_batch_at");
        return Date.now();
      }),
    );
    // The nightly cron fired after this run's last plan (while it rendered or finished) and was dropped.
    if (!isSkipped(endedAt) && nightlyMissed(endedAt)) {
      await round("nightly", () => "nightly");
      await step.run("heartbeat-nightly", () =>
        runStep("render.heartbeat", async (deps) => (await import("@edf/pipeline")).heartbeat(deps, "last_render_batch_at")),
      );
    }
    return { trigger, results: results.length };
  },
);

export const FUNCTIONS = [pipelineTick, mailboxBackfill, renderBatch, dailyMaintenance, mailboxDisconnect];
