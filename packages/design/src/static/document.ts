/**
 * One parse of the raw HTML, then bounded passes that collect everything the static checks
 * need: style blocks (with Outlook visibility), Outlook conditional blocks, font links,
 * visible text with UTF-8 byte offsets, links, images and tables.
 */
import { ByteOffsetMapper } from "../util/bytes";
import { analyzeStack } from "../fonts/normalize";
import { analyzeStyles, type StyleAnalysis, type StyleBlock } from "./css";
import {
  attr,
  childrenOf,
  isComment,
  isElement,
  isText,
  parseStaticHtml,
  parsePx,
  tag,
  type P5Document,
  type P5Element,
  type P5Node,
  type P5Text,
  MAX_NODES,
} from "./dom";
import type { FontLinkFact } from "./fonts-static";
import { familyFromDecls } from "./fonts-static";

export interface VisibleText {
  /** The text node itself (link context reads the visible sentence around a link). */
  node: P5Text;
  text: string;
  /** UTF-8 byte offset of the text node in the raw HTML. */
  byteOffset: number;
  parent: P5Element | null;
  /** Inside `<code>`, `<pre>` or monospace text (merge tags are not flagged there). */
  code: boolean;
  /** Inherited `text-transform: uppercase`. */
  uppercase: boolean;
  /** Inside a heading element (h1–h6 or role=heading). */
  heading: boolean;
  /** Inside a link. */
  link: P5Element | null;
}

export interface LinkFact {
  el: P5Element;
  href: string | null;
  text: string;
  ariaLabel: string | null;
  title: string | null;
  imgAlts: string[];
  hasImage: boolean;
  byteOffset: number;
}

export interface ImageFact {
  /** The element; null for VML images found inside Outlook-only comments. */
  el: P5Element | null;
  kind: "img" | "area" | "input" | "vml";
  src: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  linked: boolean;
  hidden: boolean;
}

export interface StaticDocument {
  html: string;
  doc: P5Document;
  mapper: ByteOffsetMapper;
  styles: StyleAnalysis;
  styleBlocks: StyleBlock[];
  msoBlocks: string[];
  fontLinks: FontLinkFact[];
  htmlEl: P5Element | null;
  body: P5Element | null;
  title: string;
  hasViewport: boolean;
  texts: VisibleText[];
  links: LinkFact[];
  images: ImageFact[];
  tables: P5Element[];
  /** VML shapes found in Outlook-only blocks. */
  vml: {
    shapes: number;
    withoutAlt: number;
    roundrects: number;
    images: Array<{ alt: string | null }>;
  };
  /** An Outlook-only block contains a ghost table (fallback for fluid/flex layouts). */
  msoGhostTable: boolean;
  hasSvg: boolean;
  hasVideo: boolean;
  hasPicture: boolean;
  /** Elements inside `<!--[if !mso]><!-->` regions. */
  hiddenFromOutlook: WeakSet<P5Element>;
}

const NOT_MSO_START = /^\s*\[if\s+!mso\s*\]\s*>\s*<!\s*(?:--)?\s*$/i;
const ENDIF = /^\s*<!\s*\[endif\]\s*$/i;
const MSO_BLOCK = /^\s*\[if\s+([^\]]*)\]\s*>([\s\S]*)<!\[endif\]\s*$/i;

function styleText(el: P5Element): string {
  return childrenOf(el)
    .filter(isText)
    .map((t) => t.value)
    .join("");
}

const MONO = /mono|courier|consolas|menlo|monaco|lucida console/i;

function isMonospace(family: string | null): boolean {
  if (!family) return false;
  const primary = analyzeStack(family).primary;
  if (!primary) return false;
  return (
    primary.generic === "monospace" ||
    primary.generic === "ui-monospace" ||
    MONO.test(primary.display)
  );
}

/** Tags laid out inline by default: `max-height` does not apply to them (checked in Chromium). */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "font",
  "i",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
]);
const TABLE_TAGS = /^(?:table|caption|colgroup|col|thead|tbody|tfoot|tr|td|th)$/;

/**
 * `height`/`max-height` (and the widths) clip only block-level boxes: Chromium ignores them on
 * inline boxes and treats them as a minimum on table boxes (`<td style="max-height:0;
 * overflow:hidden">` still shows its text).
 */
