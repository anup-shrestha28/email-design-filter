import { describe, expect, it } from "vitest";
import {
  buildTrustBadge,
  detectSecuritySensitive,
  parseAuthenticationResults,
  parseListUnsubscribe,
} from "../src/index";
import type { AuthFacts } from "../src/index";
import { analyze, fakeContent, fakeHeaders, fakeParsed } from "./helpers";

async function sec(subject: string, html: string) {
  return (await analyze({ from: "Acme <no-reply@acme.example>", subject, html })).security;
}

describe("security-sensitive detection (DESIGN.md §7.4)", () => {
  it.each([
    ["Your code", "<p>Your verification code is 482913.</p>"],
    ["Código", "<p>Tu código de verificación es 482913.</p>"],
    ["Code", "<p>Ihr Bestätigungscode lautet 482913.</p>"],
    ["Code", "<p>Votre code de vérification : 482913</p>"],
    ["認証", "<p>認証コード：482913</p>"],
    ["Sign in", "<p>Use 482 913 as your one-time passcode.</p>"],
    ["G-482913 is your Google verification code", "<p>Don't share it.</p>"],
  ])("OTP: %s / %s", async (subject, html) => {
    expect(await sec(subject, html)).toEqual({ securitySensitive: true, reason: "otp" });
  });

  it("promo tokens in the primary content disqualify; a promo footer does not", async () => {
    expect(
      (await sec("Verify your email and get 10% off", `<p>Your code is 482913.</p>`))
        .securitySensitive,
    ).toBe(false);
    const footer = `<p>Your verification code is 482913.</p>${"<p>Never share this code with anyone.</p>".repeat(8)}<p>Free shipping on orders over $50 — shop now.</p>`;
    expect(await sec("Your Acme code", footer)).toEqual({ securitySensitive: true, reason: "otp" });
  });

  it("security mail in a marketing template (promo preheader, banner or nav bar) is still sensitive", async () => {
    const hiddenPre = `<div style="display:none">Plus: shop the fall sale inside</div>`;
    expect(await sec("Your sign-in code", `${hiddenPre}<p>Your sign-in code is 482913</p>`)).toEqual({
      securitySensitive: true,
      reason: "otp",
    });
    const freeShipPre = `<span style="display:none;max-height:0">Free shipping on all orders this week</span>`;
    expect(await sec("Your sign-in code", `${freeShipPre}<p>Your verification code is 482913.</p>`)).toEqual({
      securitySensitive: true,
      reason: "otp",
    });
    expect(
      await sec("Your sign-in code", `<p>FREE SHIPPING ON ORDERS $50+ | SHOP NOW</p><p>Your sign-in code is 482913</p>`),
    ).toEqual({ securitySensitive: true, reason: "otp" });
    expect(
      await sec("Your code", `<p>New Arrivals Women Men Kids Sale</p><p>Your sign-in code is 482913</p>`),
    ).toEqual({ securitySensitive: true, reason: "otp" });
    // A password reset under a nav bar: the subject states the purpose, so body promo tokens do not count.
    expect(
      await sec(
        "Reset your password",
        `<p>Women Men Kids Sale</p><p>Reset your password: <a href="https://shop.example/reset-password?token=Zx8Kq2Lm9Pv4Rt7W">Reset password</a></p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "password_reset" });
    // Body-only purpose: a promo preheader is not primary content, so the reset still counts.
    expect(
      await sec(
        "Account help",
        `${freeShipPre}<p>Reset your password: <a href="https://shop.example/reset-password?token=Zx8Kq2Lm9Pv4Rt7W">Reset password</a></p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "password_reset" });
    // Body-only reset under a visible nav bar with no security subject: the reset keyword plus a
    // password-reset link outranks the nav bar's "Sale".
    for (const subject of ["Account recovery", "Action required"]) {
      expect(
        await sec(
          subject,
          `<p>Women Men Kids Sale</p><p>Click below to reset your password. <a href="https://shop.example/reset-password?token=Zx8Kq2Lm9Pv4Rt7W">Reset password</a></p>`,
        ),
      ).toEqual({ securitySensitive: true, reason: "password_reset" });
    }
    // Still not sensitive: a promo body opening with a verify link, no code and no security subject
    // (a "confirm your email and get 15% off" welcome promo).
    expect(
      (
        await sec(
          "This week at Acme",
          `<p>Flash sale: 20% off everything. Shop now!</p><p>Verify your email: <a href="https://shop.example/confirm?t=Zx8Kq2Lm9Pv4Rt7W">Confirm</a></p>`,
        )
      ).securitySensitive,
    ).toBe(false);
  });

  it("a promo footer's 2FA/passcode wording next to its postal address is not a one-time code", async () => {
    const promo = async (subject: string, html: string) =>
      (await analyze({ from: "Acme <news@acme.example>", subject, html })).security;
    expect(
      await promo(
        "Fall collection is here",
        `<p>Shop the fall sale — up to 40% off new arrivals.</p><p>Acme Inc · 1234 Market St, San Francisco, CA 94103 · Protect your account: turn on two-factor authentication.</p>`,
      ),
    ).toEqual({ securitySensitive: false, reason: null });
    expect(
      await promo(
        "Weekend picks",
        `<p>Shop now: free shipping on everything this weekend.</p><p>We will never ask for your passcode. Acme, PO Box 5521, Austin TX 78701</p>`,
      ),
    ).toEqual({ securitySensitive: false, reason: null });
    expect(
      await promo(
        "Weekend picks",
        `<p>Shop now: free shipping on everything this weekend.</p><p>We never ask for your verification code. Acme, 1234 Market St, San Francisco, CA 94103</p>`,
      ),
    ).toEqual({ securitySensitive: false, reason: null });
    // A European address is not masked: the generic "two-factor" wording alone does not count.
    expect(
      await promo(
        "Neue Kollektion",
        `<p>Sale: up to 40% off new arrivals. Shop now!</p><p>Acme GmbH, Hauptstraße 5, 10115 Berlin · Turn on two-factor authentication.</p>`,
      ),
    ).toEqual({ securitySensitive: false, reason: null });
    // The code itself still wins under a promo opening, next to a footer address.
    expect(
      await promo(
        "Your Acme code",
        `<p>Shop now: free shipping on everything.</p><p>Your sign-in code is 482913.</p><p>Acme, 1234 Market St, San Francisco, CA 94103</p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "otp" });
  });

  it("a year near a keyword is not a code", async () => {
    expect(
      (
        await sec(
          "Security code of conduct",
          "<p>Our security code of conduct was updated in 2026.</p>",
        )
      ).securitySensitive,
    ).toBe(false);
  });

  it("password reset / magic link / email verification need an action link", async () => {
    expect(
      (await sec("Password help", "<p>You can reset your password in settings.</p>"))
        .securitySensitive,
    ).toBe(false);
    expect(
      await sec(
        "Password help",
        `<p>Reset your password: <a href="https://acme.example/reset-password?token=Zx8Kq2Lm9Pv4Rt7W">Reset password</a></p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "password_reset" });
    expect(
      await sec(
        "Sign in",
        `<p>Here is your magic link. <a href="https://acme.example/auth/magic?t=abcDEF123456ghiJKL">Sign in to Acme</a></p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "magic_link" });
    expect(
      await sec(
        "Confirm",
        `<p>Please verify your email address. <a href="https://acme.example/verify?t=abcDEF123456ghiJKL">Verify email</a></p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "magic_link" });
  });

  it("login/security alerts: an explicit subject suffices, body-only needs a link", async () => {
    expect(await sec("New sign-in to your account", "<p>Chrome on Windows, Lisbon.</p>")).toEqual({
      securitySensitive: true,
      reason: "login_alert",
    });
    expect(
      (await sec("Account update", "<p>We noticed a new sign-in from Chrome.</p>"))
        .securitySensitive,
    ).toBe(false);
    expect(
      await sec(
        "Account update",
        `<p>We noticed a new sign-in from Chrome. <a href="https://acme.example/security/review">Review activity</a></p>`,
      ),
    ).toEqual({ securitySensitive: true, reason: "login_alert" });
    expect(
      await sec("Your password was changed", "<p>If this wasn't you, contact us.</p>"),
    ).toEqual({ securitySensitive: true, reason: "security_alert" });
  });

  it("headers-only evaluation checks the subject alone", () => {
    const headers = fakeHeaders();
    expect(
      detectSecuritySensitive({
        parsed: fakeParsed({ subject: "482913 is your Acme verification code" }),
        content: null,
        headers,
      }),
    ).toEqual({ securitySensitive: true, reason: "otp" });
    expect(
      detectSecuritySensitive({
        parsed: fakeParsed({ subject: "Weekly digest" }),
        content: null,
        headers,
      }).securitySensitive,
    ).toBe(false);
  });
});

