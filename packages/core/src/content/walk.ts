/**
 * One iterative pass over the parsed HTML (FREE-TIER.md §4.6: keep ingest ≈ 0.1 CPU-s): visible
 * text in reading order, the hidden preheader, visible links, button-like CTAs, content images vs
 * tracking pixels, JSON-LD blocks, microdata items and the DOM skeleton shingles for the template
 * simhash — all collected in the same walk.
 */
import { isTrackingPixel } from "../policy";
import type { SchemaOrgItem } from "../types";
import { matchingBrace, stripCssComments } from "../util/css";
import { hostOfUrl, registrableDomain } from "../util/domain";
import {
  hasBackground,
  hasVisibleBorder,
  isHiddenStyle,
  parseInlineStyle,
  cssLengthPx,
} from "../util/style";
import { childrenOf, isElement, isText, parseHtml, subtreeText } from "./dom";
import type { DomElement, DomNode } from "./dom";

export const WALK_LIMITS = {
  /** Elements processed before the walk stops (the renderer itself caps DOMs at 20k nodes). */
  maxElements: 60_000,
  /** Visible text characters collected. */
  maxText: 200_000,
  maxPreheader: 600,
  maxLinks: 400,
  maxJsonLd: 5,
  maxJsonLdChars: 64 * 1024,
  maxCssChars: 300 * 1024,
  maxMicrodataItems: 10,
  maxMicrodataFields: 40,
} as const;

export interface LinkRecord {
  href: string;
  /** Visible link text (raw). */
  text: string;
  /** Up to 100 characters of visible text immediately before the link. */
  before: string;
  buttonLike: boolean;
  /** alt of a button-like image inside the link (image CTAs). */
  imageAlt: string | null;
}

export interface WalkResult {
  /** Visible text with "\n" at block boundaries (not yet collapsed). */
  text: string;
  preheader: string;
  links: LinkRecord[];
  imageCount: number;
  pixelCount: number;
  pixelHosts: string[];
  jsonLd: string[];
  microdata: SchemaOrgItem[];
  skeleton: Set<string>;
  htmlLang: string | null;
}

const SKIP_SUBTREE = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "canvas",
  "video",
  "audio",
  "select",
  "title",
  "xml",
]);

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "button",
]);

/** Layout containers that form the template skeleton. */
const STRUCTURAL = new Set([
  "table",
  "tr",
  "td",
  "th",
  "div",
  "center",
  "section",
  "header",
  "footer",
  "article",
  "main",
  "nav",
  "aside",
  "hr",
  "img",
  "a",
  "button",
  "form",
]);

/** Text blocks: one skeleton token each; their inner structure varies with content, so it's ignored. */
const TEXT_BLOCK = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "dl",
]);

const BUTTON_PARENTS = new Set(["td", "th", "div", "p", "center", "span", "table"]);

/** A character that is neither whitespace nor an invisible filler. */
const VISIBLE_CHAR_RE = /(?![\s\u00A0\u00AD\u200B-\u200F\u2060\uFEFF]|\u034F)[\s\S]/u;

interface MicroScope {
  target: Record<string, string>;
  prefix: string;
  count: { n: number };
}

interface Ctx {
  hidden: boolean;
  inHead: boolean;
  /** Last structural tokens on the path (for skeleton shingles). */
  skel: string;
  inTextBlock: boolean;
  scope: MicroScope | null;
}

interface ActiveLink {
  href: string;
  text: string;
  before: string;
  el: DomElement;
  style: Map<string, string>;
  imageAlt: string | null;
}

type Frame =
  | { kind: "enter"; node: DomNode; ctx: Ctx }
  | { kind: "exit"; el: DomElement; block: boolean; link: boolean };

/**
 * Collects class names hidden by top-level `<style>` rules (`.preheader{display:none}`). Rules
 * inside at-rules (@media, @supports…) are skipped: they hide only under conditions.
 */
export function collectHiddenClasses(cssRaw: string, out: Set<string>): void {
  const css = stripCssComments(cssRaw);
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@", i);
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    if (at >= 0 && at < brace) {
      const semi = css.indexOf(";", at);
      if (semi >= 0 && semi < brace) {
        i = semi + 1;
        continue;
      }
      i = matchingBrace(css, brace) + 1;
      continue;
    }
    const end = matchingBrace(css, brace);
    const selector = css.slice(i, brace);
    const body = css.slice(brace + 1, end);
    if (/display\s*:\s*none/i.test(body) || /visibility\s*:\s*hidden/i.test(body)) {
      for (const sel of selector.split(",")) {
        const m = /^\s*(?:[a-z][a-z0-9]*)?\.([a-z0-9_-]{1,64})\s*$/i.exec(sel);
        if (m && out.size < 200) out.add((m[1] as string).toLowerCase());
      }
    }
    i = end + 1;
  }
}

