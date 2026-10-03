import { describe, expect, it } from "vitest";
import { analyze } from "./helpers";

async function sec(subject: string, html: string, from = "Acme <no-reply@acme.example>") {
  return (await analyze({ from, subject, html })).security;
}

const NAV = "<p>New Arrivals Women Men Kids Sale</p>";
const OTP = { securitySensitive: true, reason: "otp" };
const NONE = { securitySensitive: false, reason: null };

describe("OTP wording in a marketing template (C1-08)", () => {
  it.each([
    ["Login", "<p>Your OTP for login is 482913</p>"],
    ["Your OTP", "<p>Your OTP is 482913</p>"],
    ["Sign in", "<p>Your passcode is 482913</p>"],
    ["Sign in", "<p>Your 2FA code: 482913</p>"],
    ["Sign in", "<p>Your 2FA code:</p><p>482 913</p><p>It expires in 10 minutes.</p>"],
  ])("generic OTP keyword bound to the code under a nav bar: %s / %s", async (subject, html) => {
    expect(await sec(subject, `${NAV}${html}`)).toEqual(OTP);
  });

  it("a subject that names the OTP lets the generic keyword count", async () => {
    expect(await sec("Your OTP", `${NAV}<p>Use 482913 to log in to Acme.</p>`)).toEqual(OTP);
  });

  it("generic footer wording is still not a code", async () => {
    const promo = (subject: string, html: string) => sec(subject, html, "Acme <news@acme.example>");
    expect(
      await promo(
        "Neue Kollektion",
        `<p>Sale: up to 40% off new arrivals. Shop now!</p><p>Acme GmbH, Hauptstraße 5, 10115 Berlin · Turn on two-factor authentication.</p>`,
      ),
    ).toEqual(NONE);
    expect(
      await promo(
        "Weekend picks",
        `<p>Shop now: free shipping on everything.</p><p>Turn on 2FA. Call 5550199 for help.</p>`,
      ),
    ).toEqual(NONE);
  });

  it("an order number near 'use your code at checkout' in a promo is not a one-time code", async () => {
    expect(
      await sec(
        "Thanks for shopping",
        `<p>Flash sale: 20% off everything. Shop now!</p><p>Use your code at checkout. Order 48291374 ships soon.</p>`,
        "Acme <news@acme.example>",
      ),
    ).toEqual(NONE);
    expect(
      await sec(
        "Thanks for shopping",
        `<p>Flash sale: 20% off everything. Shop now!</p><p>Use your code at checkout. Order #: 48291374 · Order no. 5528193</p>`,
        "Acme <news@acme.example>",
      ),
    ).toEqual(NONE);
  });
});

describe("OTP binding under a promo opening, second pass (C1-08)", () => {
  const promo = (html: string, subject = "Weekend picks") =>
    sec(subject, `<p>Shop now: free shipping.</p>${html}`, "Acme <news@acme.example>");

  it.each([
    "<p>Enable 2FA for 5000 bonus points</p>",
    "<p>Get 2FA for 1000 bonus points</p>",
    "<p>Turn on 2FA — 15000 members already have</p>",
    "<p>Protect your account: turn on 2FA</p><p>5550199</p>",
    "<p>Turn on two-factor authentication to earn 2500 points.</p>",
    "<p>Call 5550199 to turn on 2FA.</p>",
    "<p>2FA</p><p>5550199</p>",
  ])("a promo footer's 2FA wording next to a number is not an OTP: %s", async (html) => {
    expect(await promo(html)).toEqual(NONE);
  });

  it.each([
    "<p>Use your code at checkout.</p><p>Your order number is 48291374.</p>",
    "<p>Use your code at checkout.</p><p>Your order ID is 48291374.</p>",
    "<p>Use your code at checkout.</p><p>Tracking: 1Z 4829 1374</p>",
    "<p>Use your code at checkout.</p><p>Tracking number: 1Z4829X1374</p>",
  ])("a labelled reference number in a promo is not a code: %s", async (html) => {
    expect(await promo(html, "Thanks for shopping")).toEqual(NONE);
  });

  it.each([
    ["Sign in", "<p>Your verification code for your order: 482913</p>"],
    ["Delivery", "<p>Your verification code for order 48291374 is 482913</p>"],
    ["Sign in", "<p>Use 482913 as your OTP.</p>"],
    ["Sign in", "<p>Enter 482913 as your passcode.</p>"],
    ["Sign in", "<p>482913 is your OTP</p>"],
    ["Sign in", "<p>Your OTP is valid for 10 minutes: 482913</p>"],
    ["Sign in", "<p>Your OTP code for your Acme account is 482913</p>"],
    ["Delivery", "<p>Your delivery OTP for order 48291374 is 4829</p>"],
    ["Sign in", "<p>Your OTP:</p><p>482913</p>"],
    ["Sign in", "<p>OTP - 482913</p>"],
  ])("an OTP in a marketing template stays sensitive: %s / %s", async (subject, html) => {
    expect(await sec(subject, `${NAV}${html}`)).toEqual(OTP);
  });
});