function maxHeightApplies(el: P5Element, display: string): boolean {
  if (display) return !/^(?:inline|contents|(?:inline-)?table(?:-.*)?)$/.test(display);
  const t = tag(el);
  return !INLINE_TAGS.has(t) && !TABLE_TAGS.test(t);
}

/**
 * One side of the element's padding is zero (absent counts as zero). `side` 2 is the bottom,
 * 1 the right, as in the `padding` shorthand; a value it can't read (`var()`, `calc()`) counts as
 * non-zero, so the box is never hidden on a guess.
 */
function zeroPadding(decls: Map<string, string>, prop: string, side: 1 | 2): boolean {
  let v = decls.get(prop);
  if (v === undefined) {
    const parts = (decls.get("padding") ?? "").trim().split(/\s+/).filter(Boolean);
    v = parts[side] ?? parts[0] ?? "0";
  }
  return /^[+-]?0*\.?0+(?:[a-z]+|%)?$/i.test(v.trim());
}

/**
 * A block box clipped to nothing: `overflow` hidden, clip, auto or scroll with a zero height or
 * max-height (or width / max-width) and no padding on the far side to show its content in.
 * Overflow clips to the padding box, so `max-height:0;padding-bottom:20px` still shows its first
 * line (checked in Chromium); inline boxes and table boxes ignore these sizes.
 */
function clippedAway(el: P5Element, decls: Map<string, string>, display: string): boolean {
  const zero = (prop: string) => parsePx(decls.get(prop)) === 0;
  const short = (decls.get("overflow") ?? "").trim().toLowerCase().split(/\s+/);
  const ox = (decls.get("overflow-x") ?? short[0] ?? "").trim().toLowerCase();
  const oy = (decls.get("overflow-y") ?? short[1] ?? short[0] ?? "").trim().toLowerCase();
  // `auto`/`scroll` clip too, and one clipping axis turns the other's `visible` into `auto`.
  const scrolls = (v: string) => /^(?:hidden|auto|scroll|overlay)$/.test(v);
  const clipsX = ox === "clip" || scrolls(ox) || (!ox.startsWith("clip") && scrolls(oy));
  const clipsY = oy === "clip" || scrolls(oy) || (!oy.startsWith("clip") && scrolls(ox));
  if (!clipsY && !clipsX) return false;
  if (!maxHeightApplies(el, display)) return false;
  if (clipsY && (zero("height") || zero("max-height")) && zeroPadding(decls, "padding-bottom", 2))
    return true;
  return clipsX && (zero("width") || zero("max-width")) && zeroPadding(decls, "padding-right", 1);
}

/**
 * Subtree-hiding static rules: nothing inside can show itself again (`display:none`, the `hidden`
 * attribute unless an author `display` overrides it, `opacity:0`, a block clipped to a zero
 * height or width). `visibility` and `font-size:0` are inherited but a descendant can undo them, so
 * they are tracked separately (`staticVisibility`, `staticFontSize`).
 */
export function staticallyHidden(el: P5Element, decls: Map<string, string>): boolean {
  const display = (decls.get("display") ?? "").trim().toLowerCase();
  if (display === "none") return true;
  if (attr(el, "hidden") !== null && display === "") return true;
  const opacity = decls.get("opacity");
  if (opacity !== undefined && parseFloat(opacity) === 0) return true;
  return clippedAway(el, decls, display);
}

/**
 * The element's own `visibility`: true = hidden, false = visible again (a descendant of a hidden
 * element can set `visibility:visible`), null = inherited.
 */
export function staticVisibility(decls: Map<string, string>): boolean | null {
  const raw = decls.get("visibility");
  if (raw === undefined) return null;
  const vis = raw.trim().toLowerCase();
  if (vis === "hidden" || vis === "collapse") return true;
  if (vis === "visible") return false;
  return null;
}

/** Form controls get an absolute UA font size (13.33px), whatever their parent's is. */
const OWN_SIZE_TAGS = new Set(["button", "input", "select", "textarea"]);
const RELATIVE_UNIT = /^(?:em|%|ex|ch|cap|ic|lh)$/;
const INHERITING_SIZE = /^(?:inherit|unset|revert|revert-layer|smaller|larger)$/;
const SIZE_KEYWORD =
  /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/;
