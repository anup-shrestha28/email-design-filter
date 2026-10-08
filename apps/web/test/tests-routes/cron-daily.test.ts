/**
 * GET /api/cron/daily (FREE-TIER.md §4.9): only `Authorization: Bearer <CRON_SECRET>` runs it;
 * anything else is a 401 with a rate-limited, content-free audit row, written only once the database
 * is awake anyway (a refused request never opens a connection). With a healthy heartbeat the
 * run does its privacy + maintenance work and reports no watchdog action. Real database and
 * pipeline; outbound HTTP is refused (nothing external should be needed here).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { endAppPool, fakeFetch } from "./helpers";

const fake = fakeFetch([]);

describe.skipIf(!HAS_DB)("/api/cron/daily", () => {
  let owner: pg.Pool;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    owner = ownerPool();
    globalThis.fetch = fake.fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await owner.end();
    await endAppPool();
  });

  const failureRows = () =>
    owner.query<{ metadata: { reason: string; previousWindowCount: number }; ip_hash: string | null }>(
      "SELECT metadata, ip_hash FROM audit_log WHERE action = 'm2m.auth_failed' AND target = 'cron-daily'",
    );

  async function call(authorization: string | null): Promise<Response> {
    const { GET } = await import("@/app/api/cron/daily/route");
    const headers: Record<string, string> = { "x-real-ip": "198.51.100.40" };
    if (authorization !== null) headers.authorization = authorization;
    return GET(new Request("https://app.test/api/cron/daily", { headers }));
  }

  it("refuses a missing, wrong, differently-cased or re-spaced secret", async () => {
    const { env } = await import("@/env");
    const secret = env().CRON_SECRET;
    expect(secret, "CRON_SECRET must be configured in apps/web/.env.local").toBeTruthy();
    const before = await owner.query<{ last_cron_at: Date | null }>("SELECT last_cron_at FROM system_state");
    const { rawPool } = await import("@/server/db");
    delete (globalThis as { __edfDbUsedAt?: number }).__edfDbUsedAt; // the database is asleep
    let checkouts = 0;
    const onAcquire = () => void checkouts++;
    rawPool().on("acquire", onAcquire);
    try {
      for (const a of [null, "", "Bearer", `Bearer ${secret}x`, `bearer ${secret}`, `Bearer  ${secret}`, secret!, `Basic ${secret}`]) {
        const res = await call(a);
        expect(res.status, JSON.stringify(a === secret ? "<secret>" : a?.replace(secret!, "<secret>"))).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toBe("Unauthorized");
      }
      // A scanner probing the cron path never wakes Neon (FREE-TIER.md §8.4).
      expect(checkouts).toBe(0);
    } finally {
      rawPool().off("acquire", onAcquire);
    }
    expect((await failureRows()).rows).toEqual([]);
    const after = await owner.query<{ last_cron_at: Date | null }>("SELECT last_cron_at FROM system_state");
    expect(after.rows[0]!.last_cron_at).toEqual(before.rows[0]!.last_cron_at); // nothing ran
  });

  it("runs with the right secret: heartbeat written, no watchdog action when the tick is healthy", async () => {
    await owner.query(
      "UPDATE system_state SET last_tick_at = now(), last_maintenance_at = now(), last_render_batch_at = now(), inngest_paused = false",
    );
    const { env } = await import("@/env");
    const secret = env().CRON_SECRET;
    // A refused call while the database is asleep (this test's own, so it doesn't rely on the
    // test above having run): its audit row waits in memory.
    delete (globalThis as { __edfDbUsedAt?: number }).__edfDbUsedAt;
    expect((await call(`Bearer ${secret}x`)).status).toBe(401);
    expect((await failureRows()).rows).toEqual([]);
    const res = await call(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; watchdog: unknown; pictures: boolean | null };
    expect(body).toMatchObject({ ok: true, watchdog: { stale: [], ranPoll: false, drained: 0 } });
    // The daily picture check ran (server/picture-health.ts): true, false, or null if it couldn't.
    expect([true, false, null]).toContain(body.pictures);
    const s = await owner.query<{ fresh: boolean }>("SELECT last_cron_at > now() - interval '1 minute' AS fresh FROM system_state");
    expect(s.rows[0]!.fresh).toBe(true);
    // No outside calls but the picture check's own visits to edf-view (cards and their pictures).
    const viewOrigin = new URL(env().VIEW_ORIGIN).origin;
    expect(fake.calls.map((c) => new URL(c.url).origin).filter((o) => o !== viewOrigin)).toEqual([]);

    // The run, which uses the database anyway, wrote the refused request's buffered audit row.
    const rows = await failureRows();
    expect(rows.rows).toHaveLength(1); // rate-limited: one row per 10 minutes
    expect(rows.rows[0]!.metadata.reason).toBe("bad_cron_secret");
    expect(rows.rows[0]!.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rows.rows[0]!.metadata.previousWindowCount).toBe(0);
    expect(JSON.stringify(rows.rows)).not.toContain(secret!);
  });
});
