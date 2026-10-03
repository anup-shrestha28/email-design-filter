import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_RULES,
  analyzeStack,
  extractStaticDesign,
  fontCardLines,
  fontProfile,
  fontProfileFromSummary,
  fontSummary,
  looseKey,
  lookupFamily,
  matchKey,
  resolveStack,
  type FontFeatures,
  type FontsStatic,
} from "../src/index";
import { indexDeclared } from "../src/fonts/clients";
import { __test, extractFontsStatic, parseFontServiceUrl } from "../src/static/fonts-static";

const ctx = {
  htmlBytes: 1000,
  subject: null,
  listUnsubscribeHttps: [],
  senderDomain: null,
  language: "en",
};

function fontsOf(html: string): FontsStatic {
  const r = extractStaticDesign(html, ctx);
  if (!r.fonts.static) throw new Error("no fonts_static");
  return r.fonts.static;
}

describe("fonts_static: Google Fonts grammars (DESIGN.md §8.1 step 1)", () => {
  it("parses css v1: families with | and styles as weights, i/italic and keywords", () => {
    const fams = __test.parseGoogleV1("Open Sans:400,700i|Roboto:300italic,bold|Lato", false);
    expect(fams).toEqual([
      { family: "Open Sans", weights: [400, 700], variable: null, italic: true },
      { family: "Roboto", weights: [300, 700], variable: null, italic: true },
      { family: "Lato", weights: [400], variable: null, italic: false },
    ]);
  });
  it("parses css2: repeated family=, axis tuples, variable ranges, no axes = 400", () => {
    const u = parseFontServiceUrl(
      "https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;1,700&amp;family=Inter&amp;family=Roboto+Flex:opsz,wght@8..144,100..1000&amp;display=swap",
    );
    expect(u?.provider).toBe("Google Fonts");
    expect(u?.families).toEqual([
      { family: "Montserrat", weights: [400, 700], variable: null, italic: true },
      { family: "Inter", weights: [400], variable: null, italic: false },
      { family: "Roboto Flex", weights: [], variable: [100, 1000], italic: false },
    ]);
  });
  it("decodes + and %20, and excludes icon fonts", () => {
    const u = parseFontServiceUrl(
      "https://fonts.googleapis.com/css?family=Open%20Sans|Material+Icons|Material+Symbols+Outlined",
    );
    expect(u?.families.map((f) => f.family)).toEqual(["Open Sans"]);
    expect(
      parseFontServiceUrl("https://fonts.googleapis.com/icon?family=Material+Icons")?.families,
    ).toEqual([]);
  });
  it("maps Bunny slugs to display names; Adobe and Fonts.com are provider-only", () => {
    const b = parseFontServiceUrl(
      "https://fonts.bunny.net/css?family=open-sans:400,700|source-serif-4",
    );
    expect(b?.provider).toBe("Bunny Fonts");
    expect(b?.families.map((f) => f.family)).toEqual(["Open Sans", "Source Serif 4"]);
    expect(parseFontServiceUrl("https://use.typekit.net/abc1234.css")).toMatchObject({
      kind: "adobe",
      provider: "Adobe Fonts",
      families: [],
    });
    expect(parseFontServiceUrl("https://fast.fonts.net/cssapi/1234-abcd.css")).toMatchObject({
      provider: "Fonts.com",
      families: [],
    });
    expect(parseFontServiceUrl("https://assets.brand-cdn.co.uk/css/fonts.css")?.provider).toBe(
      "brand-cdn.co.uk",
    );
  });
});