const MATH_FN = /^(?:calc|min|max|clamp)\(/;
const SYSTEM_FONT = /^(?:caption|icon|menu|message-box|small-caption|status-bar)$/;

/** One `font-size` value: a zero size, a real size (resets a zero parent), or relative/inherited. */
function sizeEffect(value: string): "zero" | "reset" | "inherit" {
  const v = value.trim().toLowerCase();
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(v);
  if (m) {
    const n = parseFloat(m[1]!);
    if (n === 0) return "zero";
    // Negative and unitless non-zero sizes are invalid in standards mode (the render adds a
    // doctype), so the parent's size stays; relative units scale a zero parent to zero.
    if (n < 0 || m[2] === "" || RELATIVE_UNIT.test(m[2]!)) return "inherit";
    return "reset";
  }
  if (INHERITING_SIZE.test(v)) return "inherit";
  if (MATH_FN.test(v)) {
    // calc()/min()/max()/clamp(): zero when every length in it is zero ("calc(0px)"), relative when
    // its only non-zero lengths are relative ("max(0px, 1em)"); unitless factors don't count.
    const lengths = [...v.matchAll(/(-?\d*\.?\d+)([a-z%]+)/g)];
    const live = lengths.filter((m) => parseFloat(m[1]!) !== 0);
    if (lengths.length > 0 && live.length === 0) return "zero";
    if (live.length > 0 && live.every((m) => RELATIVE_UNIT.test(m[2]!))) return "inherit";
  }
  // Absolute keywords, `initial`, var(), other math: a real size.
  return "reset";
}

/** The size part of a `font` shorthand ("bold 14px/1.4 Arial", "0/0 a"), or null. */
function shorthandSize(font: string): string | null {
  const v = font.trim().toLowerCase();
  if (SYSTEM_FONT.test(v)) return "medium";
  for (const token of v.split(/\s+/).slice(0, 6)) {
    const size = token.split("/")[0]!;
    // A unitless number is a weight (1–1000), except 0, which can only be the size.
    if (/^-?\d*\.?\d+[a-z%]+$/.test(size) || /^0*\.?0+$/.test(size) || SIZE_KEYWORD.test(size))
      return size;
    if (/^["']/.test(token)) break;
  }
  return null;
}

/**
 * The element's computed font size is zero, given whether its parent's is. `font-size:0` (the
 * MJML/Klaviyo `<td style="direction:ltr;font-size:0px">` section wrapper, there to remove
 * whitespace between inline-block columns) hides only text that inherits it: a descendant with its
 * own absolute size (`14px`, `1rem`, `small`, `<font size>`, a form control) shows again, while
 * relative sizes (`2em`, `120%`, `larger`, an `<h1>`) stay zero. Checked in Chromium.
 */
export function staticFontSize(
  el: P5Element,
  decls: Map<string, string>,
  parentZero: boolean,
): boolean {
  let value = decls.get("font-size");
  if (value === undefined) {
    const font = decls.get("font");
    if (font !== undefined) value = shorthandSize(font) ?? undefined;
  }
  if (value !== undefined && value.trim() !== "") {
    const effect = sizeEffect(value);
    if (effect === "zero") return true;
    if (effect === "reset") return false;
    return parentZero;
  }
  if (!parentZero) return false;
  const t = tag(el);
  if (OWN_SIZE_TAGS.has(t)) return false;
  if (t === "font" && (attr(el, "size") ?? "").trim() !== "") return false;
  return parentZero;
}

/**
 * Parse and collect (never throws on malformed HTML; parse5 is total). The input is bounded first
 * (`boundHtml`, via `parseStaticHtml`); `StaticDocument.html` is the bounded string every later pass
 * must use.
 */
export function buildStaticDocument(rawHtml: string): StaticDocument {
  const { html, doc } = parseStaticHtml(rawHtml);
  const mapper = new ByteOffsetMapper(html);

  // Pass 1: style blocks, Outlook conditionals, font links, head facts.
  const styleBlocks: StyleBlock[] = [];
  const msoBlocks: string[] = [];
  const fontLinks: FontLinkFact[] = [];
  const hiddenFromOutlook = new WeakSet<P5Element>();
  let htmlEl: P5Element | null = null;
  let body: P5Element | null = null;
  let title = "";
  let hasViewport = false;
  let notMso = false;
  let msoGhostTable = false;
  let hasSvg = false;
  let hasVideo = false;
  let hasPicture = false;
  const vml = {
    shapes: 0,
    withoutAlt: 0,
    roundrects: 0,
    images: [] as Array<{ alt: string | null }>,
  };

  const stack: P5Node[] = [doc];
  let visited = 0;
  while (stack.length > 0 && visited++ < MAX_NODES) {
    const node = stack.pop()!;
    if (isComment(node)) {
      const data = node.data;
      if (NOT_MSO_START.test(data)) notMso = true;
      else if (ENDIF.test(data)) notMso = false;
      else {
        const m = MSO_BLOCK.exec(data);
        if (m && /mso/i.test(m[1]!) && !/!\s*mso/i.test(m[1]!) && msoBlocks.length < 50) {
          const inner = m[2]!;
          msoBlocks.push(inner.length > 200_000 ? inner.slice(0, 200_000) : inner);
          if (/<table\b/i.test(inner)) msoGhostTable = true;
          scanVml(inner, vml);
        }
      }
      continue;
    }
    if (isElement(node)) {
      const t = tag(node);
      if (notMso) hiddenFromOutlook.add(node);
      if (t === "html" && !htmlEl) htmlEl = node;
      else if (t === "body" && !body) body = node;
      else if (t === "title" && !title) title = styleText(node).trim();
      else if (t === "meta" && (attr(node, "name") ?? "").toLowerCase() === "viewport")
        hasViewport = true;
      else if (t === "style") {
        styleBlocks.push({ css: styleText(node), hiddenFromOutlook: notMso });
      } else if (t === "link") {
        const href = attr(node, "href");
        const rel = (attr(node, "rel") ?? "").toLowerCase();
        if (href && (rel.includes("stylesheet") || /fonts\.|typekit|\.css(?:[?#]|$)/i.test(href))) {
          if (fontLinks.length < 20) fontLinks.push({ href, hiddenFromOutlook: notMso });
        }
      } else if (t === "svg") hasSvg = true;
      else if (t === "video") hasVideo = true;
      else if (t === "picture") hasPicture = true;
    }
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }

  const styles = analyzeStyles(styleBlocks);

  // Pass 2: visible text, links, images, tables (static cascade: simple rules + inline).
  const texts: VisibleText[] = [];
  const links: LinkFact[] = [];
  const images: ImageFact[] = [];
  const tables: P5Element[] = [];
  interface Frame {
    node: P5Node;
    /** Inside a subtree nothing can show again (`staticallyHidden`). */
    hidden: boolean;
    /** Inherited `visibility:hidden` (a descendant can set it back to visible). */
    invisible: boolean;
    /** Inherited computed font size of 0 (a descendant with its own size shows again). */
    fontZero: boolean;
    code: boolean;
    uppercase: boolean;
    heading: boolean;
    link: LinkFact | null;
  }
  const root = body ?? doc;
  const frames: Frame[] = [
    {
      node: root,
      hidden: false,
      invisible: false,
      fontZero: false,
      code: false,
      uppercase: false,
      heading: false,
      link: null,
    },
  ];
  // Links opened where the font size is zero: kept only if something inside them shows.
  const zeroFontLinks = new Set<LinkFact>();
  visited = 0;
  while (frames.length > 0 && visited++ < MAX_NODES) {
    const f = frames.pop()!;
    const node = f.node;
    if (isText(node)) {
      if (f.hidden || f.invisible || f.fontZero) continue;
      const loc = node.sourceCodeLocation;
      const parent =
        node.parentNode && isElement(node.parentNode as P5Node)
          ? (node.parentNode as P5Element)
          : null;
      const entry: VisibleText = {
        node,
        text: node.value,
        byteOffset: loc ? mapper.toBytes(loc.startOffset) : 0,
        parent,
        code: f.code,
        uppercase: f.uppercase,
        heading: f.heading,
        link: f.link?.el ?? null,
      };
      texts.push(entry);
      if (f.link) f.link.text += node.value;
      continue;
    }
    if (!isElement(node)) continue;
    const t = tag(node);
    if (
      t === "script" ||
      t === "style" ||
      t === "template" ||
      t === "head" ||
      t === "title" ||
      t === "noscript"
    )
      continue;
    const decls = styles.rules.styleOf(node);
    const hidden = f.hidden || staticallyHidden(node, decls);
    const invisible = staticVisibility(decls) ?? f.invisible;
    const fontZero = staticFontSize(node, decls, f.fontZero);
    const family = familyFromDecls(decls) ?? (t === "font" ? attr(node, "face") : null);
    const transform = (decls.get("text-transform") ?? "").trim().toLowerCase();
    const role = (attr(node, "role") ?? "").toLowerCase();
    const frame: Omit<Frame, "node"> = {
      hidden,
      invisible,
      fontZero,
      code:
        f.code ||
        t === "code" ||
        t === "pre" ||
        t === "kbd" ||
        t === "samp" ||
        (family !== null && isMonospace(family)),
      uppercase: transform ? transform === "uppercase" : f.uppercase,
      heading: f.heading || /^h[1-6]$/.test(t) || role === "heading",
      link: f.link,
    };
    if (t === "a" && !hidden && !invisible) {
      const lf: LinkFact = {
        el: node,
        href: attr(node, "href"),
        text: "",
        ariaLabel: attr(node, "aria-label"),
        title: attr(node, "title"),
        imgAlts: [],
        hasImage: false,
        byteOffset: node.sourceCodeLocation
          ? mapper.toBytes(node.sourceCodeLocation.startOffset)
          : 0,
      };
      if (links.length < 2000) {
        links.push(lf);
        if (fontZero) zeroFontLinks.add(lf);
      }
      frame.link = lf;
    }
    if (
      t === "img" ||
      t === "area" ||
      (t === "input" && (attr(node, "type") ?? "").toLowerCase() === "image")
    ) {
      const w = parsePx(attr(node, "width")) ?? parsePx(decls.get("width"));
      const h = parsePx(attr(node, "height")) ?? parsePx(decls.get("height"));
      // A zero font size never hides an image; visibility does.
      const imgHidden = hidden || invisible;
      const img: ImageFact = {
        el: node,
        kind: t === "img" ? "img" : t === "area" ? "area" : "input",
        src: attr(node, "src") ?? attr(node, "href"),
        alt: attr(node, "alt"),
        width: w,
        height: h,
        linked: f.link !== null || t === "area",
        hidden: imgHidden,
      };
      if (images.length < 1000) images.push(img);
      if (f.link && !imgHidden) {
        f.link.hasImage = true;
        if (img.alt) f.link.imgAlts.push(img.alt);
      }
    }
    if (t === "table" && tables.length < 2000) tables.push(node);
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i--) frames.push({ node: kids[i]!, ...frame });
  }
  // A zero-size link with no text or image of its own size is not on screen.
  const shownLinks =
    zeroFontLinks.size === 0
      ? links
      : links.filter((l) => !zeroFontLinks.has(l) || l.hasImage || l.text.trim() !== "");
  for (const v of vml.images) {
    images.push({
      el: null,
      kind: "vml",
      src: null,
      alt: v.alt,
      width: null,
      height: null,
      linked: false,
      hidden: false,
    });
  }

  return {
    html,
    doc,
    mapper,
    styles,
    styleBlocks,
    msoBlocks,
    fontLinks,
    htmlEl,
    body,
    title,
    hasViewport,
    texts,
    links: shownLinks,
    images,
    tables,
    vml,
    msoGhostTable,
    hasSvg,
    hasVideo,
    hasPicture,
    hiddenFromOutlook,
  };
}

const VML_TAG = /<v:(rect|roundrect|oval|shape|image)\b([^>]{0,2000})>/gi;
const VML_FILL_IMAGE = /<v:fill\b[^>]{0,2000}\bsrc\s*=/gi;
const VML_ALT = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * Count VML shapes and images in an Outlook-only block (A10 "VML without alt", A2 VML
 * images, X2 VML fallbacks). A `v:fill` with an image `src` makes its shape an image.
 */
function scanVml(inner: string, out: StaticDocument["vml"]): void {
  VML_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  let shapesWithAlt = 0;
  while ((m = VML_TAG.exec(inner)) !== null && guard++ < 500) {
    const name = m[1]!.toLowerCase();
    const alt = VML_ALT.exec(m[2]!);
    const altValue = alt ? (alt[1] ?? alt[2] ?? "") : null;
    out.shapes++;
    if (name === "roundrect") out.roundrects++;
    if (altValue !== null) shapesWithAlt++;
    if (name === "image") {
      if (out.images.length < 50) out.images.push({ alt: altValue });
      if (altValue === null) out.withoutAlt++;
    }
  }
  VML_FILL_IMAGE.lastIndex = 0;
  const fills = inner.match(VML_FILL_IMAGE)?.length ?? 0;
  if (fills > 0 && shapesWithAlt === 0) out.withoutAlt += fills;
}
