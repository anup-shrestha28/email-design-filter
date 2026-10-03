import { describe, expect, it } from "vitest";
import { effectiveImportance } from "../src/index";
import type { DealCandidate } from "../src/index";
import { loadFixtures, runPipeline } from "./helpers";

const fixtures = loadFixtures();

function dealView(d: DealCandidate): Record<string, unknown> {
  return {
    kind: d.kind,
    value: d.value,
    currency: d.currency,
    isUpTo: d.isUpTo,
    minSpend: d.minSpend,
    code: d.code,
    endsAt: d.endsAt?.toISOString() ?? null,
    endsAtConfidence: d.endsAtConfidence,
    source: d.source,
  };
}

describe("fixture corpus", () => {
  it("has at least 24 fixtures, each with an expected file", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(24);
  });

  for (const fx of fixtures) {
    it(`${fx.name}: ${fx.description}`, async () => {
      const r = await runPipeline(fx.raw, fx.input);
      const e = fx.expected;
      expect(r.automated.automated, "automated").toBe(e.automated);
      if ("skipReason" in e) expect(r.automated.skipReason, "skipReason").toBe(e.skipReason);
      if (!e.automated) return;
      const actual: Record<string, unknown> = {
        isSubscription: r.automated.isSubscription,
        primaryType: r.type.primaryType,
        subtype: r.type.subtype,
        securitySensitive: r.security.securitySensitive,
        suspicious: r.headers.suspicious,
        oneClick: r.headers.oneClick,
        language: r.content.language,
        importance: r.importance.level,
        espPlatform: r.headers.espPlatform,
        authResult: r.headers.authResult,
        trust: r.trust.state,
        secondaryTags: r.type.secondaryTags,
        pixelCount: r.content.tracking.pixelCount,
        typeSource: r.type.typeSource,
        hasUnsubscribeLink: r.content.hasUnsubscribeLink,
        postalAddress: r.content.postalAddress,
        deadlineAt: r.content.deadlineAt?.toISOString() ?? null,
      };
      for (const key of Object.keys(actual)) {
        if (key in e) expect(actual[key], key).toEqual(e[key]);
      }
      if (Array.isArray(e.deals)) {
        const deals = r.content.deals.map(dealView);
        expect(deals.length, "deal count").toBe(e.deals.length);
        (e.deals as Array<Record<string, unknown>>).forEach((want, i) => {
          expect(deals[i], `deal ${i}`).toMatchObject(want);
        });
      }
      if (e.importanceAfter) {
        const after = e.importanceAfter as { at: string; level: string };
        const eff = effectiveImportance(
          { score: r.importance.score, reasons: r.importance.reasons },
          new Date(after.at),
        );
        expect(eff.level, "importance after decay").toBe(after.level);
      }
    });
  }
});
