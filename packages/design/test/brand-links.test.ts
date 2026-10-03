import { describe, expect, it } from "vitest";
import { extractStaticDesign } from "../src/index";
import * as kit from "../src/render-kit";
import { brandOf, isOtherBrandLink, isOwnBrandHost } from "../src/util/links";

/**
 * Other brands' links (social icons, app-store badges) are never a call to action; the sender's
 * own brand is content. One rule (`isOtherBrandLink`) for the static pass and the renderer —
 * these cases mirror packages/render/test/structure.test.ts ("a brand's own links…").
 */
describe("other brands' links (static ∥ render)", () => {
  it("the renderer imports the very same helpers", () => {
    expect(kit.isOtherBrandLink).toBe(isOtherBrandLink);
    expect(kit.isOwnBrandHost).toBe(isOwnBrandHost);
    expect(kit.brandOf).toBe(brandOf);
  });

  it("own brand: same label, or the sender's label extends one of ≥ 4 letters", () => {
    expect(brandOf("mail.example.co.uk")).toBe("example");
    expect(isOwnBrandHost("www.linkedin.com", brandOf("linkedin.com"))).toBe(true);
    expect(isOwnBrandHost("www.facebook.com", brandOf("facebookmail.com"))).toBe(true);
    expect(isOwnBrandHost("youtu.be", brandOf("youtube.com"))).toBe(true);
    expect(isOwnBrandHost("x.com", brandOf("xbox.com"))).toBe(false);
    expect(isOwnBrandHost("x.com", brandOf("x.com"))).toBe(true);
    expect(isOwnBrandHost("www.linkedin.com", null)).toBe(false);
  });

  it("social links and store badges of other brands are excluded; the sender's own are not", () => {
    const li = "https://www.linkedin.com/comm/in/example";
    expect(isOtherBrandLink(li, "Connect", false, brandOf("linkedin.com"))).toBe(false);
    expect(isOtherBrandLink(li, "Connect", false, brandOf("shop.example.com"))).toBe(true);
    expect(isOtherBrandLink(li, "Connect", false, null)).toBe(true);
    expect(isOtherBrandLink("https://x.com/example", "", true, brandOf("xylophone.com"))).toBe(
      true,
    );
    const store = "https://play.google.com/store/account/orderhistory";
    expect(isOtherBrandLink(store, "Order history", false, brandOf("google.com"))).toBe(false);
    expect(isOtherBrandLink(store, "Order history", false, brandOf("example.com"))).toBe(true);
    const tracked = `https://click.example.com/c?url=${encodeURIComponent("https://apps.apple.com/app/id1")}`;
    expect(isOtherBrandLink(tracked, "Open", false, brandOf("example.com"))).toBe(true);
    // A badge by its alt text (image-only link), wherever it points.
    const badge = "https://example.com/app";
    expect(isOtherBrandLink(badge, "Get it on Google Play", true, brandOf("example.com"))).toBe(
      true,
    );
    expect(isOtherBrandLink(badge, "Get it on Google Play", false, brandOf("example.com"))).toBe(
      false,
    );
  });
});

describe("static CTA candidates follow the same rule", () => {
  const button = (href: string) =>
    `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#e60023;border-radius:20px;padding:10px 24px"><a href="${href}" style="color:#ffffff;text-decoration:none">Shop now</a></td></tr></table>`;
  const badges = (iosHref: string) =>
    `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
       <td><a href="${iosHref}"><img src="https://img.example.com/badge-ios.png" width="160" height="48" alt="Download on the App Store"></a></td>
       <td><a href="https://play.google.com/store/apps/details?id=com.example.app"><img src="https://img.example.com/badge-play.png" width="160" height="48" alt="Get it on Google Play"></a></td>
     </tr></table>`;
  const cta = (body: string, senderDomain: string | null) => {
    const html = `<html><body><p>A short paragraph of synthetic body copy.</p>${body}</body></html>`;
    return extractStaticDesign(html, {
      htmlBytes: html.length,
      subject: null,
      listUnsubscribeHttps: [],
      senderDomain,
      language: "en",
    }).static.cta;
  };
  const primaryFor = (href: string, senderDomain: string) =>
    cta(button(href), senderDomain).primaryLabel;

  it("a brand's own links are its content (social network, app store); other senders' aren't", () => {
    const pin = "https://www.pinterest.com/ideas/example/";
    expect(primaryFor(pin, "explore.pinterest.com")).toBe("shop now");
    expect(primaryFor(pin, "shop.example.com")).toBeNull();
    expect(primaryFor("https://www.linkedin.com/comm/jobs/view/1", "linkedin.com")).toBe(
      "shop now",
    );
    expect(primaryFor("https://www.linkedin.com/comm/jobs/view/1", "example.com")).toBeNull();
    // A one-letter network is only its own sender's (a sender label starting with "x" isn't it).
    expect(primaryFor("https://x.com/example", "xylophone.com")).toBeNull();
    const store = "https://play.google.com/store/account/orderhistory";
    expect(primaryFor(store, "google.com")).toBe("shop now");
    expect(primaryFor(store, "shop.example.com")).toBeNull();
  });

  it("app-store badges are never the call to action (direct or through a click tracker)", () => {
    for (const ios of [
      "https://apps.apple.com/app/id000000001",
      `https://click.example.com/c?url=${encodeURIComponent("https://apps.apple.com/app/id000000001")}`,
    ]) {
      const c = cta(`${badges(ios)}${button("https://example.com/shop")}`, "example.com");
      expect(c.buttonLike, ios).toBe(1);
      expect(c.primaryLabel, ios).toBe("shop now");
      expect(cta(badges(ios), "example.com").buttonLike, ios).toBe(0);
    }
  });
});
