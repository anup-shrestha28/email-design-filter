/**
 * Static CSS analysis with css-tree: the `<style>` byte budget and @media cut-off (X4),
 * @font-face / @import facts (fonts_static), feature usage for X2, and a small map of
 * simple-selector rules so static heuristics can see class-based styles without juice.
 */
import * as csstree from "css-tree";
import { ByteOffsetMapper, utf8Length } from "../util/bytes";
import type { P5Element } from "./dom";
import { attr, parseInlineStyle, tag } from "./dom";

/** Gmail keeps only the first 16,384 bytes of `<style>` (DESIGN-SCORE §5.8 X4). */
export const GMAIL_STYLE_LIMIT = 16_384;
const MAX_BLOCK_CHARS = 256_000;
const MAX_RULES = 4_000;

export interface StyleBlock {
  css: string;
  /** Inside `<!--[if !mso]><!-->…<!--<![endif]-->`. */
  hiddenFromOutlook: boolean;
}

export interface FontFaceFact {
  family: string;
  srcUrls: string[];
  weights: number[];
  variable: [number, number] | null;
  italic: boolean;
  msoFontAlt: string | null;
  hiddenFromOutlook: boolean;
}

export interface ImportFact {
  url: string;
  hiddenFromOutlook: boolean;
}

export interface SimpleRule {
  tag: string | null;
  id: string | null;
  classes: string[];
  decls: Map<string, string>;
  order: number;
}

export interface StyleAnalysis {
  bytes: number;
  mediaRules: number;
  mediaAfterLimit: boolean;
  fontFaces: FontFaceFact[];
  imports: ImportFact[];
  /** Declarations from all rules (for X2 feature detection), with block-level context. */
  blocks: Array<Map<string, string>>;
  /** Font-family values declared anywhere in `<style>` (for mso overrides / stacks fallback). */
  fontFamilies: string[];
  rules: SimpleRuleIndex;
}

/** Simple-selector rule index: `c:<class>`, `i:<id>`, `t:<tag>`. */
export class SimpleRuleIndex {
  private readonly byKey = new Map<string, SimpleRule[]>();
  private readonly memo = new WeakMap<P5Element, Map<string, string>>();
  private count = 0;

  add(rule: SimpleRule): void {
    if (this.count >= MAX_RULES) return;
    this.count++;
    const key = rule.id
      ? `i:${rule.id}`
      : rule.classes.length > 0
        ? `c:${rule.classes[0]}`
        : rule.tag
          ? `t:${rule.tag}`
          : null;
    if (!key) return;
    const list = this.byKey.get(key) ?? [];
    list.push(rule);
    this.byKey.set(key, list);
  }

  /** Merged static declarations for `el`: tag < class < id rules < inline style. */
  styleOf(el: P5Element): Map<string, string> {
    const cached = this.memo.get(el);
    if (cached) return cached;
    const t = tag(el);
    const id = attr(el, "id");
    const classes = (attr(el, "class") ?? "").split(/\s+/).filter(Boolean).slice(0, 20);
    const candidates: SimpleRule[] = [];
    const pushAll = (key: string) => {
      const list = this.byKey.get(key);
      if (list) candidates.push(...list);
    };
    pushAll(`t:${t}`);
    for (const c of classes) pushAll(`c:${c}`);
    if (id) pushAll(`i:${id}`);
    const matched = candidates
      .filter(
        (r) =>
          (!r.tag || r.tag === t) &&
          (!r.id || r.id === id) &&
          r.classes.every((c) => classes.includes(c)),
      )
      .sort((a, b) => specificity(a) - specificity(b) || a.order - b.order);
    const out = new Map<string, string>();
    for (const r of matched) for (const [k, v] of r.decls) out.set(k, v);
    for (const [k, v] of parseInlineStyle(attr(el, "style"))) out.set(k, v);
    this.memo.set(el, out);
    return out;
  }
}

function specificity(r: SimpleRule): number {
  return (r.id ? 100 : 0) + r.classes.length * 10 + (r.tag ? 1 : 0);
}

function declMap(block: csstree.Block | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!block) return out;
  block.children.forEach((node) => {
    if (node.type === "Declaration") {
      out.set(node.property.toLowerCase(), csstree.generate(node.value).trim());
    }
  });
  return out;
}

