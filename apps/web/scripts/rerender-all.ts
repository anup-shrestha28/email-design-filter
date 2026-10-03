/**
 * DEVELOPMENT ONLY — queue one fresh render of every designable email of a local account, so the
 * normal render-batch job re-renders them with the current renderer. render-2026.3 measures each
 * design's visible content extent (`layout.content`), which the gallery card crops to; emails
 * rendered before it (or never rendered: static / template coverage) show the whole canvas.
 *
 *   pnpm --filter @edf/web rerender-all [--email demo@edf.local] [--all] [--dry-run] [--trigger]
 *   pnpm --filter @edf/web rerender-all --status [--email demo@edf.local]
 *
 * Queues an on-demand render request (no AI review) for each email of the account that is not
 * hidden, not security-sensitive, analysed (`design_status = 'done'`) and in an active mailbox —
 * skipping emails whose own render already measured the extent (`--all` queues those too). An email
 * already queued for a sample or fill render becomes an on-demand one; requests already on demand or
 * running are left alone. Nothing is rendered here: the render-batch job (Inngest, `pnpm dev:jobs`,
 * local Chrome with RENDERER=local) does that through the real pipeline — Gmail refetch, image
 * policy, render, rescore, store — about 20 emails per round, 10 rounds per run. The pipeline tick
 * re-sends render/requested every :00 and :30 while on-demand work is queued, so the queue drains
 * by itself; `--trigger` (or the curl command printed at the end) starts a run now. Re-running the
 * script later queues only what still lacks the extent (on-demand requests that fail aren't
 * retried by the job). `--status` prints progress and changes nothing.
 *
 * The daily "Analyze this email" allowance (src/server/limits.ts ON_DEMAND_LIMITS) is checked by
 * that action only; these maintenance requests are dated just before today's UTC midnight so they
 * don't use up today's allowance or show up as today's usage on the email page.
 *
 * Safety: refuses to run against anything but a local database (and in production / on Vercel).
 */
import { createPool, withUser, type pg } from "@edf/db";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const emailArg = args.indexOf("--email");
const email = (emailArg >= 0 ? (args[emailArg + 1] ?? "") : "demo@edf.local").trim().toLowerCase();
const all = flag("--all");
const dryRun = flag("--dry-run");
const statusOnly = flag("--status");
const trigger = flag("--trigger");

const dbUrl = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(dbUrl).hostname;
  } catch {
    return "";
  }
})();
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  process.env.NODE_ENV === "production" ||
  process.env.VERCEL
) {
  console.error("rerender-all only runs against a local database.");
  process.exit(1);
}

/** The local Inngest Dev Server (`pnpm dev:jobs`); it accepts events under any key. */
const INNGEST_DEV_URL = (process.env.INNGEST_BASE_URL ?? "http://127.0.0.1:8288").replace(
  /\/+$/,
  "",
);
const EVENT_URL = `${INNGEST_DEV_URL}/e/${process.env.INNGEST_EVENT_KEY ?? "dev"}`;
/** The event the render-batch job runs on for on-demand work (payload: ids only, none needed). */
const RENDER_EVENT = { name: "render/requested", data: { reason: "sweep" } };

/** Emails a render can cover (the render step's own checks, and the gallery's list). */
const DESIGNABLE = `e.user_id = $1 AND e.design_status = 'done' AND NOT e.security_sensitive AND NOT e.is_hidden
  AND EXISTS (SELECT 1 FROM mailbox m WHERE m.id = e.mailbox_id AND m.status = 'active')`;
/** The email's own render measured the visible content extent (render-2026.3 or later). */
const MEASURED = `e.design_source = 'render' AND coalesce(a.features #> '{render,layout}' ? 'content', false)`;

interface Status {
  designable: number;
  measured: number;
  byState: Array<{ kind: string; state: string; error: string | null; n: number }>;
}

async function status(c: pg.PoolClient, userId: string): Promise<Status> {
  const counts = await c.query<{ designable: string; measured: string }>(
    `SELECT count(*) AS designable, count(*) FILTER (WHERE ${MEASURED}) AS measured
     FROM email e LEFT JOIN email_analysis a ON a.email_id = e.id WHERE ${DESIGNABLE}`,
    [userId],
  );
  const states = await c.query<{ kind: string; state: string; error: string | null; n: string }>(
    `SELECT kind, state, error, count(*) AS n FROM render_request
     WHERE user_id = $1 AND (state IN ('queued', 'running') OR updated_at > now() - interval '1 day')
     GROUP BY 1, 2, 3 ORDER BY 2, 1, 3`,
    [userId],
  );
  return {
    designable: Number(counts.rows[0]?.designable ?? 0),
    measured: Number(counts.rows[0]?.measured ?? 0),
    byState: states.rows.map((r) => ({ ...r, n: Number(r.n) })),
  };
}

function printStatus(s: Status): void {
  console.log(
    `${email}: ${s.measured} of ${s.designable} designable emails have a render that measured the content extent.`,
  );
  if (s.byState.length === 0) return;
  console.log("Render requests (active, or updated in the last day):");
  for (const r of s.byState)
    console.log(
      `  ${r.state.padEnd(8)} ${r.kind.padEnd(10)} ${String(r.n).padStart(5)}${r.error ? `  (${r.error})` : ""}`,
    );
}

