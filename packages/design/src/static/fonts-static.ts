// Packages that type-check these sources (pipeline, web) don't include src/types: the reference is needed.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/juice-client.d.ts" />
/**
 * `fonts_static` (DESIGN.md §8.1 step 1): declared web fonts and Outlook font signals,
 * extracted at ingest from the raw HTML with parse5, css-tree and `juice(html)`.
 *
 * No network: `juice/client` is the build without web-resource-inliner, and only the
 * synchronous `juice(html)` is called. Stored: provider names, family names and weights —
 * never font or stylesheet URLs. Output ≤ 2 KB.
 */
import * as csstree from "css-tree";
import juice from "juice/client";
import type { FontDeclaration, FontsStatic } from "../features/fonts";
import { displayNameFromSlug, lookupFamily, matchKey } from "../fonts/catalog";
import { analyzeStack, isIconFamily, parseFamilyList } from "../fonts/normalize";
import { countedChars } from "../util/text";
import { decodeBasicEntities, queryParams, registrableDomain, urlHost, urlPath } from "../util/url";
import type { FontFaceFact, ImportFact } from "./css";
import {
  attr,
  isElement,
  isText,
  type P5Document,
  type P5Node,
  parseDocument,
  parseHtmlFragment,
  parseInlineStyle,
  tag,
  walk,
} from "./dom";

export const FONTS_STATIC_MAX_BYTES = 2048;
const JUICE_MAX_CHARS = 1_500_000;
/**
 * juice matches every selector against the whole document, so its cost grows with selectors ×
 * elements: ≈ 0.3 µs per pair that does not match, ≈ 2 µs per pair that matches (the declarations
 * are merged into the element), plus, for each descendant combinator, a walk up the ancestors
 * (≈ 6 ns per step, so ≈ 50 steps cost one non-matching pair). juice therefore never sees the
 * author CSS as is: only top-level rules that can change a text stack (`font-family`, `font`,
 * `display`) are kept, only those declarations, and only selectors of bounded shape (see
 * `juiceSelectorShape`). Above this budget (≤ ≈ 1.6 s even when every pair matches) the stacks come
 * from inline styles and `<font face>` instead. Real email stays far below it (a heavy newsletter:
 * ~50 font selectors × ~3,000 elements).
 */
export const JUICE_MAX_WORK = 800_000;
/** Ancestor steps that cost as much as one selector × element pair (see JUICE_MAX_WORK). */
const ANCESTOR_STEPS_PER_PAIR = 50;
/** Longest combinator chain (descendant, `>`, `+`) handed to juice. */
export const JUICE_MAX_COMBINATORS = 4;
/** Longest selector handed to juice (a compound's cost grows with its length). */
const JUICE_MAX_SELECTOR_CHARS = 200;
/** The only declarations `staticStacks` reads from the inlined HTML. */
const JUICE_PROPERTIES = new Set(["font-family", "font", "display"]);

/**
 * The shape of one selector for juice: its number of descendant combinators, or null when the
 * selector must not reach juice. Dropped: pseudo-classes and pseudo-elements (`:not(…)`/`:has(…)`
 * nest selectors without css-select's result cache and are polynomial in depth; `:last-of-type`
 * and friends scan all siblings; the rest cannot change a static text stack), the general sibling
 * combinator `~` (scans all earlier siblings), chains longer than JUICE_MAX_COMBINATORS and
 * selectors longer than JUICE_MAX_SELECTOR_CHARS. Plain descendant chains are linear in depth.
 */
export function juiceSelectorShape(selector: string): number | null {
  const sel = selector.trim();
  if (sel.length === 0 || sel.length > JUICE_MAX_SELECTOR_CHARS) return null;
  const s = sel
    .replace(/\\[\s\S]/g, "_")
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\[[^\]]*\]/g, "[]");
  if (/[:()~]/.test(s)) return null;
  const compact = s.replace(/\s*([>+])\s*/g, "$1");
  const descendant = compact.match(/\s+/g)?.length ?? 0;
  const other = compact.match(/[>+]/g)?.length ?? 0;
  if (descendant + other > JUICE_MAX_COMBINATORS) return null;
  return descendant;
}