function simpleSelectors(
  prelude: csstree.SelectorList | csstree.Raw,
): Array<Omit<SimpleRule, "decls" | "order">> {
  if (prelude.type !== "SelectorList") return [];
  const out: Array<Omit<SimpleRule, "decls" | "order">> = [];
  prelude.children.forEach((sel) => {
    if (sel.type !== "Selector") return;
    let t: string | null = null;
    let id: string | null = null;
    const classes: string[] = [];
    let simple = true;
    sel.children.forEach((part) => {
      if (part.type === "TypeSelector") t = part.name.toLowerCase();
      else if (part.type === "ClassSelector") classes.push(part.name);
      else if (part.type === "IdSelector") id = part.name;
      else simple = false;
    });
    if (simple && (t || id || classes.length > 0) && t !== "*") out.push({ tag: t, id, classes });
  });
  return out;
}

function numericWeights(value: string): { weights: number[]; variable: [number, number] | null } {
  const v = value.trim().toLowerCase();
  if (v === "bold") return { weights: [700], variable: null };
  if (v === "normal" || v === "") return { weights: [400], variable: null };
  const nums = (v.match(/\d{3}/g) ?? []).map(Number).filter((n) => n >= 1 && n <= 1000);
  if (nums.length >= 2)
    return { weights: [], variable: [Math.min(nums[0]!, nums[1]!), Math.max(nums[0]!, nums[1]!)] };
  if (nums.length === 1) return { weights: [nums[0]!], variable: null };
  return { weights: [400], variable: null };
}

