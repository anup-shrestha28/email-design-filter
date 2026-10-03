/**
 * The visible content extent (`layout.content`, render-2026.3) on synthetic emails rendered with the
 * local Chrome: what a reader can see counts (text, images, painted boxes, over the whole
 * document), what they can't doesn't (hidden and clipped preheaders, invisible padding characters,
 * tracking pixels, page-wide backgrounds, white-on-white borders, hidden images); an image the
 * render had no picture for counts as the viewer will lay it out, and text as the line box it sets
 * in (the reader's fonts differ from the render's). Skipped when no Chrome binary is present.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { renderFeaturesSchema, type RenderFeatures, type RenderJob } from "@edf/design";
import { defaultChromePath, launchChromium } from "../src/chromium";
import { TEXT_GROWTH } from "../src/extract/content";
import { hasVisibleText } from "../src/extract/runs";
import { renderEmail } from "../src/render-email";

const CHROME = defaultChromePath();
const HAS_CHROME = existsSync(CHROME);

/** A 1×1 PNG (the layout size comes from the width/height attributes). */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const IMG = "https://img.example.com/a.png";

function job(id: string, body: string): RenderJob {
  return {
    id,
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`,
    images: { [IMG]: PNG },
    cid: {},
    imageLog: { [IMG]: { status: 200, bytes: 68 } },
    imagesAllowed: true,
    wantAiTiles: false,
    lite: true,
  };
}

describe("hasVisibleText", () => {
  it("is false for preheader padding and whitespace, true for any real character", () => {
    for (const blank of [
      "",
      "   \n\t",
      "\u00a0\u200c\u034f\u00ad\u200b\u2060\ufeff",
      "\u3164\u115f\u1160\uffa0\u2800",
      "\u034f\u200c\u00a0".repeat(40),
    ])
      expect(hasVisibleText(blank), JSON.stringify(blank)).toBe(false);
    for (const text of ["a", " Hello ", "\u00a0.\u00a0", "日本", "🎉", "\u200c€"])
      expect(hasVisibleText(text), text).toBe(true);
  });
});

describe.skipIf(!HAS_CHROME)("visible content extent (local Chrome)", () => {
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

  it("a centred card: hidden preheaders, padding characters, a tracking pixel, a page-wide background and a white border don't count", async () => {
    const f = await render(
      job(
        "card",
        `<div style="display:none">Hidden preheader one</div>
         <div style="max-height:0;overflow:hidden">Hidden preheader two, long enough to wrap across the whole page width if it were shown</div>
         <div style="font-size:1px;line-height:1px;color:#ffffff">Tiny white preheader text</div>
         <div>&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#12644;&#12644;&#847;&zwnj;&nbsp;</div>
         <img src="https://t.example.com/open.gif" width="1" height="1" alt="">
         <div style="width:760px;margin-left:5px;height:20px;border:10px solid #ffffff"></div>
         <table width="100%" bgcolor="#f4f4f4" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:40px 0">
           <table width="600" bgcolor="#ffffff" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr><td style="padding:24px">
             <h1 style="font-family:Arial,sans-serif;font-size:28px;margin:0">Hello there</h1>
             <p style="font-family:Arial,sans-serif;font-size:16px">Some body text for the email.</p>
             <img src="${IMG}" width="552" height="200" alt="Hero" style="display:block">
           </td></tr></table>
         </td></tr></table>`,
      ),
    );
    const c = f.layout.content!;
    expect(c).not.toBeNull();
    // The white 600 px card on the grey page background, centred in the 800 px render.
    expect(c.left).toBe(100);
    expect(c.right).toBe(700);
    // It ends where the card ends (the grey band's 40 px padding below it is page background).
    expect(c.bottom).toBeGreaterThan(300);
    expect(c.bottom).toBeLessThanOrEqual(f.layout.desktopHeight - 40);
    expect(
      Number.isInteger(c.left) && Number.isInteger(c.right) && Number.isInteger(c.bottom),
    ).toBe(true);
  }, 60_000);

  it("measures the whole document: a painted box and a border-only box far below the first screen count", async () => {
    const f = await render(
      job(
        "long",
        `<div style="width:400px;margin:0 auto;font:16px Arial,sans-serif">Top column text</div>
         <div style="height:9000px"></div>
         <div style="margin-left:50px;width:700px;height:60px;background-color:#333333"></div>
         <div style="margin-left:20px;width:300px;height:40px;border-left:6px solid #e11d48"></div>`,
      ),
    );
    expect(f.meta.screenshotClipped).toBe(true);
    const c = f.layout.content!;
    expect(c.left).toBe(20);
    expect(c.right).toBe(750);
    expect(c.bottom).toBeGreaterThan(9100);
    expect(c.bottom).toBeLessThanOrEqual(Math.ceil(f.layout.desktopHeight));
  }, 60_000);

  it("images count unless hidden, transparent or clipped away", async () => {
    const f = await render(
      job(
        "images",
        `<img src="${IMG}" width="100" height="100" alt="" style="display:block;visibility:hidden">
         <img src="${IMG}" width="100" height="100" alt="" style="display:block;margin-left:auto;opacity:0">
         <div style="width:300px;margin:0 auto"><img src="${IMG}" width="300" height="120" alt="Photo" style="display:block"></div>
         <div style="height:0;overflow:hidden"><img src="${IMG}" width="760" height="50" alt="" style="display:block"></div>`,
      ),
    );
    expect(f.layout.content).toEqual({ left: 250, right: 550, bottom: 320 });
  }, 60_000);

  it("pictograph-only text (a lone emoji, ©, an arrow) counts at the design's edge", async () => {
    const f = await render(
      job(
        "symbols",
        `<div style="margin-left:40px;font:24px Arial,sans-serif;line-height:30px">\u{1F389}</div>
         <div style="width:600px;margin:0 auto;height:40px;background:#333333"></div>
         <div style="margin-left:730px;font:20px Arial,sans-serif;line-height:24px">\u2194</div>
         <div style="display:none">\u2705 hidden</div>
         <div style="height:0;overflow:hidden;margin-left:10px">\u{1F389}</div>`,
      ),
    );
    const c = f.layout.content!;
    expect(c.left).toBeGreaterThanOrEqual(38);
    expect(c.left).toBeLessThanOrEqual(42);
    expect(c.right).toBeGreaterThan(735);
    expect(c.right).toBeLessThan(760);
  }, 60_000);

  it("a checklist's emoji column counts", async () => {
    const f = await render(
      job(
        "checklist",
        `<table width="560" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;font:16px Arial,sans-serif">
           <tr><td width="40" style="font-size:22px">\u2705</td><td style="padding-right:70px">Confirm your email address</td></tr>
           <tr><td width="40" style="font-size:22px">\u2709\uFE0F</td><td style="padding-right:70px">Read the welcome guide</td></tr>
         </table>`,
      ),
    );
    const c = f.layout.content!;
    expect(c.left).toBeGreaterThanOrEqual(120);
    expect(c.left).toBeLessThanOrEqual(124);
  }, 60_000);

  it("<body> counts as a painted box when <html> has its own background", async () => {
    const card = (id: string, htmlBg: string) =>
      job(id, "").html.replace(
        /<head>.*<\/body>/s,
        `<head><meta charset="utf-8"><style>html{background:${htmlBg}}</style></head>
         <body style="width:600px;margin:0 auto;background:#ffffff">
           <p style="margin:40px;font:16px Arial,sans-serif">Short text</p>
         </body>`,
      );
    const grey = await render({ ...job("body-card", ""), html: card("body-card", "#dddddd") });
    expect(grey.layout.content).toMatchObject({ left: 100, right: 700 });
    // With a transparent root, the body's background moves to the canvas: only the text counts.
    const plain = await render({
      ...job("body-canvas", ""),
      html: card("body-canvas", "transparent"),
    });
    // The text counts as the line box it sets in: the paragraph's content box (140–660), not the
    // body's 100–700 box.
    expect(plain.layout.content).toMatchObject({ left: 140, right: 660 });
  }, 60_000);

  describe("images the render had no picture for", () => {
    const HERO = "https://img.example.com/hero-4mb.png";
    const failed = (id: string, body: string, status: "too_large" | "blocked" = "too_large") => ({
      ...job(id, body),
      imageLog: { [IMG]: { status: 200, bytes: 68 }, [HERO]: { status, bytes: 0 } },
    });
    const card = (img: string) =>
      `<table width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">${img}</td></tr></table>`;

    it("count with their declared width where the viewer puts them, however flat they laid out", async () => {
      // A broken inline <img alt=""> gets no box at all in Chrome, one with alt text only the
      // text's box; the viewer shows a 500 px image or placeholder, centred in the 600 px card.
      for (const img of [
        `<img src="${HERO}" width="500" alt="">`,
        `<img src="${HERO}" width="500" alt="Refer and earn">`,
        `<div style="max-width:500px"><img src="${HERO}" width="500" height="auto" alt="" style="display:block;height:auto;border:0;width:100%"></div>`,
      ]) {
        const c = (await render(failed("failed-hero", card(img)))).layout.content!;
        // (An alt-text box is centred to a subpixel, so its centre may floor a pixel lower.)
        expect(c.left, img).toBeGreaterThanOrEqual(149);
        expect(c.left, img).toBeLessThanOrEqual(150);
        expect(c.right, img).toBe(650);
      }
      // A left-aligned one starts where its line does; a declared height counts for the bottom.
      const tall = await render(
        failed(
          "failed-tall",
          `<div style="margin-left:40px"><img src="${HERO}" width="300" alt="" style="height:260px"></div>`,
        ),
      );
      expect(tall.layout.content).toMatchObject({ left: 40, right: 340 });
      expect(tall.layout.content!.bottom).toBeGreaterThanOrEqual(260);
      // Blocked by the privacy policy (a per-recipient URL): no src in the viewer, but its box is
      // still there, taking the same room.
      const blocked = await render(
        failed("blocked-hero", card(`<img src="${HERO}" width="500" alt="">`), "blocked"),
      );
      expect(blocked.layout.content).toMatchObject({ left: 150, right: 650 });
    }, 60_000);

    it("with both dimensions declared they get a placeholder here, laid out as the viewer will (CSS included)", async () => {
      const f = await render(
        failed(
          "failed-both",
          `<div style="width:300px;margin-left:100px"><img src="${HERO}" width="1351" height="760" alt="" style="max-width:100%;height:auto"></div>`,
        ),
      );
      expect(f.layout.content).toMatchObject({ left: 100, right: 400 });
    }, 60_000);

    it("with no declared width, hidden, clipped away, or a tracking pixel, they count for nothing", async () => {
      const f = await render(
        failed(
          "failed-none",
          `${card(`<img src="${HERO}" alt="">`)}
           ${card(`<img src="${HERO}" width="500" alt="" style="visibility:hidden">`)}
           <div style="max-height:0;overflow:hidden">${card(`<img src="${HERO}" width="500" alt="">`)}</div>
           ${card(`<img src="https://t.example.com/open.gif" width="1" alt="">`)}
           <div style="width:200px;margin:0 auto;font:16px Arial,sans-serif">Footer</div>`,
        ),
      );
      // Only the footer's 200 px column (its line box) is left.
      expect(f.layout.content).toMatchObject({ left: 300, right: 500 });
    }, 60_000);

    const FOOT = `<div style="width:200px;margin:0 auto;font:16px Arial,sans-serif">Footer</div>`;
    const F = (w: number) => `<img src="${HERO}" width="${w}" alt="">`;
    const auto = (inner: string, td = "") =>
      `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td ${td}>${inner}</td></tr></table>`;

    it("in a shrink-to-fit container, where the container grows to in the viewer", async () => {
      // The render collapses the auto-width table to nothing; the viewer's is 500 px, centred.
      for (const [id, body] of [
        ["grow-plain", auto(`<img src="${HERO}" width="500" alt="">`)],
        [
          "grow-alt",
          auto(`<img src="${HERO}" width="500" alt="IIT Kharagpur Executive Programme">`),
        ],
        [
          "grow-caption",
          auto(`<img src="${HERO}" width="500" alt=""><br>Caption`, 'style="font:16px Arial"'),
        ],
        // A % max-width resolves against what the table grows to, not its collapsed 0 px.
        [
          "grow-maxw",
          auto(`<img src="${HERO}" width="500" alt="" style="max-width:100%;height:auto">`),
        ],
        [
          "grow-inline-block",
          card(
            `<a href="#" style="display:inline-block"><img src="${HERO}" width="500" alt=""></a>`,
          ),
        ],
      ] as const) {
        const c = (await render(failed(id, body + FOOT))).layout.content!;
        expect(c.left, id).toBeGreaterThanOrEqual(149);
        expect(c.left, id).toBeLessThanOrEqual(150);
        expect(c.right, id).toBe(650);
      }
    }, 120_000);

    it("side by side on a line, with what else is on it moving along", async () => {
      const three = `<img src="${HERO}" width="200" alt="">`.repeat(3);
      const centre = await render(failed("row-centre", card(three)));
      expect(centre.layout.content).toMatchObject({ left: 100, right: 700 });
      const left = await render(failed("row-left", card(three).replace(' align="center">', ">")));
      expect(left.layout.content).toMatchObject({ left: 100, right: 700 });
      // A loaded image before a failed one: the pair (400 px) is centred, 200–600.
      const mixed = await render(
        failed("row-mixed", card(`<img src="${IMG}" width="100" height="100" alt="">${F(300)}`)),
      );
      expect(mixed.layout.content).toMatchObject({ left: 200, right: 600 });
      // A grown auto-width table's other cell moves with it; so does a card painted around it.
      const cols = await render(
        failed(
          "row-cells",
          `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
             <td style="font:16px Arial;padding-right:10px">Left col</td><td>${F(400)}</td>
           </tr></table>`,
        ),
      );
      // Since render-2026.4 an unloaded image with a declared width lays out as a sized
      // placeholder, so the row spans exactly what it does with the picture loaded.
      const c = cols.layout.content!;
      const loaded = await render(
        job(
          "row-cells-loaded",
          `<table align="center" cellpadding="0" cellspacing="0" border="0"><tr>
             <td style="font:16px Arial;padding-right:10px">Left col</td><td><img src="${IMG}" width="400" alt=""></td>
           </tr></table>`,
        ),
      );
      expect({ left: c.left, right: c.right }).toEqual({
        left: loaded.layout.content!.left,
        right: loaded.layout.content!.right,
      });
      expect(c.right - c.left).toBeGreaterThan(440);
      expect(Math.abs(c.left + c.right - 800)).toBeLessThanOrEqual(2);
      const boxed = await render(
        failed("row-card", auto(F(500), 'style="background:#eeeeee;padding:40px"')),
      );
      expect(boxed.layout.content).toMatchObject({ left: 110, right: 690 });
    }, 120_000);

    it("hidden by a zero height, they count for nothing", async () => {
      for (const img of [
        `<img src="${HERO}" width="760" height="0" alt="" style="display:block">`,
        `<img src="${HERO}" width="760" alt="" style="display:block;height:0">`,
        `<img src="${HERO}" width="760" alt="" style="display:block;max-height:0">`,
        `<img src="${HERO}" width="760" height="0" alt="">`,
      ]) {
        const body = `<table width="760" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>${img}</td></tr></table>`;
        const f = await render(failed("zero-height", body + FOOT));
        expect(f.layout.content, img).toMatchObject({ left: 300, right: 500 });
      }
    }, 120_000);
  });

  describe("text is measured as the line box it sets in, not its glyphs", () => {
    /** Glyph width of a line of text in this Chrome (the render uses the same fonts). */
    async function glyphWidth(text: string, font: string): Promise<number> {
      const page = await browser.newPage();
      try {
        await page.setContent(
          `<!doctype html><span id="t" style="font:${font};white-space:nowrap">${text}</span>`,
        );
        return await page.$eval("#t", (el) => el.getBoundingClientRect().width);
      } finally {
        await page.close();
      }
    }

    it("a heading in a 520 px cell covers the cell's content box, whatever its glyphs span", async () => {
      const f = await render(
        job(
          "heading-cell",
          `<table width="520" align="center" cellpadding="0" cellspacing="0" border="0"><tr>
             <td style="padding:0 16px"><h1 style="font:bold 28px Arial,sans-serif;margin:0">Hello there</h1></td>
           </tr></table>`,
        ),
      );
      // Table 140–660, cell padding 16 px: the heading may wrap anywhere in 156–644.
      expect(f.layout.content).toMatchObject({ left: 156, right: 644 });
    }, 60_000);

    it("a shrink-wrapped button grows with its text, both ways when it's centred", async () => {
      const label = "Get started now";
      const w = await glyphWidth(label, "16px Arial,sans-serif");
      const f = await render(
        job(
          "button",
          `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
             <table cellpadding="0" cellspacing="0" border="0"><tr>
               <td style="padding:10px 20px;font:16px Arial,sans-serif">${label}</td>
             </tr></table>
           </td></tr></table>`,
        ),
      );
      // The button (text + 20 px padding each side) is centred on 400 and grows by TEXT_GROWTH.
      const half = ((w + 40) / 2) * (1 + TEXT_GROWTH);
      const c = f.layout.content!;
      expect(Math.abs(c.left - Math.floor(400 - half))).toBeLessThanOrEqual(1);
      expect(Math.abs(c.right - Math.ceil(400 + half))).toBeLessThanOrEqual(1);
    }, 60_000);

    it("an image filling a shrink-wrapped table doesn't make its caption's cell grow with the text", async () => {
      // The table is as wide as its 600 px image, whatever the fonts: the caption wraps in it.
      const f = await render(
        job(
          "image-cell",
          `<table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr>
             <td style="font:16px Arial,sans-serif"><img src="${IMG}" width="600" height="200" alt=""><br>Caption</td>
           </tr></table>`,
        ),
      );
      expect(f.layout.content).toMatchObject({ left: 100, right: 700 });
    }, 60_000);

    it("directly in a full-bleed wrapper, the glyphs widen by TEXT_GROWTH on the side(s) the alignment grows into", async () => {
      const text = "Short line of text";
      const font = "16px Arial,sans-serif";
      const w = await glyphWidth(text, font);
      const wrapper = (id: string, align: string) =>
        job(id, `<div style="padding:0 40px;font:${font};text-align:${align}">${text}</div>`);
      // Content box 40–760 of an 800 px wrapper.
      const left = (await render(wrapper("full-left", "left"))).layout.content!;
      expect(left.left).toBe(40);
      expect(Math.abs(left.right - Math.ceil(40 + w * (1 + TEXT_GROWTH)))).toBeLessThanOrEqual(1);
      const right = (await render(wrapper("full-right", "right"))).layout.content!;
      expect(right.right).toBe(760);
      expect(Math.abs(right.left - Math.floor(760 - w * (1 + TEXT_GROWTH)))).toBeLessThanOrEqual(1);
      const centre = (await render(wrapper("full-centre", "center"))).layout.content!;
      const half = (w / 2) * (1 + TEXT_GROWTH);
      expect(Math.abs(centre.left - Math.floor(400 - half))).toBeLessThanOrEqual(1);
      expect(Math.abs(centre.right - Math.ceil(400 + half))).toBeLessThanOrEqual(1);
      // Justified text may fill its line box.
      const justified = (await render(wrapper("full-justify", "justify"))).layout.content!;
      expect(justified).toMatchObject({ left: 40, right: 760 });
    }, 60_000);

    it("a long line never grows past its full-bleed line box; nowrap text overflowing its box grows from where it starts", async () => {
      const font = "16px Arial,sans-serif";
      const wrapped = await render(
        job(
          "full-long",
          `<div style="padding:0 30px;font:${font}">${"A long line of body text that wraps. ".repeat(12)}</div>`,
        ),
      );
      expect(wrapped.layout.content).toMatchObject({ left: 30, right: 770 });
      const text = "Nowrap text that overflows its box, twice over";
      const w = await glyphWidth(text, font);
      expect(w).toBeGreaterThan(300);
      const nowrap = (
        await render(
          job(
            "nowrap",
            `<div style="width:300px;margin-left:100px;font:${font};white-space:nowrap">${text}</div>`,
          ),
        )
      ).layout.content!;
      expect(nowrap.left).toBe(100);
      expect(Math.abs(nowrap.right - Math.ceil(100 + w * (1 + TEXT_GROWTH)))).toBeLessThanOrEqual(
        1,
      );
    }, 60_000);
  });

  it("is null when nothing is visible", async () => {
    const f = await render(
      job(
        "empty",
        `<div style="display:none">Hidden preheader</div>
         <img src="https://t.example.com/open.gif" width="1" height="1" alt="">`,
      ),
    );
    expect(f.layout.content).toBeNull();
  }, 60_000);
});
