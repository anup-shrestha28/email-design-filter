import { describe, expect, it } from "vitest";
import {
  billingPeriodStart,
  costFromUsage,
  daysElapsed,
  FREE_TIER_PROFILE,
  llmCaps,
  OWNER_MONTH_HOLD_USD,
  priceRequest,
  RESOURCE_CODE_PATTERN,
  RESOURCES,
} from "../src/index";

describe("llmCaps (FREE-TIER §6.5)", () => {
  it("global cap is 0.9 × G", () => {
    expect(
      llmCaps({ G: 5, role: "owner", activeUsers: 2, activeFriends: 1, globalReservedUsd: 0 })
        .globalCap,
    ).toBe(4.5);
    expect(
      llmCaps({ G: 10, role: "owner", activeUsers: 2, activeFriends: 1, globalReservedUsd: 0 })
        .globalCap,
    ).toBe(9);
  });

  it("owner: $3/month and $0.50/day; the global cap while the owner is the only active user", () => {
    expect(
      llmCaps({ G: 5, role: "owner", activeUsers: 1, activeFriends: 0, globalReservedUsd: 0 }),
    ).toEqual({ globalCap: 4.5, monthCap: 4.5, dayCap: 0.5 });
    expect(
      llmCaps({ G: 5, role: "owner", activeUsers: 3, activeFriends: 2, globalReservedUsd: 0 }),
    ).toEqual({ globalCap: 4.5, monthCap: 3, dayCap: 0.5 });
    // A small G can't raise the owner above the global cap.
    expect(
      llmCaps({ G: 2, role: "owner", activeUsers: 3, activeFriends: 2, globalReservedUsd: 0 }),
    ).toEqual({ globalCap: 1.8, monthCap: 1.8, dayCap: 0.5 });
  });

  it("friends: $0.50/month and $0.10/day at G = 5, scaled by G/5", () => {
    // A friend's global cap leaves the owner's unreserved $1.60 hold.
    expect(
      llmCaps({ G: 5, role: "friend", activeUsers: 2, activeFriends: 1, globalReservedUsd: 0 }),
    ).toEqual({ globalCap: 2.9, monthCap: 0.5, dayCap: 0.1 });
    expect(
      llmCaps({ G: 10, role: "friend", activeUsers: 5, activeFriends: 4, globalReservedUsd: 0 }),
    ).toEqual({ globalCap: 7.4, monthCap: 1, dayCap: 0.2 });
    expect(
      llmCaps({ G: 7, role: "friend", activeUsers: 2, activeFriends: 1, globalReservedUsd: 0 }),
    ).toEqual({ globalCap: 4.7, monthCap: 0.7, dayCap: 0.14 });
    // Once the owner has reserved the hold, a friend's global cap is the whole 0.9 × G.
    expect(
      llmCaps({ G: 5, role: "friend", activeUsers: 2, activeFriends: 1, globalReservedUsd: 2, ownerMonthReservedUsd: 1.7 })
        .globalCap,
    ).toBe(4.5);
    expect(
      llmCaps({ G: 5, role: "friend", activeUsers: 2, activeFriends: 1, globalReservedUsd: 2, ownerMonthReservedUsd: 0.5 })
        .globalCap,
    ).toBe(3.4);
  });

  it("near the global cap the budget left by the owner is split equally among friends", () => {
    // Owner $2.90 of the $4.50 cap → $1.60 for 4 friends → $0.40 each.
    const c = llmCaps({
      G: 5,
      role: "friend",
      activeUsers: 5,
      activeFriends: 4,
      globalReservedUsd: 4.1,
      ownerMonthReservedUsd: 2.9,
    });
    expect(c.monthCap).toBe(0.4);
    expect(c.dayCap).toBe(0.1);
    // FREE-TIER §6.4 at 20 users: owner ≈ $1.60 → friends ≈ $0.15 at G = 5, ≈ $0.39 at G = 10.
    const at20 = (G: number) =>
      llmCaps({ G, role: "friend", activeUsers: 20, activeFriends: 19, globalReservedUsd: 3, ownerMonthReservedUsd: 1.6 })
        .monthCap;
    expect(at20(5)).toBe(0.1526);
    expect(at20(10)).toBe(0.3894);
    // The owner's reservations can't exceed the global total; the owner taking everything leaves nothing.
    expect(
      llmCaps({ G: 5, role: "friend", activeUsers: 5, activeFriends: 4, globalReservedUsd: 1, ownerMonthReservedUsd: 9 })
        .monthCap,
    ).toBe(0.5);
    expect(
      llmCaps({ G: 5, role: "friend", activeUsers: 5, activeFriends: 4, globalReservedUsd: 4.5, ownerMonthReservedUsd: 4.5 })
        .monthCap,
    ).toBe(0);
    // Without the owner's figure the whole global reservation is assumed to be the owner's (conservative).
    expect(
      llmCaps({ G: 5, role: "friend", activeUsers: 5, activeFriends: 4, globalReservedUsd: 4.1 })
        .monthCap,
    ).toBe(0.1);
    expect(() =>
      llmCaps({ G: -1, role: "friend", activeUsers: 1, activeFriends: 1, globalReservedUsd: 0 }),
    ).toThrow(RangeError);
  });

  it("a friend reserving repeatedly near the cap never exceeds an equal share", () => {
    // $0.40 left after the owner ($2.90) and 4 friends at $0.30 each: every friend ends at $0.40.
    const reserved = [0.3, 0.3, 0.3, 0.3];
    const owner = 2.9;
    const take = (i: number) => {
      const global = owner + reserved.reduce((a, b) => a + b, 0);
      const caps = llmCaps({
        G: 5,
        role: "friend",
        activeUsers: 5,
        activeFriends: 4,
        globalReservedUsd: global,
        ownerMonthReservedUsd: owner,
      });
      // Reserve as much as the month, day and global caps allow (a new day each time).
      const room = Math.min(caps.monthCap - reserved[i]!, caps.dayCap, caps.globalCap - global);
      if (room > 0) reserved[i] = Math.round((reserved[i]! + room) * 1e4) / 1e4;
    };
    for (let day = 0; day < 5; day++) take(0);
    expect(reserved[0]).toBe(0.4);
    for (let i = 1; i < 4; i++) for (let day = 0; day < 5; day++) take(i);
    expect(reserved).toEqual([0.4, 0.4, 0.4, 0.4]);
  });

  it("at 20 users, friends reserving from day 1 leave the owner their $1.60 month (§6.4 'You 100%')", () => {
    const G = 5;
    const friends = Array.from({ length: 19 }, () => ({ month: 0 }));
    let owner = 0;
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const globalReserved = () => r4(owner + friends.reduce((a, f) => a + f.month, 0));
    // reserve_llm: global, month and day reservations each stay within their caps.
    const take = (role: "owner" | "friend", month: number, day: number) => {
      const global = globalReserved();
      const caps = llmCaps({ G, role, activeUsers: 20, activeFriends: 19, globalReservedUsd: global, ownerMonthReservedUsd: owner });
      return Math.max(0, r4(Math.min(caps.dayCap - day, caps.monthCap - month, caps.globalCap - global)));
    };
    for (let day = 0; day < 31; day++) {
      // Every friend reserves as much as allowed, first thing each day; the owner is idle for 3 days.
      for (const f of friends) f.month = r4(f.month + take("friend", f.month, 0));
      if (day >= 3) owner = r4(owner + take("owner", owner, 0));
    }
    expect(owner).toBeGreaterThanOrEqual(OWNER_MONTH_HOLD_USD);
    // Each friend still gets an equal share: (4.50 − 1.60) / 19.
    for (const f of friends) expect(f.month).toBe(0.1526);
    expect(globalReserved()).toBeLessThanOrEqual(4.5);

    // Friends who spent their $0.50 before 15 more became active can't take the owner's hold either.
    const early = [0.5, 0.5, 0.5, 0.5];
    const late = Array.from({ length: 15 }, () => 0);
    const total = () => r4(early.reduce((a, b) => a + b, 0) + late.reduce((a, b) => a + b, 0));
    for (let day = 0; day < 31; day++)
      for (let i = 0; i < late.length; i++) {
        const caps = llmCaps({ G, role: "friend", activeUsers: 20, activeFriends: 19, globalReservedUsd: total(), ownerMonthReservedUsd: 0 });
        late[i] = r4(late[i]! + Math.max(0, Math.min(caps.dayCap, caps.monthCap - late[i]!, caps.globalCap - total())));
      }
    expect(r4(4.5 - total())).toBeGreaterThanOrEqual(OWNER_MONTH_HOLD_USD);
  });
});

