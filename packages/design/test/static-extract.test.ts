import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractStaticDesign, staticDesignFeaturesSchema, fontFeaturesSchema, stampByteOffsets } from "../src/index";
import { buildStaticDocument } from "../src/static/document";
import { juiceInputOf, juiceSelectorShape, JUICE_MAX_WORK, planJuice } from "../src/static/fonts-static";

const DIR = join(import.meta.dirname, "../../../fixtures/emails/design");

/** Minimal quoted-printable decoder for the fixture HTML parts (design fixtures only). */
function htmlOf(eml: string): string {
  const i = eml.indexOf("Content-Type: text/html");
  const start = eml.indexOf("\n\n", i) + 2;
  const end = eml.indexOf("\n--alt--", start);
  const qp = eml.slice(start, end).replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let k = 0; k < qp.length; k++) {
    if (qp[k] === "=" && /^[0-9A-F]{2}$/.test(qp.slice(k + 1, k + 3))) {
      bytes.push(parseInt(qp.slice(k + 1, k + 3), 16));
      k += 2;
    } else bytes.push(qp.charCodeAt(k));
  }
  return Buffer.from(bytes).toString("utf8");
}

function extract(name: string, subject: string | null = null) {
  const html = htmlOf(readFileSync(join(DIR, `${name}.eml`), "utf8"));
  return extractStaticDesign(html, {
    htmlBytes: Buffer.byteLength(html, "utf8"),
    subject,
    listUnsubscribeHttps: ["https://tidewell-outdoor.com/unsubscribe?u=7f3a"],
    senderDomain: "tidewell-outdoor.com",
    language: "en",
  });
}

