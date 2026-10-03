/**
 * server/out.ts — the /out interstitial check (DESIGN.md §11.5): the signature binds the link to
 * the signed-in user and the exact URL, http(s) only, the real (punycode) host is surfaced, click
 * trackers and embedded destinations are flagged. Includes a round trip with the links that the
 * real view-source rewriter mints for a fixture email.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signOutLink, signViewToken } from "@edf/crypto";
import type { pg } from "@edf/db";
import type { SessionUser } from "@/server/session";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { endAppPool } from "./helpers";

const user = (userId: string): SessionUser => ({
  userId,
  email: `${userId}@example.com`,
  name: "U",
  image: null,
  sessionId: "s",
  sessionCreatedAt: new Date(),
  role: "friend",
});

async function signed(userId: string, url: string, ttl = 3600): Promise<{ u: string; t: string }> {
  const { outKeys } = await import("@/server/keys");
  return { u: url, t: signOutLink(outKeys(), { sessionId: `u:${userId}`, url, exp: Math.floor(Date.now() / 1000) + ttl }) };
}

describe("checkOutRequest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts the user's own signed link and reports the host", async () => {
    const { checkOutRequest } = await import("@/server/out");
    const r = checkOutRequest(user("u_a"), await signed("u_a", "https://shop.example/sale?x=1"));
    expect(r).toEqual({
      ok: true,
      url: "https://shop.example/sale?x=1",
      host: "shop.example",
      hostUnicode: null,
      trackingRedirect: false,
      embeddedDestination: null,
    });
  });

  it("refuses another user's link, a swapped URL, and an expired token", async () => {
    const { checkOutRequest } = await import("@/server/out");
    const p = await signed("u_a", "https://shop.example/sale");
    expect(checkOutRequest(user("u_b"), p)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(checkOutRequest(user("u_a"), { ...p, u: "https://evil.example/sale" })).toMatchObject({ ok: false });
    expect(checkOutRequest(user("u_a"), { ...p, u: "https://shop.example/sale#" })).toMatchObject({ ok: false });

    vi.useFakeTimers({ now: Date.now() + 2 * 3600 * 1000, toFake: ["Date"] });
    expect(checkOutRequest(user("u_a"), p)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it("incomplete, malformed and non-web links never reach the signature check", async () => {
    const { checkOutRequest } = await import("@/server/out");
    const me = user("u_a");
    expect(checkOutRequest(me, {})).toEqual({ ok: false, reason: "This link is incomplete." });
    expect(checkOutRequest(me, { u: ["https://a.example", "https://b.example"], t: "x" })).toEqual({ ok: false, reason: "This link is incomplete." });
    expect(checkOutRequest(me, { u: "https://a.example", t: ["a", "b"] })).toEqual({ ok: false, reason: "This link is incomplete." });
    expect(checkOutRequest(me, { u: "not a url", t: "x" })).toEqual({ ok: false, reason: "This link isn't a valid web address." });
    for (const u of ["javascript:alert(1)", "data:text/html,hi", "mailto:a@example.com", "file:///etc/passwd"]) {
      expect(checkOutRequest(me, { u, t: "x" }), u).toEqual({ ok: false, reason: "Only web links can be opened." });
    }
    // Even a validly signed mailto link is not opened here.
    expect(checkOutRequest(me, await signed("u_a", "mailto:a@example.com"))).toEqual({ ok: false, reason: "Only web links can be opened." });
  });

  it("shows the Unicode form of a punycode host and flags trackers and embedded destinations", async () => {
    const { checkOutRequest } = await import("@/server/out");
    const me = user("u_a");
    const puny = checkOutRequest(me, await signed("u_a", "https://xn--80ak6aa92e.com/login"));
    expect(puny).toMatchObject({ ok: true, host: "xn--80ak6aa92e.com", hostUnicode: "аррӏе.com" });

    for (const url of [
      "https://click.news.example/abc",
      "https://links.shop.example/x",
      "https://u123.ct.sendgrid.net/ls/click?upn=abc",
      "https://example.us1.list-manage.com/track/click?u=1",
      "https://trk.klclick1.com/ls/click",
      "https://email.shop.example/c/abc",
    ]) {
      expect(checkOutRequest(me, await signed("u_a", url)), url).toMatchObject({ ok: true, trackingRedirect: true, embeddedDestination: null });
    }
    const embedded = checkOutRequest(me, await signed("u_a", "https://go.example/r?url=https%3A%2F%2Fdest.example%2Fp"));
    expect(embedded).toMatchObject({ ok: true, trackingRedirect: true, embeddedDestination: "https://dest.example/p" });
    const plain = checkOutRequest(me, await signed("u_a", "https://shop.example/p?u=notaurl"));
    expect(plain).toMatchObject({ ok: true, trackingRedirect: false, embeddedDestination: null });
  });
});

describe.skipIf(!HAS_DB)("view-source → /out round trip", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;

  beforeAll(() => {
    pool = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await pool.end();
    await owner.end();
    await endAppPool();
  });

  it("every /out link minted for a fixture email opens for its owner and only its owner", async () => {
    const u = await createUser(pool);
    const mb = await createMailbox(pool, u.id);
    await owner.query("UPDATE mailbox SET provider_account_id = $2 WHERE id = $1", [mb, `fixture:${mb}`]);
    const emailId = await seedEmail(pool, u.id, mb, { providerMessageId: "27-cart-reminder" });
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const token = signViewToken(viewKeys(), { userId: u.id, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode: "noimg" });
    const r = await buildViewSource(token, emailId);
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);

    const hrefs = [...r.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&")).filter((h) => h.includes("/out?"));
    expect(hrefs.length).toBeGreaterThan(0);
    const { checkOutRequest } = await import("@/server/out");
    for (const href of hrefs) {
      const q = new URL(href).searchParams;
      const params = { u: q.get("u") ?? undefined, t: q.get("t") ?? undefined };
      expect(checkOutRequest(user(u.id), params), href.slice(0, 120)).toMatchObject({ ok: true });
      expect(checkOutRequest(user("u_someone_else"), params)).toMatchObject({ ok: false });
    }
  });
});
