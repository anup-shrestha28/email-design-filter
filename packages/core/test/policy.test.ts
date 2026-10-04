import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractImageRefs,
  imageFetchDecision,
  imagesAllowedFor,
  isClickTrackerHost,
  isClickTrackingUrl,
  isPerRecipientUrl,
  isTrackerHost,
  isTrackingPixel,
} from "../src/policy";

const ME = ["Owner@Example.com"];
const addr = "owner@example.com";

describe("tracker hosts (our own list; not Disconnect/DuckDuckGo)", () => {
  it.each([
    "trk.klaviyomail.com",
    "ctrk.klaviyomail.com",
    "us21.list-manage.com",
    "r.us-east-1.awstrack.me",
    "click.convertkit-mail2.com",
    "eotrx.substackcdn.com",
    "mandrillapp.com",
    "u123.klclick3.com",
  ])("%s is tracker-exclusive", (h) => expect(isTrackerHost(h)).toBe(true));
  it.each([
    "cdn.shopify.com",
    "substackcdn.com",
    "mcusercontent.com",
    // Klaviyo's image CDN, beside its trk./ctrk. trackers on the same domain (a Grüns welcome
    // email's designed sections live there).
    "cdn.klaviyomail.com",
    "CDN.Klaviyomail.com.",
    "cdn.mcauto-images-production.sendgrid.net",
    "images.example.com",
    "example.com",
  ])("%s serves content (not exclusive)", (h) => expect(isTrackerHost(h)).toBe(false));

  it("click trackers: ESP click domains, shorteners and branded redirect shapes", () => {
    expect(isClickTrackerHost("u1843377.ct.sendgrid.net")).toBe(true);
    expect(isClickTrackerHost("bit.ly")).toBe(true);
    expect(isClickTrackerHost("brand.example")).toBe(false);
    expect(isClickTrackingUrl("https://url9921.brand.example/ls/click?upn=abc123")).toBe(true);
    expect(
      isClickTrackingUrl("https://r.brand.example/CL0/https:%2F%2Fbrand.example%2F/1/0100abc/xyz"),
    ).toBe(true);
    expect(isClickTrackingUrl("https://email.mg.brand.example/c/eJyNkM1uwjAQhF8l8pk")).toBe(true);
    expect(isClickTrackingUrl("https://brand.example/products/jacket?utm_medium=email")).toBe(
      false,
    );
  });
});

