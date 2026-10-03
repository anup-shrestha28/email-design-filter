import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractStaticDesign, stampByteOffsets } from "../src/index";
import { RenderInputError } from "../src/render-kit/html";
import { buildStaticDocument } from "../src/static/document";
import { juiceInputOf, juiceSourceOf } from "../src/static/fonts-static";
import { MAX_PARSED_DEPTH, MAX_PARSED_ELEMENTS } from "../src/static/parse-bound";

const ctx = { htmlBytes: 1000, subject: null, listUnsubscribeHttps: [], senderDomain: null, language: "en" };

/** Depth of the tree htmlparser2 (juice's parser, via cheerio) builds from `html`. */
function htmlparser2Depth(html: string): number {
  const $ = cheerio.load(html, { xml: { decodeEntities: false } });
  let max = 0;
  const stack: Array<[{ children?: unknown[] }, number]> = [[$.root()[0] as never, 0]];
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    if (d > max) max = d;
    for (const c of (n.children ?? []) as Array<{ children?: unknown[] }>) stack.push([c, d + 1]);
  }
  return max;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

// core's limitNesting token scan cannot follow every parse5 tree-building rule, so these inputs
// reached parse5 with their nesting intact (quadratic: 100k divs inside <noscript> ≈ 64 s, 60k <rt>
// ≈ 35 s). parse5's own open-element depth is now bounded while it parses.
describe("static extraction: parse5 depth is bounded where parse5 builds it (fin-store)", () => {
  const tail = "<p>tail text</p>";
  const cases: Array<[string, string]> = [
    ["stray end tags", "<div></x>".repeat(40_000) + tail],
    ["<noscript> parsed as HTML", "<noscript>" + "<div>".repeat(40_000) + "</noscript>" + tail],
    ["<!--> closes at once in parse5", "<!-->" + "<div>".repeat(40_000) + "-->" + tail],
    ["<rt> outside <ruby>", "<rt>".repeat(40_000) + tail],
  ];
  for (const [name, html] of cases) {
    it(`${name}: parse5 depth ≤ ${MAX_PARSED_DEPTH}, extraction stays fast`, () => {
      const { value: sd, ms: parseMs } = timed(() => buildStaticDocument(html));
      expect(juiceInputOf(sd.doc).maxDepth).toBeLessThanOrEqual(MAX_PARSED_DEPTH);
      expect(parseMs).toBeLessThan(4_000);
      const { value: r, ms } = timed(() => extractStaticDesign(html, ctx));
      expect(r.static).toBeTruthy();
      expect(ms).toBeLessThan(6_000);
      // Byte stamping cuts at the same place, so static and renderer offsets still agree.
      expect(stampByteOffsets(html)).toContain("tail text");
      expect(sd.html).toContain("tail text");
    }, 120_000);
  }

  it("normal email is parsed as is (no cut, same string)", () => {
    const html = `<table><tr><td><div><p style="font-family:Georgia">Hello <b>there</b></p></div></td></tr></table>`;
    expect(buildStaticDocument(html).html).toBe(html);
  });
});

// juice parses with htmlparser2, which nests `<caption>` outside tables (parse5 drops them), so
// planJuice costed a 5-element tree while juice matched `x *` over a 60k-deep one (≈ 108 s).
describe("juice sees the bounded parse5 tree, not the raw HTML (fin-store)", () => {
  it("<caption> / <colgroup> / <bgsound> floods cannot nest in juice's parser", () => {
    for (const unit of ["<caption>t", "<colgroup>t", "<bgsound>t"]) {
      const html = `<style>x *{font-family:Arial}</style>` + unit.repeat(20_000);
      const source = juiceSourceOf(buildStaticDocument(html).doc);
      expect(htmlparser2Depth(source)).toBeLessThanOrEqual(MAX_PARSED_DEPTH);
    }
  });

  it("a caption flood with a universal descendant rule stays fast", () => {
    const html = `<style>x *{font-family:Arial}</style>` + "<caption>t".repeat(40_000);
    const { value: r, ms } = timed(() => extractStaticDesign(html, ctx));
    expect(r.fonts.static).toBeTruthy();
    expect(ms).toBeLessThan(6_000);
  }, 180_000);

  it("juice still inlines class-based font stacks of a normal email", () => {
    const html =
      `<html><head><style>.brand{font-family:Georgia,serif}</style></head>` +
      `<body><table><tr><td class="brand">A &amp; B text that is long enough to count</td></tr></table></body></html>`;
    const r = extractStaticDesign(html, ctx);
    expect(JSON.stringify(r.fonts.static)).toContain("Georgia");
  });
});

/** Elements in a parse5 tree (iterative). */
function elementCount(root: { childNodes?: unknown[] }): number {
  let n = 0;
  const stack: Array<{ childNodes?: unknown[]; tagName?: string }> = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.tagName) n++;
    for (const c of (node.childNodes ?? []) as Array<{ childNodes?: unknown[] }>) stack.push(c);
  }
  return n;
}

// parse5 reconstructs its active formatting elements for every text token after a `</p>`: ~400
// distinct unclosed `<b>` (all core's limitNesting keeps, all under the depth limit) were re-created
// per `x`, so 84 KB built millions of elements (9 s, ~2 GB) and ~180 KB exhausted the heap.
describe("static extraction: elements parse5 creates are bounded (fin-store)", () => {
  const opened = Array.from({ length: 420 }, (_, i) => `<b id=${i}>`).join("");
  const cases: Array<[string, string]> = [
    ["reconstruction per paragraph", "<p>" + opened + "</p><p>x".repeat(20_000) + "<p>tail text"],
    ["reconstruction with growing list", Array.from({ length: 30_000 }, (_, i) => `<p><b id=${i}>x</p>`).join("")],
    [
      "reconstruction carrying a long style",
      "<p>" + Array.from({ length: 300 }, (_, i) => `<i id=${i} style="${"a".repeat(2_000)}">`).join("") + "</p><p>x".repeat(5_000),
    ],
  ];
  for (const [name, html] of cases) {
    it(`${name}: at most ${MAX_PARSED_ELEMENTS} elements, extraction stays fast`, () => {
      const { value: sd, ms: parseMs } = timed(() => buildStaticDocument(html));
      expect(elementCount(sd.doc)).toBeLessThanOrEqual(MAX_PARSED_ELEMENTS);
      expect(parseMs).toBeLessThan(4_000);
      const { value: r, ms } = timed(() => extractStaticDesign(html, ctx));
      expect(r.static).toBeTruthy();
      expect(ms).toBeLessThan(8_000);
      // The renderer either stamps the bounded tree or refuses it by design (DOM cap → too_many_nodes).
      const { value: stamped, ms: stampMs } = timed(() => {
        try {
          return stampByteOffsets(html);
        } catch (e) {
          if (e instanceof RenderInputError) return e.code;
          throw e;
        }
      });
      expect(stamped.length).toBeLessThan(40 * html.length);
      expect(stampMs).toBeLessThan(4_000);
    }, 180_000);
  }

  it("a large ordinary email (many small elements, no amplification) is not cut", () => {
    const html = "<table>" + "<tr><td class=c>cell text</td></tr>".repeat(25_000) + "</table>";
    expect(buildStaticDocument(html).html).toBe(html);
  });
});
