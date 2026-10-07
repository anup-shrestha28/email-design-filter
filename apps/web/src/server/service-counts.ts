/**
 * Counters POSTed by edf-view (/api/view-stats) and edf-keys (/api/keys-audit): codes and integers
 * only, written as one audit_log row per report plus usage-ledger totals (FREE-TIER.md §8.1, §9.2).
 * The `view.*` / `keys.*` rows are diagnostics; the amounts the governor acts on are edf-view's
 * served image bytes, metered as Fast Origin Transfer (below), and its CPU time (mostly shrinking
 * images), metered as Vercel Active CPU.
 *
 * edf-view's counts are its Vercel functions' traffic, and the governor reads them (the FOT caps;
 * `view.view_requests` / `view.img_requests` in its external-load spike watch), so their ledger
 * rows are written only where Vercel usage is metered (`platformMetering().vercel`: on Vercel — any
 * production build whose database isn't on this machine counts, even without `VERCEL` — or with
 * `EDF_METER_LOCAL=1`); the audit_log row with all the counts is written everywhere. A local
 * edf-view reports to the local edf-app and production accepts only Vercel-issued tokens, so the
 * receiver's platform is the reporter's. `keys.*` rows are recorded everywhere (the governor never
 * reads them). packages/budget/DECISIONS.md, "Local development".
 */
import "server-only";
import { z } from "zod";
import { platformMetering, RESOURCES, utcDay } from "@edf/budget";
import { withSystem } from "@edf/db";
import { getPool } from "./db";

const bodySchema = z
  .object({
    v: z.literal(1),
    windowStart: z.number().int().positive(),
    windowEnd: z.number().int().positive(),
    counts: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.number().int().min(0).max(10_000_000)),
  })
  .refine((b) => Object.keys(b.counts).length <= 50 && b.windowEnd >= b.windowStart && b.windowEnd - b.windowStart <= 86_400);

export async function recordServiceCounts(actor: "edf-view" | "edf-keys", request: Request): Promise<boolean> {
  const text = await request.text();
  if (text.length > 4096) return false;
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(JSON.parse(text));
  } catch {
    return false;
  }
  const pool = await getPool();
  // The meter's day (UTC), so these rows and the Fast Origin Transfer row land where the governor
  // and the rest of the meter put them.
  const day = utcDay(new Date());
  await withSystem(pool, async (_db, c) => {
    await c.query(`INSERT INTO audit_log (actor, action, metadata) VALUES ($1, $2, $3)`, [
      actor,
      actor === "edf-view" ? "view.stats" : "keys.audit",
      JSON.stringify({ windowStart: parsed.windowStart, windowEnd: parsed.windowEnd, counts: parsed.counts }),
    ]);
    // edf-view's traffic is Vercel usage: off Vercel (pnpm dev) only the audit row above.
    if (actor === "edf-view" && !platformMetering().vercel) return;
    const prefix = actor === "edf-view" ? "view" : "keys";
    for (const [code, n] of Object.entries(parsed.counts)) {
      if (n > 0) await c.query("SELECT add_usage($1::date, $2, $3)", [day, `${prefix}.${code}`, n]);
    }
    const imageBytes = actor === "edf-view" ? viewImageOriginBytes(parsed.counts) : 0;
    // edf-view's CPU (its instances' own count, mostly shrinking images: apps/view resize.ts) is
    // Vercel Active CPU like edf-app's, from the same pool.
    const viewCpuMs = actor === "edf-view" ? (parsed.counts.cpu_ms ?? 0) : 0;
    if (viewCpuMs > 0)
      await c.query("SELECT add_usage($1::date, $2, $3::numeric / 1000)", [day, RESOURCES.vercelCpuS, viewCpuMs]);
    // Exact bytes → MB with 6 decimals (usage_ledger's scale), computed in numeric so none are lost.
    if (imageBytes > 0)
      await c.query("SELECT add_usage($1::date, $2, $3::numeric / 1000000)", [day, RESOURCES.vercelFotMb, imageBytes]);
  });
  return true;
}

/**
 * The Fast Origin Transfer of one edf-view report: the image bytes it served from its function
 * (every `/img` response body; CDN cache hits never reach it and are Fast Data Transfer). This is
 * the only place viewer images are metered: `/api/view-source` meters just its HTML, not the
 * allowances it mints (packages/budget/DECISIONS.md, "Fast Origin Transfer"; FREE-TIER.md §8.1).
 * `img_card_bytes_served` is a subset of `img_bytes_served` (edf-view adds a card image's bytes
 * to both), so it is never added on top; a report that somehow carried only the card count still
 * meters those bytes. Metered exactly once per report: written in the same transaction as the
 * report's audit row, and edf-view re-sends counts only when a report failed.
 */
export function viewImageOriginBytes(counts: Readonly<Record<string, number>>): number {
  return Math.max(counts.img_bytes_served ?? 0, counts.img_card_bytes_served ?? 0);
}
