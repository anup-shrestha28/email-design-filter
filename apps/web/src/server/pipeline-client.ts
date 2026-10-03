/**
 * Event emission towards the background pipeline (FREE-TIER.md §4.2, §4.4, §4.9).
 * A failed send never fails the user's request: the daily cron + sync-on-open keep the app
 * working, and a quota/paused failure sets `system_state.inngest_paused` (Plan B).
 */
import "server-only";
import { withSystem } from "@edf/db";
import { getPool } from "./db";
import { inngest, type EdfEvent } from "./inngest/client";

export async function emit(event: EdfEvent, id?: string): Promise<boolean> {
  try {
    await inngest.send({ ...event, ...(id ? { id } : {}) });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/quota|paused|limit|429|402/i.test(msg)) {
      const pool = await getPool();
      await withSystem(pool, (_db, c) => c.query("UPDATE system_state SET inngest_paused = true, updated_at = now()")).catch(() => {});
    }
    return false;
  }
}

/** Ask the render batch to run soon (on-demand requests get their own VM immediately). */
export function requestRender(userId: string): Promise<boolean> {
  return emit({ name: "render/requested", data: { userId } }, `render-${userId}-${Math.floor(Date.now() / 60_000)}`);
}

/** Sync-on-open kick; repeat kicks are dropped for 10 minutes by the event id (FREE-TIER.md §4.4). */
export function kickAfterSync(userId: string): Promise<boolean> {
  return emit({ name: "pipeline/kick", data: { reason: "sync_on_open" } }, `kick-${userId}-${Math.floor(Date.now() / 600_000)}`);
}