/** Splits a selector list on top-level commas (not inside brackets, parentheses or strings). */
function splitSelectorList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (c === "," && depth === 0) {
      out.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  out.push(prelude.slice(start));
  return out;
}

/** What juice reads from a document: its `<style>` text, element count and element depth. */
export interface JuiceInput {
  /** Text of every `<style>` juice applies (one text child, no `data-embed`), document order. */
  css: string;
  elements: number;
  maxDepth: number;
}

/**
 * Full iterative traversal of the (bounded) parsed document — not capped at MAX_NODES, so a
 * `<style>` placed after 200,000 nodes is still found and counted. Linear in the node count.
 */
export function juiceInputOf(doc: P5Document): JuiceInput {
  const css: string[] = [];
  let elements = 0;
  let maxDepth = 0;
  const stack: Array<[P5Node, number]> = [[doc, 0]];
  while (stack.length > 0) {
    const [n, depth] = stack.pop()!;
    if (isElement(n)) {
      elements++;
      if (depth > maxDepth) maxDepth = depth;
      if (tag(n) === "style" && attr(n, "data-embed") === null && n.childNodes.length === 1) {
        const only = n.childNodes[0]!;
        if (isText(only)) css.push(only.value);
      }
    }
    const kids = "childNodes" in n ? (n.childNodes as P5Node[]) : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1]);
  }
  return { css: css.join("\n"), elements, maxDepth };
}

/** htmlparser2's void elements (juice parses with cheerio's htmlparser2): no end tag is written. */
const JUICE_PARSER_VOID = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** Subtrees juice's input leaves out: `staticStacks` never reads them and the CSS comes from the plan. */
const JUICE_SKIPPED = new Set(["script", "style", "template"]);
const JUICE_TAG_NAME = /^[a-z][a-z0-9:._-]*$/;
const JUICE_ATTR_NAME = /^[a-z_:][a-z0-9:._-]*$/i;

const escapeJuiceText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeJuiceAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The HTML handed to juice: the bounded parse5 tree re-written well-formed (every non-void element
 * closed explicitly, all text escaped, no comments, scripts, styles or templates).
 *
 * juice parses with htmlparser2, not parse5, and htmlparser2 builds its own tree from raw HTML:
 * `<caption>`/`<colgroup>` outside tables, stray end tags and `<bgsound>` all nest there while
 * parse5 ignores or closes them, and htmlparser2 is itself quadratic in that depth (120k
 * `<div></x>` took ≈ 69 s to load). On this string htmlparser2 builds (at most) parse5's tree, so
 * the element count and depth `planJuice` costs are those of the tree juice matches against, and
 * its depth is bounded by `MAX_PARSED_DEPTH`. Iterative and linear in the node count.
 */
export function juiceSourceOf(doc: P5Document): string {
  const out: string[] = [];
  const stack: Array<P5Node | string> = [];
  const pushChildren = (n: P5Node) => {
    const kids = "childNodes" in n ? (n.childNodes as P5Node[]) : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  };
  pushChildren(doc);
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (isText(item)) {
      out.push(escapeJuiceText(item.value));
      continue;
    }
    if (!isElement(item)) continue;
    const t = tag(item);
    if (JUICE_SKIPPED.has(t)) continue;
    // A name htmlparser2 might read differently (`<a"b>`): keep the content, drop the wrapper.
    if (!JUICE_TAG_NAME.test(t)) {
      pushChildren(item);
      continue;
    }
    let open = `<${t}`;
    for (const a of item.attrs) {
      if (JUICE_ATTR_NAME.test(a.name)) open += ` ${a.name}="${escapeJuiceAttr(a.value)}"`;
    }
    out.push(`${open}>`);
    if (!JUICE_PARSER_VOID.has(t)) stack.push(`</${t}>`);
    pushChildren(item);
  }
  return out.join("");
}

export interface JuicePlan {
  /** The CSS handed to juice: kept rules, kept declarations, kept selectors, in source order. */
  css: string;
  selectors: number;
  /** Estimated cost in selector × element pairs (see JUICE_MAX_WORK). */
  work: number;
}

