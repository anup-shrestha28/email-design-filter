/**
 * Visible content extent (render features `layout.content`): where, in the 800 px desktop pass,
 * everything a reader can see sits — the left and right edges and the bottom edge of
 *  - rendered text (the §2.1 "rendered" runs, preheader excluded, pictograph-only runs such as a
 *    lone emoji or © included) with at least one visible character and a font size a reader can
 *    see — horizontally as the line box it sets in (below), vertically as its glyphs;
 *  - images, except tracking pixels (the §2.1 pixel rule) — an image the render had no picture for
 *    as the box the viewer will give it (below);
 *  - painted boxes: a background image, a background colour that differs from what is behind it,
 *    or a border side whose colour shows — except boxes as wide as the page (≥ 98% of its width:
 *    page backgrounds and full-bleed wrappers), `<html>`, and `<body>` when its background moves
 *    to the canvas (the root has none of its own) — those paint the whole canvas;
 * each at least 4 px in both dimensions (images and boxes; an image the render had no picture for
 * needs only the width), not hidden (visibility, opacity), and cut to what its overflow-clipping
 * ancestors and the page let show (a hidden preheader in a zero-height box shows nothing).
 * Measured over the whole document, not only the first screen.
 *
 * The gallery crops its card preview to this span, so every design is whole and fills its card
 * evenly; the "main container" (L1) is a text-share heuristic and can miss the design's edges.
 * The card is not this document, though: it is the viewer (edf-view) showing the email in the
 * reader's own browser, so two things are measured the way the viewer will lay them out:
 *
 * TEXT is set in the reader's fonts, not the render's (web fonts load in neither; system fonts
 * differ), so a line can be wider there — and a template's measurement is reused for siblings whose
 * text differs. A run's horizontal extent is therefore its line box: the content box (padding
 * excluded) of the nearest block container whose width doesn't follow its text (`lineBox`). A
 * container that does follow its text — a shrink-wrapped button, an auto-width table, a float, or
 * nowrap text overflowing its box: its text fills it exactly on unwrapped lines — grows with the
 * text, so the walk goes on to the box it sits in. On a side where that line box reaches the page
 * edge (at it, or set in from it only by a page-wide wrapper's padding: a full-bleed wrapper, a
 * block running to the edge), it would say nothing about the design, so there the text's own extent
 * is used instead, widened by TEXT_GROWTH towards where its alignment lets it grow (left-aligned
 * text grows right, right-aligned left, centred both ways; justified text fills the line box), and
 * never past the line box.
 *
 * IMAGES the render had no picture for (not inlined — fetch failed, too large, timed out, over the
 * email's budget, blocked by the privacy policy — and without the declared-size placeholder an
 * image with both dimensions gets; or undecodable) lay out broken there — Chrome gives a broken
 * inline `<img alt="">` no box at all and one with alt text only the text's box, ignoring its
 * declared width — while the viewer gives it a picture (the image, or its grey placeholder
 * stretched to the declared size) or, with no src (policy, the card's image cap), an empty box of
 * the declared width. Such an image counts with the declared width (the `width` attribute or inline
 * style, % of its container; a non-inline box already has it), placed where its line puts it; with
 * no declared or laid-out width it counts for nothing (the viewer's placeholder would be 1×1).
 * Policy-blocked content images count too: their box takes the same room in every view (an empty
 * frame in a card, alt text in the detail view), the fetch log can't tell them from images the
 * render merely ran out of budget for (both are "blocked"), and counting a box can only widen the
 * crop, never cut anything off. Tracking pixels stay out.
 */
import { type Rgba, WHITE, composite, isTrackingPixel, parseColor } from "@edf/design/render-kit";
import { type Rect, type Snap, type StyleProp, px } from "../snapshot";
import { type Run, hasVisibleText } from "./runs";

export interface ContentExtent {
  /** Left edge of the visible content, CSS px (floored, ≥ 0). */
  left: number;
  /** Right edge, CSS px (ceiled, ≤ the document width). */
  right: number;
  /** Bottom edge, CSS px (ceiled, ≤ the document height). */
  bottom: number;
}

/** What `contentExtent` needs to know about an `<img>`. */
export interface ImageInfo {
  /** Its source (for the tracking-pixel rule), or null when unknown. */
  ref: string | null;
  /**
   * The render showed a picture for it (inlined and decoded, or the declared-size placeholder);
   * false → it laid out broken.
   */
  rendered: boolean;
}

/** Images and painted boxes smaller than this in either dimension don't count (spacers, pixels). */
export const MIN_BOX_PX = 4;
/** Painted boxes at least this share of the page width are page backgrounds / full-bleed wrappers. */
export const FULL_BLEED_SHARE = 0.98;
/** Text smaller than this paints nothing a reader can see (font-size:0 / 1px hiding tricks). */
export const MIN_TEXT_PX = 2;
/**
 * How much longer a line may set in the reader's fonts than in the render's, where only the text's
 * own extent bounds it (a line box reaching the page edge). Measured in Chrome at 16 px on English
 * lines: the Arial-metric faces the render uses (Liberation Sans / Arimo, Helvetica's Nimbus Sans)
 * against Noto Sans +5%, Adwaita Sans +7%, DejaVu Sans (Verdana-class widths) +13–14%, Noto Serif
 * against Tinos +7–17%; 15% covers the common substitutions, and costs at most 15% of the line.
 */