/** Sanitised class tokens for the skeleton: stable, human-named classes only. */
function skeletonClasses(cls: string | undefined): string {
  if (!cls) return "";
  const out: string[] = [];
  for (const c of cls.toLowerCase().split(/\s+/)) {
    if (out.length >= 2) break;
    if (c.length < 2 || c.length > 24) continue;
    if (!/^[a-z][a-z_-]*[a-z0-9]?$/.test(c)) continue;
    if (/\d{3,}/.test(c) || c.startsWith("m_") || c.startsWith("x_")) continue;
    out.push(c);
  }
  return out.length > 0 ? `.${out.sort().join(".")}` : "";
}

function skeletonToken(name: string, attribs: Record<string, string>): string {
  if (name === "img" || name === "a" || name === "hr") return name;
  let t = name + skeletonClasses(attribs.class);
  if (name === "table") {
    const w = attribs.width?.trim();
    if (w && /^\d{2,4}%?$/.test(w)) t += `[w=${w}]`;
  }
  return t;
}

function hasPadding(style: Map<string, string>): boolean {
  for (const key of ["padding", "padding-top", "padding-bottom", "padding-left", "padding-right"]) {
    const v = style.get(key);
    if (v && /[1-9]/.test(v)) return true;
  }
  return false;
}

function isSoleMeaningfulChild(parent: DomNode, child: DomElement): boolean {
  let count = 0;
  for (const k of childrenOf(parent)) {
    if (k === child) {
      count++;
      continue;
    }
    if (isText(k)) {
      if (VISIBLE_CHAR_RE.test(k.data)) return false;
      continue;
    }
    if (isElement(k)) {
      if (k.name === "br") continue;
      return false;
    }
  }
  return count === 1;
}

/** Button-like anchor (static heuristic; the renderer does the precise version, DESIGN-SCORE §2.1). */
function isButtonLike(el: DomElement, style: Map<string, string>): boolean {
  const cls = el.attribs.class ?? "";
  if (/(?:^|[\s_-])(?:btn|button|cta)(?:$|[\s_-])/i.test(cls)) return true;
  if ((el.attribs.role ?? "").toLowerCase() === "button") return true;
  const display = style.get("display") ?? "";
  const lineHeight = cssLengthPx(style.get("line-height"));
  const height = cssLengthPx(style.get("height"));
  const boxy =
    hasPadding(style) ||
    display.startsWith("inline-block") ||
    display === "block" ||
    (lineHeight !== null && lineHeight >= 28) ||
    (height !== null && height >= 28);
  if ((hasBackground(style) || el.attribs.bgcolor !== undefined || hasVisibleBorder(style)) && boxy)
    return true;
  // Bulletproof button: a coloured cell/div whose only content is this link.
  const parent = el.parent;
  if (parent && isElement(parent) && BUTTON_PARENTS.has(parent.name)) {
    const pStyle = parseInlineStyle(parent.attribs.style);
    const coloured = parent.attribs.bgcolor !== undefined || hasBackground(pStyle);
    if (coloured && isSoleMeaningfulChild(parent, el)) return true;
  }
  return false;
}

const BUTTON_WORDS_RE =
  /\b(?:shop|buy|order|get|start|learn|view|see|read|watch|download|sign ?up|join|register|book|claim|redeem|explore|discover|reserve|subscribe|upgrade|try|more|now|button|btn|cta)\b|comprar|acheter|kaufen|acquista|comprar|bestellen|jetzt|ahora|maintenant|ora\b/i;

/**
 * Image link that looks like a button: aspect 2:1–8:1, height 30–80px, and alt text or file
 * name that suggests a button (DESIGN-SCORE §2.1). Logos are excluded.
 */
function isButtonImage(attribs: Record<string, string>): boolean {
  const w = Number(attribs.width);
  const h = Number(attribs.height);
  if (!(w > 0 && h > 0)) return false;
  const aspect = w / h;
  if (!(aspect >= 2 && aspect <= 8 && h >= 30 && h <= 80)) return false;
  const alt = attribs.alt ?? "";
  const file = (attribs.src ?? "").split("?")[0]?.split("/").pop() ?? "";
  if (/logo/i.test(alt) || /logo/i.test(file)) return false;
  return BUTTON_WORDS_RE.test(alt) || /btn|button|cta/i.test(file);
}

