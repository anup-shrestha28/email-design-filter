import { describe, expect, it } from "vitest";
import { looksLikeReferenceNumber, parseAmount, resolveCurrency } from "../src/index";
import { analyze } from "./helpers";

async function deals(text: string, subject = "News", extraHtmlHead = "") {
  const html = `<html><head>${extraHtmlHead}</head><body><p>${text}</p></body></html>`;
  return (await analyze({ subject, html })).content.deals;
}

describe("amounts and currencies", () => {
  it("parses thousands and decimal separators", () => {
    expect(parseAmount("1,000")).toBe(1000);
    expect(parseAmount("1.000,50")).toBe(1000.5);
    expect(parseAmount("24.99")).toBe(24.99);
    expect(parseAmount("10,50")).toBe(10.5);
    expect(parseAmount("0")).toBeNull();
  });

  it("resolves symbols with language hints", () => {
    expect(resolveCurrency("$", null)).toBe("USD");
    expect(resolveCurrency("CA$", null)).toBe("CAD");
    expect(resolveCurrency("R$", null)).toBe("BRL");
    expect(resolveCurrency("¥", "ja")).toBe("JPY");
    expect(resolveCurrency("¥", "zh")).toBe("CNY");
    expect(resolveCurrency("kr", "sv")).toBe("SEK");
    expect(resolveCurrency("kr", "da")).toBe("DKK");
    expect(resolveCurrency("kr", null)).toBeNull();
    expect(resolveCurrency("EUR", null)).toBe("EUR");
  });

  it.each([
    ["$20 off orders over $100", { kind: "amount_off", value: 20, currency: "USD", minSpend: 100 }],
    ["Save £15 on everything today", { kind: "amount_off", value: 15, currency: "GBP" }],
    ["Jetzt 20 € Rabatt sichern", { kind: "amount_off", value: 20, currency: "EUR" }],
    ["CA$10 off your first box", { kind: "amount_off", value: 10, currency: "CAD" }],
    ["今なら¥1,000 OFF", { kind: "amount_off", value: 1000, currency: "JPY" }],
    ["R$ 50 de desconto na primeira compra", { kind: "amount_off", value: 50, currency: "BRL" }],
  ])("%s", async (text, want) => {
    expect((await deals(text))[0]).toMatchObject(want);
  });
});

describe("offer kinds and qualifiers", () => {
  it("'up to' marks the value as a maximum", async () => {
    expect((await deals("Up to 70% off outerwear"))[0]).toMatchObject({
      kind: "percent_off",
      value: 70,
      isUpTo: true,
    });
    expect((await deals("Save up to $50 on boots"))[0]).toMatchObject({
      kind: "amount_off",
      value: 50,
      isUpTo: true,
    });
    expect((await deals("Bis zu 40 % Rabatt"))[0]).toMatchObject({ value: 40, isUpTo: true });
    expect((await deals("30% off everything"))[0]).toMatchObject({ value: 30, isUpTo: false });
  });

  it.each([
    ["Buy one, get one free on all socks", "bogo"],
    ["Free shipping on every order", "free_shipping"],
    ["Envío gratis en todos los pedidos", "free_shipping"],
    ["全品送料無料", "free_shipping"],
    ["Free gift with purchase this week", "gift"],
    ["Enjoy -25% sur tout le site", "percent_off"],
    ["3割引セール", "percent_off"],
  ])("%s → %s", async (text, kind) => {
    expect((await deals(text)).map((d) => d.kind)).toContain(kind);
  });

  it("ignores non-offers: 0% APR, 100% cotton, 30% of customers", async () => {
    expect(await deals("0% APR financing. 100% cotton. 30% of customers agree.")).toEqual([]);
  });
});

describe("coupon codes (letter, near 'code', not a reference number)", () => {
  it("attaches a code to the nearest offer", async () => {
    const d = await deals("Get 25% off sitewide. Use code SPRING25 at checkout.");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "percent_off", value: 25, code: "SPRING25" });
  });

  it("keeps a code-only deal as kind 'other'", async () => {
    expect((await deals("Promo code: WELCOME for new members"))[0]).toMatchObject({
      kind: "other",
      code: "WELCOME",
    });
  });

  it.each([
    "Your order code: ORD-1234567 has been received",
    "Tracking code 1Z999AA10123456784 is now active",
    "Your verification code is 482913",
    "Enter your zip code 94105",
    "No code needed, discount applied at checkout",
    "Reference code RR123456789US for your parcel",
    "Pay with PAYPAL or use AMAZON",
    "Use the code below at checkout",
  ])("rejects %s", async (text) => {
    expect((await deals(text)).filter((d) => d.code !== null)).toEqual([]);
  });

  it("recognises reference-number shapes", () => {
    for (const r of [
      "1Z999AA10123456784",
      "RR123456789US",
      "TBA123456789012",
      "INV-2026091",
      "A1234567890",
    ]) {
      expect(looksLikeReferenceNumber(r), r).toBe(true);
    }
    for (const c of ["SPRING25", "WELCOME10", "LEAF20", "HERBST20"])
      expect(looksLikeReferenceNumber(c), c).toBe(false);
  });
});

describe("expiry (anchored to receipt time and the sender's timezone)", () => {
  // helpers.RECEIVED = 2026-09-25T12:00:05Z (a Friday), Date header offset +0000.
  it("relative phrases: ends tonight / 48 hours only", async () => {
    expect((await deals("20% off ends tonight"))[0]?.endsAt?.toISOString()).toBe(
      "2026-09-25T23:59:59.000Z",
    );
    expect((await deals("40% off — 48 hours only"))[0]?.endsAt?.toISOString()).toBe(
      "2026-09-27T12:00:05.000Z",
    );
  });

  it("explicit dates via chrono (US order), end of day when no time is given", async () => {
    const d = await deals("15% off. Offer valid through 10/05.");
    expect(d[0]?.endsAt?.toISOString()).toBe("2026-10-05T23:59:59.000Z");
    expect(d[0]?.endsAtConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it("undated deals expire 14 days after receipt with low confidence", async () => {
    const d = await deals("Take 10% off your next order");
    expect(d[0]).toMatchObject({ endsAtConfidence: 0.2 });
    expect(d[0]?.endsAt?.toISOString()).toBe("2026-10-09T12:00:05.000Z");
  });

  it("stale JSON-LD end dates (before receipt) are ignored", async () => {
    const offer = `<script type="application/ld+json">{"@type":"DiscountOffer","discountCode":"OLD10","description":"10% off","availabilityEnds":"2025-01-01T00:00:00Z"}</script>`;
    const d = await deals("Use code OLD10 for 10% off", "Offer", offer);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ source: "jsonld", code: "OLD10", endsAtConfidence: 0.2 });
  });

  it("stays fast on hostile text", async () => {
    const t = performance.now();
    await deals(
      `${"1 000 ".repeat(3000)} ${"% off ".repeat(2000)} ${"code ".repeat(2000)} ${"$".repeat(5000)}`,
    );
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
