/**
 * The deal card mirrors core's undated-deal confidence as UNDATED_CONFIDENCE_MAX instead of importing
 * it (R1-11). This runs core's real extractor so the two can't drift apart unnoticed: an undated deal
 * must fall below the threshold, and a phrase-based end ("last chance", core's weakest real date
 * source) must not, including after a float4 (`real`) round trip.
 */
import { extractContent } from "@edf/core";
import type { ParsedEmail } from "@edf/core/types";
import { describe, expect, it } from "vitest";
import { UNDATED_CONFIDENCE_MAX } from "@/components/email/deal-card";

const RECEIVED = new Date("2026-09-01T10:00:00Z");

function dealConfidences(subject: string, text: string): number[] {
  const parsed: ParsedEmail = {
    headers: [{ name: "date", value: "Tue, 01 Sep 2026 10:00:00 +0000" }],
    messageId: "<r1xk5b0@example.com>",
    subject,
    from: { name: "Shop", address: "news@shop.example.com" },
    replyTo: [],
    to: [{ name: null, address: "me@example.org" }],
    cc: [],
    date: RECEIVED,
    html: null,
    htmlBytes: 0,
    text,
    hasCalendar: false,
    hasAmp: false,
    attachments: [],
    inline: [],
  };
  const content = extractContent(parsed, {
    receivedAt: RECEIVED,
    userAddresses: ["me@example.org"],
    fromDomain: "shop.example.com",
  });
  return content.deals.map((d) => d.endsAtConfidence);
}

describe("DealCard's undated threshold stays in step with core", () => {
  it("core's undated deal confidence is below the card's threshold, also as float4", () => {
    const [c] = dealConfidences("Big sale", "Take 20% off everything in the store.");
    expect(c).toBeDefined();
    expect(c!).toBeLessThan(UNDATED_CONFIDENCE_MAX);
    expect(Math.fround(c!)).toBeLessThan(UNDATED_CONFIDENCE_MAX);
  });

  it("a phrase-based end ('last chance') is at or above the card's threshold, also as float4", () => {
    const [c] = dealConfidences("Last chance!", "Take 20% off everything in the store.");
    expect(c).toBeDefined();
    expect(c!).toBeGreaterThanOrEqual(UNDATED_CONFIDENCE_MAX);
    expect(Math.fround(c!)).toBeGreaterThanOrEqual(UNDATED_CONFIDENCE_MAX);
  });
});
