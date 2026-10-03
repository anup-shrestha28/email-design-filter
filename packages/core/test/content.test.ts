import { describe, expect, it } from "vitest";
import { countWords, simhashDistance } from "../src/index";
import { analyze } from "./helpers";

async function content(html: string, headers: string[] = []) {
  return (await analyze({ subject: "Hi", html, headers })).content;
}

const page = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const ZWNJ = String.fromCharCode(0x200c);
const CGJ = String.fromCharCode(0x34f);

describe("visible text and the hidden preheader", () => {
  it("skips head/title/script/style and hidden elements", async () => {
    const c = await content(
      page(
        `<p>Visible one.</p>
         <div style="display:none">hidden a</div>
         <span style="visibility:hidden">hidden b</span>
         <span style="opacity:0">hidden c</span>
         <span style="font-size:0">hidden d</span>
         <div style="max-height:0;overflow:hidden">hidden e</div>
         <p class="pre">hidden f</p>
         <p class="mob">shown on desktop</p>
         <p style="mso-hide:all">outlook-only hide</p>
         <script>var x = "hidden g";</script>
         <p>Visible two.</p>`,
        `<title>hidden title</title><style>.pre{display:none!important} @media (max-width:600px){.mob{display:none}}</style>`,
      ),
    );
    expect(c.visibleText).toContain("Visible one.");
    expect(c.visibleText).toContain("Visible two.");
    expect(c.visibleText).toContain("shown on desktop");
    expect(c.visibleText).toContain("outlook-only hide");
    expect(c.visibleText).not.toMatch(/hidden [a-g]|hidden title/);
  });

  it("detects the hidden preheader before visible content and puts it first in the excerpt", async () => {
    const c = await content(
      page(
        `<div style="display:none;max-height:0;overflow:hidden">Last chance: 30% off ${CGJ}${ZWNJ} ${CGJ}${ZWNJ}</div><h1>Autumn sale</h1><div style="display:none">not a preheader</div>`,
      ),
    );
    expect(c.preheader).toBe("Last chance: 30% off");
    expect(c.visibleText.startsWith("Last chance: 30% off\nAutumn sale")).toBe(true);
    expect(c.visibleText).not.toContain("not a preheader");
  });

  it("counts words with Intl.Segmenter (CJK too) and detects language only on ≥ 20 words", async () => {
    expect(countWords("Hello brave new world")).toBe(4);
    expect(countWords("生成AIと小さなチームの働き方")).toBeGreaterThan(5);
    expect((await content(page("<p>Bonjour et merci.</p>"))).language).toBeNull();
    const fr = await content(
      page(
        "<p>Nous sommes ravis de vous présenter notre nouvelle collection d'automne. Découvrez des pièces intemporelles, fabriquées avec soin dans nos ateliers, et profitez de la livraison offerte pendant toute la semaine.</p>",
      ),
    );
    expect(fr.language).toBe("fr");
    const es = await content(
      page(
        "<p>Estamos encantados de presentarte nuestra nueva colección de otoño. Descubre prendas atemporales, fabricadas con cuidado en nuestros talleres, y disfruta del envío gratuito durante toda la semana.</p>",
      ),
    );
    expect(es.language).toBe("es");
  });

  it("walks pathologically deep documents without overflowing the stack", async () => {
    const deep = `${"<div>".repeat(20_000)}deep text${"</div>".repeat(20_000)}`;
    const c = await content(page(deep));
    expect(c.visibleText).toContain("deep text");
  });
});