function unquote(s: string): string {
  const t = s.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Analyse every `<style>` block (in document order, mso-only blocks excluded). */
export function analyzeStyles(blocks: StyleBlock[]): StyleAnalysis {
  const rules = new SimpleRuleIndex();
  const result: StyleAnalysis = {
    bytes: 0,
    mediaRules: 0,
    mediaAfterLimit: false,
    fontFaces: [],
    imports: [],
    blocks: [],
    fontFamilies: [],
    rules,
  };
  let cumulative = 0;
  let order = 0;
  for (const block of blocks) {
    const css =
      block.css.length > MAX_BLOCK_CHARS ? block.css.slice(0, MAX_BLOCK_CHARS) : block.css;
    const blockBytes = utf8Length(block.css);
    const mapper = new ByteOffsetMapper(css);
    let ast: csstree.CssNode;
    try {
      ast = csstree.parse(css, { positions: true, onParseError: () => undefined });
    } catch {
      cumulative += blockBytes;
      continue;
    }
    const conditionalDepth = { media: 0 };
    csstree.walk(ast, {
      enter(node: csstree.CssNode) {
        if (node.type === "Atrule") {
          const name = node.name.toLowerCase();
          if (name === "media") {
            result.mediaRules++;
            const start = node.loc
              ? cumulative + mapper.toBytes(node.loc.start.offset)
              : cumulative;
            if (start >= GMAIL_STYLE_LIMIT) result.mediaAfterLimit = true;
            conditionalDepth.media++;
          } else if (name === "supports" || name === "container") {
            conditionalDepth.media++;
          } else if (name === "font-face" && node.block) {
            const decls = declMap(node.block);
            const family = unquote(decls.get("font-family") ?? "");
            if (family && result.fontFaces.length < 40) {
              const srcUrls: string[] = [];
              const src = node.block.children
                .toArray()
                .find(
                  (d): d is csstree.Declaration =>
                    d.type === "Declaration" && d.property.toLowerCase() === "src",
                );
              if (src) {
                csstree.walk(src.value, (v) => {
                  if (v.type === "Url" && srcUrls.length < 8) srcUrls.push(v.value);
                });
              }
              const w = numericWeights(decls.get("font-weight") ?? "400");
              result.fontFaces.push({
                family: family.slice(0, 64),
                srcUrls,
                weights: w.weights,
                variable: w.variable,
                italic: /italic|oblique/i.test(decls.get("font-style") ?? ""),
                msoFontAlt: decls.has("mso-font-alt")
                  ? unquote(decls.get("mso-font-alt")!).slice(0, 64) || null
                  : null,
                hiddenFromOutlook: block.hiddenFromOutlook || conditionalDepth.media > 0,
              });
            }
          } else if (name === "import" && node.prelude && node.prelude.type === "AtrulePrelude") {
            let url: string | null = null;
            let hasMedia = false;
            node.prelude.children.forEach((p) => {
              if (p.type === "Url") url = p.value;
              else if (p.type === "String" && url === null) url = p.value;
              else if (
                p.type === "MediaQueryList" ||
                p.type === "MediaQuery" ||
                p.type === "Identifier"
              )
                hasMedia = true;
            });
            if (url && result.imports.length < 10) {
              result.imports.push({
                url,
                hiddenFromOutlook:
                  block.hiddenFromOutlook || hasMedia || conditionalDepth.media > 0,
              });
            }
          }
        } else if (node.type === "Rule") {
          const decls = declMap(node.block);
          if (result.blocks.length < MAX_RULES) result.blocks.push(decls);
          const ff = decls.get("font-family");
          if (ff && result.fontFamilies.length < 200) result.fontFamilies.push(ff);
          if (conditionalDepth.media === 0) {
            for (const s of simpleSelectors(node.prelude))
              rules.add({ ...s, decls, order: order++ });
          }
        }
      },
      leave(node: csstree.CssNode) {
        if (node.type === "Atrule") {
          const name = node.name.toLowerCase();
          if (name === "media" || name === "supports" || name === "container")
            conditionalDepth.media--;
        }
      },
    });
    cumulative += blockBytes;
  }
  result.bytes = cumulative;
  return result;
}

// ───────────────────────── X2 feature detection ─────────────────────────

const GRADIENT = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i;
const URL_FN = /url\s*\(/i;
const COLOR_TOKEN =
  /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\b(?:white|black|red|green|blue|gray|grey|navy|teal|orange|purple|yellow|silver|maroon|olive|lime|aqua|fuchsia)\b/i;

export interface CompatHits {
  flex: boolean;
  grid: boolean;
  position: boolean;
  float: boolean;
  maxWidth: boolean;
  backgroundImage: boolean;
  /** Every background image sits on a block that also sets a solid colour. */
  backgroundImageColorFallback: boolean;
  borderRadius: boolean;
  gradient: boolean;
  gradientFallback: boolean;
  boxShadow: boolean;
}

export function emptyCompatHits(): CompatHits {
  return {
    flex: false,
    grid: false,
    position: false,
    float: false,
    maxWidth: false,
    backgroundImage: false,
    backgroundImageColorFallback: true,
    borderRadius: false,
    gradient: false,
    gradientFallback: true,
    boxShadow: false,
  };
}

/**
 * Record X2-relevant features of one declaration block. `el` is the element for inline
 * styles (to see `bgcolor` fallbacks and skip floated images), else null.
 */
export function scanDeclarations(
  decls: Map<string, string>,
  hits: CompatHits,
  el: P5Element | null,
): void {
  if (decls.size === 0) return;
  const display = (decls.get("display") ?? "").toLowerCase();
  if (/\b(?:inline-)?flex\b/.test(display)) hits.flex = true;
  if (/\b(?:inline-)?grid\b/.test(display)) hits.grid = true;
  if (/^(?:absolute|fixed)$/i.test((decls.get("position") ?? "").trim())) hits.position = true;
  const float = (decls.get("float") ?? "").trim().toLowerCase();
  if ((float === "left" || float === "right") && !(el && tag(el) === "img")) hits.float = true;
  if (decls.has("max-width") && !/^(?:none|100%)$/i.test(decls.get("max-width")!.trim()))
    hits.maxWidth = true;
  const bg = decls.get("background") ?? "";
  const bgImage = decls.get("background-image") ?? "";
  const hasSolid =
    COLOR_TOKEN.test(decls.get("background-color") ?? "") ||
    COLOR_TOKEN.test(bg.replace(GRADIENT, "").replace(/url\([^)]*\)/gi, "")) ||
    (el !== null && attr(el, "bgcolor") !== null);
  if (URL_FN.test(bg) || URL_FN.test(bgImage)) {
    hits.backgroundImage = true;
    if (!hasSolid) hits.backgroundImageColorFallback = false;
  }
  if (GRADIENT.test(bg) || GRADIENT.test(bgImage)) {
    hits.gradient = true;
    if (!hasSolid) hits.gradientFallback = false;
  }
  const radius = decls.get("border-radius") ?? "";
  if (radius && !/^0(?:px)?$/.test(radius.trim())) hits.borderRadius = true;
  for (const k of [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-left-radius",
    "border-bottom-right-radius",
  ]) {
    const v = decls.get(k);
    if (v && !/^0(?:px)?$/.test(v.trim())) hits.borderRadius = true;
  }
  const shadow = decls.get("box-shadow");
  if (shadow && !/^none$/i.test(shadow.trim())) hits.boxShadow = true;
}