/** Reduce a document's CSS to what `staticStacks` needs, with its estimated juice cost. */
export function planJuice(input: JuiceInput): JuicePlan {
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(input.css, {
      parseRulePrelude: false,
      parseValue: false,
      parseAtrulePrelude: false,
      parseCustomProperty: false,
      onParseError: () => undefined,
    });
  } catch {
    return { css: "", selectors: 0, work: 0 };
  }
  const rules: string[] = [];
  let selectors = 0;
  let pairs = 0;
  if (ast.type === "StyleSheet") {
    // Top-level rules only: juice does not inline rules inside at-rules.
    ast.children.forEach((node) => {
      if (node.type !== "Rule" || node.prelude.type !== "Raw") return;
      const decls: string[] = [];
      node.block.children.forEach((d) => {
        if (d.type !== "Declaration") return;
        const prop = d.property.toLowerCase();
        if (!JUICE_PROPERTIES.has(prop) || d.value.type !== "Raw") return;
        const value = d.value.value.trim();
        if (value) decls.push(`${prop}:${value}${d.important ? " !important" : ""}`);
      });
      if (decls.length === 0) return;
      const kept: string[] = [];
      for (const sel of splitSelectorList(node.prelude.value)) {
        const descendant = juiceSelectorShape(sel);
        if (descendant === null) continue;
        kept.push(sel.trim());
        pairs += 1 + (descendant * input.maxDepth) / ANCESTOR_STEPS_PER_PAIR;
      }
      if (kept.length === 0) return;
      selectors += kept.length;
      rules.push(`${kept.join(",")}{${decls.join(";")}}`);
    });
  }
  return { css: rules.join("\n"), selectors, work: pairs * input.elements };
}

export interface FontLinkFact {
  href: string;
  hiddenFromOutlook: boolean;
}

export interface FontsStaticInput {
  html: string;
  fontFaces: FontFaceFact[];
  imports: ImportFact[];
  links: FontLinkFact[];
  /** Inner HTML of `<!--[if mso]>` / `<!--[if gte mso 9]>` blocks. */
  msoBlocks: string[];
  /**
   * `html` already parsed (the static document), so the juice plan needs no second parse. When
   * absent, `html` is parsed here.
   */
  doc?: P5Document;
}

type ProviderKind = "google" | "bunny" | "adobe" | "fontscom" | "typekit-counter" | "other";

interface ParsedFontUrl {
  kind: ProviderKind;
  provider: string;
  families: Array<{
    family: string;
    weights: number[];
    variable: [number, number] | null;
    italic: boolean;
  }>;
}

const GOOGLE_V1_STYLE: Record<string, { weight: number; italic: boolean }> = {
  regular: { weight: 400, italic: false },
  normal: { weight: 400, italic: false },
  italic: { weight: 400, italic: true },
  i: { weight: 400, italic: true },
  bold: { weight: 700, italic: false },
  b: { weight: 700, italic: false },
  bolditalic: { weight: 700, italic: true },
  bi: { weight: 700, italic: true },
};

/** css v1: `family=Open+Sans:400,700i|Roboto` (styles as weights + i/italic, or keywords). */
function parseGoogleV1(value: string, slugs: boolean): ParsedFontUrl["families"] {
  const out: ParsedFontUrl["families"] = [];
  for (const part of value.split("|").slice(0, 20)) {
    const [rawName, styles] = part.split(":");
    const name = (rawName ?? "").trim();
    if (!name) continue;
    const weights = new Set<number>();
    let italic = false;
    for (const token of (styles ?? "").split(",")) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      const kw = GOOGLE_V1_STYLE[t];
      if (kw) {
        weights.add(kw.weight);
        italic ||= kw.italic;
        continue;
      }
      const m = /^(\d{3})(i|italic)?$/.exec(t);
      if (m) {
        weights.add(Number(m[1]));
        if (m[2]) italic = true;
      }
    }
    if (weights.size === 0) weights.add(400);
    out.push({
      family: slugs ? displayNameFromSlug(name) : name,
      weights: [...weights].sort((a, b) => a - b),
      variable: null,
      italic,
    });
  }
  return out;
}

