/**
 * Buttons, the text column and content-image loads (render-2026.4, render-structure) on synthetic
 * emails rendered with the local Chrome: pill buttons whose fill sits on an inner span, table-cell
 * and class-styled buttons are button-like (ordinary text links are not); a filled button outranks
 * an outline one; a painted cell around a text link means only the text is tappable; L1 measures
 * the text column, not a full-bleed background row; every content image that wasn't drawn is in
 * `images.loads` with its reason, once per URL, and an SVG is "unsupported", not broken.
 * Skipped when no Chrome binary is present.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { renderFeaturesSchema, type RenderFeatures, type RenderJob } from "@edf/design";
import { defaultChromePath, launchChromium } from "../src/chromium";
import { renderEmail } from "../src/render-email";

const CHROME = defaultChromePath();
const HAS_CHROME = existsSync(CHROME);

/** A 1×1 PNG (the layout size comes from the width/height attributes). */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const LOGO = "https://img.example.com/logo.png";
const PARA =
  "Your order has shipped and is on its way. You can follow the parcel from our warehouse to your door, change the delivery day or pick it up from a nearby locker whenever that suits you better.";

function job(
  id: string,
  body: string,
  extra: Partial<Omit<RenderJob, "html">> & { head?: string } = {},
): RenderJob {
  return {
    id,
    html: `<!doctype html><html><head><meta charset="utf-8">${extra.head ?? ""}</head><body style="margin:0;font:16px Arial,sans-serif">${body}</body></html>`,
    images: { [LOGO]: PNG, ...extra.images },
    cid: {},
    imageLog: { [LOGO]: { status: 200, bytes: 68 }, ...extra.imageLog },
    imagesAllowed: extra.imagesAllowed ?? true,
    wantAiTiles: false,
    lite: true,
  };
}

/** A 560px centred column of copy with `inner` below the paragraph. */
const column = (inner: string, bg = "#ffffff") =>
  `<table width="560" align="center" cellpadding="0" cellspacing="0" border="0" style="background:${bg}"><tr><td style="padding:24px"><p style="margin:0 0 16px">${PARA}</p>${inner}</td></tr></table>`;

