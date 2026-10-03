/**
 * The Inngest client (FREE-TIER.md §4.7). Payloads carry IDs only — never tokens or content.
 * Only production is synced to Inngest Cloud; locally the Inngest Dev Server is used if running.
 */
import { Inngest } from "inngest";
import { executionMeter } from "./execution-meter";

export const inngest = new Inngest({
  id: "edf",
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Keep the SDK's extended OpenTelemetry tracing off (500 MB/month span cap on Free).
  optimizeParallelism: true,
  // +1 per run, +1 per step, into the instance meter (FREE-TIER.md §8.1); loaded on first use.
  // Written only while the database is awake (a metering write never wakes Neon).
  middleware: [
    executionMeter(
      async () => (await import("../metering")).instanceMeter(),
      async () => (await import("../metering")).databaseAwake(),
    ),
  ],
});

export type EdfEvent =
  | { name: "pipeline/kick"; data: { reason: "sync_on_open" | "continuation" | "connect" | "manual" } }
  // `sweep`: the tick re-sending for on-demand requests still queued; `fresh`: the tick asking for a
  // fresh batch (@edf/pipeline render-policy.ts). Neither event carries work itself.
  | { name: "render/requested"; data: { userId: string } | { reason: "sweep" | "fresh" } }
  | { name: "mailbox/connected"; data: { mailboxId: string; userId: string; generation: number } }
  | { name: "backfill/requested"; data: { mailboxId: string; userId: string } }
  | { name: "mailbox/disconnected"; data: { mailboxId: string; userId: string } };
