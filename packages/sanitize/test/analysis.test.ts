import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { sanitizeForAnalysis, sanitizeForViewer } from "../src/index";
import { rw } from "./oracle";

function doc(html: string): Document {
  return new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
}

const EMAIL = `<!DOCTYPE html>
<html lang="de" dir="ltr" data-o="0" onload="alert(1)">
<head data-o="15">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="unsafe-url">
  <meta http-equiv="refresh" content="0;url=https://evil.example/">
  <title data-o="40">Sale &amp; more</title>
  <link rel="preconnect" href="https://tracker.example"><link rel="dns-prefetch" href="//t.example"><link rel="preload" href="https://t.example/p.gif">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Lato">
  <style data-o="120">@import url(https://fonts.googleapis.com/css2?family=Lato);
    @font-face{font-family:Lato;src:url(https://fonts.gstatic.com/lato.woff2)}
    .hero{background:url(https://cdn.shop.example/hero.jpg) center/cover}
    @media (max-width:600px){.hero{padding:8px!important}}</style>
  <script>alert(1)</script>
</head>
<body data-o="300" data-tracking="x" style="margin:0">
  <img data-o="310" src="https://cdn.shop.example/a.png" alt="A" width="600" onerror="alert(1)">
  <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">
  <img src="cid:logo@shop" alt="logo">
  <a data-o="400" href="https://shop.example/sale?utm=1" target="_blank">Shop now</a>
  <a href="javascript:alert(1)">bad</a>
  <form action="https://evil.example/"><input name="q"></form>
  <div data-o="not-a-number" style="width:expression(alert(1))">x</div>
</body></html>`;

describe("analysis profile (DESIGN-SCORE §2)", () => {
  const out = sanitizeForAnalysis(EMAIL);
  const d = doc(out);

  it("returns a whole document with a doctype and html[lang|dir]", () => {
    expect(out.startsWith("<!DOCTYPE html>\n<html")).toBe(true);
    expect(d.documentElement.getAttribute("lang")).toBe("de");
    expect(d.documentElement.getAttribute("dir")).toBe("ltr");
    expect(d.documentElement.hasAttribute("onload")).toBe(false);
  });

  it("keeps <title>, meta viewport/color-scheme and head <style>", () => {
    expect(d.title).toBe("Sale & more");
    const metas = Array.from(d.querySelectorAll("meta")).map((m) => [
      m.getAttribute("name"),
      m.getAttribute("content"),
    ]);
    expect(metas).toEqual([
      ["viewport", "width=device-width, initial-scale=1"],
      ["color-scheme", "light dark"],
    ]);
    const style = d.head.querySelector("style")?.textContent ?? "";
    expect(style).toContain(".hero{background:url(https://cdn.shop.example/hero.jpg)center/cover}");
    expect(style).toContain("@media (max-width:600px)");
    expect(style).not.toMatch(/@import|@font-face|fonts\.g/);
  });

  it("keeps data-o (numeric only) and drops every other data-* attribute", () => {
    const withO = Array.from(d.querySelectorAll("[data-o]")).map((e) => e.getAttribute("data-o"));
    expect(withO).toEqual(["0", "15", "40", "120", "300", "310", "400"]);
    expect(out).not.toMatch(/data-tracking|not-a-number/);
  });

  it("keeps original image src and link href (the renderer intercepts every request)", () => {
    const srcs = Array.from(d.images).map((i) => i.getAttribute("src"));
    expect(srcs[0]).toBe("https://cdn.shop.example/a.png");
    expect(srcs[1]?.startsWith("data:image/png;base64,")).toBe(true);
    expect(srcs[2]).toBe("cid:logo@shop");
    const links = Array.from(d.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://shop.example/sale?utm=1", null]);
    expect(d.querySelector("a")?.hasAttribute("target")).toBe(false);
  });

  it("removes scripts, handlers, forms, links, http-equiv and CSS expressions", () => {
    expect(out).not.toMatch(
      /<script|onerror|onload|<form|<input|<link|http-equiv|referrer|expression|javascript:/i,
    );
    expect(d.querySelector("div")?.hasAttribute("style")).toBe(false);
  });

  it("never calls viewer rewriters and never proxies", () => {
    expect(out).not.toContain("view.example");
  });
});

describe("analysis profile: hostile data: values", () => {
  it("a whitespace-padded value is refused in linear time", () => {
    // The old DATA_IMAGE_RE backtracked quadratically here (about 17 s).
    const ws = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUg${" ".repeat(128 * 1024)}!`;
    const t0 = performance.now();
    const out = sanitizeForAnalysis(`<img src="${ws}" alt="a">`);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toContain('<img alt="a">');
  });

  it("millions of `;` parameters don't overflow the regex stack", () => {
    // The old nested `(?:;[…]*)*` threw a RangeError out of sanitizeForAnalysis.
    const semis = `data:image/png${";".repeat(4 * 1024 * 1024)}x`;
    expect(sanitizeForAnalysis(`<img src="${semis}" alt="b">`)).toContain('<img alt="b">');
  });
});

describe("jsdom inline-style optimisation is scoped to the sanitizer's window", () => {
  it("other jsdom windows still sync el.style", () => {
    sanitizeForViewer(`<p style="color:red">x</p>`, rw);
    const other = new JSDOM(`<p style="color: red">x</p>`, {
      virtualConsole: new VirtualConsole(),
    });
    const p = other.window.document.querySelector("p") as HTMLElement;
    expect(p.style.color).toBe("red");
    p.setAttribute("style", "color: blue");
    expect(p.style.color).toBe("blue");
  });
});
