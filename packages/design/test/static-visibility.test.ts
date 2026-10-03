/**
 * Static visibility (what the HTML pass counts as seen), pointer-link context, the button
 * heuristic and a failed pass. Found by the 2026-09-30 verdict audit: MJML / Klaviyo wrap every
 * section in `<td style="font-size:0px">`, and the pass hid everything inside it — 44 real emails
 * lost > 50% of their text and 43 an unsubscribe link the render saw. Every expectation on
 * visibility was checked in Chromium. Fixtures are synthetic (fictitious brand).
 */
import { describe, expect, it } from "vitest";
import {
  extractStaticDesign,
  scoreEmail,
  staticDesignFeaturesSchema,
  templateMatchDetails,
} from "../src/index";
import { buildStaticDocument } from "../src/static/document";
import { baseCtx, baseFeatures } from "./helpers/factory";

const CTX = {
  subject: null,
  listUnsubscribeHttps: [],
  senderDomain: "larkspur-goods.com",
  language: "en",
};
const run = (html: string) =>
  extractStaticDesign(html, { ...CTX, htmlBytes: Buffer.byteLength(html, "utf8") }).static;
const shown = (body: string) =>
  buildStaticDocument(`<html><body>${body}</body></html>`)
    .texts.map((t) => t.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
const page = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

/** One MJML section: the zero-size wrapper cell, an inline-block column, a sized text block. */
const section = (inner: string) => `
  <table role="presentation" width="100%"><tr>
    <td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center">
      <div class="mj-column-per-100" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;width:100%">
        <table role="presentation" width="100%"><tr>
          <td align="left" style="font-size:0px;padding:10px 25px;word-break:break-word">${inner}</td>
        </tr></table>
      </div>
    </td>
  </tr></table>`;

const MJML = page(
  [
    `<div style="display:none;font-size:1px;max-height:0px;overflow:hidden;opacity:0">Preheader words the reader never sees</div>`,
    section(
      `<img src="https://cdn.larkspur-goods.com/logo.png" alt="Larkspur Goods" width="160" height="48">`,
    ),
    section(
      `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:24px;color:#222">Our autumn catalogue is here, with forty new pieces made to last for years of daily use.</div>`,
    ),
    section(`<table role="presentation" style="border-collapse:separate"><tr>
      <td style="border-radius:4px;background:#1f5130" valign="middle">
        <a href="https://larkspur-goods.com/autumn" style="display:inline-block;background:#1f5130;color:#ffffff;font-family:Arial;font-size:15px;padding:12px 28px;text-decoration:none">Shop the catalogue</a>
      </td></tr></table>`),
    section(
      `<div style="font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#555">You are receiving this because you subscribed to our newsletter. Larkspur Goods, 12 Mill Lane, Bristol BS1 4DJ, United Kingdom. <a href="https://larkspur-goods.com/u/abc" style="color:#555">Unsubscribe</a> · <a href="https://larkspur-goods.com/prefs" style="color:#555">Manage preferences</a></div>`,
    ),
  ].join(""),
);

describe("static visibility: font-size:0 hides only the text that inherits it", () => {
  it("MJML sections: text, links, the button, images and the footer are all seen", () => {
    const s = run(MJML);
    expect(staticDesignFeaturesSchema.safeParse(s).success).toBe(true);
    expect(s.unavailable).toBeUndefined();
    expect(s.text.visibleChars).toBeGreaterThan(200);
    expect(s.links.total).toBe(3);
    expect(s.cta).toMatchObject({ buttonLike: 1, primaryLabel: "shop the catalogue" });
    expect(s.footer).toMatchObject({
      unsubscribe: "before_clip",
      preferences: true,
      receiving: true,
      postalAddress: true,
    });
    // The logo is a content image, not a "hidden" tracking pixel.
    expect(s.images).toMatchObject({ total: 1, content: 1, pixels: 0, withAlt: 1 });
    expect(shown(MJML.replace(/^.*<body>|<\/body>.*$/g, ""))).not.toContain("Preheader");
  });

  it("the wrapper's own text stays hidden; absolute sizes show again, relative ones stay zero", () => {
    expect(
      shown(
        `<div style="font-size:0">own<span style="font-size:2em">em</span><span style="font-size:120%">pct</span><span style="font-size:larger">larger</span><h1>heading</h1><span style="font-size:14px">px</span><span style="font-size:1rem">rem</span><span style="font-size:small">keyword</span><span style="font-size:calc(1em + 2px)">calc</span><font size="2">font</font><button>button</button></div>`,
      ),
    ).toBe("pxremkeywordcalcfontbutton");
  });

  it("class rules and the font shorthand count too (`font:0/0 a` hides, `font:14px/1.4` shows)", () => {
    const head = `<style>.root{font-size:0} .txt{font-size:15px}</style>`;
    const sd = buildStaticDocument(
      page(`<div class="root">gap<div class="txt">class sized</div></div>`, head),
    );
    expect(sd.texts.map((t) => t.text).join("")).toBe("class sized");
    expect(
      shown(
        `<span style="font:0/0 a">replaced</span><div style="font-size:0"><p style="font:bold 14px/1.4 Arial,sans-serif">shorthand</p></div>`,
      ),
    ).toBe("shorthand");
  });

  it("a zero-size link counts only if something inside it shows (text with its own size, an image)", () => {
    const s = run(
      page(`<div style="font-size:0">
        <a href="https://larkspur-goods.com/a">zero</a>
        <a href="https://larkspur-goods.com/b"><span style="font-size:14px">Sized label</span></a>
        <a href="https://larkspur-goods.com/c"><img src="https://cdn.larkspur-goods.com/hero.jpg" alt="Autumn range" width="600" height="300"></a>
      </div>`),
    );
    expect(s.links.total).toBe(2);
    expect(s.images).toMatchObject({ content: 1, pixels: 0 });
  });
});

describe("static visibility: the other hiding rules", () => {
  it("visibility is inherited but a descendant can set it back to visible", () => {
    expect(
      shown(
        `<div style="visibility:hidden">gone<span style="visibility:visible">back</span></div>`,
      ),
    ).toBe("back");
    const s = run(
      page(
        `<div style="visibility:hidden"><a href="https://larkspur-goods.com/x">Hidden link</a></div>`,
      ),
    );
    expect(s.links.total).toBe(0);
  });

  it("the hidden attribute yields to an author display; display:none and opacity:0 hide the subtree", () => {
    expect(shown(`<div hidden>a</div><div hidden style="display:block">b</div>`)).toBe("b");
    expect(
      shown(
        `<div style="display:none"><span style="display:inline">c</span></div><div style="opacity:0"><span style="opacity:1">d</span></div>e`,
      ),
    ).toBe("e");
  });

  it("max-height:0 clips block boxes only (Chromium ignores it on inline and table boxes)", () => {
    const clip = "max-height:0;overflow:hidden";
    expect(
      shown(
        `<div style="${clip}">div</div><p style="${clip}">p</p><a href="#" style="display:block;${clip}">blocklink</a><span style="${clip}">span</span><a href="#" style="${clip}">link</a><table><tr><td style="${clip}">td</td></tr></table><table style="${clip}"><tr><td>table</td></tr></table>`,
      ),
    ).toBe("spanlinktdtable");
  });

  it("a block clipped to zero height or width hides its subtree, unless far-side padding shows it", () => {
    expect(
      shown(
        `<div style="height:0;overflow:hidden">a</div><div style="width:0;overflow:hidden">b</div><div style="max-width:0px;overflow:hidden">c</div><div style="height:0;overflow:auto">d</div><div style="height:0;overflow-y:hidden">e</div><div style="height:0;overflow:hidden visible">f</div>`,
      ),
    ).toBe("");
    expect(
      shown(
        `<div style="max-height:0;overflow:hidden;padding:20px">pad</div><div style="height:0;overflow:hidden;padding:0 0 12px">bottom</div><div style="height:0;overflow:hidden;padding-top:20px">top</div><div style="height:0;overflow:visible">spill</div><span style="height:0;overflow:hidden">inline</span><table><tr><td style="height:0;overflow:hidden">cell</td></tr></table>`,
      ),
    ).toBe("padbottomspillinlinecell");
    // Hard to game: an unsubscribe link tucked into a zero-height box is not a visible link.
    const s = run(
      page(
        `<p style="font-size:16px">Fresh arrivals for the autumn range.</p><div style="height:0;overflow:hidden"><a href="https://larkspur-goods.com/u/1" style="font-size:14px">Unsubscribe</a></div>`,
      ),
    );
    expect(s.links.total).toBe(0);
    expect(s.footer.unsubscribe).toBe("none");
  });

  it("a zero size written as a math function hides too (calc(0px), calc(1em) under a zero parent)", () => {
    expect(
      shown(
        `<div style="font-size:calc(0px)">a</div><div style="font-size:0"><span style="font-size:calc(1em + 0px)">b</span><span style="font-size:max(0px, 0em)">c</span><span style="font-size:calc(1px * 14)">d</span><span style="font-size:clamp(12px, 2vw, 16px)">e</span></div>`,
      ),
    ).toBe("de");
  });
});

describe("unsubscribe by the pointer link's own sentence", () => {
  const footer = (html: string) =>
    run(
      page(
        `<p style="font-size:16px">A short update from the team about the autumn range.</p>${html}`,
      ),
    );

  it("'Click <a>here</a> to unsubscribe' is an unsubscribe link, and not a CTA", () => {
    const s = footer(
      `<p style="text-align:center">Click <a href="https://larkspur-goods.com/r/9" style="background:#1f5130;color:#fff;padding:10px 20px;display:inline-block">here</a> to unsubscribe</p>`,
    );
    expect(s.footer.unsubscribe).toBe("before_clip");
    expect(s.cta.buttonLike).toBe(0);
  });

  it("a 'here' in another sentence of the same block borrows nothing", () => {
    const s = footer(
      `<p>Read our terms <a href="https://larkspur-goods.com/terms">here</a>. To unsubscribe, reply to this email.</p><p>More about us <a href="https://larkspur-goods.com/about">here</a></p>`,
    );
    expect(s.footer.unsubscribe).toBe("none");
  });

  it("a question before a bare pointer carries its meaning; a line break ends the sentence", () => {
    expect(
      footer(
        `<p>Would you rather opt out of these emails? <a href="https://larkspur-goods.com/r/1">Click here</a>.</p>`,
      ).footer.unsubscribe,
    ).toBe("before_clip");
    expect(
      footer(
        `<td>You can unsubscribe at any time<br>See our privacy policy <a href="https://larkspur-goods.com/p">here</a></td>`,
      ).footer.unsubscribe,
    ).toBe("none");
    expect(
      footer(
        `<p>To stop getting these, opt out of the list,<br>by clicking <a href="https://larkspur-goods.com/r/2">here</a></p>`,
      ).footer.unsubscribe,
    ).toBe("before_clip");
  });

  it("a nested block is its own line; a preferences sentence counts for U3, not U1", () => {
    expect(
      footer(
        `<td><div>Unsubscribe instructions are in your account.</div>Our new store is open <a href="https://larkspur-goods.com/s">here</a></td>`,
      ).footer.unsubscribe,
    ).toBe("none");
    const s = footer(
      `<p>To manage your email preferences, click <a href="https://larkspur-goods.com/m">here</a>.</p>`,
    );
    expect(s.footer).toMatchObject({ unsubscribe: "none", preferences: true });
  });

  it("reads outwards from the link: a long block neither hides its sentence nor lends a far one", () => {
    const filler = "<span>x</span>".repeat(3_500);
    // The pointer sits after thousands of nodes of the same block: its own sentence still counts.
    expect(
      footer(
        `<div>${filler} Click <a href="https://larkspur-goods.com/r/3">here</a> to unsubscribe.</div>`,
      ).footer.unsubscribe,
    ).toBe("before_clip");
    // Thousands of empty nodes between an unsubscribe sentence and a pointer: nothing is borrowed.
    expect(
      footer(
        `<div>Unsubscribe from everything by writing to us${"<b></b>".repeat(3_500)}<a href="https://larkspur-goods.com/b">here</a></div>`,
      ).footer.unsubscribe,
    ).toBe("none");
  });

  it("1 MB of sibling pointer links stays linear (was ~9 s here, 25-70 s at 2 MB)", () => {
    // Each link used to rescan its parent's 80,000 children for the button boxes.
    const unit = `<a href="https://larkspur-goods.com/x">here</a><i></i>`;
    const html = page(`<div>${unit.repeat(Math.ceil(1_000_000 / unit.length))}</div>`);
    const t = performance.now();
    const s = run(html);
    expect(performance.now() - t).toBeLessThan(6_000);
    expect(s.unavailable).toBeUndefined();
    expect(s.links.total).toBe(2000);
    expect(s.footer.unsubscribe).toBe("none");
  }, 30_000);
});

describe("a failed static pass is 'not evaluated', never a finding", () => {
  // A caller bug (no string) stands in for any internal failure of the pass.
  const failed = extractStaticDesign(null as unknown as string, { ...CTX, htmlBytes: 42_000 });

  it("returns schema-valid zero counts marked unavailable", () => {
    expect(failed.static.unavailable).toBe(true);
    expect(failed.static.htmlBytes).toBe(42_000);
    expect(staticDesignFeaturesSchema.safeParse(failed.static).success).toBe(true);
    expect(failed.fonts.static).toBeNull();
  });

  it("scoring leaves the static-HTML checks not evaluated and drops the absence chips", () => {
    const f = baseFeatures();
    const r = scoreEmail({ ...f, static: failed.static }, baseCtx());
    const byId = new Map(r.checks.map((c) => [c.id, c]));
    for (const id of ["A2", "A3", "A4", "U3", "U4", "X2", "X3"]) {
      expect(byId.get(id as never)?.status).toBe("not_evaluated");
      expect(byId.get(id as never)?.value).toEqual({ reason: "static_unavailable" });
    }
    // U1 is the union of both passes (methodology 2026.5): the render's link still counts…
    expect(byId.get("U1")?.status).toBe("pass");
    expect(byId.get("U1")?.value).toMatchObject({ unsubscribe: "before_clip", static: null });
    // …but the render's "none" alone is no finding: the static pass couldn't look.
    const noLink = scoreEmail(
      { ...baseFeatures({ render: { footer: { unsubscribe: null } } }), static: failed.static },
      baseCtx(),
    );
    expect(noLink.checks.find((c) => c.id === "U1")?.status).toBe("not_evaluated");
    expect(noLink.signals?.unsubscribeUnion).toBeNull();
    expect(noLink.signals?.staticUnsubscribe).toBeNull();
    expect(noLink.signals?.renderUnsubscribe).toBe("none");
    // An own render answers H1; the subject check never read the HTML.
    expect(byId.get("H1")?.status).not.toBe("not_evaluated");
    expect(byId.get("C1")?.status).not.toBe("not_evaluated");
    expect(r.staticChips.map((c) => c.code)).not.toContain("no_unsubscribe");
    expect(r.staticChips.map((c) => c.code)).not.toContain("no_lang");
    const staticOnly = scoreEmail(
      { ...baseFeatures({ render: null }), static: failed.static },
      baseCtx(),
    );
    expect(staticOnly.checks.find((c) => c.id === "H1")?.status).toBe("not_evaluated");
  });

  it("no consumer reads the placeholder zeros: info figures, button applicability, template match", () => {
    const own = scoreEmail({ ...baseFeatures(), static: failed.static }, baseCtx());
    expect(own.info).toMatchObject({ linkCount: null, imageCount: null, words: null });
    // Template coverage, a type that needs a button for H3-H5: the template's render decides.
    const template = scoreEmail(
      { ...baseFeatures({ renderSource: "template" }), static: failed.static },
      baseCtx({ primaryType: "newsletter" }),
    );
    for (const id of ["H3", "H5"])
      expect(template.checks.find((c) => c.id === id)?.status).not.toBe("not_applicable");
    expect(template.checks.find((c) => c.id === "H4")?.value).toEqual({
      reason: "static_unavailable",
    });
    const a = { ...baseFeatures(), static: failed.static };
    const b = baseFeatures({
      static: { cta: { buttonLike: 0, labels: [] }, images: { content: 0 } },
    });
    const twin = { ...b, static: { ...b.static, htmlBytes: 42_000 } };
    expect(templateMatchDetails(a, twin).match).toBe(false);
    // The same placeholder values from a pass that ran would match.
    const ran = { ...a, static: { ...a.static, unavailable: undefined } };
    expect(templateMatchDetails(ran, twin).match).toBe(true);
  });
});

describe("static button heuristic: the fill can sit inside or around the link", () => {
  const ctas = (body: string) => run(page(body)).cta;
  const href = "https://larkspur-goods.com/go";

  it("a pill whose fill is on a span inside the link, filled or outlined", () => {
    expect(
      ctas(
        `<a href="${href}"><span style="display:inline-block;padding:9px 18px;border-radius:40px;background-color:#0b57d0;color:#fff">Manage your order</span></a>`,
      ).labels,
    ).toEqual(["manage your order"]);
    expect(
      ctas(
        `<a href="${href}" style="padding:0"><span style="display:table-cell;padding:13px 28px;border:1px solid #5f6368;border-radius:999px">See pricing</span></a>`,
      ).labels,
    ).toEqual(["see pricing"]);
  });

  it("a filled table around a padded link (Mailchimp's button block), and class-named wrappers", () => {
    expect(
      ctas(
        `<table style="border-radius:4px;background-color:#2baadf"><tr><td style="padding:18px"><a class="mcnButton" href="${href}" style="color:#fff">Learn more</a></td></tr></table>`,
      ).labels,
    ).toEqual(["learn more"]);
    expect(
      ctas(`<a href="${href}"><div class="email-btn">Set a password</div></a>`).labels,
    ).toEqual(["set a password"]);
  });

  it("not buttons: a text CTA class, a badge pill, a link inside a filled paragraph, a full-width bar, an image card, a logo", () => {
    expect(
      ctas(
        `<div class="single-text-cta"><a href="${href}" style="color:#0b57d0">Visit the help centre</a></div>`,
      ).buttonLike,
    ).toBe(0);
    expect(
      ctas(
        `<a href="${href}"><span class="pill-badge" style="background-color:#ecfdf5;padding:5px 12px;display:inline-block">Remote</span></a>`,
      ).buttonLike,
    ).toBe(0);
    expect(
      ctas(
        `<div style="background-color:#fff;padding:30px"><p>Missed it? Watch <a href="${href}">the recordings</a>.</p></div>`,
      ).buttonLike,
    ).toBe(0);
    expect(
      ctas(
        `<table width="100%" style="background:#222"><tr><td style="padding:12px"><a href="${href}" style="color:#fff">Larkspur Goods</a></td></tr></table>`,
      ).buttonLike,
    ).toBe(0);
    expect(
      ctas(
        `<a href="${href}"><table width="236" style="background-color:#ede7fe"><tr><td style="height:236px"><img src="https://cdn.larkspur-goods.com/card.png" alt="Pick a colour" width="200" height="200"></td></tr></table></a>`,
      ).buttonLike,
    ).toBe(0);
    expect(
      ctas(
        `<table style="background:#222"><tr><td style="padding:12px"><a href="${href}"><img src="https://cdn.larkspur-goods.com/logo.png" alt="Larkspur Goods" width="160" height="48"></a></td></tr></table>`,
      ).buttonLike,
    ).toBe(0);
  });
});
