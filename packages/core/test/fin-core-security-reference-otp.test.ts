import { describe, expect, it } from "vitest";
import { analyze } from "./helpers";

async function sec(subject: string, html: string, from = "Acme <no-reply@acme.example>") {
  return (await analyze({ from, subject, html })).security;
}

const NAV = "<p>New Arrivals Women Men Kids Sale</p>";
const OTP = { securitySensitive: true, reason: "otp" };
const NONE = { securitySensitive: false, reason: null };

describe("reference labels next to a real one-time code under a promo opening (C1-08)", () => {
  it.each([
    [
      "Sign in",
      "<h1>Sign in to the Acme Store</h1><p>482913</p><p>Enter this verification code to finish signing in.</p>",
    ],
    [
      "Welcome back",
      "<h1>Your Acme Store verification code</h1><p>Welcome back to Acme Store</p><p>482913</p>",
    ],
    ["Sign in", "<p>Your verification code for the Apple Store</p><p>482913</p>"],
    ["Sign in", "<p>Your sign-in code for Acme Store</p><p>482913</p>"],
    ["Booking", "<p>Your security code for booking 482913</p>"],
    ["Sign in", "<p>Your verification code for your order 482913</p>"],
    ["Sign in", "<p>Your verification code, reference 482913</p>"],
    ["Sign in", "<p>Verification code for phone 482913</p>"],
    ["Sign in", "<p>Your verification code for your order: 482913</p>"],
    ["Sign in", "<p>Your OTP for your order: 482913</p>"],
    ["Sign in", "<p>OTP for login to Acme: 482913</p>"],
    ["Sign in", "<p>Your OTP for the Acme app is 482913</p>"],
  ])("the code stays security-sensitive: %s / %s", async (subject, html) => {
    expect(await sec(subject, `${NAV}${html}`)).toEqual(OTP);
  });

  // A reward word inside the "for …" phrase never vetoes a code that a binder ties to the keyword.
  it.each([
    "<p>Your OTP for credit card payment is 482913</p>",
    "<p>OTP for your credit card transaction: 482913</p>",
    "<p>Your OTP for redeeming points is 482913</p>",
    "<p>Your OTP for voucher redemption is 482913</p>",
    "<p>Your 2FA code for your Miles account: 482913</p>",
    "<p>Your OTP for Rewards login: 482913</p>",
    "<p>Your OTP for the Bonus app is 482913</p>",
    "<p>Your OTP for Coins wallet withdrawal is 482913</p>",
    "<p>Your passcode for Stars account: 482913</p>",
    "<p>Your OTP for cashback withdrawal is 482913</p>",
    "<p>Your OTP for Discount Club sign in is 482913</p>",
  ])("a bank/loyalty OTP stays security-sensitive: %s", async (html) => {
    expect(await sec("Weekend picks", `${NAV}${html}`)).toEqual(OTP);
  });
});

describe("promo numbers near OTP wording are not codes (C1-08)", () => {
  const promo = (html: string, subject = "Weekend picks") =>
    sec(subject, `<p>Shop now: free shipping.</p>${html}`, "Acme <news@acme.example>");

  it.each([
    "<p>Enable 2FA for extra points: 5000</p>",
    "<p>Turn on 2FA for bonus rewards: 2500</p>",
    "<p>2FA for extra points: 5000</p>",
    "<p>The 2FA for bonus points: 5000</p>",
    "<p>Enable 2FA for the number of points: 5000</p>",
    "<p>Your 2FA for extra miles = 5000</p>",
    "<p>Enable 2FA for your account: 5000 bonus points</p>",
    "<p>Enable 2FA for your account: 5000 points</p>",
    "<p>Turn on two-factor for your account = 2500 points</p>",
    "<p>Enable 2FA for login: 5000 points</p>",
  ])("a promo footer's 2FA points offer is not an OTP: %s", async (html) => {
    expect(await promo(html)).toEqual(NONE);
  });

  it.each([
    "<p>Use your code at checkout.</p><p>Confirmation number: 48291374</p>",
    "<p>Use your code at checkout.</p><p>Your order confirmation 48291374</p>",
    "<p>Use your code at checkout.</p><p>Call us: 5550199</p>",
    "<p>Use your code at checkout. Order no. 5528193</p>",
  ])("a labelled reference number in another sentence is not a code: %s", async (html) => {
    expect(await promo(html, "Thanks for shopping")).toEqual(NONE);
  });
});
