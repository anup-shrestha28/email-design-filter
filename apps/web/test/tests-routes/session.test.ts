/**
 * server/session.ts against real Better Auth sessions in this run's database (DESIGN.md §4.1):
 * the absolute 30-day cap (revoked, not just ignored), the 10-minute freshness rule for sensitive
 * actions, and the role read from user_settings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { ownerPool } from "../support/db";
import { ageSession, endAppPool, signUp } from "./helpers";

process.env.EDF_DEV_LOGIN = "1";

const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => h.headers }));

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!HAS_DB)("session helpers", () => {
  let owner: pg.Pool;

  beforeAll(() => {
    owner = ownerPool();
  });
  afterAll(async () => {
    await owner.end();
    await endAppPool();
  });

  async function as(cookie: string | null) {
    h.headers = new Headers(cookie ? { cookie } : {});
    return import("@/server/session");
  }

  it("no cookie → no user; requireUserOrThrow throws UnauthorizedError", async () => {
    const s = await as(null);
    expect(await s.getSessionUser()).toBeNull();
    await expect(s.requireUserOrThrow()).rejects.toBeInstanceOf(s.UnauthorizedError);
    await expect(s.requireFreshSession()).rejects.toBeInstanceOf(s.UnauthorizedError);
  });

  it("a fresh session resolves the user with the role from user_settings", async () => {
    const o = await signUp(owner, { role: "owner" });
    const s = await as(o.cookie);
    const u = await s.getSessionUser();
    expect(u).toMatchObject({ userId: o.userId, email: o.email, role: "owner" });
    expect(Date.now() - u!.sessionCreatedAt.getTime()).toBeLessThan(60_000);
    await expect(s.requireFreshSession()).resolves.toMatchObject({ userId: o.userId });

    const f = await signUp(owner, { role: "friend" });
    expect(await (await as(f.cookie)).getSessionUser()).toMatchObject({ userId: f.userId, role: "friend" });
  });

  it("a session older than 10 minutes is stale for sensitive actions (the caller can widen the window)", async () => {
    const u = await signUp(owner);
    await ageSession(owner, u.token, 11 * 60 * 1000);
    const s = await as(u.cookie);
    expect(await s.getSessionUser()).toMatchObject({ userId: u.userId });
    await expect(s.requireFreshSession()).rejects.toBeInstanceOf(s.StaleSessionError);
    await expect(s.requireFreshSession(30 * 60 * 1000)).resolves.toMatchObject({ userId: u.userId });
  });

  it("a 29-day-old session still works; past 30 days it is refused and revoked", async () => {
    const u = await signUp(owner);
    await ageSession(owner, u.token, 29 * DAY);
    const s = await as(u.cookie);
    expect(await s.getSessionUser()).toMatchObject({ userId: u.userId });

    await ageSession(owner, u.token, 30 * DAY + 60_000);
    expect(await s.getSessionUser()).toBeNull();
    const left = await owner.query("SELECT 1 FROM session WHERE token = $1", [u.token]);
    expect(left.rowCount).toBe(0);
    // Still refused afterwards (the row is gone, not merely skipped once).
    expect(await s.getSessionUser()).toBeNull();
  });

  it("a forged or unknown session cookie is no user", async () => {
    const s = await as("edf.session_token=not-a-real-token.c2lnbmF0dXJl");
    expect(await s.getSessionUser()).toBeNull();
  });
});
