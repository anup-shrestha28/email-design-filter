/**
 * Per-recipient false positives found by the 2026-09-30 gallery audit (packages/core DECISIONS.md
 * "Policy"), each reproduced with synthetic URLs: the narrow exemptions let the shared asset
 * through, and the same shapes still count as per-recipient wherever a recipient id could hide.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { imageFetchDecision, isExpiredSignedUrl, isPerRecipientUrl, looksLikeRecipientToken } from "../src/policy";

const ME = ["Owner@Example.com"];
const addr = "owner@example.com";
const ULID = "01M0A1B2C3D4E5F6G7H8J9K0MN";
const ctx = { userAddresses: ME, imagesAllowed: true };

describe("Customer.io asset-library uploads (STATIC_ASSET_UPLOAD_PATHS)", () => {
  it.each([
    `https://userimg-assets.customeriomail.com/images/client-env-123456/${ULID}.png`,
    `https://userimg-assets.customeriomail.com/images/client-env-123456/1700000000000_brand-logo-icon_${ULID}.png`,
    `https://userimg-assets-eu.customeriomail.com/images/client-env-98765/1700000000000_Footer_logo_small_${ULID}.png`,
    `https://USERIMG-ASSETS.customeriomail.com/images/client-env-1/${ULID}.gif`,
  ])("%s is a shared asset", (url) => {
    expect(isPerRecipientUrl(url, ME)).toBe(false);
    expect(imageFetchDecision({ src: url, style: "width:460px" }, ctx)).toEqual({ allowed: true });
  });

  it.each([
    // The query is still checked…
    `https://userimg-assets.customeriomail.com/images/client-env-1/${ULID}.png?uid=Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5`,
    // …and so are the recipient's address and its hashes.
    `https://userimg-assets.customeriomail.com/images/client-env-1/${encodeURIComponent(addr)}.png`,
    `https://userimg-assets.customeriomail.com/images/client-env-1/${createHash("md5").update(addr).digest("hex")}.png`,
    // Only that path shape: no other folder, no nesting, no other path on the host.
    `https://userimg-assets.customeriomail.com/e/o/${ULID}Zx8Kq2Lm9`,
    `https://userimg-assets.customeriomail.com/images/client-env-1/sub/${ULID}.png`,
    `https://userimg-assets.customeriomail.com/images/client-envx/${ULID}.png`,
    // Only those two hosts: the rest of customeriomail.com (and look-alikes) keep the token check.
    `https://e.customeriomail.com/images/client-env-1/${ULID}.png`,
    `https://userimg-assets.customeriomail.com.evil.example/images/client-env-1/${ULID}.png`,
    `https://cdn.brand.example/images/client-env-1/${ULID}.png`,
  ])("%s still carries a possible recipient token", (url) => {
    expect(isPerRecipientUrl(url, ME)).toBe(true);
  });

  it("the open pixel on a branded host is still a pixel", () => {
    const pixel = "https://email.brand.example/e/o/eyJlbWFpbF9pZCI6InN5bnRoZXRpYy0wMDAxLWFiY2RlZmdoaWprbG1ub3AifQ==";
    expect(imageFetchDecision({ src: pixel, style: "display:none;width:1px;height:1px" }, ctx)).toEqual({
      allowed: false,
      reason: "pixel",
    });
  });
});

describe("Marketo Design Studio images (STATIC_ASSET_UPLOAD_PATH_SHAPES)", () => {
  it.each([
    "https://info.brand.example/rs/123-ABC-456/images/logo_brand_blackandwhite_72x72%402x.png",
    "https://go.brand.example/rs/987-XYZ-001/images/Newsletter-Header-Autumn.jpg",
  ])("%s is a shared asset", (url) => expect(isPerRecipientUrl(url, ME)).toBe(false));

  it.each([
    // Only that path shape (a Munchkin id, then images/, then one file) …
    "https://info.brand.example/rs/123-ABC-456/images/sub/Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5.png",
    "https://info.brand.example/rs/12-ABC-456/images/Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5.png",
    "https://info.brand.example/rs/123-abc-456/images/Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5.png",
    "https://info.brand.example/x/rs/123-ABC-456/images/Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5.png",
    // … and the query and the address checks still apply.
    "https://info.brand.example/rs/123-ABC-456/images/logo.png?mkt_tok=Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5",
    `https://info.brand.example/rs/123-ABC-456/images/${encodeURIComponent(addr)}.png`,
  ])("%s still carries a possible recipient token", (url) => expect(isPerRecipientUrl(url, ME)).toBe(true));
});

describe("expired signed CDN URLs (isExpiredSignedUrl)", () => {
  const now = 1_790_000_000;
  it("a LinkedIn media URL whose `e` has passed can't load; one still valid, or without `e`, can", () => {
    const at = (e: string) => `https://media.licdn.com/dms/image/v2/D56/p/0/1?e=${e}&v=beta&t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ`;
    expect(isExpiredSignedUrl(at(String(now - 1)), now)).toBe(true);
    expect(isExpiredSignedUrl(at(String(now + 86_400)), now)).toBe(false);
    expect(isExpiredSignedUrl(at("2147483647"), now)).toBe(false);
    expect(isExpiredSignedUrl(at("soon"), now)).toBe(false);
    expect(isExpiredSignedUrl("https://static.licdn.com/aero-v1/sc/h/abc.png", now)).toBe(false);
    // Only on the CDNs that sign an expiry into `e` (elsewhere `e` means anything).
    expect(isExpiredSignedUrl(`https://img.brand.example/p.png?e=${now - 1}`, now)).toBe(false);
    // Not a privacy decision: the policy itself is unchanged.
    expect(imageFetchDecision({ src: at(String(now - 1)) }, ctx)).toEqual({ allowed: true });
  });
});

describe("dated file names (DATE_IN_NAME)", () => {
  it.each([
    "https://newsletter.brand.example/uploads/WhatsApp-Image-2026-05-02-at-09.14.22-PM_Xy34Zw.jpeg",
    "https://cdn.brand.example/uploads/Screenshot_2026_08_13_at_Sale_banner.png",
    "https://cdn.brand.example/uploads/Photo-from-Team-1999-12-31-at-Home.jpg",
  ])("%s is a shared asset", (url) => expect(isPerRecipientUrl(url, ME)).toBe(false));

  it("a date is neutral: it neither counts as a word nor hides a random part", () => {
    expect(looksLikeRecipientToken("WhatsApp-Image-2026-05-02-at-09", true)).toBe(false);
    // Without the date rule these were tokens; a random part next to a date still is one.
    expect(looksLikeRecipientToken("2026-08-13-a8Kd9fJ2kLm3xYq7Rw", true)).toBe(true);
    expect(looksLikeRecipientToken("2026_08_13_Zq8Kd9fJ2kLm3xYq7Rw2", true)).toBe(true);
    expect(looksLikeRecipientToken("x9Kd2Lm8Qp4Rt7Wy1Bn3-2026-08-13", false)).toBe(true);
    // Not a date (month 13, mixed separators): the numbers stay parts, and outnumber the words.
    expect(looksLikeRecipientToken("Photo-2026-13-08-at-11-Kq", true)).toBe(true);
    expect(looksLikeRecipientToken("Photo-2026-08_13-at-11-Kq", true)).toBe(true);
    expect(looksLikeRecipientToken("Photo-2026-08-13-at-11-Kq", true)).toBe(false);
    for (const url of [
      "https://img.brand.example/2026-08-13-a8Kd9fJ2kLm3xYq7Rw.png",
      "https://img.brand.example/p?id=2026-08-13-a8Kd9fJ2kLm3xYq7Rw",
      "https://img.brand.example/o/2026-08-13_Zq8Kd9fJ2kLm3xYq7Rw2.gif",
      "https://img.brand.example/banner-12026-08-137Zq8Kd9fJ2kLm3xYq7Rw.png",
    ]) {
      expect(isPerRecipientUrl(url, ME), url).toBe(true);
    }
  });
});

describe("kept as per-recipient (documented misses and correct removals)", () => {
  it.each([
    // A 40-character random upload name (Laravel's hashName) reads exactly like a path token.
    "https://bucket.s3.eu-west-1.amazonaws.com/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/logo/Q7wLm2Xk9Rt4Vz8Nc1Bp6Hs3Jd5Fg0Ye7Ua2Oi9P.png",
    // A random suffix on an upload name, on a generic CDN.
    "https://d111111abcdef8.cloudfront.net/uploads/images/75x75/5f0c1a2b3c4d5_company_image-Hk3Lm9Qz2Wx7Rt5Yb1Nc8Vd4Pq6.png",
    // A signed Facebook CDN URL minted per message: opaque query ids that can't be told from a
    // per-recipient one (unlike LinkedIn's verified `t`).
    "https://scontent.xx.fbcdn.net/v/t39.2081-6/1_2_3_n.png?stp=dst-png_p32x32&_nc_cat=1&_nc_sid=abc123&_nc_ohc=Zk3Lm9Qz2Wx7Rt-Yb1Nc8&_nc_oc=AdQz9Lm3Wx7Rt5Yb1Nc8Vd4Pq6Hk3Lm9Qz2Wx7Rt5Yb1Nc8Vd4Pq6",
  ])("%s", (url) => expect(isPerRecipientUrl(url, ME)).toBe(true));
});
