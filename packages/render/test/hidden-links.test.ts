/**
 * Hidden unsubscribe links (render-2026.6, `links.hidden`; 2026-10-01 security review): the static
 * pass reads inline styles and simple tag / class / id rules only, so an unsubscribe link hidden by
 * a descendant selector, an @media rule or text the colour of its background used to count as
 * present — a sender could game U1 and the gallery's "no unsubscribe" rule. The render now lists
 * the links that draw nothing in passes D and M by their `data-o` byte offset, and U1 drops a
 * static-pass link at one of them; a link the render drew but didn't recognise (Truecaller's
 * "Click <a>here</a> to unsubscribe") still counts. Synthetic emails, local Chrome; skipped when
 * no Chrome binary is present.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import {
  buildDesignFeatures,
  extractStaticDesign,
  renderFeaturesSchema,
  scoreEmail,
  type RenderJob,
} from "@edf/design";
import { defaultChromePath, launchChromium } from "../src/chromium";
import { renderEmail } from "../src/render-email";

const CHROME = defaultChromePath();
const HAS_CHROME = existsSync(CHROME);

const CONTEXT = { listUnsubscribeHttps: [], senderDomain: "shop.example", language: "en" };
const UNSUB = "https://shop.example/unsubscribe";

/** A promotional email whose footer holds `foot`, with `css` in a `<style>` block. */
function email(css: string, foot: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">
<table width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px;font:16px Arial,sans-serif;color:#222222">
<h1 style="font:bold 28px Arial,sans-serif;margin:0 0 16px">Big autumn sale</h1>
<p style="margin:0 0 16px">Everything is 40% off this weekend only. Come and see the new collection in store and online, with free delivery on every order.</p>
<a href="https://shop.example/sale" style="display:inline-block;background:#d93025;color:#ffffff;padding:14px 28px;font:bold 16px Arial,sans-serif;text-decoration:none">Shop the sale</a>
</td></tr><tr><td class="foot" style="padding:24px;font:12px Arial,sans-serif;color:#666666;background:#ffffff">
Shop Example Inc, 1 Main St, Springfield, IL 62701. ${foot}
</td></tr></table></body></html>`;
}

describe.skipIf(!HAS_CHROME)("hidden unsubscribe links (local Chrome)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchChromium({ executablePath: CHROME });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Static pass + render + score: the U1 union (`signals.unsubscribeUnion`) and the facts. */
  async function u1(id: string, html: string) {
    const job: RenderJob = {
      id,
      html,
      images: {},
      cid: {},
      imageLog: {},
      imagesAllowed: true,
      wantAiTiles: false,
      lite: true,
      context: CONTEXT,
    };
    const out = await renderEmail(browser, job, { axeSource: null, deadlineMs: 30_000 });
    expect(out.error, id).toBeNull();
    expect(renderFeaturesSchema.safeParse(out.features).success, id).toBe(true);
    const st = extractStaticDesign(html, {
      htmlBytes: Buffer.byteLength(html),
      subject: "Big autumn sale",
      ...CONTEXT,
    });
    const features = buildDesignFeatures({
      static: st.static,
      fonts: st.fonts,
      render: out.features,
    });
    const r = scoreEmail(features, {
      primaryType: "promotional",
      isSubscription: true,
      typeConfidence: 0.9,
      subject: "Big autumn sale",
      snippet: null,
      receivedAt: new Date("2026-09-30T10:00:00Z"),
      now: new Date("2026-10-01T10:00:00Z"),
      ...CONTEXT,
    });
    return {
      union: r.signals?.unsubscribeUnion,
      static: r.signals?.staticUnsubscribe,
      render: r.signals?.renderUnsubscribe,
      offsets: st.static.footer.unsubscribeOffsets,
      hidden: out.features!.links.hidden,
    };
  }

  it("a visible footer link counts (control)", async () => {
    const r = await u1("control", email("", `<a class="u" href="${UNSUB}">Unsubscribe</a>`));
    expect(r).toMatchObject({ union: "before_clip", static: "found", render: "found", hidden: [] });
  });

  it("hidden by a descendant selector the static pass can't read → no unsubscribe link", async () => {
    const r = await u1(
      "descendant",
      email(".foot .u{display:none}", `<a class="u" href="${UNSUB}">Unsubscribe</a>`),
    );
    // The static pass still finds it; the render shows that same element (by offset) hidden.
    expect(r.static).toBe("found");
    expect(r.offsets).toHaveLength(1);
    expect(r.hidden).toContain(r.offsets![0]);
    expect(r).toMatchObject({ union: "none", render: "none" });
  });

  it("hidden by an @media rule → no unsubscribe link", async () => {
    const r = await u1(
      "media",
      email(
        "@media screen{.u{display:none!important}}",
        `<a class="u" href="${UNSUB}">Unsubscribe</a>`,
      ),
    );
    expect(r).toMatchObject({ static: "found", union: "none" });
  });

  it("white text on the white footer → no unsubscribe link", async () => {
    const inline = await u1(
      "white-inline",
      email("", `<a href="${UNSUB}" style="color:#ffffff;text-decoration:none">Unsubscribe</a>`),
    );
    expect(inline).toMatchObject({ static: "found", union: "none" });
    const rule = await u1(
      "white-rule",
      email(
        ".foot a{color:#ffffff!important;text-decoration:none!important}",
        `<a href="${UNSUB}">Unsubscribe</a>`,
      ),
    );
    expect(rule).toMatchObject({ static: "found", union: "none" });
  });

  it("display:none through its class → no unsubscribe link (both passes agree)", async () => {
    const r = await u1(
      "class",
      email(".u{display:none}", `<a class="u" href="${UNSUB}">Unsubscribe</a>`),
    );
    expect(r).toMatchObject({ static: "none", render: "none", union: "none" });
  });

  it("pushed off the page → no unsubscribe link", async () => {
    const off = await u1(
      "offscreen",
      email(".u{position:absolute;left:-9999px}", `<a class="u" href="${UNSUB}">Unsubscribe</a>`),
    );
    expect(off).toMatchObject({ static: "found", union: "none" });
  });

  it("Truecaller's 'Click here to unsubscribe' (only 'here' is linked) still counts", async () => {
    // The render's detector reads the link's own label ("here") and misses it; the static pass
    // reads the sentence. The render drew the link, so the static find stands.
    const r = await u1(
      "pointer",
      email(
        "",
        `Don't want these emails? Click <a href="https://t.example/x?id=1" style="color:#666666">here</a> to unsubscribe.`,
      ),
    );
    expect(r).toMatchObject({ static: "found", render: "none", union: "before_clip", hidden: [] });
    // …but not when that sentence is hidden by a descendant rule.
    const hidden = await u1(
      "pointer-hidden",
      email(
        ".foot .p{display:none}",
        `<span class="p">Click <a href="https://t.example/x?id=1">here</a> to unsubscribe.</span>`,
      ),
    );
    expect(hidden).toMatchObject({ static: "found", union: "none" });
  });

  it("a light grey link or an !important colour still shows: it counts", async () => {
    const grey = await u1(
      "grey",
      email(".foot a{color:#999999!important}", `<a href="${UNSUB}">Unsubscribe</a>`),
    );
    expect(grey).toMatchObject({ union: "before_clip", hidden: [] });
    // Shown only on phones (an @media rule overrides a class rule the static pass reads as hidden).
    const phone = await u1(
      "phone-only",
      email(
        ".u{display:none} @media (max-width:600px){.u{display:inline!important}}",
        `<a class="u" href="${UNSUB}">Unsubscribe</a>`,
      ),
    );
    expect(phone).toMatchObject({ union: "before_clip", render: "found" });
  });
});
