/**
 * Text, footer and phone measures (render-2026.4) on synthetic emails rendered with the local
 * Chrome: the footer never swallows the email (it starts in the bottom 40% of the text, and holds
 * < 40% of it unless its text is smaller than the body's), the body size leaves out fine print,
 * line length is measured on prose only, M3's prose widths skip card grids, the phone passes
 * match `max-device-width` queries, text with no font renders in Arial, an unloaded banner with a
 * declared width doesn't widen the layout, and text over an unloaded background image is
 * undecided rather than hidden. Skipped when no Chrome binary is present.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderFeaturesSchema, type RenderFeatures, type RenderJob } from "@edf/design";
import { defaultChromePath, launchChromium } from "../src/chromium";
import { renderEmail } from "../src/render-email";

const CHROME = defaultChromePath();
const HAS_CHROME = existsSync(CHROME);

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur".split(
    " ",
  );
/** `n` synthetic words, deterministic per seed. */
function prose(n: number, seed = 0): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(i * 7 + seed * 13) % WORDS.length]!);
  out[0] = out[0]!.charAt(0).toUpperCase() + out[0]!.slice(1);
  return `${out.join(" ")}.`;
}

function job(id: string, body: string, head = ""): RenderJob {
  return {
    id,
    html: `<!doctype html><html><head><meta charset="utf-8">${head}</head><body style="margin:0">${body}</body></html>`,
    images: {},
    cid: {},
    imageLog: {},
    imagesAllowed: true,
    wantAiTiles: false,
    lite: false,
  };
}

const FONT = "font-family:Helvetica,Arial,sans-serif";
const LEGAL = `<p style="font-size:12px;color:#777777;${FONT}">You are receiving this email because you signed up at example.com. <a href="https://example.com/unsubscribe">Unsubscribe</a> · Example Inc, 1 Market Street, San Francisco, CA 94105</p>`;