describe.skipIf(!HAS_CHROME)("buttons, text column and image loads (local Chrome)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChromium({ executablePath: CHROME });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function render(j: RenderJob): Promise<RenderFeatures> {
    const out = await renderEmail(browser, j, { axeSource: null, deadlineMs: 30_000 });
    expect(out.error, j.id).toBeNull();
    expect(renderFeaturesSchema.safeParse(out.features).success, j.id).toBe(true);
    return out.features!;
  }

  describe("button detection", () => {
    it("a pill whose fill sits on an inner span is button-like, sized by the span", async () => {
      const f = await render(
        job(
          "pill",
          column(
            `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" height="40"><tr><td>
               <a href="https://example.com/start" style="color:#0b57d0;text-decoration:none;display:inline-block;font-size:14px">
                 <span style="display:inline-block;padding:9px 18px;border-radius:40px;color:#ffffff;background-color:#0b57d0;line-height:21px">Explore the plan</span>
               </a></td></tr></table>`,
          ),
        ),
      );
      const p = f.cta.primary!;
      expect(f.cta.buttonLike).toBe(1);
      expect(p.label).toBe("Explore the plan");
      expect(p.visual.h).toBeGreaterThanOrEqual(38);
      expect(p.fillDeltaE!).toBeGreaterThanOrEqual(15);
      expect(p.labelContrast!).toBeGreaterThan(4.5);
      // The link wraps the span, so the whole pill is tappable.
      expect(p.textOnlyTap).toBe(false);
    }, 60_000);

    it("a table-cell button (bgcolor + padding around an inline link): the visible box, and only the text is tappable", async () => {
      for (const cell of [
        `<td bgcolor="#e8590c" style="padding:13px 32px;border-radius:4px"><a href="https://example.com/go" style="color:#ffffff;text-decoration:none">Register now</a></td>`,
        // Wrapped in a <p> / <font> inside the cell, as many ESP templates do.
        `<td bgcolor="#e8590c" style="padding:13px 32px"><p style="margin:0"><font face="Arial"><a href="https://example.com/go" style="color:#ffffff;text-decoration:none">Register now</a></font></p></td>`,
      ]) {
        const f = await render(
          job(
            "cell",
            column(
              `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr>${cell}</tr></table>`,
            ),
          ),
        );
        const p = f.cta.primary!;
        expect(f.cta.buttonLike, cell).toBe(1);
        expect(p.visual.h, cell).toBeGreaterThanOrEqual(44);
        expect(p.target.h, cell).toBeLessThan(24);
        expect(p.textOnlyTap, cell).toBe(true);
      }
    }, 60_000);

    it("a class-styled button (<style> rule) is button-like", async () => {
      const f = await render(
        job("class", column(`<a class="btn" href="https://example.com/go">Get started</a>`), {
          head: `<style>.btn{display:inline-block;background:#1a73e8;color:#fff!important;padding:12px 24px;border-radius:6px;text-decoration:none}</style>`,
        }),
      );
      expect(f.cta.buttonLike).toBe(1);
      expect(f.cta.primary!.label).toBe("Get started");
      expect(f.cta.primary!.textOnlyTap).toBe(false);
    }, 60_000);

    it("ordinary text links stay links: inline in copy, beside other text in a coloured card, alone in a tall coloured section", async () => {
      const f = await render(
        job(
          "links",
          `${column(`<p style="margin:0">Questions? <a href="https://example.com/help">Visit the help centre</a> any time.</p>`)}
           ${column(`<div style="background:#1e3a8a;color:#fff;padding:16px">Your plan renews on 1 May. <a href="https://example.com/manage" style="color:#fff">Manage plan</a></div>`)}
           ${column(`<div style="background:#1e3a8a;padding:80px 16px;text-align:center"><a href="https://example.com/more" style="color:#fff">See all stories</a></div>`)}`,
        ),
      );
      expect(f.cta.buttonLike).toBe(0);
      expect(f.cta.primary).toBeNull();
    }, 60_000);

    it("a filled button outranks a (slightly wider) outline one beside it", async () => {
      const f = await render(
        job(
          "outline",
          column(
            `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
               <td style="border:1px solid #0a66c2;border-radius:24px;padding:12px 28px"><a href="https://example.com/profile" style="color:#0a66c2;text-decoration:none;font-weight:bold">View profile</a></td>
               <td width="12"></td>
               <td style="background:#0a66c2;border-radius:24px;padding:12px 28px"><a href="https://example.com/connect" style="color:#fff;text-decoration:none;font-weight:bold">Connect</a></td>
             </tr></table>`,
          ),
        ),
      );
      expect(f.cta.buttonLike).toBe(2);
      expect(f.cta.primary!.label).toBe("Connect");
    }, 60_000);
  });

  describe("button detection on real-world link patterns (render-2026.4 review)", () => {
    const BADGE_IOS = "https://img.example.com/badge-ios.png";
    const BADGE_PLAY = "https://img.example.com/badge-play.png";
    const badges = (iosHref: string) =>
      `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
         <td><a href="${iosHref}"><img src="${BADGE_IOS}" width="160" height="48" alt="Download on the App Store" style="display:block"></a></td>
         <td><a href="https://play.google.com/store/apps/details?id=com.example.app"><img src="${BADGE_PLAY}" width="160" height="48" alt="Get it on Google Play" style="display:block"></a></td>
       </tr></table>`;
    const badgeImages = {
      images: { [BADGE_IOS]: PNG, [BADGE_PLAY]: PNG },
      imageLog: {
        [BADGE_IOS]: { status: 200, bytes: 68 },
        [BADGE_PLAY]: { status: 200, bytes: 68 },
      },
    };
    const button = (href: string) =>
      `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#e60023;border-radius:20px;padding:10px 24px"><a href="${href}" style="color:#ffffff;text-decoration:none">Shop now</a></td></tr></table>`;

    it("app-store badges are never the call to action (direct or through a click tracker)", async () => {
      for (const ios of [
        "https://apps.apple.com/app/id000000001",
        `https://click.example.com/c?url=${encodeURIComponent("https://apps.apple.com/app/id000000001")}`,
      ]) {
        const f = await render(
          job(
            "badges",
            column(`${badges(ios)}<p>${PARA}</p>${button("https://example.com/shop")}`),
            badgeImages,
          ),
        );
        expect(f.cta.primary?.label, ios).toBe("Shop now");
        expect(f.cta.buttonLike, ios).toBe(1);
        const only = await render(job("badges-only", column(badges(ios)), badgeImages));
        expect(only.cta.primary, ios).toBeNull();
      }
    }, 60_000);

    it("a brand's own links are its content (social network, app store); other senders' aren't", async () => {
      const primaryFor = async (href: string, senderDomain: string) =>
        (
          await render({
            ...job("own-brand", column(button(href))),
            context: { listUnsubscribeHttps: [], senderDomain, language: "en" },
          })
        ).cta.primary?.label ?? null;
      const pin = "https://www.pinterest.com/ideas/example/";
      expect(await primaryFor(pin, "explore.pinterest.com")).toBe("Shop now");
      expect(await primaryFor(pin, "shop.example.com")).toBeNull();
      // A one-letter network is only its own sender's (a sender label starting with "x" isn't it).
      expect(await primaryFor("https://x.com/example", "xylophone.com")).toBeNull();
      // A store's own receipt links to the store; a store link from anyone else is a badge.
      const store = "https://play.google.com/store/account/orderhistory";
      expect(await primaryFor(store, "google.com")).toBe("Shop now");
      expect(await primaryFor(store, "shop.example.com")).toBeNull();
    }, 60_000);

    it("a filled button stays the primary beside a much wider outline one with a darker label", async () => {
      const f = await render(
        job(
          "outline-wide",
          column(
            `<div style="text-align:center"><a href="https://example.com/register" style="display:inline-block;background:#167dff;color:#ffffff;padding:12px 32px;border-radius:25px;text-decoration:none">Register</a></div>
             <div style="text-align:center;padding-top:16px"><a href="https://example.com/agenda" style="display:inline-block;background:#ffffff;border:1px solid #bababb;color:#19191c;padding:12px 64px;border-radius:25px;text-decoration:none">View the full agenda and speakers</a></div>`,
          ),
        ),
      );
      expect(f.cta.buttonLike).toBe(2);
      expect(f.cta.primary!.label).toBe("Register");
    }, 60_000);

    it("a card wrapped in one link: the nested button's tap target is the button, not the card", async () => {
      const f = await render(
        job(
          "card-link",
          column(
            `<a href="https://example.com/article" style="display:block;text-decoration:none;color:#222222"><div style="height:220px;background:#eeeeee"></div><p>${PARA}</p>
               <table cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="background:#0a66c2;border-radius:24px;padding:12px 24px"><a href="https://example.com/article" style="color:#ffffff;text-decoration:none">Read more</a></td></tr></table></a>`,
          ),
        ),
      );
      const p = f.cta.primary!;
      expect(p.label).toBe("Read more");
      expect(p.target.h).toBeLessThan(60);
      expect(p.target.h).toBeGreaterThanOrEqual(p.visual.h - 1);
      expect(p.textOnlyTap).toBe(false);
    }, 60_000);

    it("a link nested in a link (outer <a> around the button table): the whole button is the tap target", async () => {
      const f = await render(
        job(
          "nested",
          column(
            `<a href="https://example.com/connect" style="display:inline-block;text-decoration:none"><table cellpadding="0" cellspacing="0" border="0"><tr>
               <td style="background:#0a66c2;border-radius:24px;padding:12px 24px"><a href="https://example.com/connect" style="color:#ffffff;text-decoration:none">Connect</a></td>
             </tr></table></a>`,
          ),
        ),
      );
      const p = f.cta.primary!;
      expect(p.label).toBe("Connect");
      expect(p.visual.h).toBeGreaterThanOrEqual(40);
      // The tap target is the outer link (the whole button), not the inner link's text box.
      expect(p.target.h).toBeGreaterThanOrEqual(p.visual.h);
      expect(p.textOnlyTap).toBe(false);
    }, 60_000);
  });

  describe("long button labels and the footer (render-2026.5)", () => {
    // A filled cell around a link with an 8-word label (Docker), and a pill whose fill sits on a
    // span inside the link with a two-line label (upGrad).
    const cellButton = `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#2560ff" style="border-radius:6px;background:#2560ff"><a href="https://example.com/governance" style="display:inline-block;background:#2560ff;color:#ffffff;font-size:16px;font-weight:700;padding:14px 16px;text-decoration:none">Contact us to get started with AI governance</a></td></tr></table>`;
    const spanButton = `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center"><a href="https://example.com/form" style="color:#ffffff;text-decoration:none"><span style="background-color:#d8001a;color:#ffffff;display:inline-block;border-radius:4px;font-size:14px;font-weight:700"><span style="padding:5px 30px;display:block;line-height:21px">How is India actually learning AI?<br>Fill out form</span></span></a></td></tr></table>`;

    it("a filled box around a long label (8+ words) is a button; a long text link isn't", async () => {
      for (const [id, html, label] of [
        ["long-cell", cellButton, "Contact us to get started with AI governance"],
        ["long-span", spanButton, "How is India actually learning AI? Fill out form"],
      ] as const) {
        const f = await render(job(id, column(html)));
        expect(f.cta.buttonLike, id).toBe(1);
        expect(f.cta.primary?.label, id).toBe(label);
      }
      // The same words as a plain standalone link, as a link in a coloured card with a sentence,
      // or a filled banner holding a whole sentence stay links.
      const plain = await render(
        job(
          "long-plain",
          column(
            `<p style="margin:0"><a href="https://example.com/governance" style="color:#2560ff">Contact us to get started with AI governance</a></p>`,
          ),
        ),
      );
      expect(plain.cta.buttonLike).toBe(0);
      const card = await render(
        job(
          "long-card",
          column(
            `<div style="background:#eef3ff;padding:16px">Questions about rollout? <a href="https://example.com/governance" style="color:#2560ff">Contact us to get started with AI governance</a> today.</div>`,
          ),
        ),
      );
      expect(card.cta.buttonLike).toBe(0);
      const banner = await render(
        job(
          "long-banner",
          column(
            `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#2560ff" style="background:#2560ff;padding:12px"><a href="https://example.com/report" style="color:#ffffff;text-decoration:none">Read our complete annual report on how engineering teams around the world adopted agent security practices in 2026</a></td></tr></table>`,
          ),
        ),
      );
      expect(banner.cta.buttonLike).toBe(0);
    }, 60_000);

    it("the footer never swallows a filled button in the email's last section (Tavily)", async () => {
      // A short email whose last section holds the button, the postal address and the
      // unsubscribe links: the footer starts after the button, which stays the main CTA.
      const f = await render(
        job(
          "last-section",
          `<table width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px">
             <h1 style="font-size:28px;margin:0 0 16px">Results are in</h1>
             <p style="margin:0 0 16px">${PARA}</p></td></tr>
           <tr><td style="padding:10px 20px">
             <table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#1f1e1e" style="border-radius:8px;background-color:#1f1e1e"><a href="https://example.com/results" style="color:#00a4bd;font-size:16px;padding:12px 18px;display:block;text-decoration:none"><strong style="color:#ffffff">See the full results here</strong></a></td></tr></table>
             <p style="font-size:12px;color:#555555;margin:16px 0 4px">Acme Search, 1350 Broadway, New York, New York 10018, United States</p>
             <p style="font-size:12px;margin:0"><a href="https://example.com/unsubscribe" style="color:#555555">Unsubscribe</a> <a href="https://example.com/preferences" style="color:#555555">Manage preferences</a></p>
           </td></tr></table>`,
        ),
      );
      expect(f.cta.primary?.label).toBe("See the full results here");
      expect(f.cta.buttonLike).toBe(1);
      expect(f.footer.present).toBe(true);
      expect(f.footer.top!).toBeGreaterThan(f.cta.primary!.visual.y + f.cta.primary!.visual.h - 1);
    }, 60_000);
  });

  it("L1 measures the text column inside a full-bleed background row, not the row", async () => {
    const section = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111"><tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" border="0"><tr><td style="color:#eee;padding:20px 0">${PARA} ${PARA}</td></tr></table>
      </td></tr></table>`;
    const f = await render(job("column", section.repeat(3)));
    expect(f.layout.mainContainer!.w).toBeGreaterThanOrEqual(555);
    expect(f.layout.mainContainer!.w).toBeLessThanOrEqual(560);
    expect(f.layout.mainContainer!.x).toBeCloseTo(120, 0);
    // A plain, genuinely wide email keeps its width.
    const wide = await render(
      job("wide", `<div style="padding:0 10px">${PARA} ${PARA} ${PARA}</div>`),
    );
    expect(wide.layout.mainContainer!.w).toBeGreaterThanOrEqual(770);
  }, 60_000);

  describe("content-image loads", () => {
    const HERO = "https://img.example.com/poster.png";
    const SVG = "https://img.example.com/logo.svg";
    const OTHER = "https://img.example.com/banner.png";
    const TRACK = "https://mailtrack.io/trace/open";

    it("records every declared image that wasn't drawn, with its reason, once per URL", async () => {
      const f = await render(
        job(
          "loads",
          column(
            `<img src="${LOGO}" width="120" height="40" alt="Logo">
             <div style="max-width:500px"><img src="${HERO}" width="500" height="auto" alt="" style="display:block;width:100%;height:auto"></div>
             <img src="${SVG}" height="40" alt="Brand" style="display:block;height:40px;width:auto">
             <img src="${SVG}" height="32" alt="Brand" style="display:block;height:32px;width:auto">
             <img src="${OTHER}" width="560" alt="Sale">
             <img src="${TRACK}" alt="">`,
          ),
          {
            imageLog: {
              [HERO]: { status: "too_large", bytes: 0, reason: "too_many_pixels" },
              [SVG]: { status: 200, bytes: 0, reason: "svg" },
              [OTHER]: { status: "blocked", bytes: 0, reason: "per_recipient" },
              [TRACK]: { status: "blocked", bytes: 0, reason: "tracker" },
            },
          },
        ),
      );
      const loads = f.images.loads;
      expect(loads).toHaveLength(4);
      expect(loads[0]).toMatchObject({ status: 200, decoded: true });
      expect(loads[0]!.reason).toBeUndefined();
      expect(loads[1]).toMatchObject({
        status: "too_large",
        decoded: false,
        reason: "too_many_pixels",
      });
      // An SVG used twice: one entry, "not shown by Gmail" rather than broken.
      expect(loads[2]).toMatchObject({ status: "unsupported", decoded: false, reason: "svg" });
      expect(loads[3]).toMatchObject({
        status: "blocked",
        decoded: false,
        reason: "per_recipient",
      });
      expect(loads[3]!.area).toBeGreaterThan(0);
      expect(f.images.declared).toBe(4);
      expect(f.images.drawn).toBe(1);
      // The tracking pixel is not a content image.
      expect(JSON.stringify(loads)).not.toContain("tracker");
    }, 60_000);

    it("images off: declared images are recorded as blocked (images_off), none drawn", async () => {
      const f = await render(
        job("off", column(`<img src="${OTHER}" width="560" height="200" alt="Sale">`), {
          imagesAllowed: false,
        }),
      );
      expect(f.images.loads).toEqual([
        expect.objectContaining({ status: "blocked", decoded: false, reason: "images_off" }),
      ]);
      expect(f.images.declared).toBe(1);
      expect(f.images.drawn).toBe(0);
    }, 60_000);
  });
});
