/**
 * A user whose sign-up hook failed after Better Auth committed the user row has no user_settings row,
 * and Better Auth never re-runs the hook. The session lookup must re-provision it (with the invited
 * role), so the account is not stuck as a friend that can never record consent or change settings.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, ownerPool } from "../support/db";
import { type FakeSession, ownerRow, sessionFor } from "./helpers";

const state = vi.hoisted(() => ({ session: null as FakeSession | null }));
vi.mock("@/server/auth", () => ({
  auth: () => ({ api: { getSession: async () => state.session, revokeSession: async () => {} } }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

describe.skipIf(!HAS_DB)("missing user_settings row (failed sign-up hook)", () => {
  let app: pg.Pool;
  let owner: pg.Pool;

  beforeAll(() => {
    app = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });
  beforeEach(() => {
    state.session = null;
  });

  /** A Better Auth user row with no user_settings row, invited with `role`. */
  async function strandedUser(role: "owner" | "friend") {
    const id = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const email = `${id}@example.com`;
    await owner.query("INSERT INTO beta_allowlist (email, role) VALUES ($1, $2)", [email, role]);
    await app.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Stranded', $2, true)`, [id, email]);
    return { id, email, name: "Stranded" };
  }
  const settingsOf = (userId: string) =>
    ownerRow<{ role: string; timezone: string; backfill_window_days: number; ai_processing_consent_at: Date | null }>(
      owner,
      "SELECT role, timezone, backfill_window_days, ai_processing_consent_at FROM user_settings WHERE user_id = $1",
      [userId],
    );

  it("an invited owner gets their row back with the owner role on the next request", async () => {
    const { getSessionUser } = await import("@/server/session");
    const { updateSettings } = await import("@/server/actions/settings");
    const u = await strandedUser("owner");
    state.session = sessionFor(u);
    expect(await getSessionUser()).toMatchObject({ userId: u.id, role: "owner" });
    expect(await settingsOf(u.id)).toMatchObject({ role: "owner", backfill_window_days: 90 });

    expect(await updateSettings({ timezone: "Europe/Berlin", backfillWindowDays: 180 })).toEqual({ ok: true });
    expect(await settingsOf(u.id)).toMatchObject({ role: "owner", timezone: "Europe/Berlin", backfill_window_days: 180 });
    const invite = await ownerRow<{ used_at: Date | null }>(owner, "SELECT used_at FROM beta_allowlist WHERE email = $1", [u.email]);
    expect(invite?.used_at).toBeInstanceOf(Date);
    const audit = await owner.query<{ action: string }>("SELECT action FROM audit_log WHERE user_id = $1 ORDER BY id", [u.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["account.created"]);
  });

  it("the disclosure is actually recorded (consent needed to connect Gmail)", async () => {
    const { acceptDisclosure } = await import("@/server/actions/settings");
    const u = await strandedUser("friend");
    state.session = sessionFor(u);
    expect(await acceptDisclosure()).toEqual({ ok: true });
    const s = await settingsOf(u.id);
    expect(s).toMatchObject({ role: "friend", backfill_window_days: 30 });
    expect(s?.ai_processing_consent_at).toBeInstanceOf(Date);
  });

  it("an existing row is left untouched and no second audit entry is written", async () => {
    const { getSessionUser } = await import("@/server/session");
    const u = await strandedUser("friend");
    state.session = sessionFor(u);
    await getSessionUser();
    await owner.query("UPDATE user_settings SET timezone = 'Asia/Tokyo' WHERE user_id = $1", [u.id]);
    state.session = sessionFor(u); // a new request (getSessionUser is memoized per request only under React)
    await getSessionUser();
    expect(await settingsOf(u.id)).toMatchObject({ timezone: "Asia/Tokyo" });
    const audit = await owner.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE user_id = $1 AND action = 'account.created'", [u.id]);
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });
});