export const TEXT_GROWTH = 0.15;
/** Opaque colours closer than this (largest channel difference, 0–255) look the same. */
const SAME_COLOUR = 3;
/**
 * "Its content fills the box exactly" (CSS px): a shrink-to-fit box is as wide as its content to a
 * layout unit (1/64 px); a line that merely happens to end near its box's edge is rarely this close.
 */
const FILL_SLACK = 0.25;
/** Slack (CSS px) for comparing layout edges: flush with, centred in. */
const EDGE_SLACK = 1;
/** Line-box containers walked through (shrink-wrapped boxes nest a few levels at most). */
const MAX_WALK = 32;

type Clip = [number, number, number, number] | null;
type Span = [number, number];
type Align = "left" | "right" | "center" | "justify";

/** The four border sides, each with the strip of the box it paints (never wider than the box). */
const SIDES: ReadonlyArray<{
  width: StyleProp;
  color: StyleProp;
  strip: (r: Rect, w: number) => Rect;
}> = [
  {
    width: "border-top-width",
    color: "border-top-color",
    strip: (r, w) => ({ ...r, h: Math.min(w, r.h) }),
  },
  {
    width: "border-bottom-width",
    color: "border-bottom-color",
    strip: (r, w) => ({ ...r, y: r.y + r.h - Math.min(w, r.h), h: Math.min(w, r.h) }),
  },
  {
    width: "border-left-width",
    color: "border-left-color",
    strip: (r, w) => ({ ...r, w: Math.min(w, r.w) }),
  },
  {
    width: "border-right-width",
    color: "border-right-color",
    strip: (r, w) => ({ ...r, x: r.x + r.w - Math.min(w, r.w), w: Math.min(w, r.w) }),
  },
];

/** The part of `r` inside `clip` (and inside the page), or null when nothing of it shows. */
function visiblePart(r: Rect, clip: Clip, page: [number, number]): Rect | null {
  const x0 = Math.max(r.x, clip ? clip[0] : -Infinity, 0);
  const y0 = Math.max(r.y, clip ? clip[1] : -Infinity, 0);
  const x1 = Math.min(r.x + r.w, clip ? clip[2] : Infinity, page[0]);
  const y1 = Math.min(r.y + r.h, clip ? clip[3] : Infinity, page[1]);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function differs(a: Rgba, b: Rgba): boolean {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) >= SAME_COLOUR;
}

/** Horizontal content box of a laid-out element (border and padding excluded). */
function contentBox(s: Snap, li: number): Span {
  const r = s.rect(li);
  const x0 = r.x + px(s.style(li, "border-left-width")) + px(s.style(li, "padding-left"));
  const x1 = r.x + r.w - px(s.style(li, "border-right-width")) - px(s.style(li, "padding-right"));
  return [x0, Math.max(x0, x1)];
}

/** The line-box container of an element: its parent's nearest block container. */
function containerOf(s: Snap, node: number): number {
  const p = s.parent[node] ?? -1;
  return p >= 0 ? s.blockOf[p]! : -1;
}

/** The nearest ancestor element that has a layout box, or -1. */
function laidOutParent(s: Snap, node: number): number {
  let p = s.parent[node] ?? -1;
  for (let n = 0; p >= 0 && s.layoutOf[p]! < 0 && n < 5000; n++) p = s.parent[p] ?? -1;
  return p;
}

/**
 * Side `side` (0 left, 1 right) of element `c` reaches the page edge: it is at the edge (within the
 * full-bleed share), or flush with the content edge of an ancestor whose side does — the padding of
 * a page-wide wrapper, not a design column set in from the edge (a fixed width, a margin).
 */
function reachesPageEdge(s: Snap, c: number, side: 0 | 1, page: number, edge: number): boolean {
  let node = c;
  const r0 = s.rect(s.layoutOf[c]!);
  let x = side === 0 ? r0.x : r0.x + r0.w;
  for (let n = 0; n < 5000; n++) {
    if (side === 0 ? x <= edge : x >= page - edge) return true;
    const a = laidOutParent(s, node);
    if (a < 0) return false;
    const ali = s.layoutOf[a]!;
    if (Math.abs(x - contentBox(s, ali)[side]) > EDGE_SLACK) return false;
    const r = s.rect(ali);
    x = side === 0 ? r.x : r.x + r.w;
    node = a;
  }
  return false;
}

/** Computed `text-align` of a block container, resolved against its direction. */
function alignOf(s: Snap, li: number): Align {
  const rtl = s.style(li, "direction") === "rtl";
  switch (s.style(li, "text-align")) {
    case "center":
    case "-webkit-center":
      return "center";
    case "right":
    case "-webkit-right":
      return "right";
    case "left":
    case "-webkit-left":
      return "left";
    case "justify":
      return "justify";
    case "end":
      return rtl ? "left" : "right";
    default:
      return rtl ? "right" : "left";
  }
}

/**
 * Where a box that grows with its content sits in its container's content box: centred, flush
 * with one side, or overflowing (left-to-right overflow runs off the right, so it's anchored left).
 */
function placement(g: Span, box: Span, fallback: Align): Align {
  const gapL = g[0] - box[0];
  const gapR = box[1] - g[1];
  if (gapR < -EDGE_SLACK && gapL >= -EDGE_SLACK) return "left";
  if (gapL < -EDGE_SLACK && gapR >= -EDGE_SLACK) return "right";
  if (gapL > EDGE_SLACK && gapR > EDGE_SLACK && Math.abs(gapL - gapR) <= EDGE_SLACK)
    return "center";
  if (gapL <= EDGE_SLACK && gapR > EDGE_SLACK) return "left";
  if (gapR <= EDGE_SLACK && gapL > EDGE_SLACK) return "right";
  return fallback;
}

