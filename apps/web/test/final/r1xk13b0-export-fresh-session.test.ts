/**
 * GET /api/export freshness (DESIGN.md §4.1, "freshAge 10 min, required for export"): the first page,
 * which starts the export, needs a session at most 10 minutes old. Continuation pages may run on a
 * session up to 30 minutes old, but only to finish an export that same session started.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, ownerPool, seedEmail } from "../support/db";
import { ageSession, endAppPool, signUp, type TestSession } from "../tests-routes/helpers";

process.env.EDF_DEV_LOGIN = "1";

const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => h.headers }));

const MIN = 60 * 1000;

describe.skipIf(!HAS_DB)("/api/export session freshness", () => {
  let owner: pg.Pool;
  let pool: pg.Pool;

  beforeAll(() => {
    owner = ownerPool();
    pool = appPool();
  });
  afterAll(async () => {
    await owner.end();
    await pool.end();
    await endAppPool();
  });

  async function get(s: TestSession, query = ""): Promise<Response> {
    h.headers = new Headers({ cookie: s.cookie });
    const { GET } = await import("@/app/api/export/route");
    return GET(new Request(`https://app.test/api/export${query}`, { headers: h.headers }));
  }

  it("a 15-minute-old session cannot start an export (401 stale_session, nothing audited)", async () => {
    const u = await signUp(owner);
    await ageSession(owner, u.token, 15 * MIN);
    const res = await get(u);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "stale_session" });
    const audits = await owner.query(
      "SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'data.exported'",
      [u.userId],
    );
    expect(audits.rowCount).toBe(0);
  });

  it("a 9-minute-old session can start an export", async () => {
    const u = await signUp(owner);
    await ageSession(owner, u.token, 9 * MIN);
    expect((await get(u)).status).toBe(200);
  });

  it("continuation pages: a 15-minute-old session may finish an export it started, not one it never started", async () => {
    const u = await signUp(owner);
    const mb = await createMailbox(pool, u.userId);
    const id = await seedEmail(pool, u.userId, mb, { subject: "Mine" });

    // Never started by this session: the wider window does not apply to a hand-made cursor.
    await ageSession(owner, u.token, 15 * MIN);
    const unstarted = await get(u, `?cursor=${id}`);
    expect(unstarted.status).toBe(401);
    expect(await unstarted.json()).toEqual({ error: "stale_session" });

    // Started while fresh, then the download runs long: continuation pages keep working up to 30 min.
    await ageSession(owner, u.token, 2 * MIN);
    expect((await get(u)).status).toBe(200);
    await ageSession(owner, u.token, 15 * MIN);
    expect((await get(u, `?cursor=${id}`)).status).toBe(200);
    await ageSession(owner, u.token, 29 * MIN);
    expect((await get(u, `?cursor=${id}`)).status).toBe(200);

    // Past 30 minutes even a started export stops.
    await ageSession(owner, u.token, 31 * MIN);
    const late = await get(u, `?cursor=${id}`);
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual({ error: "stale_session" });
  });

  it("another session of the same user starting an export does not widen this session's window", async () => {
    const u = await signUp(owner);
    const mb = await createMailbox(pool, u.userId);
    const id = await seedEmail(pool, u.userId, mb, { subject: "Mine" });
    // An export row recorded for some other session id of this user.
    await owner.query(
      "INSERT INTO audit_log (user_id, actor, action, metadata) VALUES ($1, 'user', 'data.exported', jsonb_build_object('session', 'someone-else'))",
      [u.userId],
    );
    await ageSession(owner, u.token, 15 * MIN);
    expect((await get(u, `?cursor=${id}`)).status).toBe(401);
  });
});
