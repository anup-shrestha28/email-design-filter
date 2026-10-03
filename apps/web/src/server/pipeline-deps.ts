/**
 * Builds the pipeline's dependencies from edf-app's environment. Server-only; lazily constructed.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withSystem } from "@edf/db";
import { TokenProvider } from "@edf/gmail";
import type { GovernorLevel, PipelineDeps, RendererLike } from "@edf/pipeline";
import { env, IS_PROD, rendererSetUp } from "@/env";
import { getPool } from "./db";
import { accessTokenKeys, keyWrapper } from "./keys";

let cached: Promise<PipelineDeps> | null = null;

async function governorLevel(): Promise<GovernorLevel> {
  const pool = await getPool();
  return withSystem(pool, async (_db, c) => {
    const r = await c.query<{ value: { level?: number } }>("SELECT value FROM app_setting WHERE key = 'governor'");
    const lvl = Number(r.rows[0]?.value?.level ?? 0);
    return (lvl === 1 || lvl === 2 || lvl === 3 ? lvl : 0) as GovernorLevel;
  });
}

export function connectorOAuth(): { clientId: string; clientSecret: string } {
  const e = env();
  if (!e.GOOGLE_CONNECTOR_CLIENT_ID || !e.GOOGLE_CONNECTOR_CLIENT_SECRET) {
    throw new Error("GOOGLE_CONNECTOR_CLIENT_ID/SECRET are not configured");
  }
  return { clientId: e.GOOGLE_CONNECTOR_CLIENT_ID, clientSecret: e.GOOGLE_CONNECTOR_CLIENT_SECRET };
}

/**
 * The renderer seam (FREE-TIER.md §12): Vercel Sandbox in production (a deny-all microVM per batch),
 * local Chromium in development, or none. Loaded lazily so ordinary requests never import it.
 * VM time is metered by the tick's sweep from the Sandbox API (sweepAndMeterSandboxes), never here.
 */
/**
 * The VM's render code (packages/render/dist/render.js, traced into the Inngest function by
 * next.config.ts). Written into every VM so app and VM code always match; if it can't be read, the
 * snapshot's own copy runs instead.
 */
async function readRenderBundle(): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path.resolve(process.cwd(), "../../packages/render/dist/render.js")));
  } catch {
    console.warn(JSON.stringify({ event: "render.bundle_missing" }));
    return undefined;
  }
}

async function makeRenderer(): Promise<RendererLike | null> {
  const e = env();
  // The same rule "Analyze", the email page and the gallery use (env.ts rendererSetUp).
  if (!rendererSetUp(e)) return null;
  try {
    const render = await import("@edf/render");
    if (e.RENDERER === "sandbox") {
      const snapshotId = e.SANDBOX_SNAPSHOT_ID;
      if (!snapshotId) return null;
      const bundle = await readRenderBundle();
      return {
        host: "sandbox",
        renderBatch: (jobs, opts) => new render.SandboxRenderer({ snapshotId, bundle }).renderBatch(jobs, { deadlineMs: opts.deadlineMs }),
      };
    }
    const executablePath = e.CHROME_PATH ?? "/usr/bin/google-chrome";
    return {
      host: "local",
      renderBatch: (jobs, opts) => new render.LocalChromiumRenderer({ executablePath }).renderBatch(jobs, { deadlineMs: opts.deadlineMs }),
    };
  } catch {
    return null;
  }
}

export function pipelineDeps(): Promise<PipelineDeps> {
  cached ??= (async () => {
    const pool = await getPool();
    const e = env();
    const oauth = e.GOOGLE_CONNECTOR_CLIENT_ID && e.GOOGLE_CONNECTOR_CLIENT_SECRET
      ? { clientId: e.GOOGLE_CONNECTOR_CLIENT_ID, clientSecret: e.GOOGLE_CONNECTOR_CLIENT_SECRET }
      : { clientId: "unconfigured", clientSecret: "unconfigured" };
    const tokens = new TokenProvider({ pool, keyWrapper: keyWrapper(), accessRing: accessTokenKeys(), oauth });
    // Claude Opus 5 (the only paid service). SDK retries are off: we never pay twice for one request.
    const anthropic = e.ANTHROPIC_API_KEY
      ? new (await import("@anthropic-ai/sdk")).default({ apiKey: e.ANTHROPIC_API_KEY, maxRetries: 0 })
      : null;
    const fixtures = IS_PROD ? null : await import("./fixtures");
    return {
      pool,
      tokens,
      tickEvery: e.TICK_EVERY === "60" ? 60 : 30,
      governorLevel,
      alerts: { token: e.GITHUB_ALERT_TOKEN, repo: e.GITHUB_ALERT_REPO },
      anthropic,
      renderer: await makeRenderer(),
      // Orphan stops + exactly-once VM metering from the Sandbox API (FREE-TIER.md §5.1), every tick.
      sweepSandboxes:
        e.RENDERER === "sandbox"
          ? async (o) => {
              const render = await import("@edf/render");
              return render.sweepSandboxes(render.vercelSandboxOps, o);
            }
          : null,
      rawSourceFor: fixtures
        ? (mb) => (fixtures.isFixtureAccount(mb.providerAccountId) ? (id: string) => fixtures.readFixtureRaw(id) : null)
        : undefined,
      log: IS_PROD
        ? (event, fields) => console.info(JSON.stringify({ event, ...fields }))
        : (event, fields) => console.debug(`[edf] ${event}`, fields ?? {}),
    } satisfies PipelineDeps;
  })().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