/**
 * The span `g` may take in line box `box` in the reader's fonts: the line box, except on a side
 * that is `free` (the line box reaches the page edge there), where `g` grows by TEXT_GROWTH away
 * from its alignment's anchor, up to the line box. The anchor is the line box's edge (or centre)
 * for text set directly in it (a line starts there, whatever runs it's made of), or `g`'s own for a
 * box that grows with its text (`ownAnchor`). Never less than `g` itself (overflowing text).
 */
function grow(
  g: Span,
  box: Span,
  align: Align,
  ownAnchor: boolean,
  freeL: boolean,
  freeR: boolean,
): Span {
  let lo = box[0];
  let hi = box[1];
  if (align !== "justify") {
    const k = 1 + TEXT_GROWTH;
    const a = ownAnchor ? g : box;
    const anchor = align === "left" ? a[0] : align === "right" ? a[1] : (a[0] + a[1]) / 2;
    const g0 = align === "left" ? g[0] : anchor - (anchor - g[0]) * k;
    const g1 = align === "right" ? g[1] : anchor + (g[1] - anchor) * k;
    if (freeL) lo = Math.max(box[0], g0);
    if (freeR) hi = Math.min(box[1], g1);
  }
  return [Math.min(g[0], lo), Math.max(g[1], hi)];
}

/** The last `prop` declaration of an inline style attribute, `!important` dropped. */
function styleValue(
  style: string | null,
  prop: "width" | "height" | "max-width" | "max-height",
): string | null {
  if (!style) return null;
  let out: string | null = null;
  for (const decl of style.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0 || decl.slice(0, colon).trim().toLowerCase() !== prop) continue;
    out = decl
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, "")
      .trim();
  }
  return out;
}

/** A width/height attribute or style value: px (a bare number is px) or a % (`pct`), or null. */
function lengthDecl(v: string | null): { n: number; pct: boolean } | null {
  const m = v ? /^\s*(\d+(?:\.\d+)?)\s*(px|%)?\s*$/i.exec(v) : null;
  return m ? { n: parseFloat(m[1]!), pct: m[2] === "%" } : null;
}

/** An element that sets its own width (inline style over the attribute), px or %. */
function declaresWidth(s: Snap, node: number): boolean {
  return lengthDecl(styleValue(s.attr(node, "style"), "width") ?? s.attr(node, "width")) !== null;
}

/** An `<img>`'s declared height in px (an inline style over the attribute), or null. */
function declaredHeight(s: Snap, node: number): number | null {
  const v = styleValue(s.attr(node, "style"), "height") ?? s.attr(node, "height");
  const d = lengthDecl(v);
  return d && !d.pct ? d.n : null;
}

/** An `<img>` hidden by a zero height: declared (`height="0"`, `height:0`) or `max-height:0`. */
function zeroHeight(s: Snap, node: number): boolean {
  const max = lengthDecl(styleValue(s.attr(node, "style"), "max-height"));
  return declaredHeight(s, node) === 0 || (max !== null && !max.pct && max.n === 0);
}

/**
 * Container `c` (layout `li`, content box `bw` wide) grows in the viewer with content wider than
 * it, whose narrowest layout is `min` wide: a table without a width of its own, or one its content
 * can't fit in (auto table layout widens any table for that), a cell of such a table, and any other
 * box that sets no width and isn't at its max-width — a shrink-to-fit box (inline-block, float) or
 * one that fills its parent (which then grows in turn).
 */
function canGrow(s: Snap, c: number, li: number, min: number, bw: number): boolean {
  const display = s.style(li, "display");
  let table = display === "table" || display === "inline-table" ? c : -1;
  if (display === "table-cell") {
    const t = containerOf(s, c);
    const tli = t >= 0 ? s.layoutOf[t]! : -1;
    if (tli >= 0 && s.style(tli, "display").endsWith("table")) table = t;
  }
  if (table >= 0) return !declaresWidth(s, table) || min > bw + EDGE_SLACK;
  const max = lengthDecl(styleValue(s.attr(c, "style"), "max-width"));
  return !declaresWidth(s, c) && !(max && !max.pct && s.rect(li).w >= max.n - EDGE_SLACK);
}

/**
 * The width a % on an `<img>` resolves against in the viewer: its container's content box — or,
 * when that is narrower than the image's px width `need` and grows with it, what its containers
 * grow to: the room the first one that doesn't grow gives (less what the grown ones take besides).
 */
function percentBase(s: Snap, node: number, need: number | null, pageW: number): number {
  let c = containerOf(s, node);
  let first = -1;
  let grown = -1;
  for (let n = 0; n < MAX_WALK; n++) {
    const li = c >= 0 ? s.layoutOf[c]! : -1;
    const box: Span = li >= 0 ? contentBox(s, li) : [0, pageW];
    const bw = box[1] - box[0];
    if (first < 0) first = bw;
    // Content that may get narrower (a % width or max-width) forces no table past its width.
    if (li < 0 || need === null || bw >= need - EDGE_SLACK || !canGrow(s, c, li, 0, bw))
      return grown < 0 ? bw : Math.max(0, first + bw - s.rect(s.layoutOf[grown]!).w);
    grown = c;
    c = containerOf(s, c);
  }
  return Math.max(0, first);
}