/** css2: `family=Montserrat:ital,wght@0,400;1,700` (repeated), ranges `wght@100..900`. */
function parseGoogleCss2(value: string, slugs: boolean): ParsedFontUrl["families"][number] | null {
  const colon = value.indexOf(":");
  const name = (colon < 0 ? value : value.slice(0, colon)).trim();
  if (!name) return null;
  const family = slugs ? displayNameFromSlug(name) : name;
  if (colon < 0) return { family, weights: [400], variable: null, italic: false };
  const spec = value.slice(colon + 1);
  const at = spec.indexOf("@");
  if (at < 0) return { family, weights: [400], variable: null, italic: false };
  const axes = spec
    .slice(0, at)
    .split(",")
    .map((a) => a.trim().toLowerCase());
  const wIdx = axes.indexOf("wght");
  const iIdx = axes.indexOf("ital");
  const weights = new Set<number>();
  let variable: [number, number] | null = null;
  let italic = false;
  for (const tuple of spec
    .slice(at + 1)
    .split(";")
    .slice(0, 40)) {
    const vals = tuple.split(",").map((v) => v.trim());
    if (iIdx >= 0 && vals[iIdx] === "1") italic = true;
    const w = wIdx >= 0 ? vals[wIdx] : undefined;
    if (!w) continue;
    const range = /^(\d{1,4})\.\.(\d{1,4})$/.exec(w);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      variable = variable ? [Math.min(variable[0], lo), Math.max(variable[1], hi)] : [lo, hi];
    } else if (/^\d{1,4}$/.test(w)) {
      weights.add(Number(w));
    }
  }
  if (weights.size === 0 && !variable) weights.add(400);
  return { family, weights: [...weights].sort((a, b) => a - b), variable, italic };
}

function isIconServiceFamily(family: string): boolean {
  return isIconFamily(family) || /^material (?:icons|symbols)/i.test(family);
}

/** Classify a stylesheet URL by font service (DESIGN.md §8.1 step 1). */
export function parseFontServiceUrl(rawUrl: string): ParsedFontUrl | null {
  const url = decodeBasicEntities(rawUrl.trim());
  const host = urlHost(url);
  if (!host) return null;
  const path = urlPath(url) ?? "/";
  if (host === "fonts.googleapis.com" || host === "fonts.bunny.net") {
    const bunny = host === "fonts.bunny.net";
    const provider = bunny ? "Bunny Fonts" : "Google Fonts";
    if (path.startsWith("/icon"))
      return { kind: bunny ? "bunny" : "google", provider, families: [] };
    const params = queryParams(url).filter(([k]) => k === "family");
    let families: ParsedFontUrl["families"] = [];
    if (path.startsWith("/css2")) {
      for (const [, v] of params) {
        const f = parseGoogleCss2(v, bunny);
        if (f) families.push(f);
      }
    } else {
      for (const [, v] of params) families.push(...parseGoogleV1(v, bunny));
    }
    families = families.filter((f) => !isIconServiceFamily(f.family));
    return { kind: bunny ? "bunny" : "google", provider, families };
  }
  if (host === "p.typekit.net")
    return { kind: "typekit-counter", provider: "Adobe Fonts", families: [] };
  if (host === "use.typekit.net" || host === "use.typekit.com")
    return { kind: "adobe", provider: "Adobe Fonts", families: [] };
  if (host === "fast.fonts.net" || host.endsWith(".fonts.net") || host === "fonts.com") {
    return { kind: "fontscom", provider: "Fonts.com", families: [] };
  }
  const reg = registrableDomain(host);
  return reg ? { kind: "other", provider: reg, families: [] } : null;
}

/** Provider of an `@font-face` src URL (DESIGN.md §8.1 step 1). */
export function fontFaceProvider(srcUrls: string[]): string | null {
  for (const raw of srcUrls) {
    const host = urlHost(raw);
    if (!host) continue;
    if (host === "fonts.gstatic.com" || host === "fonts.googleapis.com") return "Google Fonts";
    if (host === "fonts.bunny.net") return "Bunny Fonts";
    if (host.endsWith("typekit.net") || host.endsWith("typekit.com")) return "Adobe Fonts";
    if (host.endsWith("fonts.net")) return "Fonts.com";
    return registrableDomain(host);
  }
  return null;
}

