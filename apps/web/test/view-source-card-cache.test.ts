/**
 * Saved gallery cards (view-source.ts cardCacheKey, migration 0019): a "card" view is built once
 * and then served from card_view_cache (no Gmail fetch, no parse, no sanitize) while its key
 * matches; a new deployment, a new image-token week or a changed input rebuilds it. The opened
 * design ("img") and the images-off view ("noimg") are never saved, local runs without a
 * deployment id never use it, and one user can never read another's saved card.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signViewToken, type ViewMode } from "@edf/crypto";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, seedEmail } from "./support/db";

const fixture = vi.hoisted(() => ({ raw: new Uint8Array() as Uint8Array, reads: 0 }));
vi.mock("@/server/fixtures", () => ({
  isFixtureAccount: () => true,
  readFixtureRaw: async () => {
    fixture.reads++;
    return fixture.raw;
  },
}));

function rawEmail(html: string): Uint8Array {
  const body = Buffer.from(html).toString("base64").replace(/.{76}/g, "$&\r\n");
  return new TextEncoder().encode(
    [
      "From: Northwind <hello@northwind.example>",
      "To: someone@gmail.example",
      "Subject: Autumn sale",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
      "",
    ].join("\r\n"),
  );
}

afterAll(async () => {
  if (!HAS_DB) return;
  const { getPool } = await import("@/server/db");
  await (await getPool()).end();
});

describe.skipIf(!HAS_DB)("saved gallery cards", () => {
  const pool = appPool();
  let userId = "";
  let emailId = "";

  beforeAll(async () => {
    fixture.raw = rawEmail(`<html><body><h1>Autumn sale</h1><img src="https://img.example.com/hero.png" alt="hero" width="600"></body></html>`);
    userId = (await createUser(pool)).id;
    emailId = await seedEmail(pool, userId, await createMailbox(pool, userId));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function view(mode: ViewMode, user = userId, id = emailId) {
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const r = await buildViewSource(
      signViewToken(viewKeys(), { userId: user, emailId: id, exp: Math.floor(Date.now() / 1000) + 240, mode }),
      id,
    );
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    return r;
  }

  it("builds a card once, then serves the saved one; img and noimg views are always built", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "sha-one");
    const before = fixture.reads;
    const first = await view("card");
    expect(first.html).toContain("/img/");
    expect(fixture.reads).toBe(before + 1);
    const second = await view("card");
    expect(fixture.reads).toBe(before + 1); // no fetch: the saved card
    expect(second.html).toBe(first.html);
    expect(second.height).toBe(first.height);
    expect(second.imageBytesMinted).toBe(first.imageBytesMinted);
    expect(second.unsignableUrls).toBe(0);
    await view("img");
    await view("noimg");
    expect(fixture.reads).toBe(before + 3);
  });

  it("a new deployment or a new image-token week rebuilds the card", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "sha-two");
    const before = fixture.reads;
    await view("card");
    await view("card");
    expect(fixture.reads).toBe(before + 1);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "sha-three");
    await view("card");
    expect(fixture.reads).toBe(before + 2);
    // Two weeks on: the image tokens of the saved card belong to an older week.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 14 * 86_400_000 });
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const r = await buildViewSource(
      signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode: "card" }),
      emailId,
    );
    expect(r.ok).toBe(true);
    expect(fixture.reads).toBe(before + 3);
  });

  it("is off without a deployment id (local development)", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    const before = fixture.reads;
    await view("card");
    await view("card");
    expect(fixture.reads).toBe(before + 2);
  });

  it("is private to its owner and goes with its email", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "sha-private");
    await view("card");
    const other = (await createUser(pool)).id;
    const counted = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM card_view_cache WHERE email_id = $1`,
      [emailId],
    ); // app_rw without a tenant context sees nothing (RLS fails closed)
    expect(counted.rows[0]?.n).toBe(0);
    const { withUser } = await import("@edf/db");
    const { getPool } = await import("@/server/db");
    const p = await getPool();
    const theirs = await withUser(p, other, async (_db, c) =>
      (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM card_view_cache")).rows[0]?.n,
    );
    expect(theirs).toBe(0);
    const mine = await withUser(p, userId, async (_db, c) =>
      (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM card_view_cache WHERE email_id = $1", [emailId])).rows[0]?.n,
    );
    expect(mine).toBe(1);
    // The daily prune keeps cards younger than 8 days.
    const { withSystem } = await import("@edf/db");
    const pruned = await withSystem(p, async (_db, c) =>
      (await c.query<{ n: number }>("SELECT prune_card_view_cache() AS n")).rows[0]?.n,
    );
    expect(pruned).toBe(0);
    await withUser(p, userId, async (_db, c) => {
      await c.query("UPDATE card_view_cache SET created_at = now() - interval '9 days' WHERE email_id = $1", [emailId]);
    });
    const prunedOld = await withSystem(p, async (_db, c) =>
      (await c.query<{ n: number }>("SELECT prune_card_view_cache() AS n")).rows[0]?.n,
    );
    expect(prunedOld).toBeGreaterThanOrEqual(1);
  });
});