describe.skipIf(!HAS_CHROME)("text, footer and phone measures (local Chrome)", () => {
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
  const footerShare = (f: RenderFeatures) => f.text.chars.footer / f.text.chars.total;

  it("a wrapper holding the whole email (a postal-looking line in the body) doesn't make it all footer", async () => {
    const paras = [0, 1, 2, 3, 4]
      .map((i) => `<p style="font-size:16px;${FONT}">${prose(60, i)}</p>`)
      .join("");
    const f = await render(
      job(
        "wrapper",
        `<div><div style="font-size:16px;${FONT}">${prose(90, 9)}</div>
         <div>${paras.slice(0, paras.length / 2)}
           <p style="font-size:16px;${FONT}">Visit our store at 12 Main Street, Springfield, IL 62704 this weekend.</p>
           ${paras.slice(paras.length / 2)}
           <div>${LEGAL}</div>
         </div></div>`,
      ),
    );
    expect(f.footer.present).toBe(true);
    expect(footerShare(f)).toBeLessThan(0.4);
    expect(f.footer.top!).toBeGreaterThan(0.6 * f.layout.mobileHeight);
    expect(f.text.body.mobile).toBe(16);
    expect(f.text.body.fallback).toBe(false);
  });

  it("a “you're receiving this” box in the body is not where the footer starts", async () => {
    const f = await render(
      job(
        "receiving-box",
        `<table width="100%" cellpadding="0" cellspacing="0"><tbody>
           <tr><td style="height:320px;font-size:28px;${FONT}">Your account summary</td></tr>
           <tr><td style="background:#e8f0fe;padding:16px;font-size:16px;${FONT}">You're receiving this email because you signed in to a new app. ${prose(30, 2)}</td></tr>
           ${[3, 4, 5, 6].map((i) => `<tr><td style="font-size:16px;${FONT}"><p>${prose(50, i)}</p></td></tr>`).join("")}
           <tr><td>${LEGAL}</td></tr>
         </tbody></table>`,
      ),
    );
    expect(f.footer.present).toBe(true);
    expect(footerShare(f)).toBeLessThan(0.2);
    expect(f.footer.top!).toBeGreaterThan(0.75 * f.layout.mobileHeight);
  });

  it("keeps a short notification's long small-print footer (> 40% of the text, smaller than the body)", async () => {
    const f = await render(
      job(
        "long-legal",
        `<table width="100%" cellpadding="0" cellspacing="0"><tbody>
           <tr><td style="padding:24px;font-size:16px;${FONT}"><p>${prose(40, 1)}</p><p style="height:260px">${prose(12, 2)}</p></td></tr>
           <tr><td style="padding:24px;background:#f3f2ef">
             <p style="font-size:12px;color:#555555;${FONT}">This email was intended for a member of Example. ${prose(40, 3)}</p>
             ${LEGAL}
             <p style="font-size:12px;color:#555555;${FONT}">© 2026 Example Inc. ${prose(20, 4)}</p>
           </td></tr>
         </tbody></table>`,
      ),
    );
    expect(f.footer.present).toBe(true);
    expect(footerShare(f)).toBeGreaterThan(0.4);
    // The footer starts at its section, above the "intended for" line (not at the unsubscribe).
    expect(f.text.sizes.filter(([px]) => px === 12).reduce((s, [, c]) => s + c, 0)).toBe(
      f.text.chars.footer,
    );
  });

  it("body size leaves out fine print an undetected footer brings (18px copy, 12px legal lines)", async () => {
    const f = await render(
      job(
        "fine-print",
        `<div style="font-size:18px;${FONT}"><p>${prose(45, 1)}</p><p>${prose(25, 2)}</p></div>
         <div style="font-size:12px;color:#888888;${FONT}"><p>${prose(40, 3)}</p><p>${prose(40, 4)}</p><p>${prose(30, 5)}</p></div>`,
      ),
    );
    expect(f.footer.present).toBe(false);
    expect(f.text.body.desktop).toBe(18);
    expect(f.text.body.mobile).toBe(18);
  });

  it("line length: label cells and a <br> sign-off give no measure; a real paragraph does", async () => {
    const labels = await render(
      job(
        "labels",
        `<div style="font-size:15px;${FONT}"><p>${prose(14, 1)}</p>
         <table>${[1, 2, 3, 4, 5]
           .map((i) => `<tr><td>${i}+ years</td><td>Remote</td><td>Full time</td></tr>`)
           .join("")}</table>
         <p>Company name<br>City, Country<br>3+ years</p><p>Best,<br>The Team</p></div>`,
      ),
    );
    expect(labels.text.charsPerLine).toBeNull();
    const para = await render(
      job(
        "paragraphs",
        `<div style="width:560px;font-size:16px;${FONT}"><p>${prose(90, 1)}</p><p>${prose(70, 2)}</p><p>Best,<br>The Team</p></div>`,
      ),
    );
    expect(para.text.charsPerLine).not.toBeNull();
    expect(para.text.charsPerLine!).toBeGreaterThan(55);
    expect(para.text.charsPerLine!).toBeLessThan(95);
  });

  it("M3 prose widths: a 2-up card grid isn't squeezed paragraph text; a narrow prose column is", async () => {
    const card = (i: number) =>
      `<td style="width:170px;padding:4px;vertical-align:top;font-size:14px;${FONT}"><p style="font-weight:bold">Member ${i}</p><p>${prose(9, i)}</p><p>${i} mutual connections</p></td>`;
    const grid = await render(
      job(
        "grid",
        `<p style="font-size:16px;${FONT}">${prose(40, 7)}</p>
         <table style="width:360px" cellpadding="0" cellspacing="0">${[0, 2, 4]
           .map((i) => `<tr>${card(i)}${card(i + 1)}</tr>`)
           .join("")}</table>`,
      ),
    );
    expect(grid.text.blockWidths.some(([w]) => w < 200)).toBe(true);
    expect((grid.text.proseWidths ?? []).filter(([w]) => w < 200)).toEqual([]);
    const narrow = await render(
      job(
        "narrow-prose",
        `<table style="width:360px" cellpadding="0" cellspacing="0"><tr>
           <td style="width:175px;vertical-align:top;font-size:14px;${FONT}"><p>${prose(45, 1)}</p></td>
           <td style="width:175px;vertical-align:top;font-size:14px;${FONT}"><p>${prose(45, 2)}</p></td>
         </tr></table>`,
      ),
    );
    const squeezed = (narrow.text.proseWidths ?? []).filter(([w]) => w < 200);
    expect(squeezed.reduce((s, [, c]) => s + c, 0)).toBeGreaterThan(400);
  });

  it("the phone passes match max-device-width media queries (a 375×667 screen)", async () => {
    const f = await render(
      job(
        "device-width",
        `<table class="outer" width="600" style="width:600px"><tr><td style="font-size:16px;${FONT}">${prose(60, 1)}</td></tr></table>`,
        `<style>@media only screen and (max-device-width:480px){table.outer{width:100%!important}}</style>`,
      ),
    );
    expect(f.layout.desktopContentWidth).toBe(800);
    expect(f.layout.mobileContentWidth).toBe(375);
    expect(f.layout.k).toBe(1);
  });

  it("line length: a letter whose paragraphs each wrap once at ~110 characters is measured, not N/A", async () => {
    const f = await render(
      job(
        "long-lines",
        `<div style="font-size:15px;${FONT}"><p>${prose(30, 1)}</p><p>${prose(30, 2)}</p><p>Best,<br>The Team</p></div>`,
      ),
    );
    expect(f.text.charsPerLine).not.toBeNull();
    expect(f.text.charsPerLine!).toBeGreaterThan(100);
  });

  it("renders the light version on a dark host: dark-mode styles stay off and their text isn't hidden", async () => {
    // A host whose theme is dark (headless Chromium follows the desktop's theme).
    const dark = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      pipe: true,
      args: ["--force-dark-mode", "--disable-gpu", "--no-first-run"],
    });
    try {
      const out = await renderEmail(
        dark,
        job(
          "dark-host",
          `<table class="wrap" width="100%" style="background:#ffffff"><tr><td class="content" style="color:#222222;font-size:16px;${FONT}"><p style="color:#222222">${prose(60, 1)}</p><p style="color:#222222">${prose(60, 2)}</p></td></tr></table>`,
          `<style>:root{color-scheme:light dark}@media (prefers-color-scheme:dark){.wrap{background:#141414!important}.content,.content p{color:#e4e4e4!important;-webkit-text-fill-color:#e4e4e4!important}}</style>`,
        ),
        { axeSource: null, deadlineMs: 30_000 },
      );
      expect(out.error).toBeNull();
      const f = out.features!;
      expect(f.text.chars.body).toBeGreaterThan(500);
      const fgs = f.contrast.groups
        .filter((g) => g.chars > 100)
        .map((g) => [g.fg, g.bg, g.rendered]);
      expect(fgs).toEqual([["#222222", "#ffffff", true]]);
    } finally {
      await dark.close();
    }
  });

  it("text with no font set renders in Gmail's default Arial stack; a declared font still wins", async () => {
    const f = await render(
      job(
        "no-font",
        `<p style="font-size:16px">${prose(40, 1)}</p><p style="font-size:16px;font-family:Georgia,serif">${prose(40, 2)}</p>`,
      ),
    );
    const stacks = f.fonts!.stacks.map((s) => s.css);
    // Chromium serializes the sentinel unquoted; font analysis reads it as "No font set".
    expect(stacks).toContain("__default__, Arial, Helvetica, sans-serif");
    expect(stacks).toContain("Georgia, serif");
  });

  it("an unloaded banner with a declared width doesn't widen the phone layout", async () => {
    const f = await render(
      job(
        "banner",
        `<table width="100%" cellpadding="0" cellspacing="0"><tr><td>
           <img src="https://img.example.com/banner.png" width="624" alt="Seasonal offers" style="display:block;max-width:100%;width:624px">
           <p style="font-size:16px;${FONT}">${prose(40, 1)}</p>
         </td></tr></table>`,
      ),
    );
    expect(f.layout.mobileContentWidth).toBe(375);
    expect(f.layout.k).toBe(1);
  });

  it("text over an unloaded background image is undecided, not hidden", async () => {
    const f = await render(
      job(
        "bg-missing",
        `<p style="font-size:16px;${FONT}">${prose(30, 3)}</p>
         <table width="100%"><tr><td background="https://img.example.com/hero.jpg" style="background-color:#ffffff;background-image:url(https://img.example.com/hero.jpg);padding:40px">
           <p style="color:#ffffff;font-size:20px;${FONT}">${prose(20, 1)}</p></td></tr></table>
         <p style="font-size:16px;${FONT}">${prose(40, 2)}</p>`,
      ),
    );
    const white = f.contrast.groups.filter((g) => g.fg === "#ffffff");
    expect(white.length).toBeGreaterThan(0);
    for (const g of white) {
      expect(g.rendered).toBe(true);
      expect(g.method).toBe("pixel");
      expect(g.ratio).toBeLessThan(1.3);
      expect(g.p90).toBe(21);
    }
  });
});