/** Primary families set in Outlook-only style blocks (`[if mso]`, `[if gte mso 9]`). */
function msoOverrideFamilies(blocks: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const inner of blocks.slice(0, 20)) {
    let frag;
    try {
      frag = parseHtmlFragment(inner.length > 100_000 ? inner.slice(0, 100_000) : inner);
    } catch {
      continue;
    }
    walk(frag, (n) => {
      if (!isElement(n) || tag(n) !== "style") return true;
      const css = n.childNodes
        .filter(isText)
        .map((t) => t.value)
        .join("");
      try {
        const ast = csstree.parse(css, { onParseError: () => undefined });
        csstree.walk(ast, (node) => {
          if (node.type !== "Declaration" || node.property.toLowerCase() !== "font-family") return;
          const stack = analyzeStack(csstree.generate(node.value));
          const primary = stack.primary;
          if (!primary || primary.generic) return;
          if (!seen.has(primary.key) && out.length < 6) {
            seen.add(primary.key);
            out.push(primary.display.slice(0, 64));
          }
        });
      } catch {
        // ignore unparseable CSS
      }
      return false;
    });
  }
  return out;
}

const FONT_SHORTHAND =
  /(?:^|\s)(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)(?:\s*\/\s*\S+)?\s+(.+)$/i;

