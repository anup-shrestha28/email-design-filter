/**
 * R1-19 (server side): the page data carries the governor's image and sync-polling switches
 * (FREE-TIER.md §8.2–8.3): images click-to-load for friends at L1 / Fast Origin Transfer soft and
 * for everyone at L2 / its self-cap; sync-status polling off from L1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { getPool as getAppPool } from "@/server/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";

vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => null,
}));

describe.skipIf(!HAS_DB)("governor switches in the page data", () => {
  const pool = appPool();
  const owner = ownerPool();
  let saved: unknown = null;
  let appPoolOf: typeof getAppPool | null = null;
  const setGovernor = (value: unknown) =>
    owner.query(
      `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );

  beforeAll(async () => {
    appPoolOf = (await import("@/server/db")).getPool;
    saved =
      (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ??
      null;
  });
  afterAll(async () => {
    await setGovernor(saved ?? { level: 0 });
    await pool.end();
    await owner.end();
    await (await appPoolOf?.())?.end();
  });

  it("images click-to-load: friends at FOT soft / L1, everyone at FOT self-cap / L2", async () => {
    const { getEmailDetail } = await import("@/server/queries/email");
    const me = await createUser(pool, { role: "owner" });
    const friend = await createUser(pool, { role: "friend" });
    const mine = await seedEmail(pool, me.id, await createMailbox(pool, me.id));
    const theirs = await seedEmail(pool, friend.id, await createMailbox(pool, friend.id));
    const both = async () => [
      (await getEmailDetail(me.id, mine, "owner"))!.imagesClickToLoad,
      (await getEmailDetail(friend.id, theirs, "friend"))!.imagesClickToLoad,
    ];

    await setGovernor({ level: 0, actions: {} });
    expect(await both()).toEqual([false, false]);
    await setGovernor({ level: 0, actions: { friendsImagesClickToLoad: true } });
    expect(await both()).toEqual([false, true]);
    await setGovernor({ level: 1, actions: {} });
    expect(await both()).toEqual([false, true]);
    await setGovernor({
      level: 0,
      actions: { imagesClickToLoad: true, friendsImagesClickToLoad: true },
    });
    expect(await both()).toEqual([true, true]);
    await setGovernor({ level: 2, actions: {} });
    expect(await both()).toEqual([true, true]);
  });

  it("sync-status polling is off from L1", async () => {
    const { getSyncStatus } = await import("@/server/queries/account");
    const u = await createUser(pool, { role: "owner" });
    await createMailbox(pool, u.id);
    await setGovernor({ level: 0, actions: {} });
    expect((await getSyncStatus(u.id)).pollingOff).toBe(false);
    await setGovernor({ level: 1, actions: { syncStatusPollingOff: true } });
    expect((await getSyncStatus(u.id)).pollingOff).toBe(true);
  });
});