describe("trust badge (DESIGN-SCORE §9)", () => {
  const lu = parseListUnsubscribe("<https://acme.example/u>");
  const withAuth = (ar: string): AuthFacts => parseAuthenticationResults([ar]);
  const pass = withAuth(
    "mx.google.com; dkim=pass header.i=@acme.example; spf=pass smtp.mailfrom=b@acme.example; dmarc=pass (p=REJECT) header.from=acme.example",
  );
  const content = fakeContent({
    hasUnsubscribeLink: true,
    postalAddress: true,
    tracking: {
      pixelCount: 2,
      pixelHosts: [],
      clickTrackerHosts: ["klaviyomail.com"],
      utmCampaign: "fall",
      utmMediumEmail: true,
    },
  });

  it("trusted: DMARC pass + one-click for commercial mail", () => {
    const b = buildTrustBadge({
      headers: fakeHeaders({ auth: pass, oneClick: true, listUnsubscribe: lu }),
      content,
      isSubscription: true,
      primaryType: "promotional",
      visibleUnsubscribe: null,
    });
    expect(b).toMatchObject({
      state: "trusted",
      missing: [],
      visibleUnsubscribe: true,
      postalAddress: true,
      tracking: { pixels: 2, clickTrackerHosts: ["klaviyomail.com"], utmCampaign: "fall" },
    });
  });

  it("partial: commercial mail without one-click, visible unsubscribe or postal address", () => {
    const b = buildTrustBadge({
      headers: fakeHeaders({ auth: pass }),
      content: fakeContent(),
      isSubscription: true,
      primaryType: "newsletter",
      visibleUnsubscribe: false,
    });
    expect(b).toMatchObject({
      state: "partial",
      missing: ["one_click", "unsubscribe", "postal_address"],
    });
  });

  it("transactional mail needs no one-click; compliance items are not applicable", () => {
    const b = buildTrustBadge({
      headers: fakeHeaders({ auth: pass }),
      content: fakeContent(),
      isSubscription: false,
      primaryType: "transactional",
      visibleUnsubscribe: null,
    });
    expect(b).toMatchObject({
      state: "trusted",
      visibleUnsubscribe: null,
      postalAddress: null,
      missing: [],
    });
  });

  it("failed authentication: DMARC or DKIM fail (without ARC pass)", () => {
    const dmarcFail = withAuth(
      "mx.google.com; dkim=pass header.i=@evil.example; dmarc=fail header.from=acme.example",
    );
    expect(
      buildTrustBadge({
        headers: fakeHeaders({ auth: dmarcFail }),
        content,
        isSubscription: false,
        primaryType: "account_security",
        visibleUnsubscribe: null,
      }).state,
    ).toBe("failed_auth");
    const dkimFail = withAuth(
      "mx.google.com; dkim=fail header.i=@acme.example; spf=pass smtp.mailfrom=acme.example",
    );
    expect(
      buildTrustBadge({
        headers: fakeHeaders({ auth: dkimFail }),
        content,
        isSubscription: false,
        primaryType: "other",
        visibleUnsubscribe: null,
      }).state,
    ).toBe("failed_auth");
    const forwarded = withAuth(
      "mx.google.com; arc=pass (i=1); dkim=fail header.i=@a.example; dmarc=fail header.from=a.example",
    );
    expect(
      buildTrustBadge({
        headers: fakeHeaders({ auth: forwarded }),
        content,
        isSubscription: true,
        primaryType: "community",
        visibleUnsubscribe: true,
      }),
    ).toMatchObject({ state: "partial", missing: ["dmarc", "one_click"] });
  });

  it("unknown authentication is partial, never trusted", () => {
    const unknown = parseAuthenticationResults([]);
    expect(
      buildTrustBadge({
        headers: fakeHeaders({ auth: unknown, authResult: "unknown" }),
        content,
        isSubscription: false,
        primaryType: "notification",
        visibleUnsubscribe: null,
      }),
    ).toMatchObject({ state: "partial", missing: ["dmarc"], dmarc: "unknown" });
  });
});