/** Font-family from a declaration map (`font-family`, else the `font` shorthand). */
export function familyFromDecls(decls: Map<string, string>): string | null {
  const ff = decls.get("font-family");
  if (ff) return ff;
  const font = decls.get("font");
  if (font) {
    const m = FONT_SHORTHAND.exec(font.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

/** Static stacks with their text reach, from juice-inlined HTML (plus `<font face>`). */
function staticStacks(
  html: string,
  fallbackFamilies: string[],
  parsed: P5Document | undefined,
): Array<{ css: string; chars: number }> {
  const counts = new Map<string, number>();
  let inlined: string | null = null;
  let plan: JuicePlan | null = null;
  let source: P5Document | null = null;
  if (html.length <= JUICE_MAX_CHARS) {
    try {
      source = parsed ?? parseDocument(html);
      plan = planJuice(juiceInputOf(source));
    } catch {
      plan = null;
    }
  }
  // No applicable rule: inlining would change nothing, so juice is not run at all. juice never sees
  // the raw HTML, only the parsed tree re-written well-formed (`juiceSourceOf`).
  if (source !== null && plan !== null && plan.selectors > 0 && plan.work <= JUICE_MAX_WORK) {
    try {
      inlined = juice.inlineContent(juiceSourceOf(source), plan.css, {
        preserveImportant: true,
        applyWidthAttributes: false,
        applyHeightAttributes: false,
        applyAttributesTableElements: false,
        inlinePseudoElements: false,
        resolveCSSVariables: false,
      });
    } catch {
      inlined = null;
    }
  }
  // Otherwise (no rules, over budget, failure): inline styles and `<font face>` of the document
  // still count (linear).
  const doc = inlined !== null ? parseDocument(inlined) : (source ?? parsed ?? parseDocument(html));
  const stack: Array<{ depth: number; family: string | null }> = [];
  walk(doc, (n, depth) => {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    if (isElement(n)) {
      const t = tag(n);
      if (t === "head" || t === "style" || t === "script" || t === "title" || t === "template")
        return false;
      const decls = parseInlineStyle(attr(n, "style"));
      const display = (decls.get("display") ?? "").trim().toLowerCase();
      if (display === "none" || attr(n, "hidden") !== null) return false;
      const face = t === "font" ? attr(n, "face") : null;
      const family = familyFromDecls(decls) ?? face;
      if (family) stack.push({ depth, family: family.trim().slice(0, 200) });
      return true;
    }
    if (isText(n)) {
      const chars = countedChars(n.value);
      if (chars === 0) return true;
      const family = stack.length > 0 ? stack[stack.length - 1]!.family : null;
      if (family && !/^inherit$/i.test(family))
        counts.set(family, (counts.get(family) ?? 0) + chars);
    }
    return true;
  });
  if (counts.size === 0) {
    for (const f of fallbackFamilies)
      if (!counts.has(f.slice(0, 200))) counts.set(f.slice(0, 200), 0);
  }
  return [...counts.entries()]
    .filter(([css]) => !analyzeStack(css).icon)
    .sort((a, b) => b[1] - a[1])
    .map(([css, chars]) => ({ css, chars }));
}

function mergeDeclarations(decls: FontDeclaration[]): FontDeclaration[] {
  const byKey = new Map<string, FontDeclaration>();
  for (const d of decls) {
    const key = `${matchKey(d.family)}|${d.method}|${d.provider ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...d, weights: [...d.weights] });
      continue;
    }
    prev.weights = [...new Set([...prev.weights, ...d.weights])].sort((a, b) => a - b).slice(0, 12);
    if (d.variable) {
      prev.variable = prev.variable
        ? [Math.min(prev.variable[0], d.variable[0]), Math.max(prev.variable[1], d.variable[1])]
        : d.variable;
    }
    prev.italic ||= d.italic;
    prev.msoFontAlt ??= d.msoFontAlt;
    prev.hiddenFromOutlook &&= d.hiddenFromOutlook;
  }
  return [...byKey.values()];
}

/** Extract `fonts_static` (≤ 2 KB). Never throws; degrades to partial facts. */
export function extractFontsStatic(
  input: FontsStaticInput,
  fontFamiliesInCss: string[],
): FontsStatic {
  const declarations: FontDeclaration[] = [];
  const providerLinks: FontsStatic["providerLinks"] = [];
  let typekitCounter = false;

  const addService = (url: string, method: "link" | "import", hiddenFromOutlook: boolean) => {
    const parsed = parseFontServiceUrl(url);
    if (!parsed) return;
    if (parsed.kind === "typekit-counter") {
      typekitCounter = true;
      return;
    }
    if (parsed.kind === "google" || parsed.kind === "bunny") {
      for (const f of parsed.families) {
        const entry = lookupFamily(f.family);
        declarations.push({
          family: (entry?.name ?? f.family).slice(0, 64),
          provider: parsed.provider,
          method,
          weights: f.weights.slice(0, 12),
          variable: f.variable,
          italic: f.italic,
          msoFontAlt: null,
          hiddenFromOutlook,
        });
      }
      return;
    }
    if (!providerLinks.some((p) => p.provider === parsed.provider && p.method === method)) {
      providerLinks.push({ provider: parsed.provider.slice(0, 64), method, hiddenFromOutlook });
    }
  };

  for (const link of input.links.slice(0, 20))
    addService(link.href, "link", link.hiddenFromOutlook);
  for (const imp of input.imports.slice(0, 20))
    addService(imp.url, "import", imp.hiddenFromOutlook);
  for (const face of input.fontFaces) {
    if (isIconServiceFamily(face.family)) continue;
    const provider = fontFaceProvider(face.srcUrls);
    declarations.push({
      family: face.family.slice(0, 64),
      provider: provider ? provider.slice(0, 64) : null,
      method: "font-face",
      weights: face.weights.slice(0, 12),
      variable: face.variable,
      italic: face.italic,
      msoFontAlt: face.msoFontAlt,
      hiddenFromOutlook: face.hiddenFromOutlook,
    });
  }

  const result: FontsStatic = {
    v: 1,
    declarations: mergeDeclarations(declarations).slice(0, 16),
    providerLinks: providerLinks.slice(0, 6),
    msoOverrides: msoOverrideFamilies(input.msoBlocks),
    stacks: staticStacks(input.html, fontFamiliesInCss, input.doc).slice(0, 12),
    typekitCounter,
    truncated: declarations.length > 16 || providerLinks.length > 6,
  };
  return fitBudget(result);
}

/** Drop the least important facts until the JSON is ≤ 2 KB. */
function fitBudget(f: FontsStatic): FontsStatic {
  const size = () => JSON.stringify(f).length;
  if (size() <= FONTS_STATIC_MAX_BYTES) return f;
  f.truncated = true;
  while (size() > FONTS_STATIC_MAX_BYTES && f.stacks.length > 0) f.stacks.pop();
  while (size() > FONTS_STATIC_MAX_BYTES && f.providerLinks.length > 0) f.providerLinks.pop();
  for (const d of f.declarations)
    if (size() > FONTS_STATIC_MAX_BYTES) d.weights = d.weights.slice(0, 3);
  while (size() > FONTS_STATIC_MAX_BYTES && f.declarations.length > 0) f.declarations.pop();
  return f;
}

/** Test hook: exported parsers for the grammar tests. */
export const __test = { parseGoogleV1, parseGoogleCss2, parseFamilyList };