function schemaTypeOf(itemtype: string | undefined): string {
  if (!itemtype) return "Thing";
  const first = itemtype.trim().split(/\s+/)[0] ?? "";
  const t = first.slice(Math.max(first.lastIndexOf("/"), first.lastIndexOf("#")) + 1);
  return /^[A-Za-z]{1,64}$/.test(t) ? t : "Thing";
}

function microValue(el: DomElement): string {
  const a = el.attribs;
  if (a.content !== undefined) return a.content;
  switch (el.name) {
    case "a":
    case "link":
    case "area":
      return a.href ?? "";
    case "time":
      return a.datetime ?? subtreeText(el, 200);
    case "img":
    case "audio":
    case "video":
    case "source":
      return a.src ?? "";
    case "data":
    case "meter":
      return a.value ?? subtreeText(el, 200);
    default:
      return subtreeText(el, 200);
  }
}

/** Walks an HTML document once. */
export function walkHtml(html: string): WalkResult {
  const root = parseHtml(html);
  const parts: string[] = [];
  let textLen = 0;
  let tail = "";
  let preheader = "";
  let seenVisible = false;
  const links: LinkRecord[] = [];
  let active: ActiveLink | null = null;
  let imageCount = 0;
  let pixelCount = 0;
  const pixelHosts: string[] = [];
  const jsonLd: string[] = [];
  const microdata: SchemaOrgItem[] = [];
  const skeleton = new Set<string>();
  const hiddenClasses = new Set<string>();
  let cssBudget: number = WALK_LIMITS.maxCssChars;
  let htmlLang: string | null = null;
  let elements = 0;

  const append = (s: string): void => {
    if (textLen >= WALK_LIMITS.maxText) return;
    parts.push(s);
    textLen += s.length;
    tail = (tail + s).slice(-100);
    if (active && active.text.length < 300) active.text += s;
    if (!seenVisible && VISIBLE_CHAR_RE.test(s)) seenVisible = true;
  };
  const boundary = (): void => {
    if (textLen < WALK_LIMITS.maxText) {
      parts.push("\n");
      textLen += 1;
      tail = (tail + "\n").slice(-100);
      if (active && active.text.length < 300) active.text += " ";
    }
  };

  const rootCtx: Ctx = { hidden: false, inHead: false, skel: "", inTextBlock: false, scope: null };
  const stack: Frame[] = [];
  const kids = childrenOf(root);
  for (let i = kids.length - 1; i >= 0; i--)
    stack.push({ kind: "enter", node: kids[i] as DomNode, ctx: rootCtx });

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.kind === "exit") {
      if (frame.link && active && active.el === frame.el) {
        const buttonLike = isButtonLike(active.el, active.style);
        if (links.length < WALK_LIMITS.maxLinks) {
          links.push({
            href: active.href,
            text: active.text,
            before: active.before,
            buttonLike,
            imageAlt: active.imageAlt,
          });
        }
        active = null;
      }
      if (frame.block) boundary();
      continue;
    }

    const { node, ctx } = frame;
    if (isText(node)) {
      if (ctx.inHead) continue;
      if (ctx.hidden) {
        if (!seenVisible && preheader.length < WALK_LIMITS.maxPreheader) preheader += node.data;
      } else {
        append(node.data);
      }
      continue;
    }
    if (!isElement(node)) continue;
    if (++elements > WALK_LIMITS.maxElements) break;

    const el = node;
    const name = el.name.toLowerCase();
    const attribs = el.attribs;

    if (SKIP_SUBTREE.has(name)) {
      if (name === "style" && cssBudget > 0) {
        const css = subtreeText(el, Math.min(cssBudget, 100_000));
        cssBudget -= css.length;
        collectHiddenClasses(css, hiddenClasses);
      } else if (
        name === "script" &&
        (attribs.type ?? "").trim().toLowerCase() === "application/ld+json" &&
        jsonLd.length < WALK_LIMITS.maxJsonLd
      ) {
        jsonLd.push(subtreeText(el, WALK_LIMITS.maxJsonLdChars));
      }
      continue;
    }

    if (name === "html" && attribs.lang && !htmlLang) htmlLang = attribs.lang.trim().slice(0, 16);

    const style =
      attribs.style !== undefined ? parseInlineStyle(attribs.style) : new Map<string, string>();
    let ownHidden = attribs.hidden !== undefined || isHiddenStyle(style);
    if (!ownHidden && hiddenClasses.size > 0 && attribs.class) {
      for (const c of attribs.class.toLowerCase().split(/\s+/)) {
        if (hiddenClasses.has(c)) {
          ownHidden = true;
          break;
        }
      }
    }
    if (name === "input" && (attribs.type ?? "").toLowerCase() === "hidden") ownHidden = true;
    const hidden = ctx.hidden || ownHidden;
    const inHead = ctx.inHead || name === "head";
    const visible = !hidden && !inHead;

    // Microdata (itemscope / itemprop), recorded regardless of visibility.
    let scope = ctx.scope;
    const itemprop = attribs.itemprop?.trim().split(/\s+/)[0];
    if (attribs.itemscope !== undefined) {
      const type = schemaTypeOf(attribs.itemtype);
      if (itemprop && ctx.scope) {
        const prefix = `${ctx.scope.prefix}${itemprop}.`;
        if (
          ctx.scope.count.n < WALK_LIMITS.maxMicrodataFields &&
          !(`${prefix}@type` in ctx.scope.target)
        ) {
          ctx.scope.target[`${prefix}@type`] = type;
          ctx.scope.count.n++;
        }
        scope = { target: ctx.scope.target, prefix, count: ctx.scope.count };
      } else if (microdata.length < WALK_LIMITS.maxMicrodataItems) {
        const item: SchemaOrgItem = { type, fields: {} };
        microdata.push(item);
        scope = { target: item.fields, prefix: "", count: { n: 0 } };
      } else {
        scope = null;
      }
    } else if (itemprop && ctx.scope && ctx.scope.count.n < WALK_LIMITS.maxMicrodataFields) {
      const key = ctx.scope.prefix + itemprop;
      if (!(key in ctx.scope.target)) {
        ctx.scope.target[key] = microValue(el).trim().slice(0, 300);
        ctx.scope.count.n++;
      }
    }

    // Skeleton shingles.
    let skel = ctx.skel;
    let inTextBlock = ctx.inTextBlock;
    if (!inHead && !inTextBlock) {
      if (TEXT_BLOCK.has(name)) {
        skeleton.add(`${ctx.skel}>tb`);
        inTextBlock = true;
      } else if (STRUCTURAL.has(name)) {
        const token = skeletonToken(name, attribs);
        skeleton.add(`${ctx.skel}>${token}`);
        const path = ctx.skel ? ctx.skel.split(">") : [];
        path.push(token);
        skel = path.slice(-3).join(">");
      }
    }

    if (name === "br") {
      if (visible) boundary();
      continue;
    }

    if (name === "img") {
      const src = (attribs.src ?? "").trim();
      if (src) {
        const pixel = isTrackingPixel({
          src,
          width: attribs.width ?? null,
          height: attribs.height ?? null,
          style: attribs.style ?? null,
          alt: attribs.alt ?? null,
        });
        if (pixel) {
          pixelCount++;
          const reg = registrableDomain(hostOfUrl(src));
          if (reg && !pixelHosts.includes(reg) && pixelHosts.length < 10) pixelHosts.push(reg);
        } else if (visible) {
          imageCount++;
          if (active && active.imageAlt === null && isButtonImage(attribs)) {
            active.imageAlt = (attribs.alt ?? "").trim().slice(0, 100) || null;
          }
        }
      }
      continue;
    }

    const isBlock = visible && BLOCK.has(name);
    let isLink = false;
    if (name === "a" && visible && active === null) {
      const href = (attribs.href ?? "").trim();
      if (href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
        active = { href, text: "", before: tail.slice(-100), el, style, imageAlt: null };
        isLink = true;
      }
    }
    if (isBlock) boundary();
    if (isBlock || isLink) stack.push({ kind: "exit", el, block: isBlock, link: isLink });

    const childCtx: Ctx =
      hidden === ctx.hidden &&
      inHead === ctx.inHead &&
      skel === ctx.skel &&
      inTextBlock === ctx.inTextBlock &&
      scope === ctx.scope
        ? ctx
        : { hidden, inHead, skel, inTextBlock, scope };
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ kind: "enter", node: children[i] as DomNode, ctx: childCtx });
    }
  }

  return {
    text: parts.join(""),
    preheader,
    links,
    imageCount,
    pixelCount,
    pixelHosts,
    jsonLd,
    microdata,
    skeleton,
    htmlLang,
  };
}
