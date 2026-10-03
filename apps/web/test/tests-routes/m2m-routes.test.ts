/**
 * The machine-to-machine routes (FREE-TIER.md §9.2, §9.3) with real OIDC verification against a
 * development issuer (m2m.ts's DEV_OIDC_JWKS path; Vercel OIDC is the only thing stood in for):
 * pinned issuer / audience / subject, the exp − iat = 7200 function-token rule, rate-limited
 * content-free failure audit rows, the counters written by view-stats and keys-audit, and
 * view-source's second factor (the HMAC view token) over a real fixture mailbox.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDevOidcIssuer, mintDevOidcToken, signViewToken, type DevOidcIssuer } from "@edf/crypto";
import { withUser, type pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { endAppPool } from "./helpers";

const ISSUER = "https://oidc.dev.invalid/edf-routes-test";
const AUD = "https://vercel.com/edf-routes-test";
const VIEW_SUB = "dev:edf-view-routes";
const KEYS_SUB = "dev:edf-keys-routes";

describe.skipIf(!HAS_DB)("machine-to-machine routes", () => {
  let issuer: DevOidcIssuer;
  let stranger: DevOidcIssuer;
  let owner: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    issuer = await createDevOidcIssuer({ issuer: ISSUER });
    stranger = await createDevOidcIssuer({ issuer: ISSUER }); // same iss, different key
    delete process.env.OIDC_ISSUER;
    process.env.DEV_OIDC_JWKS = JSON.stringify(issuer.jwks);
    process.env.DEV_OIDC_ISSUER = ISSUER;
    process.env.DEV_OIDC_AUD = AUD;
    process.env.DEV_VIEW_SUB = VIEW_SUB;
    process.env.DEV_KEYS_SUB = KEYS_SUB;
    owner = ownerPool();
    pool = appPool();
  });
  afterAll(async () => {
    await owner.end();
    await pool.end();
    await endAppPool();
  });

  const tok = (sub: string, over: { issuer?: DevOidcIssuer; aud?: string; iss?: string; ttlSec?: number; iat?: number } = {}) =>
    mintDevOidcToken(over.issuer ?? issuer, { sub, aud: over.aud ?? AUD, issuer: over.iss, ttlSec: over.ttlSec, iat: over.iat });

  const now = () => Math.floor(Date.now() / 1000);
  const body = (counts: Record<string, number>, over: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, windowStart: now() - 600, windowEnd: now(), counts, ...over });

  function post(path: string, bearer: string | null, payload: string, ip = "198.51.100.7"): Request {
    const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": ip };
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    return new Request(`https://app.test${path}`, { method: "POST", headers, body: payload });
  }

  async function failures(target: string): Promise<Array<{ reason: string; ip_hash: string | null; metadata: Record<string, unknown> }>> {
    const r = await owner.query<{ ip_hash: string | null; metadata: Record<string, unknown> }>(
      "SELECT ip_hash, metadata FROM audit_log WHERE action = 'm2m.auth_failed' AND target = $1 ORDER BY id",
      [target],
    );
    return r.rows.map((x) => ({ reason: String(x.metadata.reason), ip_hash: x.ip_hash, metadata: x.metadata }));
  }

  async function expectUnauthorized(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  }

  describe("/api/view-stats", () => {
    it("refuses a missing, foreign-key, build, wrong-audience, wrong-issuer or wrong-subject token", async () => {
      const { POST } = await import("@/app/api/view-stats/route");
      const { getPool, rawPool } = await import("@/server/db");
      // The database is asleep: these anonymous failures must not open a connection (FREE-TIER.md
      // §8.4), so their audit rows wait in memory until it is awake anyway.
      delete (globalThis as { __edfDbUsedAt?: number }).__edfDbUsedAt;
      let checkouts = 0;
      const onAcquire = () => void checkouts++;
      rawPool().on("acquire", onAcquire);
      const cases: Array<string | null> = [
        null,
        "not-a-jwt",
        await tok(VIEW_SUB, { issuer: stranger }),
        await tok(VIEW_SUB, { ttlSec: 3600 }), // build token
        await tok(VIEW_SUB, { aud: "https://vercel.com/someone-else" }),
        await tok(VIEW_SUB, { iss: "https://oidc.dev.invalid/other" }),
        await tok(KEYS_SUB), // edf-keys may not post view stats
        await tok(VIEW_SUB, { iat: now() - 7300 }), // expired
      ];
      try {
        for (const bearer of cases) await expectUnauthorized(await POST(post("/api/view-stats", bearer, body({ v: 1 }))));
        expect(checkouts).toBe(0);
      } finally {
        rawPool().off("acquire", onAcquire);
      }
      expect(await failures("view-stats")).toEqual([]);

      // Once the app uses the database, the next failure writes the buffered rows with it.
      await (await getPool()).query("SELECT 1");
      const usedAt = (globalThis as { __edfDbUsedAt?: number }).__edfDbUsedAt;
      await new Promise((r) => setTimeout(r, 5));
      await expectUnauthorized(await POST(post("/api/view-stats", null, body({ v: 1 }))));
      // The audit write itself doesn't count as the app using the database (it can't keep it awake).
      expect((globalThis as { __edfDbUsedAt?: number }).__edfDbUsedAt).toBe(usedAt);
      const rows = await failures("view-stats");
      // Rate-limited per (endpoint, reason) per 10 minutes: one row each, content-free, hashed IP.
      expect(rows.map((r) => r.reason).sort()).toEqual(["invalid_token", "missing_token"]);
      for (const r of rows) {
        expect(r.ip_hash).toMatch(/^[0-9a-f]{16}$/);
        expect(r.ip_hash).not.toContain("198.51.100.7");
        expect(Object.keys(r.metadata).sort()).toEqual(["previousWindowCount", "reason"]);
        expect(r.metadata.previousWindowCount).toBe(0);
      }
    });

    it("records the counters (audit row + usage ledger) for edf-view's token", async () => {
      // edf-view's ledger rows are Vercel traffic, written where Vercel is metered (here: the
      // EDF_METER_LOCAL=1 opt-in; apps/web/test/metering.test.ts covers the local default).
      vi.stubEnv("EDF_METER_LOCAL", "1");
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const { POST } = await import("@/app/api/view-stats/route");
      const before = await owner.query<{ amount: string }>("SELECT amount FROM usage_ledger WHERE day = current_date AND resource = 'view.v_ok'");
      const res = await POST(post("/api/view-stats", await tok(VIEW_SUB), body({ v_ok: 12, img_ok: 30, v_refused: 0 })));
      expect(res.status).toBe(204);
      const audit = await owner.query<{ metadata: { counts: Record<string, number> } }>(
        "SELECT metadata FROM audit_log WHERE actor = 'edf-view' AND action = 'view.stats' ORDER BY id DESC LIMIT 1",
      );
      expect(audit.rows[0]?.metadata.counts).toEqual({ v_ok: 12, img_ok: 30, v_refused: 0 });
      const after = await owner.query<{ resource: string; amount: string }>(
        "SELECT resource, amount FROM usage_ledger WHERE day = current_date AND resource LIKE 'view.%' ORDER BY resource",
      );
      const byRes = Object.fromEntries(after.rows.map((r) => [r.resource, Number(r.amount)]));
      expect(byRes["view.v_ok"]).toBe(Number(before.rows[0]?.amount ?? 0) + 12);
      expect(byRes["view.img_ok"]).toBeGreaterThanOrEqual(30);
      expect(byRes["view.v_refused"]).toBeUndefined(); // zero counts write nothing
    });

    it("rejects malformed bodies with 400 after authenticating", async () => {
      const { POST } = await import("@/app/api/view-stats/route");
      const t = await tok(VIEW_SUB);
      const bad = [
        "{not json",
        JSON.stringify({ v: 2, windowStart: 1, windowEnd: 2, counts: {} }),
        body({ "Bad-Code": 1 }),
        body({ ok: -1 }),
        body({ ok: 1.5 }),
        body({ ok: 1 }, { windowStart: now(), windowEnd: now() - 10 }),
        body({ ok: 1 }, { windowStart: now() - 90_000, windowEnd: now() }),
        body(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, 1]))),
        body({ ok: 1 }, { pad: "x".repeat(5000) }),
      ];
      for (const b of bad) {
        const res = await POST(post("/api/view-stats", t, b));
        expect(res.status, b.slice(0, 60)).toBe(400);
        expect(await res.json()).toEqual({ error: "bad_body" });
      }
    });
  });

  describe("/api/keys-audit", () => {
    it("accepts only edf-keys' subject and writes keys.* counters", async () => {
      const { POST } = await import("@/app/api/keys-audit/route");
      await expectUnauthorized(await POST(post("/api/keys-audit", await tok(VIEW_SUB), body({ unwrap_ok: 1 }))));
      expect((await failures("keys-audit")).map((r) => r.reason)).toEqual(["invalid_token"]);

      const res = await POST(post("/api/keys-audit", await tok(KEYS_SUB), body({ unwrap_ok: 4, unwrap_refused: 1 })));
      expect(res.status).toBe(204);
      const audit = await owner.query<{ metadata: { counts: Record<string, number> } }>(
        "SELECT metadata FROM audit_log WHERE actor = 'edf-keys' AND action = 'keys.audit' ORDER BY id DESC LIMIT 1",
      );
      expect(audit.rows[0]?.metadata.counts).toEqual({ unwrap_ok: 4, unwrap_refused: 1 });
      const led = await owner.query("SELECT 1 FROM usage_ledger WHERE day = current_date AND resource = 'keys.unwrap_refused'");
      expect(led.rowCount).toBe(1);
    });
  });

  describe("/api/view-source", () => {
    let userId = "";
    let emailId = "";

    beforeAll(async () => {
      userId = (await createUser(pool)).id;
      const mailboxId = await createMailbox(pool, userId);
      // A development fixture mailbox: raw messages come from fixtures/emails, not Gmail.
      await owner.query("UPDATE mailbox SET provider_account_id = $2 WHERE id = $1", [mailboxId, `fixture:${mailboxId}`]);
      emailId = await seedEmail(pool, userId, mailboxId, { providerMessageId: "27-cart-reminder" });
    });

    const call = async (bearer: string | null, token: string, id = emailId) => {
      const { GET } = await import("@/app/api/view-source/[token]/[emailId]/route");
      const headers: Record<string, string> = { "x-real-ip": "198.51.100.9" };
      if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
      const req = new Request(`https://app.test/api/view-source/${encodeURIComponent(token)}/${id}`, { headers });
      return GET(req, { params: Promise.resolve({ token: encodeURIComponent(token), emailId: id }) });
    };
    const viewToken = async (over: { userId?: string; emailId?: string; exp?: number } = {}) => {
      const { viewKeys } = await import("@/server/keys");
      return signViewToken(viewKeys(), {
        userId: over.userId ?? userId,
        emailId: over.emailId ?? emailId,
        exp: over.exp ?? now() + 240,
        mode: "img",
      });
    };

    it("needs edf-view's OIDC token before looking at the view token", async () => {
      await expectUnauthorized(await call(null, await viewToken()));
      await expectUnauthorized(await call(await tok(KEYS_SUB), await viewToken()));
    });

    it("refuses a view token for another user or email, or a tampered one, and audits it once", async () => {
      const t = await tok(VIEW_SUB);
      const other = await createUser(pool);
      const tampered = (await viewToken()).replace(".img.", ".noimg."); // mode is covered by the HMAC
      for (const vt of [await viewToken({ userId: other.id }), tampered, "garbage.token"]) {
        const res = await call(t, vt);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "bad_token" });
      }
      const unknown = "00000000-0000-4000-8000-000000000000";
      const res = await call(t, await viewToken({ emailId: unknown }), unknown);
      expect(res.status).toBe(404);
      expect((await failures("view-source")).map((r) => r.reason).filter((r) => r === "bad_view_token")).toHaveLength(1);
    });

    it("returns the sanitized HTML and height as private, no-store JSON", async () => {
      const res = await call(await tok(VIEW_SUB), await viewToken());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      const j = (await res.json()) as { html: string; height: number };
      expect(Object.keys(j).sort()).toEqual(["height", "html"]);
      expect(j.html.length).toBeGreaterThan(100);
      expect(j.html).not.toMatch(/<script\b/i);
      expect(j.height).toBeGreaterThanOrEqual(200);
      expect(j.height).toBeLessThanOrEqual(20_000);
    });

    it("a paused mailbox answers 503 without fetching anything", async () => {
      const m = await withUser(pool, userId, (_db, c) => c.query<{ mailbox_id: string }>("SELECT mailbox_id FROM email WHERE id = $1", [emailId]));
      const mailboxId = m.rows[0]!.mailbox_id;
      await owner.query("UPDATE mailbox SET status = 'needs_reauth' WHERE id = $1", [mailboxId]);
      try {
        const res = await call(await tok(VIEW_SUB), await viewToken());
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "mailbox_unavailable" });
      } finally {
        await owner.query("UPDATE mailbox SET status = 'active' WHERE id = $1", [mailboxId]);
      }
    });
  });
});