describe("static extraction on the design fixtures", () => {
  const names = readdirSync(DIR)
    .filter((f) => f.endsWith(".eml"))
    .map((f) => f.replace(/\.eml$/, ""));
  it("produces schema-valid, compact features for every fixture", () => {
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const n of names) {
      const r = extract(n);
      expect(staticDesignFeaturesSchema.safeParse(r.static).success).toBe(true);
      expect(fontFeaturesSchema.safeParse(r.fonts).success).toBe(true);
      expect(JSON.stringify(r.static).length).toBeLessThanOrEqual(3072);
      expect(JSON.stringify(r.fonts.static).length).toBeLessThanOrEqual(2048);
    }
  });
  it("excellent promo: wrapper lang, unsubscribe before the clip via List-Unsubscribe, one button", () => {
    const s = extract("01-excellent-promo").static;
    expect(s.lang).toEqual({ html: "en", wrapper: "en" });
    expect(s.dir.wrapper).toBe("ltr");
    expect(s.footer).toMatchObject({
      unsubscribe: "before_clip",
      unsubscribeByHeader: true,
      preferences: true,
      receiving: true,
      postalAddress: true,
    });
    expect(s.cta).toMatchObject({
      buttonLike: 1,
      labels: ["shop rain shells"],
      primaryLabel: "shop rain shells",
    });
    expect(s.tables.layout).toBe(s.tables.presentational);
    expect(s.mergeTags).toEqual({ body: 0, firstScreen: false });
  });
  it("clipped fixture: > 102 KB, text and the primary CTA after the clip offset", () => {
    const s = extract("06-clipped-over-102kb").static;
    expect(s.htmlBytes).toBeGreaterThan(102_000);
    expect(s.clip.afterClipChars / s.clip.visibleChars).toBeGreaterThan(0.1);
    expect(s.cta.primaryOffset!).toBeGreaterThan(102_000);
    expect(s.footer.unsubscribe).toBe("after_clip");
  });
  it("merge tags: flagged in the first screen, not inside <code>, <pre> or monospace", () => {
    // `sample` is the tag token only; `snippet` is the tag as the reader sees it (quoted by the
    // CAP_MERGE_TAG explanation: the visible headline, not only the subject).
    expect(extract("07-merge-tag").static.mergeTags).toEqual({
      body: 1,
      firstScreen: true,
      sample: "{{ first_name }}",
      snippet: "Hi {{ first_name }}",
    });
    const code = extract("15-merge-tags-in-code").static;
    expect(code.mergeTags).toEqual({ body: 0, firstScreen: false });
    expect(code.text.codeShare).toBeGreaterThan(0);
  });
  it("instruction text aimed at AI reviewers is flagged only where it is (fixture 14)", () => {
    expect(extract("14-adversarial-prompt-injection").static.instructionText).toBe(true);
    expect(extract("01-excellent-promo").static.instructionText).toBeUndefined();
    expect(extract("02-good-newsletter").static.instructionText).toBeUndefined();
  });
  it("stray button fragments: links painted as buttons but shrunk to 1px slivers (fixture 13)", () => {
    expect(extract("13-adversarial-fake-buttons").static.strayButtons).toBe(6);
    expect(extract("01-excellent-promo").static.strayButtons).toBeUndefined();
    expect(extract("02-good-newsletter").static.strayButtons).toBeUndefined();
  });
  it("image-only: no lang, no title, missing alt, no button", () => {
    const s = extract("04-image-only").static;
    expect(s.lang).toEqual({ html: null, wrapper: null });
    expect(s.title).toBe(false);
    expect(s.images.withAlt).toBe(s.images.content);
    expect(s.images.informativeMeaningful).toBe(0);
    expect(s.cta.buttonLike).toBe(0);
  });
  it("alt stuffing is not meaningful alt", () => {
    const clean = extract("01-excellent-promo").static.images;
    const stuffed = extract("12-adversarial-alt-stuffing").static.images;
    expect(stuffed.informativeMeaningful).toBeLessThan(clean.informativeMeaningful);
  });
  it("web fonts: Google link declarations; mso-font-alt and Outlook-hidden link recorded", () => {
    const a = extract("08-webfonts-no-outlook-fallback").fonts.static!;
    expect(a.declarations.map((d) => d.family)).toEqual(["Montserrat", "Inter", "Lato"]);
    const b = extract("09-webfonts-mso-font-alt").fonts.static!;
    expect(b.declarations.find((d) => d.family === "Tidewell Sans")).toMatchObject({
      method: "font-face",
      msoFontAlt: "Arial",
      provider: "tidewell-outdoor.com",
    });
    expect(b.declarations.find((d) => d.family === "Open Sans")?.hiddenFromOutlook).toBe(true);
    expect(b.msoOverrides).toEqual(["Arial"]);
  });
  it("X2 feature detection records position without a fallback", () => {
    expect(extract("11-adversarial-hidden-text").static.compat).toContainEqual({
      id: "position",
      fallback: false,
    });
  });
  it("never throws on hostile or empty input", () => {
    for (const html of [
      "",
      "<",
      "<html><body><table><tr><td>".repeat(3000),
      `<style>${"}".repeat(10000)}</style>`,
      "\u{0000}\u{FFFF}<a href='javascript:x'>",
    ]) {
      expect(() =>
        extractStaticDesign(html, {
          htmlBytes: html.length,
          subject: null,
          listUnsubscribeHttps: [],
          senderDomain: null,
          language: null,
        }),
      ).not.toThrow();
    }
  });

  const ctx = { subject: null, listUnsubscribeHttps: [], senderDomain: null, language: null };
  const timed = (html: string) => {
    const t = performance.now();
    const r = extractStaticDesign(html, { ...ctx, htmlBytes: html.length });
    return { r, ms: performance.now() - t };
  };
  // Before the bound, 40k nested divs took ≈ 15 s and 3,000 rules × 9,000 elements ≈ 9 s of
  // synchronous CPU in the drain (one such email stalled ingestion for every mailbox).
  it("deeply nested HTML is flattened before parse5 (bounded CPU), and its text still counts", () => {
    const n = 40_000;
    const { r, ms } = timed(`<html><body>${"<div>".repeat(n)}Hello world${"</div>".repeat(n)}</body></html>`);
    expect(ms).toBeLessThan(3_000);
    expect(r.static.text.visibleChars).toBeGreaterThan(0);
    const sd = buildStaticDocument(`${"<div>".repeat(1_000)}x${"</div>".repeat(1_000)}`);
    const facts = juiceInputOf(sd.doc);
    expect(facts.elements).toBeLessThanOrEqual(403); // html/head/body + ≤ 400 levels
    expect(facts.maxDepth).toBeLessThanOrEqual(403);
  });
  it("juice is skipped above its selectors × elements budget; inline font styles still count", () => {
    let css = "";
    for (let i = 0; i < 3_000; i++) css += `.c${i} td{font-family:Arial}\n`;
    let body = "";
    for (let i = 0; i < 3_000; i++) body += `<table class="c${i % 50}"><tr><td>t</td></tr></table>`;
    body += `<p style="font-family:Georgia,serif">Some body copy in Georgia.</p>`;
    const { r, ms } = timed(`<html><head><style>${css}</style></head><body>${body}</body></html>`);
    expect(ms).toBeLessThan(3_000);
    expect(r.fonts.static?.stacks.map((s) => s.css)).toContain("Georgia,serif");
    const plan = planJuice(juiceInputOf(buildStaticDocument(`<style>${css}</style>${body}`).doc));
    expect(plan.selectors).toBe(3_000);
    expect(plan.work).toBeGreaterThan(JUICE_MAX_WORK);
  });
  // Found by verification after the first bound: juice's cost is not a constant per selector ×
  // element pair. `:not(…)` nests a selector without css-select's cache (polynomial in depth), and a
  // <style> after the first 200,000 nodes escaped the MAX_NODES-capped count (> 300 s / 141 s / 46 s).
  const deep = (depth: number, inner: string) =>
    `${'<div class="a">'.repeat(depth)}${inner}${"</div>".repeat(depth)}`;
  it("juice never sees :not()/pseudo-class, ~ or long-chain selectors (bounded on deep nesting)", () => {
    const spans = "<span>x</span>".repeat(300);
    const notRule = `<html><head><style>div:not(.x0 * * * * *){font-family:Arial}</style></head><body>${deep(399, spans)}</body></html>`;
    expect(timed(notRule).ms).toBeLessThan(3_000);
    let chains = "";
    for (let i = 0; i < 3_000; i++) chains += `.x${i} * * * * * *{font-family:Arial}\n`;
    const chainDoc = `<html><head><style>${chains}</style></head><body>${deep(399, "<span>x</span>".repeat(900))}</body></html>`;
    expect(timed(chainDoc).ms).toBeLessThan(3_000);
    // Four combinators pass the shape filter, but 3,000 of them at depth 399 exceed the budget.
    let four = "";
    for (let i = 0; i < 3_000; i++) four += `.x${i} * * * *{font-family:Arial}\n`;
    const fourDoc = `<html><head><style>${four}</style></head><body>${deep(399, "<span>x</span>".repeat(900))}</body></html>`;
    expect(planJuice(juiceInputOf(buildStaticDocument(fourDoc).doc)).work).toBeGreaterThan(JUICE_MAX_WORK);
    expect(timed(fourDoc).ms).toBeLessThan(3_000);

    expect(juiceSelectorShape("div:not(.x0 * * * * *)")).toBeNull();
    expect(juiceSelectorShape("p:last-of-type")).toBeNull();
    expect(juiceSelectorShape("h1 ~ p")).toBeNull();
    expect(juiceSelectorShape(".a .b .c .d .e .f")).toBeNull();
    expect(juiceSelectorShape(`.${"a".repeat(300)}`)).toBeNull();
    expect(juiceSelectorShape(".ExternalClass *")).toBe(1);
    expect(juiceSelectorShape("#MessageViewBody a")).toBe(1);
    expect(juiceSelectorShape("u + .body .gmail-fix")).toBe(1);
    expect(juiceSelectorShape('[data-ogsc] .dark td > p')).toBe(2);
    expect(juiceSelectorShape('a[href*="a b:c(d)"]')).toBe(0);
  });
  it("a <style> after the first 200,000 nodes is still planned (no MAX_NODES bypass of the budget)", () => {
    let css = "";
    for (let i = 0; i < 2_000; i++) css += `.c${i} i{font-family:Arial}\n`;
    const html = `<html><body>${"<i>a</i>".repeat(100_000)}<style>${css}</style></body></html>`;
    const plan = planJuice(juiceInputOf(buildStaticDocument(html).doc));
    expect(plan.selectors).toBe(2_000);
    expect(plan.work).toBeGreaterThan(JUICE_MAX_WORK);
    expect(timed(html).ms).toBeLessThan(3_000);
  });
  it("the reduced CSS still gives class-based stacks and class-based hiding, not @media rules", () => {
    const html = `<html><head><style>
      .pre{display:none} .serif td, .serif p{font-family:Georgia,serif;color:red}
      .sans{font-family:Helvetica,Arial,sans-serif !important}
      @media (max-width:600px){.serif p{font-family:Courier}}
    </style></head><body><div class="pre">Hidden preheader words that must not count here</div>
      <table class="serif"><tr><td>Serif copy in a table cell, long enough to count.</td></tr></table>
      <p class="sans" style="font-family:Times">Sans copy wins with important.</p></body></html>`;
    const plan = planJuice(juiceInputOf(buildStaticDocument(html).doc));
    expect(plan.css).not.toContain("color");
    expect(plan.css).not.toContain("Courier");
    const stacks = timed(html).r.fonts.static?.stacks ?? [];
    const css = stacks.map((s) => s.css);
    expect(css).toContain("Georgia,serif");
    expect(css).toContain("Helvetica,Arial,sans-serif");
    expect(css).not.toContain("Courier");
    expect(css).not.toContain("Times");
    expect(stacks.reduce((n, s) => n + s.chars, 0)).toBeLessThan(90);
  });
  it("oversized input is truncated at 2 M characters before parsing", () => {
    const sd = buildStaticDocument(`<p>${"a".repeat(2_500_000)}</p>`);
    expect(sd.html.length).toBe(2_000_000);
  });
  it("the renderer's byte stamps flatten the same way (bounded parse, same offsets as static extraction)", () => {
    const n = 30_000;
    // The link follows the flattened region, so its offset differs from the raw one: both sides
    // must use the flattened coordinates.
    const raw = `<html><body>${"<div>".repeat(n)}y${"</div>".repeat(n)}<a href="https://x.example/">x</a></body></html>`;
    const t = performance.now();
    const out = stampByteOffsets(raw);
    expect(performance.now() - t).toBeLessThan(3_000);
    const sd = buildStaticDocument(raw);
    const link = sd.links[0]!;
    expect(link.byteOffset).toBeLessThan(raw.indexOf("<a "));
    expect(out).toContain(`data-o="${sd.mapper.toBytes(link.el.sourceCodeLocation!.startOffset)}"`);
  });
});
