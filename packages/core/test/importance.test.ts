import { describe, expect, it } from "vitest";
import { computeImportance, effectiveImportance, importanceLevel } from "../src/index";
import type { EmailType, ImportanceInput } from "../src/index";

const T0 = new Date("2026-09-25T12:00:00Z");
const H = 3_600_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

function input(overrides: Partial<ImportanceInput> = {}): ImportanceInput {
  return {
    primaryType: "other",
    subtype: null,
    typeSource: "rule",
    securitySensitive: false,
    suspicious: false,
    authResult: "pass",
    labelIds: ["INBOX"],
    receivedAt: T0,
    now: T0,
    deals: [],
    deadlineAt: null,
    prior: null,
    ...overrides,
  };
}

describe("importance levels", () => {
  it("high ≥ 60, low < 25", () => {
    expect(importanceLevel(60)).toBe("high");
    expect(importanceLevel(59)).toBe("normal");
    expect(importanceLevel(25)).toBe("normal");
    expect(importanceLevel(24)).toBe("low");
  });
});

describe("base by type (DESIGN.md §7.5)", () => {
  it.each<[EmailType, string | null, number]>([
    ["account_security", "login_alert", 60],
    ["account_security", "security_alert", 60],
    ["account_security", "verification_code", 60],
    ["account_security", "password_reset", 60],
    ["transactional", "payment_failed", 70],
    ["transactional", "shipping", 40],
    ["transactional", "order", 25],
    ["event", "invitation", 35],
    ["newsletter", "editorial", 20],
    ["promotional", "sale", 10],
    ["lifecycle", "trial_ending", 25],
    ["notification", "activity", 20],
    ["survey", null, 15],
  ])("%s/%s → %d at receipt", (type, subtype, score) => {
    const r = computeImportance(input({ primaryType: type, subtype }));
    expect(r.score).toBe(score);
    expect(r.reasons[0]).toBe(`type:${subtype ?? type}`);
  });
});

