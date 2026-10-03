/**
 * Dependencies of the plain-function job bodies (FREE-TIER.md §4.9: "the job bodies are plain
 * functions that the Inngest steps wrap"), injected so the same code runs from Inngest, the daily
 * cron (Plan B), sync-on-open and tests.
 */
import { GmailClient, type TokenProvider } from "@edf/gmail";
import { withSystem, type pg } from "@edf/db";
import type { RenderJob, RenderOutcome } from "@edf/design";
import type Anthropic from "@anthropic-ai/sdk";
import type { AlertConfig } from "./alerts";

export type GovernorLevel = 0 | 1 | 2 | 3;

/** Content-free structured events: codes, counts and ids only. */
export type LogFn = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

/** The renderer seam (FREE-TIER.md §12 `Renderer`): Sandbox, local Chromium, Browser Run, Oracle. */
export interface RendererLike {
  readonly host: string;
  renderBatch(jobs: RenderJob[], opts: { deadlineMs: number }): Promise<RenderOutcome[]>;
}

/** One sweep of the account's Sandbox VMs (@edf/render `sweepSandboxes`), for metering and orphan stops. */
export interface SandboxSweepLike {
  stopped: string[];
  stopFailed: string[];
  finished: Array<{ name: string; createdAt: Date; stoppedAt: Date; vcpus: number }>;
}

/** Development only: raw messages for fixture mailboxes instead of Gmail. */
export type RawSourceFor = (mb: { userId: string; mailboxId: string; providerAccountId: string }) =>
  | ((messageId: string) => Promise<Uint8Array | null>)
  | null;

export interface PipelineDeps {
  pool: pg.Pool;
  tokens: TokenProvider;
  /** Gmail client per mailbox; defaults to one backed by the token provider. */
  gmailFor?: (userId: string, mailboxId: string) => GmailClient;
  now?: () => Date;
  log?: LogFn;
  tickEvery: 30 | 60;
  governorLevel: () => Promise<GovernorLevel>;
  alerts?: AlertConfig;
  renderer?: RendererLike | null;
  rawSourceFor?: RawSourceFor;
  /** Claude client (only Opus 5 via `AI_MODEL`); absent → AI is simply not run. */
  anthropic?: Anthropic | null;
  /** Sandbox renderer only: list VMs since `since`, stop render VMs older than 250 s (§5.1 "Metering"). */
  sweepSandboxes?: ((opts: { now: Date; since: Date }) => Promise<SandboxSweepLike>) | null;
}

export function gmailClient(deps: PipelineDeps, userId: string, mailboxId: string): GmailClient {
  return deps.gmailFor
    ? deps.gmailFor(userId, mailboxId)
    : new GmailClient({ getAccessToken: deps.tokens.forMailbox(userId, mailboxId) });
}

export const nowOf = (deps: PipelineDeps): Date => (deps.now ? deps.now() : new Date());
export const logOf = (deps: PipelineDeps): LogFn => deps.log ?? (() => {});

/** The pipeline stages with an emergency stop (`app_setting` "kill.<stage>", seeded by migration 0002). */
export type KillStage = "ingest" | "render" | "ai" | "backfill";

/**
 * Whether the owner switched a pipeline stage off (DESIGN.md §11.8 "global kill switches per
 * pipeline stage"; FREE-TIER.md: app_setting rows, instant, no redeploy). Only a JSON `true` stops
 * the stage; a missing or unreadable row leaves it running.
 *  - ingest: no Gmail polling (tick, sync-on-open, Plan B) and no drain;
 *  - render: no render VM, planned or on-demand;
 *  - ai: no Claude call (read by `aiState`);
 *  - backfill: no import is admitted (a listing already running finishes; its rows drain unless
 *    ingest is off too).
 */
export async function killSwitchOn(pool: pg.Pool, stage: KillStage): Promise<boolean> {
  return withSystem(pool, async (_db, c) => {
    const r = await c.query<{ value: unknown }>("SELECT value FROM app_setting WHERE key = $1", [`kill.${stage}`]);
    return r.rows[0]?.value === true;
  });
}

/** sha256-free, short, non-reversible mailbox tag for logs (the id is already opaque; never log addresses). */
export function mailboxTag(mailboxId: string): string {
  return mailboxId.slice(-8);
}
