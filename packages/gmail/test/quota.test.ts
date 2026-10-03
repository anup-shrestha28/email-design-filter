import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withUser } from "@edf/db";
import {
  ensureQuotaRow,
  FLOOR_BACKGROUND,
  FLOOR_VIEWER,
  quotaWaitMs,
  reserveQuota,
} from "../src/index";
import { HAS_DB } from "./env";
import { appPool, createMailbox, createUser, type Pool } from "./helpers";

describe.skipIf(!HAS_DB)("quota bucket (DESIGN §5.2) against Postgres", () => {
  let pool: Pool;
  let userId: string;

  beforeAll(async () => {
    pool = appPool();
    userId = await createUser(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function newMailbox(): Promise<string> {
    return withUser(pool, userId, async (db) => {
      const id = await createMailbox(db, userId);
      await ensureQuotaRow(db, id);
      return id;
    });
  }
  const setBucket = (mailboxId: string, tokens: number, secondsAgo: number) =>
    withUser(pool, userId, (db) =>
      db.execute(sql`UPDATE gmail_quota SET tokens = ${tokens}, updated_at = now() - make_interval(secs => ${secondsAgo})
                     WHERE mailbox_id = ${mailboxId}::uuid`),
    );
  const reserve = (mailboxId: string, units: number, floor: number) =>
    withUser(pool, userId, (db) => reserveQuota(db, { mailboxId, units, floor }));

  it("keeps the 1,000-unit floor for background work; the viewer may use it", async () => {
    const m = await newMailbox();
    const a = await reserve(m, 4500, FLOOR_BACKGROUND);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.tokensLeft).toBeGreaterThanOrEqual(1000);
    if (a.ok) expect(a.tokensLeft).toBeLessThan(1010);

    const b = await reserve(m, 20, FLOOR_BACKGROUND);
    expect(b.ok).toBe(false);
    // Needs 1,020 − ~1,000 units at 91.67 units/s → ≈ 218 ms.
    if (!b.ok) {
      expect(b.waitMs).toBeGreaterThan(50);
      expect(b.waitMs).toBeLessThanOrEqual(219);
    }
    const c = await reserve(m, 20, FLOOR_VIEWER);
    expect(c.ok).toBe(true);
  });

  it("refills at 5,500/min and caps at 5,500", async () => {
    const m = await newMailbox();
    await setBucket(m, 0, 30);
    const half = await reserve(m, 1000, FLOOR_BACKGROUND); // ≈ 2,750 available
    expect(half.ok).toBe(true);
    if (half.ok) {
      expect(half.tokensLeft).toBeGreaterThan(1740);
      expect(half.tokensLeft).toBeLessThan(1800);
    }

    await setBucket(m, 0, 600); // 10 minutes of refill still caps at 5,500
    const full = await reserve(m, 4500, FLOOR_BACKGROUND);
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.tokensLeft).toBeLessThan(1010);
    const over = await reserve(m, 1, FLOOR_BACKGROUND);
    expect(over.ok).toBe(false);

    await setBucket(m, 0, 0);
    const empty = await reserve(m, 20, FLOOR_BACKGROUND);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.waitMs).toBeGreaterThan(11_000); // (1,020 units) / 91.67 per s ≈ 11.1 s
      expect(empty.waitMs).toBeLessThanOrEqual(11_128);
    }
  });

  it("creates the bucket row on first use", async () => {
    const m = await withUser(pool, userId, (db) => createMailbox(db, userId));
    const r = await reserve(m, 20, FLOOR_BACKGROUND);
    expect(r.ok).toBe(true);
    const unknown = "00000000-0000-7000-8000-000000000000";
    await expect(reserve(unknown, 20, 0)).rejects.toThrow(/mailbox not found/);
  });

  it("never overspends under concurrency", async () => {
    const m = await newMailbox();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(m, 1000, FLOOR_VIEWER)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  it("rejects invalid reservations", async () => {
    const m = await newMailbox();
    await expect(reserve(m, 0, 0)).rejects.toThrow(RangeError);
    await expect(reserve(m, 1.5, 0)).rejects.toThrow(RangeError);
    await expect(reserve(m, 5000, 1000)).rejects.toThrow(RangeError);
    await expect(reserve(m, 20, -1)).rejects.toThrow(RangeError);
    expect(quotaWaitMs(5500, 20, 1000)).toBe(1);
    expect(quotaWaitMs(0, 55, 0)).toBe(600);
  });

  it("is tenant-isolated: another user can't reserve from this bucket", async () => {
    const m = await newMailbox();
    const other = await createUser(pool);
    await expect(
      withUser(pool, other, (db) => reserveQuota(db, { mailboxId: m, units: 20, floor: 0 })),
    ).rejects.toThrow(/mailbox not found/);
  });
});