/** Why the render-batch job won't render on-demand requests now, or null (@edf/pipeline render-plan). */
async function renderBlocker(c: pg.PoolClient): Promise<string | null> {
  const r = await c.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM app_setting WHERE key IN ('governor', 'kill.render')",
  );
  const v = new Map(r.rows.map((x) => [x.key, x.value]));
  if (v.get("kill.render") === true)
    return "the owner's emergency stop for renders (app_setting kill.render) is on";
  const gov = (v.get("governor") ?? {}) as { level?: number; actions?: Record<string, unknown> };
  if (Number(gov.level ?? 0) >= 3) return "the budget governor is at level 3 (no renders)";
  if (gov.actions?.rendersOff === true)
    return "the budget governor has renders off (Sandbox static-only stage)";
  if (gov.actions?.rendersNightlyOnly === true)
    return "the budget governor has renders nightly-only (Inngest soft cap): on-demand runs plan nothing until the 04:30 UTC run";
  return null;
}

async function sendRenderEvent(): Promise<void> {
  try {
    const res = await fetch(EVENT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(RENDER_EVENT),
      signal: AbortSignal.timeout(5_000),
    });
    console.log(
      res.ok
        ? `Sent render/requested to ${INNGEST_DEV_URL}.`
        : `The Inngest Dev Server answered ${res.status}.`,
    );
  } catch {
    console.error(
      `Couldn't reach the Inngest Dev Server at ${INNGEST_DEV_URL} — is \`pnpm dev:jobs\` running?`,
    );
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: dbUrl, max: 2, applicationName: "edf-rerender-all" });
  try {
    const user = await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
      email,
    ]);
    const userId = user.rows[0]?.id;
    if (!userId) {
      console.error(`No user ${email}.`);
      process.exit(1);
    }
    if (statusOnly) {
      printStatus(await withUser(pool, userId, (_db, c) => status(c, userId)));
      return;
    }
    if (process.env.RENDERER !== "local")
      console.warn(
        `Warning: RENDERER is "${process.env.RENDERER ?? ""}" in apps/web/.env.local — the dev server renders with local Chrome only when it is "local".`,
      );
    const result = await withUser(pool, userId, async (_db, c) => {
      const blocker = await renderBlocker(c);
      const targets = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM email e LEFT JOIN email_analysis a ON a.email_id = e.id
         WHERE ${DESIGNABLE} AND ($2 OR NOT (${MEASURED}))`,
        [userId, all],
      );
      if (dryRun)
        return { blocker, targets: Number(targets.rows[0]?.n ?? 0), inserted: 0, converted: 0 };
      // Newest first (pickWork takes the oldest request first), each a millisecond apart, all just
      // before today's UTC midnight (see the header: the daily allowance counts today's requests).
      const r = await c.query<{ inserted: boolean }>(
        `WITH t AS (
           SELECT e.id, row_number() OVER (ORDER BY e.received_at DESC, e.id) AS rn
           FROM email e LEFT JOIN email_analysis a ON a.email_id = e.id
           WHERE ${DESIGNABLE} AND ($2 OR NOT (${MEASURED}))
         )
         INSERT INTO render_request (user_id, email_id, kind, want_ai, requested_at)
         SELECT $1, t.id, 'on_demand', false,
                date_trunc('day', now()) - interval '1 hour' + t.rn * interval '1 millisecond'
         FROM t
         ON CONFLICT (email_id) WHERE state IN ('queued', 'running') DO UPDATE
           SET kind = 'on_demand', requested_at = EXCLUDED.requested_at, error = NULL, updated_at = now()
           WHERE render_request.state = 'queued' AND render_request.kind <> 'on_demand'
         RETURNING (xmax = 0) AS inserted`,
        [userId, all],
      );
      return {
        blocker,
        targets: Number(targets.rows[0]?.n ?? 0),
        inserted: r.rows.filter((x) => x.inserted).length,
        converted: r.rows.filter((x) => !x.inserted).length,
      };
    });
    const left = result.targets - result.inserted - result.converted;
    console.log(
      dryRun
        ? `Dry run: ${result.targets} emails of ${email} would be queued for a render${all ? "" : " (those without a measured content extent)"}.`
        : `Queued ${result.inserted} new on-demand renders for ${email}, turned ${result.converted} queued sample/fill renders into on-demand ones` +
            (left > 0 ? `; ${left} already had an on-demand or running request.` : "."),
    );
    if (result.blocker) console.warn(`Warning: nothing will render yet — ${result.blocker}.`);
    printStatus(await withUser(pool, userId, (_db, c) => status(c, userId)));
    if (dryRun) return;
    if (trigger) await sendRenderEvent();
    else
      console.log(
        `\nThe pipeline tick starts a render run at the next :00 / :30 (with \`pnpm dev\` and \`pnpm dev:jobs\` running). To start one now:\n` +
          `  curl -s -X POST ${EVENT_URL} -H 'content-type: application/json' -d '${JSON.stringify(RENDER_EVENT)}'\n` +
          `Progress: pnpm --filter @edf/web rerender-all --status`,
      );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