describe("links, CTAs and footer markers", () => {
  it("finds button-like CTAs (inline style, class, bulletproof cell, image button) but not text links", async () => {
    const c = await content(
      page(`
      <p>Read our <a href="https://acme.example/blog">latest post</a> today.</p>
      <a href="https://acme.example/shop" style="background:#123456;color:#fff;padding:12px 20px;display:inline-block">Shop the sale →</a>
      <a class="btn-primary" href="https://acme.example/new">New arrivals</a>
      <table><tr><td bgcolor="#1d4f3a" style="border-radius:6px"><a href="https://acme.example/app" style="color:#fff">Get the app</a></td></tr></table>
      <a href="https://acme.example/go"><img src="https://acme.example/btn.png" width="200" height="50" alt="Shop now"></a>
      <a href="https://acme.example/u" style="background:#000;padding:8px">Unsubscribe</a>`),
    );
    expect(c.ctaLabels).toEqual(["shop the sale", "new arrivals", "get the app", "shop now"]);
    expect(c.linkCount).toBe(6);
  });

  it.each([
    ["Unsubscribe"],
    ["Darse de baja"],
    ["Se désabonner"],
    ["Abmelden"],
    ["Annulla l'iscrizione"],
    ["Descadastre-se"],
    ["Uitschrijven"],
    ["Wypisz się"],
    ["Avregistrera"],
    ["Afmeld nyhedsbrev"],
    ["Meld deg av"],
    ["Peruuta tilaus"],
    ["配信停止"],
    ["退订"],
    ["수신거부"],
    ["Отписаться"],
    ["Abonelikten çık"],
  ])("unsubscribe link text: %s", async (label) => {
    const c = await content(
      page(`<p>Footer</p><p><a href="https://acme.example/x/y">${label}</a></p>`),
    );
    expect(c.hasUnsubscribeLink).toBe(true);
  });

  it("'click here' counts when the surrounding text says unsubscribe; List-Unsubscribe targets count too", async () => {
    expect(
      (
        await content(
          page(
            `<p>To unsubscribe from these emails, <a href="https://acme.example/z">click here</a>.</p>`,
          ),
        )
      ).hasUnsubscribeLink,
    ).toBe(true);
    expect(
      (await content(page(`<p>For the menu, <a href="https://acme.example/z">click here</a>.</p>`)))
        .hasUnsubscribeLink,
    ).toBe(false);
    const lu = await content(
      page(`<p><a href="https://lists.acme.example/l/opt/123?x=1">Leave this list</a></p>`),
      ["List-Unsubscribe: <https://lists.acme.example/l/opt/123?x=9>"],
    );
    expect(lu.hasUnsubscribeLink).toBe(true);
  });

  it("plain-text mail: the words before a bare URL decide", async () => {
    const a = await analyze({
      subject: "x",
      text: "Weekly notes.\nUnsubscribe: https://acme.example/u/abc\nManage preferences: https://acme.example/p/abc\n",
    });
    expect(a.content.hasUnsubscribeLink).toBe(true);
    expect(a.content.hasPreferencesLink).toBe(true);
    expect(a.content.linkCount).toBe(2);
  });

  it("detects preferences links, receiving statements and postal addresses", async () => {
    const c = await content(
      page(
        `<p>Hello</p><p>You're receiving this because you signed up at acme.example. <a href="https://acme.example/prefs">Manage your preferences</a></p><p>Acme Inc., 1200 Alder Street, Portland, OR 97205</p>`,
      ),
    );
    expect(c.hasPreferencesLink).toBe(true);
    expect(c.receivingStatement).toBe(true);
    expect(c.postalAddress).toBe(true);
    expect(
      (await content(page(`<p>Sie erhalten diese E-Mail, weil Sie sich angemeldet haben.</p>`)))
        .receivingStatement,
    ).toBe(true);
  });

  it.each([
    ["Acme Ltd, 21 Clerkenwell Road, London EC1M 5RN", true],
    ["Acme GmbH, Torstraße 110, 10119 Berlin", true],
    ["Acme SAS, 12 rue de Rivoli, 75004 Paris", true],
    ["Acme Pty Ltd, Level 3, 10 George St, Sydney NSW 2000", true],
    ["Acme Inc., 100 King St W, Toronto, ON M5X 1A9", true],
    ["Call us on 0800 123 4567 anytime", false],
    ["Earn 10000 points this week", false],
  ])("postal address: %s → %s", async (footer, want) => {
    expect((await content(page(`<p>Body text.</p><p>${footer}</p>`))).postalAddress).toBe(want);
  });

  it("records tracking facts: pixels, click trackers and UTM (one nested level)", async () => {
    const c = await content(
      page(`
      <a href="https://url7.acme.example/ls/click?upn=abc&amp;u=https%3A%2F%2Facme.example%2Fs%3Futm_campaign%3Dfall%26utm_medium%3Demail">Shop</a>
      <img src="https://acme.example/logo.png" width="120" height="40" alt="Acme">
      <img src="https://trk.klaviyomail.com/open/1.gif" width="1" height="1" alt="">
      <img src="https://acme.example/o.gif" style="display:none">`),
    );
    expect(c.tracking).toMatchObject({ pixelCount: 2, utmCampaign: "fall", utmMediumEmail: true });
    expect(c.tracking.pixelHosts).toEqual(["klaviyomail.com", "acme.example"]);
    expect(c.tracking.clickTrackerHosts).toEqual(["acme.example"]);
    expect(c.imageCount).toBe(1);
  });
});

