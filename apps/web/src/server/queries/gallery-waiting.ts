/**
 * The real render state behind an unscored gallery card: its render request, the user's render
 * queue and fill batches, fresh renders' monthly allowance, and the governor's switches, for
 * lib/gallery-waiting.ts `waitingFor`.
 * Runs inside the gallery query's transaction (RLS-scoped to the user), one query for the user
 * and one for the page's unscored emails; nothing when every design on the page has a score.
 *
 * The candidate conditions mirror @edf/pipeline (render-policy.ts FRESH_CANDIDATE_SQL, render.ts
 * pickWork's nightly fill); the tests check both count the same emails.
 */
import "server-only";
import { calibrationFactor, FREE_TIER_PROFILE, RESOURCES, resourceSpec } from "@edf/budget";
import { raw, sql, type SQL } from "@edf/db";
import { rendererSetUp } from "@/env";
import type { Db } from "@edf/db";
import {
  RENDER_SCHEDULE,
  waitingFor,
  type RenderSwitches,
  type WaitingInput,
} from "@/lib/gallery-waiting";
import type { GalleryItem } from "./types";

/** A fresh-render candidate (`alias`: an `email` row of the user). */
export function freshCandidate(alias: string): SQL {
  const e = sql.raw(alias);
  return sql`${e}.received_at > now() - make_interval(hours => ${RENDER_SCHEDULE.freshWindowHours}::int)
    AND ${e}.design_status = 'done' AND ${e}.design_source = 'static'
    AND NOT ${e}.security_sensitive AND NOT ${e}.is_hidden
    AND EXISTS (SELECT 1 FROM mailbox m WHERE m.id = ${e}.mailbox_id AND m.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM render_request r WHERE r.email_id = ${e}.id)`;
}

/** A nightly fill candidate (render.ts pickWork). */
export function nightlyFillCandidate(alias: string): SQL {
  const e = sql.raw(alias);
  return sql`${e}.received_at > now() - make_interval(days => ${RENDER_SCHEDULE.fillWindowDays}::int)
    AND ${e}.design_status = 'done' AND ${e}.design_source IN ('static', 'template')
    AND NOT ${e}.security_sensitive AND NOT ${e}.is_hidden
    AND EXISTS (SELECT 1 FROM mailbox m WHERE m.id = ${e}.mailbox_id AND m.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM render_request r WHERE r.email_id = ${e}.id AND r.state IN ('queued', 'running'))`;
}

/** render.ts pickWork's order for queued requests: on-demand, then samples, then fill; oldest first. */
const KIND_RANK = (alias: string) =>
  sql.raw(`(CASE ${alias}.kind WHEN 'on_demand' THEN 0 WHEN 'exemplar' THEN 1 ELSE 2 END)`);

interface UserRow {
  role: "owner" | "friend" | null;
  governor: RenderSwitches | null;
  kill_render: unknown;
  inngest_paused: boolean | null;
  fill_batches_24h: number;
  fresh_cpu_s: string | number | null;
  calibration: unknown;
  q_on_demand: number;
  q_exemplar: number;
  q_fill: number;
}

interface ItemRow {
  id: string;
  received_at: Date;
  design_status: string;
  design_source: string;
  last_failed: boolean | null;
  req_kind: "on_demand" | "exemplar" | "fill" | null;
  req_state: "queued" | "running" | null;
  queued_ahead: number | null;
  ever_requested: boolean;
  fresh_ahead: number | null;
  fill_ahead: number | null;
}

