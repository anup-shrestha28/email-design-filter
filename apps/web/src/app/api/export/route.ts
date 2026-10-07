/**
 * GET /api/export?cursor=… — one gzipped JSONL page of the user's data (fresh session required).
 * The response header `X-Export-Next` carries the cursor for the next page (absent on the last).
 *
 * Freshness (DESIGN.md §4.1): the first page, which starts the export, needs the standard 10-minute
 * fresh session. A long paged download can outlast that, so continuation pages accept a session up to
 * 30 minutes old — but only when this same session started an export (its audited first page).
 */
import { runWithRouteClass, withUser } from "@edf/db";
import { buildExportPage } from "@/server/export";
import { getPool } from "@/server/db";
import { meterOriginBytes, meterRequest } from "@/server/metering";
import { StaleSessionError, UnauthorizedError, requireFreshSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** freshAge (DESIGN.md §4.1): starting an export needs a session at most this old. */
const FRESH_MS = 10 * 60 * 1000;
/** Continuation pages of an export this session started may run on a session up to this old. */
const CONTINUATION_MAX_AGE_MS = 30 * 60 * 1000;

export function GET(request: Request) {
  return runWithRouteClass("authed", () =>
    meterRequest(async () => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      let user;
      try {
        user = await requireFreshSession(cursor === null ? FRESH_MS : CONTINUATION_MAX_AGE_MS);
      } catch (err) {
        if (err instanceof UnauthorizedError || err instanceof StaleSessionError) {
          return Response.json({ error: err instanceof StaleSessionError ? "stale_session" : "unauthorized" }, { status: 401 });
        }
        throw err;
      }
      if (cursor !== null && !/^[0-9a-f-]{36}$/i.test(cursor)) return Response.json({ error: "bad_cursor" }, { status: 400 });
      const pool = await getPool();
      if (cursor !== null) {
        // The wider window only continues an export this session started while fresh.
        const started = await withUser(pool, user.userId, (_db, c) =>
          c.query(
            "SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'data.exported' AND metadata->>'session' = $2 LIMIT 1",
            [user.userId, user.sessionId],
          ),
        );
        if (!started.rowCount && Date.now() - user.sessionCreatedAt.getTime() > FRESH_MS) {
          return Response.json({ error: "stale_session" }, { status: 401 });
        }
      }
      const page = await buildExportPage(user.userId, cursor);
      if (!cursor) {
        await withUser(pool, user.userId, (_db, c) =>
          c.query(
            "INSERT INTO audit_log (user_id, actor, action, metadata) VALUES ($1, 'user', 'data.exported', jsonb_build_object('session', $2::text))",
            [user.userId, user.sessionId],
          ),
        );
      }
      const headers = new Headers({
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="dearly-mail-export-${cursor ? cursor.slice(0, 8) : "start"}.jsonl.gz"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (page.nextCursor) headers.set("X-Export-Next", page.nextCursor);
      meterOriginBytes({ body: page.body.byteLength }); // Fast Origin Transfer (FREE-TIER.md §8.1)
      return new Response(new Uint8Array(page.body), { status: 200, headers });
    }, { maxDuration }),
  );
}
