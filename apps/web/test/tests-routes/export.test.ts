/**
 * GET /api/export (FREE-TIER.md §10): a fresh session is required, the cursor is
 * validated, page 0 carries the account records and is audited once, later pages only emails,
 * and nothing of another user's (RLS) or any token ever appears. Real session, database and gzip.
 */
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, ownerPool, seedEmail } from "../support/db";
import { ageSession, endAppPool, signUp, type TestSession } from "./helpers";

process.env.EDF_DEV_LOGIN = "1";

const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => h.headers }));

describe.skipIf(!HAS_DB)("/api/export", () => {
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

  async function get(s: TestSession | null, query = ""): Promise<Response> {
    h.headers = new Headers(s ? { cookie: s.cookie } : {});
    const { GET } = await import("@/app/api/export/route");
    return GET(new Request(`https://app.test/api/export${query}`, { headers: h.headers }));
  }

  const lines = async (res: Response) =>
    gunzipSync(Buffer.from(await res.arrayBuffer()))
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });

  it("401 without a session, 401 stale_session for an old session, 200 for a fresh one", async () => {
    const none = await get(null);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });

    const u = await signUp(owner);
    await ageSession(owner, u.token, 31 * 60 * 1000);
    const stale = await get(u);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "stale_session" });

    await ageSession(owner, u.token, 60_000);
    expect((await get(u)).status).toBe(200);
  });

  it("rejects a malformed cursor", async () => {
    const u = await signUp(owner);
    for (const c of ["abc", "'; DROP TABLE email; --", "0".repeat(37)]) {
      const res = await get(u, `?cursor=${encodeURIComponent(c)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_cursor" });
    }
  });

  it("page 0: account records + the user's emails only, audited once; a cursor page carries only later emails", async () => {
    const u = await signUp(owner);
    const mb = await createMailbox(pool, u.userId);
    await owner.query("UPDATE mailbox SET refresh_token_enc = '\\xdeadbeef'::bytea WHERE id = $1", [mb]);
    const ids = [
      await seedEmail(pool, u.userId, mb, { subject: "First mine" }),
      await seedEmail(pool, u.userId, mb, { subject: "Second mine" }),
      await seedEmail(pool, u.userId, mb, { subject: "Third mine" }),
    ].sort();
    const other = await signUp(owner);
    await seedEmail(pool, other.userId, await createMailbox(pool, other.userId), { subject: "NOT YOURS" });

    const res = await get(u);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="dearly-mail-export-start.jsonl.gz"');
    expect(res.headers.get("x-export-next")).toBeNull();
    const page = await lines(res);
    const kinds = page.map((l) => l.kind);
    expect(kinds[0]).toBe("export");
    expect(kinds).toContain("settings");
    expect(kinds).toContain("mailbox");
    const emails = page.filter((l) => l.kind === "email");
    expect(emails.map((e) => e.data.id)).toEqual(ids);
    const text = JSON.stringify(page);
    expect(text).not.toContain("NOT YOURS");
    expect(text).not.toMatch(/refresh_token|access_token|dek_wrapped|deadbeef/);

    const audits = async () =>
      (await owner.query("SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'data.exported'", [u.userId])).rowCount;
    expect(await audits()).toBe(1);

    const next = await get(u, `?cursor=${ids[0]}`);
    expect(next.status).toBe(200);
    expect(next.headers.get("content-disposition")).toContain(`export-${ids[0]!.slice(0, 8)}.jsonl.gz`);
    const later = await lines(next);
    expect(later.map((l) => l.kind)).toEqual(["email", "email"]);
    expect(later.map((l) => l.data.id)).toEqual(ids.slice(1));
    expect(await audits()).toBe(1); // only the first page is audited

    // Another user's email id as a cursor leaks nothing of theirs.
    const theirs = await owner.query<{ id: string }>("SELECT id FROM email WHERE user_id = $1", [other.userId]);
    const cross = await lines(await get(u, `?cursor=${theirs.rows[0]!.id}`));
    expect(JSON.stringify(cross)).not.toContain("NOT YOURS");
  });
});
