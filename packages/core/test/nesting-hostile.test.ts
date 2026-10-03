/**
 * Hostile-HTML bounds for core content extraction: ruby annotation tags outside <ruby> and the
 * parse5 "reconstruct active formatting elements" blow-up must stay bounded (both used to take
 * tens of seconds or exhaust the heap).
 */
import { describe, expect, it } from "vitest";
import { limitNesting, MAX_OPEN_FORMATTING } from "../src/util/nesting";
import { MAX_PARSE_CHARS, parseHtml } from "../src/content/dom";

const openFormatting = (html: string) => (html.match(/<b id=/g) ?? []).length;

describe("hostile nesting", () => {
  it("counts rt/rb outside <ruby> toward the depth limit", () => {
    const html = "<rt>".repeat(20_000) + "<rb>".repeat(20_000);
    expect(limitNesting(html).length).toBeLessThan(html.length / 10);
    const t0 = performance.now();
    parseHtml(html);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  it("caps open formatting elements so parse5 cannot rebuild them in every block", () => {
    const html =
      "<p>" +
      Array.from({ length: 420 }, (_, i) => `<b id=${i}>`).join("") +
      "</p><p>x".repeat(30_000);
    expect(openFormatting(limitNesting(html))).toBe(MAX_OPEN_FORMATTING);
    const t0 = performance.now();
    parseHtml(html);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it("leaves normal markup untouched", () => {
    const html =
      "<p><b>Sale</b> <i>ends</i> <a href='https://x.example'><strong>tonight</strong></a></p>".repeat(
        50,
      );
    expect(limitNesting(html)).toBe(html);
  });

  it("parses at most MAX_PARSE_CHARS of HTML", () => {
    const root = parseHtml("<p>a</p>" + "x".repeat(MAX_PARSE_CHARS) + "<p>TAIL</p>");
    expect(
      JSON.stringify(root, (k, v) =>
        k === "parent" || k === "prev" || k === "next" ? undefined : v,
      ),
    ).not.toContain("TAIL");
  });
});