describe("priceRequest / costFromUsage (Opus 5 list prices)", () => {
  it("prices the worst case: input $5, cached prefix as a cache write, max_tokens at $25, batch halves", () => {
    // Real-time review: 5,118 input (no cache write), max_tokens 2,000 → 0.02559 + 0.05 = 0.07559 → 0.0756
    expect(priceRequest({ inputTokens: 5118, maxTokens: 2000 })).toBe(0.0756);
    // Batch review with a 2,000-token 1-hour prefix: (3,118 × 5 + 2,000 × 10 + 2,000 × 25) / 1e6 / 2 = 0.042795 → 0.0428
    expect(
      priceRequest({
        inputTokens: 5118,
        cachedPrefixTokens: 2000,
        cacheTtl: "1h",
        maxTokens: 2000,
        batch: true,
      }),
    ).toBe(0.0428);
    // 5-minute write at $6.25
    expect(
      priceRequest({ inputTokens: 1000, cachedPrefixTokens: 1000, cacheTtl: "5m", maxTokens: 0 }),
    ).toBe(0.0063);
    // Classification batch: 1,300 input, 400 out → (6,500 + 10,000) / 1e6 / 2 = 0.00825 → 0.0083
    expect(priceRequest({ inputTokens: 1300, maxTokens: 400, batch: true })).toBe(0.0083);
    expect(priceRequest({ inputTokens: 0, maxTokens: 0 })).toBe(0.0001);
    expect(() =>
      priceRequest({ inputTokens: 10, cachedPrefixTokens: 11, cacheTtl: "1h", maxTokens: 1 }),
    ).toThrow(RangeError);
    expect(() => priceRequest({ inputTokens: -1, maxTokens: 1 })).toThrow(RangeError);
  });

  it("settles from usage, with cache reads at $0.50 and writes per TTL", () => {
    expect(
      costFromUsage(
        { input_tokens: 3018, output_tokens: 800, cache_read_input_tokens: 2000 },
        { batch: true },
      ),
    ).toBe(Math.ceil(((3018 * 5 + 800 * 25 + 2000 * 0.5) / 1e6 / 2) * 1e4) / 1e4);
    const u = {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    };
    expect(costFromUsage(u)).toBe(
      Math.ceil(((1000 * 5 + 100 * 25 + 1000 * 6.25 + 2000 * 10) / 1e6) * 1e4) / 1e4,
    );
    // No breakdown: 1-hour rate unless told otherwise.
    expect(
      costFromUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }),
    ).toBe(0.01);
    expect(
      costFromUsage(
        { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 },
        { cacheTtl: "5m" },
      ),
    ).toBe(0.0063);
    expect(costFromUsage({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  });
});

describe("resources and profile (FREE-TIER §2, §7)", () => {
  it("resource codes satisfy the usage_ledger CHECK", () => {
    for (const code of Object.values(RESOURCES)) expect(code).toMatch(RESOURCE_CODE_PATTERN);
  });

  it("carries the documented free-tier limits", () => {
    const get = (c: string) => FREE_TIER_PROFILE.resources.find((r) => r.code === c);
    expect(get(RESOURCES.vercelCpuS)).toMatchObject({
      hardLimit: 14_400,
      selfCap: 8_640,
      soft: 6_912,
      l3: 10_080,
      window: "rolling_30d",
      global: true,
    });
    expect(get(RESOURCES.vercelInvocations)).toMatchObject({
      selfCap: 600_000,
      soft: 480_000,
      l3: 700_000,
    });
    expect(get(RESOURCES.vercelMemGbh)).toMatchObject({ hardLimit: 360, selfCap: 216 });
    expect(get(RESOURCES.vercelFotMb)).toMatchObject({
      hardLimit: 10_000,
      selfCap: 6_000,
      global: false,
      l3: 7_000,
    });
    expect(get(RESOURCES.sandboxCpuS)).toMatchObject({
      hardLimit: 18_000,
      selfCap: 12_600,
      global: false,
    });
    expect(get(RESOURCES.sandboxCreations)).toMatchObject({
      hardLimit: 5_000,
      selfCap: 3_000,
      global: false,
    });
    expect(get(RESOURCES.inngestExecutions)).toMatchObject({
      hardLimit: 50_000,
      selfCap: 30_000,
      l3: 40_000,
      window: "calendar_month",
      projection: true,
    });
    expect(get(RESOURCES.neonCuH)).toMatchObject({
      soft: 50,
      l2: 60,
      l3: 80,
      window: "billing_period",
      projection: false,
    });
    expect(FREE_TIER_PROFILE.neonStorageMb).toEqual({
      shortenRetention: 250,
      noAnalysisRows: 300,
      pauseIngest: 350,
      hard: 500,
    });
    expect(FREE_TIER_PROFILE.defaultCalibration).toEqual({ vercel_cpu: 1.5, sandbox_cpu: 1.0, vercel_fot: 1.25 });
  });

  it("billing periods follow the recorded anchor day", () => {
    const now = new Date("2026-09-10T05:00:00Z");
    expect(billingPeriodStart(null, now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(billingPeriodStart("2026-03-14", now).toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(billingPeriodStart("2026-03-10", now).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(billingPeriodStart("2026-01-31", new Date("2026-03-05T00:00:00Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(billingPeriodStart("2026-01-15", new Date("2026-01-03T00:00:00Z")).toISOString()).toBe(
      "2025-12-15T00:00:00.000Z",
    );
    expect(daysElapsed(new Date("2026-09-01T00:00:00Z"), now)).toBe(10);
  });
});