describe("schema.org (JSON-LD and microdata, whitelisted fields only)", () => {
  it("reads microdata with nested items", async () => {
    const c = await content(
      page(
        `<div itemscope itemtype="http://schema.org/ParcelDelivery"><meta itemprop="trackingNumber" content="1Z999AA10123456784"><div itemprop="carrier" itemscope itemtype="http://schema.org/Organization"><meta itemprop="name" content="UPS"></div></div><p>Shipped</p>`,
      ),
    );
    expect(c.schemaOrg).toEqual([
      { type: "ParcelDelivery", fields: { trackingNumber: "1Z999AA10123456784", carrier: "UPS" } },
    ]);
  });

  it("keeps only whitelisted scalars (no names, addresses or other PII)", async () => {
    const ldJson = JSON.stringify({
      "@type": "FlightReservation",
      underName: { "@type": "Person", name: "Nova Example", email: "owner@example.com" },
      reservationNumber: "ABC123",
      reservationStatus: "http://schema.org/ReservationConfirmed",
      reservationFor: { "@type": "Flight", departureTime: "2026-10-12T08:45:00-04:00" },
    });
    const c = await content(
      page("<p>Trip</p>", `<script type="application/ld+json">${ldJson}</script>`),
    );
    expect(c.schemaOrg).toEqual([
      {
        type: "FlightReservation",
        fields: {
          reservationStatus: "ReservationConfirmed",
          reservationFor: "Flight",
          startDate: "2026-10-12T08:45:00-04:00",
        },
      },
    ]);
    expect(JSON.stringify(c.schemaOrg)).not.toContain("Nova");
  });

  it("survives malformed JSON-LD", async () => {
    const c = await content(
      page("<p>x</p>", `<script type="application/ld+json">{"@type": "Order",,,}</script>`),
    );
    expect(c.schemaOrg).toEqual([]);
  });
});

describe("template simhash (DOM skeleton)", () => {
  const template = (headline: string, items: string[], hero: string) =>
    page(`<table class="wrapper" width="600"><tr><td class="header"><img src="https://acme.example/logo.png" alt="Acme"></td></tr>
      <tr><td class="hero"><img src="${hero}" width="600" height="300" alt=""></td></tr>
      <tr><td class="content"><h1>${headline}</h1><p>${headline} — lorem ipsum dolor sit amet.</p></td></tr>
      ${items.map((it) => `<tr><td class="product"><table><tr><td class="product-img"><img src="https://acme.example/p/${it}.jpg" alt="${it}"></td><td class="product-copy"><p>${it}</p><a class="btn" href="https://acme.example/p/${it}">Buy ${it}</a></td></tr></table></td></tr>`).join("")}
      <tr><td class="footer"><p>Acme Inc. <a href="https://acme.example/u">Unsubscribe</a></p></td></tr></table>`);

  const redesign = (headline: string) =>
    page(`<div class="container"><header class="masthead"><img src="https://acme.example/logo.png" alt="Acme"><nav><a href="/a">A</a></nav></header>
      <section class="grid"><article class="card"><h2>${headline}</h2><p>Copy</p></article><article class="card"><h2>More</h2></article></section>
      <footer class="site-footer"><p>Acme</p></footer></div>`);

  it("is stable across content changes within a template (distance ≤ 3)", async () => {
    const a = await content(
      template("Autumn sale", ["jacket", "boots", "pack"], "https://acme.example/h1.jpg"),
    );
    const b = await content(
      template(
        "Winter is coming — new arrivals inside",
        ["scarf", "gloves", "hat", "coat", "socks"],
        "https://cdn.acme.example/h2.png",
      ),
    );
    expect(simhashDistance(a.simhash, b.simhash)).toBeLessThanOrEqual(3);
    expect(a.simhash).toMatch(/^-?\d+$/);
  });

  it("changes on a redesign (distance > 3)", async () => {
    const a = await content(template("Autumn sale", ["jacket"], "https://acme.example/h1.jpg"));
    const b = await content(redesign("Autumn sale"));
    expect(simhashDistance(a.simhash, b.simhash)).toBeGreaterThan(3);
  });

  it("fits a signed 64-bit integer", async () => {
    const a = await content(template("x", ["y"], "https://acme.example/h.jpg"));
    const n = BigInt(a.simhash);
    expect(n >= -(2n ** 63n) && n < 2n ** 63n).toBe(true);
  });
});
