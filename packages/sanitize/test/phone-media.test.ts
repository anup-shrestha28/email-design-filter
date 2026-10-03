/**
 * The viewer's phone frame (ViewerRewriters.phoneWidth, css.ts PrepareOptions.phoneWidth): a media
 * query that tests the device's width is split in two, as written for frames wider than the phone
 * and with device-width read as the frame's width for the phone frame only.
 */
import { describe, expect, it } from "vitest";
import { emitCss, prepareStylesheet } from "../src/css";
import { sanitizeForAnalysis, sanitizeForViewer } from "../src/index";
import { problems, rw } from "./oracle";

const rewrite = (css: string, phoneWidth?: number): string =>
  emitCss(
    prepareStylesheet(css, () => true, phoneWidth ? { phoneWidth } : {}),
    (u) => u,
    64 * 1024,
  ).css;

describe("phone media queries (phoneWidth)", () => {
  it("splits a device-width query into a wider-frame copy and a phone-frame copy", () => {
    expect(
      rewrite("@media only screen and (max-device-width:480px){.a{font-size:18px}}", 375),
    ).toBe(
      "@media only screen and (max-device-width:480px) and (min-width:376px)," +
        "only screen and (max-width:480px) and (max-width:375px){.a{font-size:18px}}",
    );
  });

  it("reads min-, max- and plain device-width (any case) and range syntax as the frame's width", () => {
    const out = rewrite(
      `@media screen and (MIN-DEVICE-WIDTH:320px) and (max-device-width:480px){.a{x:y}}
       @media (400px<=device-width<=700px){.b{x:y}}
       @media (device-width:375px){.c{x:y}}`,
      375,
    );
    expect(out).toContain(
      "screen and (min-width:320px) and (max-width:480px) and (max-width:375px)",
    );
    expect(out).toContain("(400px<=width<=700px) and (max-width:375px)");
    expect(out).toContain("(width:375px) and (max-width:375px)");
    // The wider-frame copies are exactly what the email wrote, plus the guard.
    expect(out).toContain(
      "screen and (MIN-DEVICE-WIDTH:320px) and (max-device-width:480px) and (min-width:376px)",
    );
    expect(out).toContain("(400px<=device-width<=700px) and (min-width:376px)");
  });

  it("parenthesizes a condition with a top-level or before adding the guard", () => {
    expect(
      rewrite(
        "@media screen and ((max-device-width:480px) or (orientation:portrait)){.a{x:y}}",
        375,
      ),
    ).toBe(
      "@media screen and ((max-device-width:480px) or (orientation:portrait)) and (min-width:376px)," +
        "screen and ((max-width:480px) or (orientation:portrait)) and (max-width:375px){.a{x:y}}",
    );
  });

  it("leaves other queries, negated queries and nested non-media at-rules alone", () => {
    const css =
      "@media (max-width:600px){.a{x:y}}" +
      "@media not screen and (min-device-width:600px){.b{x:y}}" +
      "@media screen and (-webkit-min-device-pixel-ratio:2){.c{x:y}}" +
      "@supports (display:grid){.d{x:y}}";
    expect(rewrite(css, 375)).toBe(rewrite(css));
  });

  it("rewrites media queries nested in other blocks, and only in the given list entries", () => {
    expect(
      rewrite("@supports (display:grid){@media print,(max-device-width:480px){.a{x:y}}}", 375),
    ).toBe(
      "@supports (display:grid){@media print,(max-device-width:480px) and (min-width:376px)," +
        "(max-width:480px) and (max-width:375px){.a{x:y}}}",
    );
  });

  it("changes nothing without phoneWidth", () => {
    const css = "@media only screen and (max-device-width:480px){.a{x:y}}";
    expect(rewrite(css)).toBe("@media only screen and (max-device-width:480px){.a{x:y}}");
  });
});

describe("sanitizeForViewer phoneWidth", () => {
  const html = `<html><head><style>@media only screen and (max-device-width:480px){.a{color:red}}</style></head><body><p class="a">x</p></body></html>`;

  it("rewrites the viewer's <style> only when asked, and stays clean", () => {
    const phone = sanitizeForViewer(html, { ...rw, phoneWidth: 375 }).html;
    expect(phone).toContain("(max-width:480px) and (max-width:375px)");
    expect(phone).toContain("(max-device-width:480px) and (min-width:376px)");
    expect(problems(phone)).toEqual([]);
    const plain = sanitizeForViewer(html, rw).html;
    expect(plain).toContain("@media only screen and (max-device-width:480px){");
    expect(plain).not.toContain("min-width:376px");
  });

  it("never changes the analysis profile (the renderer emulates a phone screen itself)", () => {
    expect(sanitizeForAnalysis(html)).toContain("@media only screen and (max-device-width:480px){");
  });

  it("refuses a phoneWidth that isn't a positive integer", () => {
    expect(() => sanitizeForViewer(html, { ...rw, phoneWidth: 0 })).toThrow(TypeError);
    expect(() => sanitizeForViewer(html, { ...rw, phoneWidth: 375.5 })).toThrow(TypeError);
  });
});