describe("fonts_static extraction", () => {
  const html = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&amp;family=Inter:wght@400;600" rel="stylesheet">
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css?family=Lato:400" rel="stylesheet"><!--<![endif]-->
<link href="https://use.typekit.net/xyz.css" rel="stylesheet">
<style>
@import url("https://p.typekit.net/p.css?s=1&k=xyz");
@font-face { font-family: 'Brand Sans'; src: url(https://cdn.brand.com/brand.woff2) format('woff2'); font-weight: 400; mso-font-alt: 'Arial'; }
@font-face { font-family: 'Brand Sans'; src: url(https://cdn.brand.com/brand-bold.woff2); font-weight: 700; font-style: italic; }
@media screen { @font-face { font-family: 'Hidden Face'; src: url(https://fonts.gstatic.com/s/x.woff2); font-weight: 100 900; } }
h1 { font-family: Montserrat, Arial, sans-serif; }
p { font-family: Inter, 'Helvetica Neue', Arial, sans-serif; }
</style>
<!--[if mso]><style>body, td { font-family: Arial, sans-serif !important; }</style><![endif]-->
</head><body><h1>Headline here</h1><p>Body copy for the static stacks test with enough characters.</p><p style="font-family: 'Brand Sans', Arial">Brand text</p></body></html>`;

  it("records declarations, providers, weights, variable ranges and Outlook visibility", () => {
    const f = fontsOf(html);
    const byFamily = Object.fromEntries(f.declarations.map((d) => [`${d.family}|${d.method}`, d]));
    expect(byFamily["Montserrat|link"]).toMatchObject({
      provider: "Google Fonts",
      weights: [400, 700],
      hiddenFromOutlook: false,
    });
    expect(byFamily["Lato|link"]).toMatchObject({ hiddenFromOutlook: true });
    expect(byFamily["Brand Sans|font-face"]).toMatchObject({
      provider: "brand.com",
      weights: [400, 700],
      italic: true,
      msoFontAlt: "Arial",
      hiddenFromOutlook: false,
    });
    expect(byFamily["Hidden Face|font-face"]).toMatchObject({
      provider: "Google Fonts",
      variable: [100, 900],
      hiddenFromOutlook: true,
    });
    expect(f.providerLinks).toEqual([
      { provider: "Adobe Fonts", method: "link", hiddenFromOutlook: false },
    ]);
    expect(f.typekitCounter).toBe(true);
    expect(f.msoOverrides).toEqual(["Arial"]);
    expect(f.stacks.map((s) => s.css)).toContain("Inter, 'Helvetica Neue', Arial, sans-serif");
  });
  it("stores no URLs and stays within 2 KB", () => {
    const f = fontsOf(html);
    const json = JSON.stringify(f);
    expect(json).not.toMatch(/https?:|\/\/|\.woff|googleapis|gstatic|typekit\.net/);
    expect(json.length).toBeLessThanOrEqual(2048);
    const many = Array.from(
      { length: 60 },
      (_, i) => `.c${i}{font-family:'Family Number ${i} With A Long Name', Arial}`,
    ).join("\n");
    const body = Array.from(
      { length: 60 },
      (_, i) => `<p class="c${i}">text ${i} with some words</p>`,
    ).join("");
    const big = fontsOf(`<html><head><style>${many}</style></head><body>${body}</body></html>`);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(2048);
  });
  it("makes no network requests (fetch, http, https and sockets all throw)", () => {
    const boom = () => {
      throw new Error("network access attempted");
    };
    const spies = [
      vi.spyOn(globalThis, "fetch").mockImplementation(boom),
      vi.spyOn(http, "request").mockImplementation(boom),
      vi.spyOn(http, "get").mockImplementation(boom),
      vi.spyOn(https, "request").mockImplementation(boom),
      vi.spyOn(https, "get").mockImplementation(boom),
      vi.spyOn(net, "connect").mockImplementation(boom),
      vi.spyOn(net, "createConnection").mockImplementation(boom),
    ];
    try {
      const f = fontsOf(html);
      expect(f.declarations.length).toBeGreaterThan(0);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
  it("never throws on hostile input", () => {
    expect(() =>
      extractFontsStatic(
        {
          html: "<style>@font-face{",
          fontFaces: [],
          imports: [],
          links: [{ href: "javascript:alert(1)", hiddenFromOutlook: false }],
          msoBlocks: ["<style>{{{"],
        },
        [],
      ),
    ).not.toThrow();
  });
});

describe("normalization (DESIGN.md §8.1 step 4)", () => {
  it("parses stacks with css-tree: quotes, escapes, generics", () => {
    const a = analyzeStack(`"Helvetica Neue", Arial\\ Black, sans-serif`);
    expect(a.families.map((f) => [f.display, f.generic, f.quoted])).toEqual([
      ["Helvetica Neue", null, true],
      ["Arial Black", null, false],
      ["sans-serif", "sans-serif", false],
    ]);
    const q = analyzeStack(`Inter, "sans-serif"`);
    expect(q.families[1]).toMatchObject({ generic: "sans-serif", quoted: true });
  });
  it("uses NFKC + case-fold match keys and a loose key for lookups", () => {
    expect(matchKey("  ＭＳ  Ｐゴシック ")).toBe("ms pゴシック");
    expect(lookupFamily("ＭＳ Ｐゴシック")?.name).toBe("MS PGothic");
    expect(lookupFamily("微软雅黑")?.name).toBe("Microsoft YaHei");
    expect(lookupFamily("맑은 고딕")?.name).toBe("Malgun Gothic");
    expect(lookupFamily("メイリオ")?.name).toBe("Meiryo");
    expect(looseKey("Segoe UI Semibold")).toBe("segoeui");
    expect(lookupFamily("Segoe UI Semibold")?.name).toBe("Segoe UI");
    expect(lookupFamily("open sans")?.name).toBe("Open Sans");
  });
  it("collapses System UI only when it leads, removes emoji families, detects icons", () => {
    expect(
      analyzeStack("-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto").primary?.display,
    ).toBe("System UI");
    expect(analyzeStack("'Apple Color Emoji', system-ui").primary?.display).toBe("System UI");
    expect(analyzeStack("'Segoe UI', system-ui").primary?.display).toBe("Segoe UI");
    expect(analyzeStack("Roboto, Arial").primary?.display).toBe("Roboto");
    expect(analyzeStack("'Font Awesome 6 Free'").icon).toBe(true);
    expect(analyzeStack("Material Icons").icon).toBe(true);
    expect(analyzeStack(`"__default__"`).noFontSet).toBe(true);
  });
});

describe("per-client table (DESIGN.md §8.1 step 3)", () => {
  const rule = (id: string) => CLIENT_RULES.find((r) => r.id === id)!;
  const decl = (over: Partial<FontsStatic["declarations"][number]> = {}): FontsStatic => ({
    v: 1,
    declarations: [
      {
        family: "Montserrat",
        provider: "Google Fonts",
        method: "link",
        weights: [400],
        variable: null,
        italic: false,
        msoFontAlt: null,
        hiddenFromOutlook: false,
        ...over,
      },
    ],
    providerLinks: [],
    msoOverrides: [],
    stacks: [],
    typekitCounter: false,
    truncated: false,
  });
  const stack = analyzeStack("Montserrat, Arial, sans-serif");

  it("classic Outlook shows Times New Roman for a linked web font with no Outlook fallback", () => {
    expect(resolveStack(stack, rule("outlook_classic"), indexDeclared(decl()))).toMatchObject({
      likely: "Times New Roman",
      tnr: true,
    });
  });
  it("mso-font-alt, an [if mso] override or hiding the declaration avoid the Times New Roman rule", () => {
    expect(
      resolveStack(stack, rule("outlook_classic"), indexDeclared(decl({ msoFontAlt: "Arial" }))),
    ).toMatchObject({ likely: "Arial", tnr: false, outlookFallback: true });
    expect(
      resolveStack(
        stack,
        rule("outlook_classic"),
        indexDeclared({ ...decl(), msoOverrides: ["Calibri"] }),
      ),
    ).toMatchObject({ likely: "Calibri", tnr: false });
    expect(
      resolveStack(
        stack,
        rule("outlook_classic"),
        indexDeclared(decl({ hiddenFromOutlook: true })),
      ),
    ).toMatchObject({ likely: "Arial", tnr: false });
  });
  it("Gmail: web fonts never load; Roboto renders on the web; Android aliases", () => {
    const d = indexDeclared(decl());
    expect(resolveStack(stack, rule("gmail_web"), d).likely).toBe("Arial");
    expect(resolveStack(stack, rule("gmail_android"), d).likely).toBe("Roboto");
    expect(resolveStack(analyzeStack("Georgia, serif"), rule("gmail_android"), d).likely).toBe(
      "Noto Serif",
    );
    expect(resolveStack(analyzeStack("Roboto, Arial"), rule("gmail_web"), d).likely).toBe("Roboto");
    expect(resolveStack(analyzeStack("Roboto, Helvetica"), rule("gmail_ios"), d).likely).toBe(
      "Helvetica",
    );
  });
  it("Apple Mail shows declared fonts; Samsung only @font-face in <style>", () => {
    expect(resolveStack(stack, rule("apple_mail"), indexDeclared(decl())).likely).toBe(
      "Montserrat",
    );
    expect(resolveStack(stack, rule("samsung"), indexDeclared(decl())).likely).toBe("Roboto");
    expect(
      resolveStack(stack, rule("samsung"), indexDeclared(decl({ method: "font-face" }))).likely,
    ).toBe("Montserrat");
  });
  it("no available family → device default", () => {
    expect(
      resolveStack(analyzeStack("'Unknown Face'"), rule("gmail_web"), indexDeclared(null)).likely,
    ).toBe("device default sans-serif");
  });
});

describe("font profile (DESIGN.md §8.1 example card)", () => {
  const exampleFonts: FontFeatures = {
    v: 1,
    static: {
      v: 1,
      declarations: [
        {
          family: "Montserrat",
          provider: "Google Fonts",
          method: "link",
          weights: [400, 700],
          variable: null,
          italic: false,
          msoFontAlt: null,
          hiddenFromOutlook: false,
        },
        {
          family: "Inter",
          provider: "Google Fonts",
          method: "link",
          weights: [400, 600],
          variable: null,
          italic: false,
          msoFontAlt: null,
          hiddenFromOutlook: false,
        },
        {
          family: "Lato",
          provider: "Google Fonts",
          method: "link",
          weights: [400],
          variable: null,
          italic: false,
          msoFontAlt: null,
          hiddenFromOutlook: false,
        },
      ],
      providerLinks: [],
      msoOverrides: [],
      stacks: [],
      typekitCounter: false,
      truncated: false,
    },
    used: {
      v: 1,
      stacks: [
        {
          css: "Montserrat, Arial, sans-serif",
          chars: 230,
          cjkChars: 0,
          roles: { heading: 230, body: 0, button: 0, navigation: 0, footer: 0 },
          weights: [
            [700, 160],
            [400, 70],
          ],
          otherWeightChars: 0,
        },
        {
          css: "Inter, Arial, sans-serif",
          chars: 740,
          cjkChars: 0,
          roles: { heading: 0, body: 740, button: 0, navigation: 0, footer: 0 },
          weights: [
            [400, 600],
            [600, 140],
          ],
          otherWeightChars: 0,
        },
        {
          css: `"__default__"`,
          chars: 30,
          cjkChars: 0,
          roles: { heading: 0, body: 0, button: 0, navigation: 0, footer: 30 },
          weights: [[400, 30]],
          otherWeightChars: 0,
        },
      ],
      otherChars: 0,
      totalChars: 1000,
      imageTextCount: 2,
    },
  };

  it("produces the card of DESIGN.md §8.1", () => {
    const p = fontProfile(exampleFonts, { source: "render" });
    expect(fontCardLines(p)).toEqual([
      "Inter       body text · 74% of text · web font (Google Fonts) · weights 400, 600",
      "Montserrat  headings · 23% of text · web font (Google Fonts) · weights 400, 700",
      "No font set (each app's default) · 3% of text",
      "Arial       backup font in the font stacks",
      "⚠ Gmail doesn't load web fonts — Gmail readers likely see Arial (Roboto on Android) instead of Inter and Montserrat.",
      "⚠ Outlook for Windows (classic) likely shows Times New Roman — the web fonts are linked with no Outlook fallback (no mso-font-alt, no Outlook-safe wrapper).",
      "  Apple Mail and iOS Mail show the web fonts.",
      "Loaded but not used: Lato",
      "At least 2 images contain text — fonts inside images can't be identified.",
    ]);
    expect(p.fontFamilies).toEqual(["Inter", "Montserrat"]);
    expect(p.usesWebFonts).toBe(true);
    expect(p.noFontSetShare).toBeCloseTo(0.03, 5);
    expect(p.clients.find((c) => c.client === "outlook_classic")).toMatchObject({
      likely: "Times New Roman",
      warning: true,
    });
  });
  it("marks weights missing from the declaration as synthesized", () => {
    const f: FontFeatures = structuredClone(exampleFonts);
    f.used!.stacks[1]!.weights = [
      [400, 500],
      [800, 240],
    ];
    const inter = fontProfile(f, { source: "render" }).families.find((x) => x.name === "Inter");
    expect(inter?.weights).toEqual([
      { weight: 400, synthesized: false },
      { weight: 800, synthesized: true },
    ]);
  });
  it("credits CJK characters to the first CJK-capable family", () => {
    const f: FontFeatures = {
      v: 1,
      static: null,
      used: {
        v: 1,
        stacks: [
          {
            css: "Arial, 'Microsoft YaHei', sans-serif",
            chars: 200,
            cjkChars: 150,
            roles: { heading: 0, body: 200, button: 0, navigation: 0, footer: 0 },
            weights: [[400, 200]],
            otherWeightChars: 0,
          },
        ],
        otherChars: 0,
        totalChars: 200,
        imageTextCount: null,
      },
    };
    const names = fontProfile(f, { source: "render" }).families.map((x) => [x.name, x.share]);
    expect(names).toEqual([
      ["Microsoft YaHei", 0.75],
      ["Arial", 0.25],
    ]);
  });
  it("static coverage: declared fonts and static stack primaries, not measured", () => {
    const html = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700"><style>h1{font-family:Montserrat,Arial,sans-serif}p{font-family:Georgia,serif}</style></head><body><h1>Hello</h1><p>Some body text that is long enough.</p></body></html>`;
    const r = extractStaticDesign(html, ctx);
    const p = fontProfile(r.fonts, { source: "static" });
    expect(p.source).toBe("static");
    expect(p.measured).toBe(false);
    expect(p.families.every((f) => f.share === null && f.roles.length === 0)).toBe(true);
    expect(p.fontFamilies).toEqual(["Georgia", "Montserrat"]);
    expect(p.usesWebFonts).toBe(true);
    expect(fontCardLines(p)[0]).toBe("Fonts declared in the email code (not measured)");
  });
  it("round-trips through the compact summary (≤ 0.3 KB)", () => {
    const p = fontProfile(exampleFonts, { source: "render" });
    const s = fontSummary(p);
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(300);
    const back = fontProfileFromSummary(s);
    expect(back.source).toBe("summary");
    expect(back.families.map((f) => f.name)).toEqual(["Inter", "Montserrat"]);
    expect(back.clients.find((c) => c.client === "outlook_classic")?.warning).toBe(true);
    expect(back.fontFamilies).toEqual(["Inter", "Montserrat"]);
  });
});

describe("no-network guard applies to static extraction too", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network");
    });
  });
  afterEach(() => fetchSpy?.mockRestore());
  it("extracts a web-font email without fetching", () => {
    const r = extractStaticDesign(
      `<link rel=stylesheet href="https://fonts.googleapis.com/css?family=Roboto"><p style="font-family:Roboto">x</p>`,
      ctx,
    );
    expect(r.fonts.static?.declarations[0]?.family).toBe("Roboto");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