describe("tracking pixels (DESIGN-SCORE §2.1)", () => {
  it.each([
    [{ src: "https://brand.example/i.gif", width: "1", height: "1" }],
    [{ src: "https://brand.example/i.gif", width: "0", height: "1" }],
    [{ src: "https://brand.example/i.gif", width: "5", height: "5" }],
    [{ src: "https://brand.example/i.gif", width: "1" }],
    [{ src: "https://brand.example/i.gif", style: "width:1px;height:1px" }],
    [{ src: "https://brand.example/i.gif", style: "max-width:1px" }],
    [{ src: "https://brand.example/i.gif", style: "display:none" }],
    [{ src: "https://brand.example/i.gif", style: "visibility:hidden" }],
    [{ src: "https://brand.example/i.gif", style: "opacity:0" }],
    [{ src: "https://trk.klaviyomail.com/open/abc.gif", width: "600", height: "300" }],
    [{ src: "https://email.brand.example/wf/open?upn=abc" }],
    [{ src: "https://brand.example/track/open.php?u=1&id=2" }],
    [{ src: "https://email.mg.brand.example/o/eJyNkM1uwjAQhF8l8pkabc" }],
    [{ src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", width: "1", height: "1" }],
  ])("%j is a pixel", (img) => expect(isTrackingPixel(img)).toBe(true));

  it.each([
    [{ src: "https://cdn.brand.example/hero.jpg", width: "600", height: "300" }],
    [{ src: "https://cdn.brand.example/open-sign.jpg" }],
    [{ src: "https://brand.example/wf/open?upn=abc", width: "600", height: "200" }],
    [
      {
        src: "https://cdn.brand.example/logo.png",
        width: "160",
        height: "40",
        style: "display:block;border:0",
      },
    ],
  ])("%j is content", (img) => expect(isTrackingPixel(img)).toBe(false));
});

describe("per-recipient URLs (DESIGN.md §6.3)", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  it.each([
    `https://img.brand.example/p?e=${addr}`,
    `https://img.brand.example/p?e=${encodeURIComponent(addr)}`,
    `https://img.brand.example/p/${b64(addr)}.png`,
    `https://img.brand.example/p?d=${b64(`["5fc63", "${addr}"]`)}`, // address inside a base64 blob
    `https://img.brand.example/p?d=${b64(`{"x":"${addr}"}`).replace(/\+/g, "-").replace(/\//g, "_")}`,
    `https://img.brand.example/p?h=${createHash("md5").update(addr).digest("hex")}`,
    `https://img.brand.example/p?h=${createHash("sha256").update(addr).digest("hex").toUpperCase()}`,
    "https://img.brand.example/o/eJyNkM1uwjAQhF8l8pkabcDefGhIjk.png",
    "https://img.brand.example/banner.png?rid=Zx8Kq2Lm9Pv4Rt7Wy1Bn3Cd5",
    "https://img.brand.example/p.png?sub=3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
    `https://img.brand.example/${"a1B2".repeat(200)}`,
    // LinkedIn's `t` is exempt only in its signature shape, on LinkedIn's CDN, and only as `t`.
    "https://media.licdn.com/dms/image/v2/D56/p/0/1?e=2147483647&v=beta&t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQZx8Kq2Lm9Pv4",
    "https://media.licdn.com/dms/image/v2/D56/p/0/1?e=2147483647&v=beta&rid=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ",
    "https://img.brand.example/p.png?t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ",
    `https://media.licdn.com/dms/image/v2/D56/p/0/1?t=${b64(addr)}`,
  ])("%s carries the recipient", (url) => expect(isPerRecipientUrl(url, ME)).toBe(true));

  it.each([
    "https://cdn.brand.example/assets/logo.3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c.png",
    "https://cdn.brand.example/images/2b1f4c9e-8d7a-4f3b-9c2e-1a0b9c8d7e6f/hero.png",
    "https://cdn.sanity.io/images/abc12345/production/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c1d2e3f40-1200x600.png",
    "https://cdn.brand.example/images/autumn-sale-hero-image-2026.jpg",
    "https://cdn.brand.example/images/summer2026HeroImageBanner.jpg",
    "https://lh3.googleusercontent.com/AF1QipN9x8Kq2Lm9Pv4Rt7Wy1Bn3Cd5Ef6Gh7Ij8Kl9Mn0Op1Qr2",
    "https://cdn.shopify.com/s/files/1/0123/4567/files/hero.jpg?v=1690000000",
    "https://brand.imgix.net/hero.jpg?w=600&auto=format&s=3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
    "https://cdn.brand.example/products/jacket-green-large.jpg?width=600",
    // LinkedIn's CDN signature (one 32-byte HMAC, the same in every email carrying the photo).
    "https://media.licdn.com/dms/image/v2/D5603AQE0iv1cTMyzgQ/profile-displayphoto-shrink_200_200/B56ZdI95IgGsAc-/0/1749275875880?e=2147483647&v=beta&t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ",
  ])("%s is a shared asset", (url) => expect(isPerRecipientUrl(url, ME)).toBe(false));
});

describe("imageFetchDecision / imagesAllowedFor", () => {
  const ctx = { userAddresses: ME, imagesAllowed: true };
  it("orders reasons: not_http → policy_off → tracker → pixel → per_recipient", () => {
    expect(imageFetchDecision({ src: "cid:logo@x" }, ctx)).toEqual({
      allowed: false,
      reason: "not_http",
    });
    expect(imageFetchDecision({ src: "https://user:pw@cdn.example/a.png" }, ctx)).toEqual({
      allowed: false,
      reason: "not_http",
    });
    expect(
      imageFetchDecision({ src: "https://cdn.example/a.png" }, { ...ctx, imagesAllowed: false }),
    ).toEqual({ allowed: false, reason: "policy_off" });
    expect(
      imageFetchDecision(
        { src: "https://trk.klaviyomail.com/open/a.gif", width: "1", height: "1" },
        ctx,
      ),
    ).toEqual({ allowed: false, reason: "tracker" });
    expect(
      imageFetchDecision({ src: "https://cdn.example/a.gif", width: "1", height: "1" }, ctx),
    ).toEqual({ allowed: false, reason: "pixel" });
    expect(
      imageFetchDecision(
        { src: `https://cdn.example/a.png?e=${addr}`, width: "600", height: "300" },
        ctx,
      ),
    ).toEqual({ allowed: false, reason: "per_recipient" });
    expect(
      imageFetchDecision({ src: "https://cdn.example/hero.jpg", width: "600", height: "300" }, ctx),
    ).toEqual({ allowed: true });
  });

  it("loads a Klaviyo CDN picture; its open pixel on the same domain stays blocked", () => {
    expect(
      imageFetchDecision(
        {
          src: "https://cdn.klaviyomail.com/company/YnDPxD/images/d7e057f5-e63e-4345-92f0-3dc1019c45d4.png",
          width: "600",
          style: "display:block;height:auto;width:100%",
        },
        ctx,
      ),
    ).toEqual({ allowed: true });
    expect(
      imageFetchDecision({ src: "https://trk.klaviyomail.com/open/a.gif", width: "1", height: "1" }, ctx),
    ).toEqual({ allowed: false, reason: "tracker" });
  });

  it("no images for security, transactional, suspicious mail or in privacy mode", () => {
    const ok = {
      primaryType: "promotional",
      securitySensitive: false,
      suspicious: false,
      loadImagesForAnalysis: true,
    };
    expect(imagesAllowedFor(ok)).toBe(true);
    expect(imagesAllowedFor({ ...ok, primaryType: "account_security" })).toBe(false);
    expect(imagesAllowedFor({ ...ok, primaryType: "transactional" })).toBe(false);
    expect(imagesAllowedFor({ ...ok, securitySensitive: true })).toBe(false);
    expect(imagesAllowedFor({ ...ok, suspicious: true })).toBe(false);
    expect(imagesAllowedFor({ ...ok, loadImagesForAnalysis: false })).toBe(false);
  });
});

describe("extractImageRefs", () => {
  const html = `<!doctype html><html><head><style>
    @import url("https://fonts.example/css?family=Inter");
    @font-face { font-family: X; src: url(https://fonts.example/x.woff2) format("woff2"); }
    /* url(https://commented.example/nope.png) */
    .hero { background-image: url('https://cdn.example/bg.jpg'); }
  </style></head><body background="https://cdn.example/body-bg.png">
    <img src="https://cdn.example/logo.png?a=1&amp;b=2" width="160" height="40" alt="Logo" style="display:block">
    <img src="cid:inline@x"><img src="data:image/png;base64,AAAA"><img src="/relative.png">
    <table><tr><td style="background:url(&quot;https://cdn.example/cell.jpg&quot;) no-repeat">x</td></tr></table>
    <img src="https://cdn.example/logo.png?a=1&b=2">
    <script>var i = "<img src='https://evil.example/x.png'>";</script>
  </body></html>`;

  it("returns absolute http(s) image refs in document order, deduplicated, fonts/imports excluded", () => {
    const refs = extractImageRefs(html);
    expect(refs.map((r) => [r.kind, r.src])).toEqual([
      ["css", "https://cdn.example/bg.jpg"],
      ["background-attr", "https://cdn.example/body-bg.png"],
      ["img", "https://cdn.example/logo.png?a=1&b=2"],
      ["css", "https://cdn.example/cell.jpg"],
    ]);
    expect(refs[2]).toMatchObject({
      width: "160",
      height: "40",
      alt: "Logo",
      style: "display:block",
    });
  });

  it("caps the number of refs", () => {
    const many = Array.from(
      { length: 100 },
      (_, i) => `<img src="https://cdn.example/${i}.png">`,
    ).join("");
    expect(extractImageRefs(many)).toHaveLength(60);
    expect(extractImageRefs(many, { max: 5 })).toHaveLength(5);
    expect(extractImageRefs("", {})).toEqual([]);
  });
});
