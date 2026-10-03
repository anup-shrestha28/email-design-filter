/**
 * Settings → Time zone is what dates render in (request-context.ts): a zone the user chose wins over
 * the device's cookie, "Automatic" (the column default, "UTC") follows the device, and "Etc/UTC" is a
 * real choice of UTC. The session, pool and database are real; only the request's headers/cookies
 * are stand-ins.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createUser, ownerPool } from "../support/db";

const state = vi.hoisted(() => ({ cookie: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": "en-GB" }),
  cookies: async () => ({
    get: (name: string) => (name === "edf-tz" && state.cookie !== null ? { name, value: state.cookie } : undefined),
  }),
}));

const { effectiveTimeZone, requestContext } = await import("@/lib/request-context");

describe("effectiveTimeZone", () => {
  it("prefers a chosen zone, treats UTC as Automatic, and ignores invalid values", () => {
    expect(effectiveTimeZone("Asia/Tokyo", "Europe/Paris")).toBe("Asia/Tokyo");
    expect(effectiveTimeZone("UTC", "Europe/Paris")).toBe("Europe/Paris");
    expect(effectiveTimeZone("Etc/UTC", "Europe/Paris")).toBe("Etc/UTC");
    expect(effectiveTimeZone("Not/AZone", "Europe/Paris")).toBe("Europe/Paris");
    expect(effectiveTimeZone(null, null)).toBe("UTC");
    expect(effectiveTimeZone("UTC", undefined)).toBe("UTC");
  });
});

describe.skipIf(!HAS_DB)("requestContext uses the saved time zone", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let alice: Awaited<ReturnType<typeof createUser>>;
  let bob: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    alice = await createUser(app);
    bob = await createUser(app);
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });
  beforeEach(() => {
    state.cookie = "Europe/Paris";
  });

  async function setZone(userId: string, tz: string) {
    await owner.query("UPDATE user_settings SET timezone = $2 WHERE user_id = $1", [userId, tz]);
  }

  it("follows the device while the setting is Automatic (the default)", async () => {
    const ctx = await requestContext(alice.id);
    expect(ctx.clock.timeZone).toBe("Europe/Paris");
    expect(ctx.deviceTimeZone).toBe("Europe/Paris");
  });

  it("renders dates in the zone chosen in Settings, whatever the device says", async () => {
    await setZone(alice.id, "Asia/Tokyo");
    const ctx = await requestContext(alice.id);
    expect(ctx.clock.timeZone).toBe("Asia/Tokyo");
    expect(ctx.deviceTimeZone).toBe("Europe/Paris");
    // Another user's choice doesn't leak (RLS scopes the read to the signed-in user).
    expect((await requestContext(bob.id)).clock.timeZone).toBe("Europe/Paris");
  });

  it("treats Etc/UTC as a real choice of UTC, and a missing cookie as UTC for the device", async () => {
    await setZone(alice.id, "Etc/UTC");
    expect((await requestContext(alice.id)).clock.timeZone).toBe("Etc/UTC");
    state.cookie = null;
    await setZone(alice.id, "UTC");
    const ctx = await requestContext(alice.id);
    expect(ctx.clock.timeZone).toBe("UTC");
    expect(ctx.deviceTimeZone).toBe("UTC");
  });

  it("without a user (sign-in pages) uses the device cookie", async () => {
    await setZone(alice.id, "Asia/Tokyo");
    expect((await requestContext()).clock.timeZone).toBe("Europe/Paris");
  });
});