/**
 * The width an `<img>` the render had no picture for gets in the viewer: its declared width (inline
 * style over the attribute) capped by an inline max-width, a % of what its container gets there
 * (`percentBase`); `shrinks` when a % lets the viewer make it narrower. Null when it declares none.
 */
function failedImageWidth(
  s: Snap,
  node: number,
  pageW: number,
): { w: number; shrinks: boolean } | null {
  const style = s.attr(node, "style");
  const w = lengthDecl(styleValue(style, "width")) ?? lengthDecl(s.attr(node, "width"));
  if (!w) return null;
  const max = lengthDecl(styleValue(style, "max-width"));
  const px = w.pct ? null : max && !max.pct ? Math.min(w.n, max.n) : w.n;
  if (px !== null && !max?.pct) return { w: px, shrinks: false };
  const base = percentBase(s, node, px, pageW);
  const own = px ?? (w.n / 100) * base;
  return { w: max?.pct ? Math.min(own, (max.n / 100) * base) : own, shrinks: true };
}

/**
 * Something that lays out wider in the viewer than here: an `<img>` the render had no picture
 * for, or a container growing with one.
 */
interface Grower {
  node: number;
  /** Its horizontal and vertical span here. */
  x: Span;
  y: Span;
  /** Inline-level: it shares a line with what's beside it (a block-level one has its own). */
  inline: boolean;
  /** Its width in the viewer (at least its width here), and the narrowest the viewer can make it. */
  w: number;
  min: number;
  /**
   * The failed images in it, and the containers that grew with them (itself included): [node, x
   * offset from its left edge in the viewer].
   */
  imgs: Array<[number, number]>;
  /** What of it shows in the viewer (its images and what's beside them), from its left edge there. */
  c: Span;
}

/** Something else on a grower's line (text, an image, an atomic inline box): it moves with them. */
interface Beside {
  node: number;
  x: Span;
  y: Span;
  /** Document order (a text run's text node), to order it against a zero-width broken image. */
  order: number;
}

/** A line of a container's growers and what's beside them, spanning `l` here. */
interface GrowerLine {
  gs: Grower[];
  bs: Beside[];
  l: Span;
  /** Its width in the viewer, and the narrowest the viewer can make its growers. */
  w: number;
  min: number;
  /** What sits on it besides its growers (an unbreakable line doesn't wrap). */
  parts: number;
}

/** A placed line of failed images in the viewer (`x`, `y` as they lay out here), and its images. */
interface FailedLine {
  x: Span;
  y: Span;
  clip: Clip;
  imgs: number[];
}

/** How much wider a grower lays out in the viewer than here. */
const growth = (g: Grower) => Math.max(0, g.w - (g.x[1] - g.x[0]));
const byX = (a: Grower, b: Grower) => a.x[0] - b.x[0] || a.node - b.node;

/** Vertical spans overlap (a zero-height one — a broken image — may touch the other's edge). */
function overlapsV(a: Span, b: Span): boolean {
  return a[1] > a[0] && b[1] > b[0] ? a[0] < b[1] && b[0] < a[1] : a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Lays a line out from `v0` (where its left edge `l0` goes): its growers and what's beside them,
 * in order, each pushed along by the growth before it, then `fit` into the line box. Calls `at`
 * with each grower's left edge; returns the span of what shows (the growers' `c`, the rest whole).
 */
function layLine(
  gs: readonly Grower[],
  bs: readonly Beside[],
  l0: number,
  v0: number,
  at: (g: Grower, x: number) => void,
  fit: (x: number, w: number) => number = (x) => x,
): Span {
  const items = [
    ...gs.map((g) => ({ g, x: g.x, order: g.node })),
    ...bs.map((b) => ({ g: null, x: b.x, order: b.order })),
  ].sort((a, b) => a.x[0] - b.x[0] || a.order - b.order);
  const span: Span = [Infinity, -Infinity];
  let shift = 0;
  for (const { g, x: gx } of items) {
    const w = Math.max(g ? g.w : 0, gx[1] - gx[0]);
    const x = fit(v0 + (gx[0] - l0) + shift, w);
    const c: Span = g ? g.c : [0, w];
    span[0] = Math.min(span[0], x + c[0]);
    span[1] = Math.max(span[1], x + c[1]);
    if (!g) continue;
    at(g, x);
    shift += growth(g);
  }
  return span;
}

/** Atomic inline boxes: laid out whole on one line, wherever their content breaks. */
const ATOMIC_INLINE = new Set(["inline-block", "inline-table", "inline-flex", "inline-grid"]);

/**
 * Where the viewer puts each `<img>` the render had no picture for (see the module comment), with
 * the clip that applies to it there; images with no declared width, or none wider than their box
 * here, keep that box. Laid out bottom-up: each container gathers the growers on its lines — the
 * images, and child containers growing with them — and, when a line no longer fits and it can
 * grow, grows too (the widest line's growth) and passes up as a grower of its own container;
 * otherwise it places each line: widened by its growers' growth, anchored as the line sits here
 * (`placement`), start-aligned when it overflows (atomic boxes wrap onto further lines, inside the
 * box). A grown table widens by its widest row's growth (its cells side by side). What else sits
 * on those lines, or in a grown row's other cells (text, loaded images, buttons), moves along with
 * them: each placed line comes back as the span it takes in the viewer (`lines`), counted when one
 * of its images is. `boxes` also holds each grown container's box there (for what it paints).
 */