describe("time-bound boosts and read-time decay (FREE-TIER.md §4.2)", () => {
  it("OTP: 60 for 1 h, then 15 — the stored row decays to exactly the recomputed value", () => {
    const base = input({
      primaryType: "account_security",
      subtype: "verification_code",
      securitySensitive: true,
    });
    const r = computeImportance(base);
    expect(r).toMatchObject({ score: 60, level: "high" });
    expect(r.expiresAt?.toISOString()).toBe(at(H).toISOString());
    expect(r.reasons).toContain(`boost:otp_fresh:45:${Math.floor(at(H).getTime() / 1000)}`);
    const later = at(H + 1000);
    const eff = effectiveImportance({ score: r.score, reasons: r.reasons }, later);
    expect(eff).toMatchObject({ score: 15, level: "low" });
    expect(eff.reasons.some((x) => x.startsWith("boost:"))).toBe(false);
    expect(eff.score).toBe(computeImportance({ ...base, now: later }).score);
    // Still high just before the hour.
    expect(effectiveImportance(r, at(H - 1000)).level).toBe("high");
  });

  it("shipping: 40 for 14 days, then the transactional base", () => {
    const base = input({ primaryType: "transactional", subtype: "shipping" });
    const r = computeImportance(base);
    expect(r.score).toBe(40);
    const later = at(14 * 24 * H + 1000);
    expect(effectiveImportance(r, later).score).toBe(25);
    expect(computeImportance({ ...base, now: later }).score).toBe(25);
  });

  it("a deal ending within 48 h from an engaged sender is boosted until the deal ends", () => {
    const end = at(30 * H);
    const base = input({
      primaryType: "promotional",
      subtype: "coupon",
      deals: [{ endsAt: end }],
      prior: { readRate60d: 0.6, emailsPerWeek: 2, userImportanceBias: 0 },
    });
    const r = computeImportance(base);
    expect(r.score).toBe(10 + 15 + 20);
    expect(r.reasons).toContain("engaged_sender");
    expect(r.reasons).toContain(`boost:deal_ending:20:${Math.floor(end.getTime() / 1000)}`);
    expect(r.expiresAt?.toISOString()).toBe(end.toISOString());
    const after = new Date(end.getTime() + 1000);
    expect(effectiveImportance(r, after).score).toBe(25);
    expect(computeImportance({ ...base, now: after }).score).toBe(25);
  });

  it("no boost for non-engaged senders; a far deadline asks for a re-score when its 48 h window opens", () => {
    expect(
      computeImportance(input({ primaryType: "promotional", deals: [{ endsAt: at(10 * H) }] }))
        .score,
    ).toBe(10);
    const far = at(5 * 24 * H);
    const r = computeImportance(
      input({
        primaryType: "event",
        deadlineAt: far,
        prior: { readRate60d: 0.5, emailsPerWeek: 1, userImportanceBias: 0 },
      }),
    );
    expect(r.reasons.some((x) => x.startsWith("boost:"))).toBe(false);
    expect(r.expiresAt?.toISOString()).toBe(new Date(far.getTime() - 48 * H).toISOString());
  });

  it("Gmail IMPORTANT +15, starred +30, never-opened frequent sender −20, bias ±15 per step", () => {
    expect(
      computeImportance(input({ primaryType: "newsletter", labelIds: ["IMPORTANT", "STARRED"] })),
    ).toMatchObject({ score: 65, level: "high" });
    const noisy = computeImportance(
      input({
        primaryType: "newsletter",
        prior: { readRate60d: 0, emailsPerWeek: 7, userImportanceBias: 0 },
      }),
    );
    expect(noisy).toMatchObject({ score: 0, level: "low" });
    expect(noisy.reasons).toContain("never_opened_sender");
    const plus = computeImportance(
      input({
        primaryType: "newsletter",
        prior: { readRate60d: null, emailsPerWeek: null, userImportanceBias: 2 },
      }),
    );
    expect(plus.score).toBe(50);
    expect(plus.reasons).toContain("user_bias:+2");
    const minus = computeImportance(
      input({
        primaryType: "newsletter",
        prior: { readRate60d: null, emailsPerWeek: null, userImportanceBias: -1 },
      }),
    );
    expect(minus.reasons).toContain("user_bias:-1");
  });

  it("guardrail: an LLM-sourced account_security / payment_failed label needs DMARC pass to be high", () => {
    const llm = input({
      primaryType: "account_security",
      subtype: "security_alert",
      typeSource: "llm",
      authResult: "none",
    });
    const r = computeImportance(llm);
    expect(r).toMatchObject({ score: 59, level: "normal" });
    expect(r.reasons).toContain("guardrail:dmarc_required");
    expect(computeImportance({ ...llm, authResult: "pass" }).level).toBe("high");
    expect(computeImportance({ ...llm, typeSource: "rule" }).level).toBe("high");
    // Claude's label reused from the per-template cache is still LLM-sourced.
    const cached = computeImportance({ ...llm, typeSource: "template_cache" });
    expect(cached).toMatchObject({ score: 59, level: "normal" });
    expect(cached.reasons).toContain("guardrail:dmarc_required");
    expect(computeImportance({ ...llm, typeSource: "template_cache", authResult: "pass" }).level).toBe("high");
    // Cached labels feed the sender's type distribution, so the sender prior can carry them on.
    const prior = computeImportance({ ...llm, subtype: null, typeSource: "sender_prior" });
    expect(prior).toMatchObject({ score: 59, level: "normal" });
    expect(prior.reasons).toContain("guardrail:dmarc_required");
    expect(computeImportance({ ...llm, subtype: null, typeSource: "sender_prior", authResult: "pass" }).level).toBe(
      "high",
    );
    expect(computeImportance({ ...llm, typeSource: "user" }).level).toBe("high");
    expect(
      computeImportance(
        input({ primaryType: "transactional", subtype: "payment_failed", typeSource: "template_cache", authResult: "unknown" }),
      ).level,
    ).toBe("normal");
    expect(
      computeImportance(
        input({
          primaryType: "transactional",
          subtype: "payment_failed",
          typeSource: "llm",
          authResult: "fail",
        }),
      ).level,
    ).toBe("normal");
  });

  it("suspicious mail isn't boosted and never ranks high", () => {
    const r = computeImportance(
      input({
        primaryType: "account_security",
        subtype: "login_alert",
        suspicious: true,
        labelIds: ["STARRED", "IMPORTANT"],
        prior: { readRate60d: 1, emailsPerWeek: 1, userImportanceBias: 2 },
      }),
    );
    expect(r).toMatchObject({ score: 59, level: "normal" });
    expect(r.reasons).not.toContain("starred");
    expect(r.reasons).toContain("suspicious");
  });

  it("decay stays exact when boosts are clamped at 100 (randomised)", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 300; i++) {
      const otp = rand() < 0.5;
      const dealEnd = at(Math.floor(rand() * 47 * H) + H);
      const base = input({
        primaryType: otp ? "account_security" : "transactional",
        subtype: otp ? "verification_code" : "shipping",
        labelIds: rand() < 0.5 ? ["STARRED", "IMPORTANT"] : ["INBOX"],
        deals: rand() < 0.7 ? [{ endsAt: dealEnd }] : [],
        prior: {
          readRate60d: rand(),
          emailsPerWeek: 1,
          userImportanceBias: Math.floor(rand() * 5) - 2,
        },
      });
      const r = computeImportance(base);
      for (const t of [H / 2, H + 1, 30 * H, 50 * H]) {
        const now = at(t);
        const eff = effectiveImportance(r, now).score;
        const fresh = computeImportance({ ...base, now }).score;
        expect(eff, `case ${i} at +${t / H}h`).toBe(fresh);
      }
    }
  });

  it("ignores malformed boost reasons", () => {
    expect(
      effectiveImportance(
        { score: 40, reasons: ["boost:x:notanumber:1", "boost:y:10:abc", "starred"] },
        at(10 * H),
      ).score,
    ).toBe(40);
  });
});