/** `items` with `waiting` set on the unscored ones (the others are returned as they are). */
export async function withWaiting(
  db: Db,
  userId: string,
  items: GalleryItem[],
  now = Date.now(),
): Promise<GalleryItem[]> {
  const ids = items.filter((i) => i.score === null).map((i) => i.id);
  if (ids.length === 0) return items;
  const idList = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const u = (
    await raw(db).execute<UserRow>(sql`
      SELECT (SELECT role FROM user_settings WHERE user_id = ${userId}) AS role,
             (SELECT value FROM app_setting WHERE key = 'governor') AS governor,
             (SELECT value FROM app_setting WHERE key = 'kill.render') AS kill_render,
             (SELECT inngest_paused FROM system_state) AS inngest_paused,
             (SELECT count(DISTINCT requested_at)::int FROM render_request
               WHERE user_id = ${userId} AND kind = 'fill' AND requested_at > now() - interval '24 hours') AS fill_batches_24h,
             (SELECT sum(amount) FROM usage_ledger
               WHERE resource = ${RENDER_SCHEDULE.freshCpuResource} AND day > current_date - 30) AS fresh_cpu_s,
             (SELECT value FROM app_setting WHERE key = 'calibration') AS calibration,
             count(*) FILTER (WHERE q.kind = 'on_demand')::int AS q_on_demand,
             count(*) FILTER (WHERE q.kind = 'exemplar')::int AS q_exemplar,
             count(*) FILTER (WHERE q.kind = 'fill')::int AS q_fill
      FROM render_request q WHERE q.user_id = ${userId} AND q.state = 'queued'`)
  ).rows[0];
  const rows = (
    await raw(db).execute<ItemRow>(sql`
      SELECT e.id, e.received_at, e.design_status, e.design_source, r.kind AS req_kind, r.state AS req_state,
             (SELECT r3.state = 'failed' FROM render_request r3 WHERE r3.email_id = e.id
               ORDER BY r3.updated_at DESC LIMIT 1) AS last_failed,
             CASE WHEN r.state = 'queued' THEN (
               SELECT count(*)::int FROM render_request q
               WHERE q.user_id = ${userId} AND q.state = 'queued'
                 AND (${KIND_RANK("q")}, q.requested_at, q.id) < (${KIND_RANK("r")}, r.requested_at, r.id)
             ) END AS queued_ahead,
             EXISTS (SELECT 1 FROM render_request r2 WHERE r2.email_id = e.id) AS ever_requested,
             CASE WHEN e.received_at > now() - make_interval(hours => ${RENDER_SCHEDULE.freshWindowHours}::int) THEN (
               SELECT count(*)::int FROM email f
               WHERE f.user_id = ${userId} AND ${freshCandidate("f")} AND f.received_at > e.received_at
             ) END AS fresh_ahead,
             CASE WHEN e.received_at > now() - make_interval(days => ${RENDER_SCHEDULE.fillWindowDays}::int) THEN (
               SELECT count(*)::int FROM email f
               WHERE f.user_id = ${userId} AND ${nightlyFillCandidate("f")} AND f.received_at > e.received_at
             ) END AS fill_ahead
      FROM email e
      LEFT JOIN render_request r ON r.email_id = e.id AND r.user_id = e.user_id AND r.state IN ('queued', 'running')
      WHERE e.user_id = ${userId} AND e.id = ANY(${idList})`)
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // The same rule as the pipeline's renderer (server/pipeline-deps.ts makeRenderer): none, nothing renders.
  const rendererOff = !rendererSetUp();
  // Fresh renders' own allowance, read as render-plan.ts freshCpuUsed reads it (× sandbox_cpu calibration).
  const cal = u?.calibration;
  const sandboxFactor = calibrationFactor(
    FREE_TIER_PROFILE,
    cal && typeof cal === "object" ? (cal as Record<string, number>) : {},
    resourceSpec(FREE_TIER_PROFILE, RESOURCES.sandboxCpuS)?.calibrationKey ?? null,
  );
  const user: WaitingInput["user"] = {
    fillBatches24h: Number(u?.fill_batches_24h ?? 0),
    freshCpuS30d: Number(u?.fresh_cpu_s ?? 0) * sandboxFactor,
    queued: {
      onDemand: Number(u?.q_on_demand ?? 0),
      exemplar: Number(u?.q_exemplar ?? 0),
      fill: Number(u?.q_fill ?? 0),
    },
  };
  return items.map((item) => {
    const r = item.score === null ? byId.get(item.id) : undefined;
    if (!r) return item;
    const waiting = waitingFor({
      now,
      role: u?.role === "owner" ? "owner" : "friend",
      governor: u?.governor ?? null,
      rendersKilled: u?.kill_render === true,
      jobsPaused: u?.inngest_paused === true,
      rendererOff,
      user,
      item: {
        receivedAt: r.received_at.toISOString(),
        designStatus: r.design_status,
        designSource: r.design_source,
        lastFailed: r.last_failed === true,
        mailboxActive: item.previewable,
        request: r.req_kind && r.req_state ? { kind: r.req_kind, state: r.req_state } : null,
        queuedAhead: r.queued_ahead,
        everRequested: r.ever_requested,
        freshAhead: r.fresh_ahead,
        fillAhead: r.fill_ahead,
      },
    });
    return { ...item, waiting };
  });
}