function failedImageBoxes(
  s: Snap,
  texts: ReadonlyArray<{ run: Run }>,
  image: (node: number) => ImageInfo,
  page: [number, number],
): { boxes: Map<number, { box: Rect; clip: Clip }>; lines: FailedLine[] } {
  const out = new Map<number, { box: Rect; clip: Clip }>();
  const placed: FailedLine[] = [];
  const own = new Map<number, Rect>();
  const pending = new Map<number, Grower[]>();
  const put = (c: number, g: Grower) => {
    const list = pending.get(c);
    if (list) list.push(g);
    else pending.set(c, [g]);
  };
  const clipOf = (node: number): Clip => {
    const p = s.parent[node] ?? -1;
    return p >= 0 ? s.clip[p]! : null;
  };

  for (let i = 0; i < s.count; i++) {
    if (s.names[i] !== "img" || !s.isElement(i)) continue;
    const li = s.layoutOf[i]!;
    if (li < 0 || image(i).rendered) continue;
    const rect = s.rect(li);
    const box = { ...rect, h: Math.max(rect.h, declaredHeight(s, i) ?? 0) };
    const display = s.style(li, "display");
    // A non-inline box already has its declared width (Chrome's broken inline box ignores it).
    const dw = display === "inline" || rect.w < MIN_BOX_PX ? failedImageWidth(s, i, page[0]) : null;
    if (!dw || dw.w <= rect.w) {
      if (rect.w >= MIN_BOX_PX) out.set(i, { box, clip: clipOf(i) });
      continue;
    }
    if (dw.w < MIN_BOX_PX) continue;
    own.set(i, { ...box, w: dw.w });
    put(containerOf(s, i), {
      node: i,
      x: [rect.x, rect.x + rect.w],
      y: [rect.y, rect.y + rect.h],
      inline: display.startsWith("inline"),
      w: dw.w,
      min: dw.shrinks ? 0 : dw.w,
      imgs: [[i, 0]],
      c: [0, dw.w],
    });
  }
  if (pending.size === 0) return { boxes: out, lines: placed };

  // What else sits on each container's lines: its text (line by line) and inline images and
  // atomic inline boxes a reader can see.
  const beside = new Map<number, Beside[]>();
  const addBeside = (c: number, node: number, r: Rect, order: number) => {
    if (c < 0 || r.w <= 0) return;
    const e = { node, x: [r.x, r.x + r.w] as Span, y: [r.y, r.y + r.h] as Span, order };
    const list = beside.get(c);
    if (list) list.push(e);
    else beside.set(c, [e]);
  };
  for (const { run } of texts)
    if (run.el >= 0) addBeside(s.blockOf[run.el]!, -1, run.rect, run.node);
  for (let i = 0; i < s.count; i++) {
    const li = s.layoutOf[i]!;
    if (li < 0 || !s.isElement(i)) continue;
    const d = s.style(li, "display");
    if (!ATOMIC_INLINE.has(d) && !(s.names[i] === "img" && d === "inline")) continue;
    if (s.style(li, "visibility") !== "visible" || s.cumOpacity[i]! <= 0.01) continue;
    addBeside(containerOf(s, i), i, s.rect(li), i);
  }

  // Deepest containers first (document order: a container precedes everything in it).
  for (let guard = 0; pending.size > 0 && guard < 100_000; guard++) {
    let c = -Infinity;
    for (const k of pending.keys()) if (k > c) c = k;
    const gs = pending.get(c)!;
    pending.delete(c);
    const li = c >= 0 ? s.layoutOf[c]! : -1;
    const display = li >= 0 ? s.style(li, "display") : "";
    const r = li >= 0 ? s.rect(li) : null;
    const box: Span = li >= 0 ? contentBox(s, li) : [0, page[0]];
    const bw = box[1] - box[0];

    if (r && (display === "table" || display === "inline-table")) {
      // Cells side by side grow their row; the table grows by its widest row's growth — a table
      // with a width of its own only by what its cells can't fit in it.
      const rows = new Map<number, Grower[]>();
      for (const g of gs) {
        const cell = s.style(s.layoutOf[g.node]!, "display") === "table-cell";
        const key = cell ? (s.parent[g.node] ?? -1) : -2 - g.node;
        const row = rows.get(key);
        if (row) row.push(g);
        else rows.set(key, [g]);
      }
      const fixed = declaresWidth(s, c);
      let grow = 0;
      for (const row of rows.values()) {
        const need = fixed
          ? row.reduce((a, g) => a + Math.max(g.w, g.x[1] - g.x[0]), 0) - bw
          : row.reduce((a, g) => a + growth(g), 0);
        grow = Math.max(grow, need);
      }
      // What the row's other cells hold (at any depth) moves along with the cells that grow.
      const others = new Map<number, Beside[]>();
      const growers = new Set(gs.map((g) => g.node));
      for (const [k, list] of beside) {
        let cell = k;
        for (let n = 0; cell >= 0 && n < MAX_WALK; n++) {
          const up = containerOf(s, cell);
          if (up === c) break;
          cell = up;
        }
        const row = cell >= 0 ? (s.parent[cell] ?? -1) : -1;
        if (cell < 0 || growers.has(cell) || !rows.has(row)) continue;
        const bs = others.get(row);
        if (bs) bs.push(...list);
        else others.set(row, [...list]);
      }
      const imgs: Array<[number, number]> = [];
      const shows: Span = [Infinity, -Infinity];
      for (const [key, row] of rows) {
        // Offsets from the table's left edge, each cell kept inside its grown content box.
        const [c0, c1] = layLine(
          row,
          others.get(key) ?? [],
          r.x,
          0,
          (g, dx) => {
            for (const [n, d] of g.imgs) imgs.push([n, dx + d]);
          },
          (x, w) => Math.max(box[0] - r.x, Math.min(x, box[1] - r.x + grow - w)),
        );
        shows[0] = Math.min(shows[0], c0);
        shows[1] = Math.max(shows[1], c1);
      }
      // Its own box grows too (a card's background or border paints around its images).
      own.set(c, { ...r, w: r.w + grow });
      imgs.push([c, 0]);
      put(containerOf(s, c), {
        node: c,
        x: [r.x, r.x + r.w],
        y: [r.y, r.y + r.h],
        inline: display === "inline-table",
        w: r.w + grow,
        min: Math.max(...gs.map((g) => g.min)) + r.w - bw,
        imgs,
        c: shows,
      });
      continue;
    }

    // Its lines: each block-level grower on its own, inline ones grouped by vertical overlap.
    const lines: GrowerLine[] = [];
    const addLine = (line: Grower[], y: Span | null) => {
      line.sort(byX);
      const l: Span = [Infinity, -Infinity];
      const bs: Beside[] = [];
      for (const g of line) {
        l[0] = Math.min(l[0], g.x[0]);
        l[1] = Math.max(l[1], g.x[1]);
      }
      if (y) {
        const mine = new Set(line.map((g) => g.node));
        for (const b of beside.get(c) ?? []) {
          if (mine.has(b.node) || !overlapsV(y, b.y)) continue;
          l[0] = Math.min(l[0], b.x[0]);
          l[1] = Math.max(l[1], b.x[1]);
          bs.push(b);
        }
      }
      const w = l[1] - l[0] + line.reduce((a, g) => a + growth(g), 0);
      const min = Math.max(...line.map((g) => g.min));
      lines.push({ gs: line, bs, l, w, min, parts: line.length + bs.length });
    };
    let cur: Grower[] | null = null;
    let cy: Span = [0, 0];
    for (const g of gs.filter((g) => g.inline).sort((a, b) => a.y[0] - b.y[0] || byX(a, b))) {
      if (cur && overlapsV(cy, g.y)) {
        cur.push(g);
        cy = [Math.min(cy[0], g.y[0]), Math.max(cy[1], g.y[1])];
        continue;
      }
      if (cur) addLine(cur, cy);
      cur = [g];
      cy = [g.y[0], g.y[1]];
    }
    if (cur) addLine(cur, cy);
    for (const g of gs) if (!g.inline) addLine([g], null);

    const widest = Math.max(...lines.map((l) => l.w));
    const align = li >= 0 ? alignOf(s, li) : "left";
    if (
      r &&
      widest > bw + EDGE_SLACK &&
      canGrow(s, c, li, Math.max(...lines.map((l) => l.min)), bw)
    ) {
      // It grows to its widest line, and passes up as a grower of its own container.
      const imgs: Array<[number, number]> = [];
      const shows: Span = [Infinity, -Infinity];
      for (const line of lines) {
        const a = placement(line.l, box, align);
        const v0 =
          box[0] -
          r.x +
          (a === "right" ? widest - line.w : a === "center" ? (widest - line.w) / 2 : 0);
        const [c0, c1] = layLine(line.gs, line.bs, line.l[0], v0, (g, x) => {
          for (const [n, d] of g.imgs) imgs.push([n, x + d]);
        });
        shows[0] = Math.min(shows[0], c0);
        shows[1] = Math.max(shows[1], c1);
      }
      own.set(c, { ...r, w: r.w + widest - bw });
      imgs.push([c, 0]);
      put(containerOf(s, c), {
        node: c,
        x: [r.x, r.x + r.w],
        y: [r.y, r.y + r.h],
        inline: display.startsWith("inline"),
        w: r.w + widest - bw,
        min: Math.max(...lines.map((l) => l.min)) + r.w - bw,
        imgs,
        c: shows,
      });
      continue;
    }

    // Placed here. Containers below grew with their images, so only the clips from here up apply
    // across; their vertical clips (a zero-height preheader box) still do.
    const across = c >= 0 ? s.clip[c]! : null;
    const clipFor = (v: Clip): Clip =>
      v || across
        ? [
            across ? across[0] : -Infinity,
            v ? v[1] : -Infinity,
            across ? across[2] : Infinity,
            v ? v[3] : Infinity,
          ]
        : null;
    for (const line of lines) {
      const a = placement(line.l, box, align);
      const fits = line.w <= bw + EDGE_SLACK;
      let v0 = a === "left" ? line.l[0] : box[0];
      if (fits) {
        if (a === "right") v0 = line.l[1] - line.w;
        else if (a === "center") v0 = (line.l[0] + line.l[1] - line.w) / 2;
        if (line.gs[0]!.inline) v0 = Math.max(box[0], Math.min(v0, box[1] - line.w));
      }
      // An overflowing line of several parts wraps: each part lands somewhere in the line box.
      const wraps = !fits && line.gs[0]!.inline && line.parts > 1;
      const fit = (x: number, w: number) =>
        wraps ? (w <= bw ? Math.max(box[0], Math.min(x, box[1] - w)) : box[0]) : x;
      const imgs: number[] = [];
      const y: Span = [Infinity, -Infinity];
      const x = layLine(
        line.gs,
        line.bs,
        line.l[0],
        v0,
        (g, gx) => {
          for (const [n, d] of g.imgs) {
            const b = own.get(n)!;
            out.set(n, { box: { ...b, x: gx + d }, clip: clipFor(clipOf(n)) });
            imgs.push(n);
            y[0] = Math.min(y[0], b.y);
            y[1] = Math.max(y[1], b.y + b.h);
          }
        },
        fit,
      );
      for (const b of line.bs) {
        y[0] = Math.min(y[0], b.y[0]);
        y[1] = Math.max(y[1], b.y[1]);
      }
      placed.push({ x, y, clip: clipFor(null), imgs });
    }
  }
  return { boxes: out, lines: placed };
}

/**
 * The visible content extent of a desktop snapshot, or null when nothing visible was found.
 * `liveRuns` are the pass's rendered runs (preheader excluded), including the pictograph-only
 * ones `buildRuns` sets aside; `image` tells, for an `<img>` node, its source (the tracking-pixel
 * rule) and whether the render had a picture for it.
 */
export function contentExtent(
  s: Snap,
  liveRuns: readonly Run[],
  image: (node: number) => ImageInfo,
): ContentExtent | null {
  const page: [number, number] = [Math.max(s.contentWidth, 1), Math.max(s.contentHeight, 1)];
  const edge = (1 - FULL_BLEED_SHARE) * page[0];
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const add = (r: Rect | null) => {
    if (!r) return;
    left = Math.min(left, r.x);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  };

  // ── Text: glyphs vertically, line boxes horizontally ──
  const texts: Array<{ run: Run; clip: Clip }> = [];
  // Each line-box container's own text (not its nested containers'): the span of its runs, and
  // of the inline-level boxes on their line (an inline's padding, an icon beside a label); the
  // vertical span of the runs; and the spread of their bottoms against the smallest run's height
  // (runs on one line share a baseline, so their bottoms differ by a descent at most; a second
  // line sits a line lower). An image on a line of its own sizes its box whatever the fonts.
  interface Line {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    b0: number;
    b1: number;
    h: number;
  }
  const direct = new Map<number, Line>();
  for (const r of liveRuns) {
    if (r.px < MIN_TEXT_PX || !hasVisibleText(r.text)) continue;
    const clip = r.el >= 0 ? s.clip[r.el]! : null;
    if (!visiblePart(r.rect, clip, page)) continue;
    texts.push({ run: r, clip });
    const c = r.el >= 0 ? s.blockOf[r.el]! : -1;
    if (c < 0) continue;
    const { x, y, w, h } = r.rect;
    const d = direct.get(c);
    if (!d) {
      direct.set(c, { x0: x, x1: x + w, y0: y, y1: y + h, b0: y + h, b1: y + h, h });
      continue;
    }
    d.x0 = Math.min(d.x0, x);
    d.x1 = Math.max(d.x1, x + w);
    d.y0 = Math.min(d.y0, y);
    d.y1 = Math.max(d.y1, y + h);
    d.b0 = Math.min(d.b0, y + h);
    d.b1 = Math.max(d.b1, y + h);
    d.h = Math.min(d.h, h);
  }
  for (let i = 0; i < s.count && direct.size > 0; i++) {
    const li = s.layoutOf[i]!;
    if (li < 0 || !s.isElement(i) || !s.style(li, "display").startsWith("inline")) continue;
    const d = direct.get(containerOf(s, i));
    const r = s.rect(li);
    if (!d || r.w <= 0 || r.y >= d.y1 || r.y + r.h <= d.y0) continue;
    d.x0 = Math.min(d.x0, r.x);
    d.x1 = Math.max(d.x1, r.x + r.w);
  }

  /**
   * The container follows its content's width (shrink-to-fit): `g` (what we came from) and its own
   * text, all on one line, fill its content box exactly, or it's an auto-width table reached from
   * such a cell. A container with a width of its own (fixed, or filling its parent) leaves room —
   * and text on several lines wrapped in it (one of them may end flush with its edge).
   */
  const followsContent = (c: number, li: number, g: Span, box: Span, fromChild: boolean) => {
    const display = s.style(li, "display");
    if (fromChild && (display === "table" || display === "inline-table"))
      return !declaresWidth(s, c);
    const d = direct.get(c);
    if (d && d.b1 - d.b0 > 0.5 * d.h) return false;
    const u0 = Math.min(g[0], d?.x0 ?? Infinity);
    const u1 = Math.max(g[1], d?.x1 ?? -Infinity);
    return u0 <= box[0] + FILL_SLACK && u1 >= box[1] - FILL_SLACK;
  };

  const reach = new Map<number, [boolean, boolean]>();
  const reachesEdges = (c: number): [boolean, boolean] => {
    let hit = reach.get(c);
    if (!hit) {
      hit = [reachesPageEdge(s, c, 0, page[0], edge), reachesPageEdge(s, c, 1, page[0], edge)];
      reach.set(c, hit);
    }
    return hit;
  };

  /** A run's horizontal extent in the reader's fonts (see the module comment). */
  const lineBox = (r: Run): Span => {
    let g: Span = [r.rect.x, r.rect.x + r.rect.w];
    let c = r.el >= 0 ? s.blockOf[r.el]! : -1;
    let fromChild = false;
    for (let n = 0; c >= 0 && n < MAX_WALK; n++) {
      const li = s.layoutOf[c]!;
      if (li < 0) break;
      const box = contentBox(s, li);
      if (followsContent(c, li, g, box, fromChild)) {
        const rect = s.rect(li);
        g = [Math.min(g[0], rect.x), Math.max(g[1], rect.x + rect.w)];
        c = containerOf(s, c);
        fromChild = true;
        continue;
      }
      const own = alignOf(s, li);
      const align = fromChild ? placement(g, box, own) : own;
      const [freeL, freeR] = reachesEdges(c);
      return grow(g, box, align, fromChild, freeL, freeR);
    }
    // Nothing narrower than the page holds it.
    const box: Span = [0, page[0]];
    return grow(g, box, placement(g, box, "left"), true, true, true);
  };

  for (const { run, clip } of texts) {
    const [x0, x1] = lineBox(run);
    add(visiblePart({ x: x0, y: run.rect.y, w: x1 - x0, h: run.rect.h }, clip, page));
  }

  // Images the render had no picture for, laid out as the viewer will (hidden ones too: their box
  // takes room there all the same), and the lines they move there; `shown`: those that count.
  const failed = failedImageBoxes(s, texts, image, page);
  const shown = new Set<number>();

  // `<body>`'s background paints the whole canvas only when the root has no background of its
  // own (CSS backgrounds §2.11.2); otherwise it paints just the body's box, like any other box.
  const root = s.names.findIndex((n, i) => n === "html" && s.isElement(i));
  const rootLi = root >= 0 ? s.layoutOf[root]! : -1;
  const rootImage = rootLi >= 0 ? s.style(rootLi, "background-image") : "";
  const bodyPaintsCanvas =
    rootLi < 0 ||
    ((parseColor(s.style(rootLi, "background-color"))?.a ?? 0) === 0 &&
      (rootImage === "" || rootImage === "none"));

  for (let i = 0; i < s.count; i++) {
    const li = s.layoutOf[i]!;
    if (li < 0 || !s.isElement(i)) continue;
    const tag = s.names[i];
    if (tag === "html" || (tag === "body" && bodyPaintsCanvas)) continue;
    const cum = s.cumOpacity[i]!;
    if (s.style(li, "visibility") !== "visible" || cum <= 0.01) continue;
    const p = s.parent[i]!;
    // A box that grows with a failed image paints where the viewer lays it out.
    const moved = tag === "img" ? undefined : failed.boxes.get(i);
    const rect = moved?.box ?? s.rect(li);
    // The element's own overflow clips its content, not its box: its ancestors' clip applies.
    const clip = moved ? moved.clip : p >= 0 ? s.clip[p]! : null;

    if (tag === "img") {
      const info = image(i);
      if (info.rendered) {
        const vis = visiblePart(rect, clip, page);
        if (!vis || vis.w < MIN_BOX_PX || vis.h < MIN_BOX_PX) continue;
        if (!isTrackingPixel({ src: info.ref, width: rect.w, height: rect.h, hidden: false }))
          add(vis);
        continue;
      }
      // No picture in the render: the box the viewer gives it, however flat it laid out here —
      // unless a zero height hides it there too.
      const f = failed.boxes.get(i);
      if (!f || zeroHeight(s, i)) continue;
      const box = f.box;
      const height = box.h >= 1 ? box.h : null;
      if (isTrackingPixel({ src: info.ref, width: box.w, height, hidden: false })) continue;
      // A flat box counts as its first rows (the viewer's is taller); a zero-height clip hides it.
      const vis = visiblePart({ ...box, h: Math.max(box.h, MIN_BOX_PX) }, f.clip, page);
      if (!vis || vis.w < MIN_BOX_PX || vis.h < MIN_BOX_PX) continue;
      add(vis);
      shown.add(i);
      continue;
    }

    if (rect.w <= 0 || rect.h <= 0) continue;
    const vis = visiblePart(rect, clip, page);
    if (!vis || vis.w < MIN_BOX_PX || vis.h < MIN_BOX_PX) continue;
    if (rect.w >= FULL_BLEED_SHARE * page[0]) continue;

    const behind = p >= 0 ? s.bg[p]! : WHITE;
    const overImage = p >= 0 && s.bgImage[p] === 1;
    const bgImage = s.style(li, "background-image");
    const bg = parseColor(s.style(li, "background-color"));
    const bgShows = !!bg && bg.a * cum > 0.01 && (overImage || differs(s.bg[i]!, behind));
    if ((bgImage !== "" && bgImage !== "none") || bgShows) {
      add(vis);
      continue;
    }
    // A box drawn only by its borders: each side whose colour shows against the box (over a
    // background image any colour shows). A computed width is 0 when the side's style is none.
    const own = s.bg[i]!;
    for (const side of SIDES) {
      const w = px(s.style(li, side.width));
      if (w < 1) continue;
      const c = parseColor(s.style(li, side.color));
      if (!c || c.a * cum <= 0.01) continue;
      if (!overImage && !differs(composite({ ...c, a: c.a * cum }, own), own)) continue;
      add(visiblePart(side.strip(rect, w), clip, page));
    }
  }

  // What shares a line with a failed image that shows moves with it (text, loaded images, buttons).
  for (const { x, y, clip, imgs } of failed.lines) {
    if (!imgs.some((n) => shown.has(n))) continue;
    add(
      visiblePart(
        { x: x[0], y: y[0], w: x[1] - x[0], h: Math.max(y[1] - y[0], MIN_BOX_PX) },
        clip,
        page,
      ),
    );
  }

  if (left === Infinity) return null;
  const out = {
    left: Math.max(0, Math.floor(left)),
    right: Math.min(Math.ceil(page[0]), Math.ceil(right)),
    bottom: Math.min(1_000_000, Math.ceil(page[1]), Math.ceil(bottom)),
  };
  return out.right > out.left && out.bottom > 0 ? out : null;
}
