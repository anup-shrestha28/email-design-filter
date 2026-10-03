/**
 * Structural analysis shared by the feature assembly (DESIGN-SCORE §2.1): preheader, main
 * container, links (standalone vs inline), navigation rows and CTA candidates with the primary
 * CTA and its prominence. The footer region is in footer.ts.
 */
import {
  NAV_SEPARATORS,
  PREFERENCES_TEXT,
  VIEWPORT_V,
  VIEW_ONLINE_TEXT,
  BUTTON_IMAGE_HINT,
  type Rgba,
  brandOf,
  collapseWhitespace,
  colorDeltaE2000,
  contrastFromLum,
  contrastRatio,
  countedChars,
  decodedTarget,
  isLargeText,
  isOtherBrandLink,
  isUnsubscribeLink,
  luminance,
  normalizeLabel,
  parseColor,
  weightedQuantile,
  words,
} from "@edf/design/render-kit";
import { type Rect, type Snap, intersectArea, px } from "../snapshot";
import { type Run, isRendered } from "./runs";

/** Parent-before-child forward pass: nearest ancestor-or-self with a tag, per node. */
export function nearestTagIndex(s: Snap, tag: string): Int32Array {
  const out = new Int32Array(s.count).fill(-1);
  for (let i = 0; i < s.count; i++) {
    const p = s.parent[i]!;
    out[i] = s.names[i] === tag ? i : p >= 0 && p < i ? out[p]! : -1;
  }
  return out;
}

/**
 * Hidden preheader (§2.1): hidden text before the first visible content (rendered text or a
 * visible image), limited to the block of the first hidden run.
 */
export function findPreheader(s: Snap, runs: readonly Run[]): Set<number> {
  let firstVisible = Infinity;
  for (const r of runs) if (isRendered(r) && r.node < firstVisible) firstVisible = r.node;
  for (let i = 0; i < s.count && i < firstVisible; i++) {
    if (s.names[i] !== "img") continue;
    const rect = s.nodeRect(i);
    if (rect && rect.w * rect.h > 25 && s.cumOpacity[i]! > 0.01) {
      firstVisible = i;
      break;
    }
  }
  const hidden = runs
    .filter((r) => !isRendered(r) && r.node < firstVisible)
    .sort((a, b) => a.node - b.node);
  if (hidden.length === 0) return new Set();
  const block = s.blockOf[hidden[0]!.node]!;
  return new Set(hidden.filter((r) => s.blockOf[r.node] === block || block < 0).map((r) => r.node));
}

/** Lowest common ancestor holding ≥ 80% of the given characters (walks down from `<body>`). */
export function mainContainer(s: Snap, runs: readonly Run[]): number {
  const chars = new Float64Array(s.count);
  let total = 0;
  for (const r of runs) {
    total += r.chars;
    for (const a of s.ancestors(r.node)) chars[a]! += r.chars;
  }
  let cur = s.names.indexOf("body");
  if (cur < 0 || total === 0) return cur;
  for (let depth = 0; depth < 200; depth++) {
    let best = -1;
    let bestChars = 0;
    for (const c of s.children[cur] ?? []) {
      if (chars[c]! > bestChars) {
        best = c;
        bestChars = chars[c]!;
      }
    }
    if (best < 0 || bestChars < 0.8 * total) break;
    cur = best;
  }
  return cur;
}

/** Text the L1 column is measured from; below it the container box is kept. */
const TEXT_COLUMN_MIN_CHARS = 100;
/** A container at least this share of the page width is full-bleed (a background row). */
const FULL_BLEED_SHARE = 0.95;

/**
 * The main text column (L1, DESIGN-SCORE §2.1 "Main container"). The container (the LCA of the
 * text) is kept unless it is full-bleed (≥ 95% of the page width): then each run's column is its
 * widest ancestor box inside the container that is narrower than 95% of it, and the column is the
 * character-weighted median of those (width, and left edge). An email built as full-width
 * background rows, each with its own 560px text table, used to be measured as an 800px column;
 * text that really runs the page's width (no narrower box around it) still measures the page.
 * Null without a container; the container box with fewer than 100 characters (an image-only
 * email has no text column to speak of).
 */
export function textColumn(s: Snap, runs: readonly Run[], container: number): Rect | null {
  const box = container >= 0 ? s.unionRect(container) : null;
  if (!box) return null;
  const chars = runs.reduce((n, r) => n + r.chars, 0);
  if (chars < TEXT_COLUMN_MIN_CHARS || box.w < FULL_BLEED_SHARE * s.contentWidth) return box;
  const limit = FULL_BLEED_SHARE * box.w;
  const widths: Array<[number, number]> = [];
  const lefts: Array<[number, number]> = [];
  for (const r of runs) {
    let col: Rect | null = null;
    for (const a of s.ancestors(r.node)) {
      if (a === container) break;
      const rect = s.nodeRect(a);
      if (rect && rect.w > 0 && rect.w < limit && (!col || rect.w >= col.w)) col = rect;
    }
    widths.push([col ? col.w : box.w, r.chars]);
    lefts.push([col ? col.x : box.x, r.chars]);
  }
  const w = weightedQuantile(widths, 0.5) ?? box.w;
  if (w >= limit) return box;
  const x = Math.max(box.x, weightedQuantile(lefts, 0.5) ?? box.x);
  return { x, y: box.y, w: Math.min(w, box.x + box.w - x), h: box.h };
}

export interface LinkInfo {
  node: number;
  href: string;
  /** Visible label (collapsed text, else image alt). */
  label: string;
  runs: Run[];
  imgs: number[];
  target: Rect | null;
  standalone: boolean;
  unsubscribe: boolean;
  preferences: boolean;
  excluded: boolean;
}

function blockTextOutside(
  s: Snap,
  runs: readonly Run[],
  block: number,
  link: number,
  linkOf: Int32Array,
): number {
  let n = 0;
  for (const r of runs) {
    if (linkOf[r.node] === link || !isRendered(r)) continue;
    if (block >= 0 && s.blockOf[r.node] !== block && !s.isAncestor(block, r.node)) continue;
    const t = r.text.replace(/[|•·–—\-/\s\u{00A0}]+/gu, "");
    n += countedChars(t);
    if (n >= 3) break;
  }
  return n;
}

/**
 * Links of a pass (M for placement, D for colours), standalone vs inline per §2.1. `senderDomain`
 * keeps the sender's own social-network and store links (LinkedIn → linkedin.com) as content
 * links; other brands' social icons and store badges are excluded (`isOtherBrandLink`, shared
 * with the static pass).
 */
export function collectLinks(
  s: Snap,
  runs: readonly Run[],
  listUnsub: string[],
  senderDomain: string | null = null,
): { links: LinkInfo[]; linkOf: Int32Array } {
  const senderBrand = brandOf(senderDomain);
  const linkOf = nearestTagIndex(s, "a");
  const byLink = new Map<number, Run[]>();
  for (const r of runs) {
    const l = linkOf[r.node]!;
    if (l < 0) continue;
    const list = byLink.get(l) ?? [];
    list.push(r);
    byLink.set(l, list);
  }
  const imgsOf = new Map<number, number[]>();
  for (let i = 0; i < s.count; i++) {
    if (s.names[i] !== "img" || linkOf[i]! < 0) continue;
    const list = imgsOf.get(linkOf[i]!) ?? [];
    list.push(i);
    imgsOf.set(linkOf[i]!, list);
  }
  const byBlock = new Map<number, Run[]>();
  for (const r of runs) {
    const b = s.blockOf[r.node]!;
    const list = byBlock.get(b) ?? [];
    list.push(r);
    byBlock.set(b, list);
  }
  const links: LinkInfo[] = [];
  for (let i = 0; i < s.count && links.length < 2000; i++) {
    if (s.names[i] !== "a") continue;
    const href = s.attr(i, "href");
    if (href === null) continue;
    const lruns = (byLink.get(i) ?? []).filter(isRendered);
    const imgs = (imgsOf.get(i) ?? []).filter((n) => {
      const r = s.nodeRect(n);
      return !!r && r.w * r.h > 25;
    });
    if (lruns.length === 0 && imgs.length === 0) continue;
    const text = collapseWhitespace(lruns.map((r) => r.text).join(" "));
    const alt = collapseWhitespace(imgs.map((n) => s.attr(n, "alt") ?? "").join(" "));
    const label = (s.attr(i, "aria-label") && !text ? s.attr(i, "aria-label")! : text || alt).slice(
      0,
      200,
    );
    const parent = s.parent[i]!;
    const block = parent >= 0 ? s.blockOf[parent]! : -1;
    const blockRuns = byBlock.get(block) ?? [];
    const standalone = blockTextOutside(s, blockRuns, block, i, linkOf) < 3;
    const u = isUnsubscribeLink(label, href, listUnsub);
    const pref = PREFERENCES_TEXT.test(label);
    const excluded =
      u.match ||
      pref ||
      VIEW_ONLINE_TEXT.test(label) ||
      isOtherBrandLink(href, label, lruns.length === 0, senderBrand) ||
      /^(?:tel|sms):/i.test(href);
    links.push({
      node: i,
      href,
      label,
      runs: lruns,
      imgs,
      target: s.unionRect(i),
      standalone,
      unsubscribe: u.match,
      preferences: pref,
      excluded,
    });
  }
  return { links, linkOf };
}

/** Navigation rows (§2.1): ≥ 3 links of ≤ 3 words on one line in the top 200px at 375. */
export function navigationNodes(
  s: Snap,
  runs: readonly Run[],
  links: readonly LinkInfo[],
  linkOf: Int32Array,
  lang: string | null,
): Set<number> {
  const top = links.filter(
    (l) => l.target && l.target.y < 200 && l.label && words(l.label, lang).length <= 3,
  );
  const sorted = [...top].sort(
    (a, b) => a.target!.y + a.target!.h / 2 - (b.target!.y + b.target!.h / 2),
  );
  const nav = new Set<number>();
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i]!;
    const cy = first.target!.y + first.target!.h / 2;
    const tol = Math.max(4, first.target!.h / 2);
    const line = sorted.filter((l) => Math.abs(l.target!.y + l.target!.h / 2 - cy) <= tol);
    i += Math.max(1, line.length);
    if (line.length < 3) continue;
    const members = new Set(line.map((l) => l.node));
    const lineTop = Math.min(...line.map((l) => l.target!.y));
    const lineBottom = Math.max(...line.map((l) => l.target!.y + l.target!.h));
    const other = runs.filter(
      (r) =>
        isRendered(r) &&
        !members.has(linkOf[r.node]!) &&
        r.rect.y < lineBottom &&
        r.rect.y + r.rect.h > lineTop,
    );
    if (other.every((r) => NAV_SEPARATORS.test(r.text))) {
      for (const r of runs) if (members.has(linkOf[r.node]!)) nav.add(r.node);
      for (const r of other) nav.add(r.node);
      for (const l of line) nav.add(l.node);
    }
  }
  return nav;
}

export interface CtaInfo {
  link: LinkInfo;
  label: string;
  normLabel: string;
  wordsN: number;
  live: boolean;
  visual: Rect;
  target: Rect;
  fill: Rgba | null;
  container: Rgba;
  buttonLike: boolean;
  labelContrast: number | null;
  labelLarge: boolean;
  labelPx: number;
  radius: number;
  prominence: number;
  hero: boolean;
  /**
   * The visible button is a painted box around the link (a filled cell or wrapper) and the link
   * itself covers under half of it: only the label text is tappable.
   */
  textOnlyTap: boolean;
  /** Button-like by its border alone (an outline button: the conventional secondary style). */
  outline: boolean;
}

/** An outer button box may be at most this much taller than the link inside it (CSS px). */
const BUTTON_BOX_MAX_PAD = 64;
/** …and never taller than this (a filled section holding one link is not a button). */
const BUTTON_BOX_MAX_H = 120;
/** A painted link's label of up to this many words is a button label (§2.1 "Primary CTA")… */
const BUTTON_WORDS_MAX = 7;
/** …a longer one only on a filled box holding nothing else, with at most this many characters. */
const BUTTON_LABEL_MAX_CHARS = 80;
/** Rendered characters tolerated in a button box outside its link (a "›" arrow, a stray "|"). */
const BUTTON_BOX_OUTSIDE_CHARS = 2;
/** The link covers less than this share of a painted box around it → only its text is tappable. */
const TEXT_ONLY_TAP_SHARE = 0.5;
/** A filled button this close to an outline one (CSS px at 375, centre to centre) pairs with it. */
const OUTLINE_PAIR_PX = 300;
/** Prominence factor of an outline-only button (a filled one gets 2, a plain link 1). */
const OUTLINE_PROMINENCE = 1.25;

/** Rendered characters, visible links and visible images per subtree (button-box search). */
interface SubtreeCounts {
  chars: Float64Array;
  links: Int32Array;
  imgs: Int32Array;
}

function subtreeCounts(s: Snap, runs: readonly Run[], links: readonly LinkInfo[]): SubtreeCounts {
  const chars = new Float64Array(s.count);
  const nLinks = new Int32Array(s.count);
  const imgs = new Int32Array(s.count);
  for (const r of runs) {
    if (!isRendered(r)) continue;
    chars[r.node]! += r.chars;
    for (const a of s.ancestors(r.node)) chars[a]! += r.chars;
  }
  for (const l of links) {
    nLinks[l.node]!++;
    for (const a of s.ancestors(l.node)) nLinks[a]!++;
  }
  for (let i = 0; i < s.count; i++) {
    if (s.names[i] !== "img") continue;
    const r = s.nodeRect(i);
    if (!r || r.w * r.h <= 100 || s.cumOpacity[i]! <= 0.01) continue;
    imgs[i]!++;
    for (const a of s.ancestors(i)) imgs[a]!++;
  }
  return { chars, links: nLinks, imgs };
}

/**
 * Boxes that may paint a live-text link's button, nearest first (DESIGN-SCORE §2.1 "Visual box"):
 * inside the link, the chain of wrappers holding all of its text (a pill `<span>` or `<div>`
 * carrying the fill, as Google's and many ESP templates do); outside it, the ancestors holding
 * nothing else that's visible (no other text, link or image) and no taller than the link plus
 * 64px (≤ 120px) — a `<td bgcolor>` cell, possibly through `<p>`/`<div>`/`<font>` wrappers.
 */
function buttonBoxes(
  s: Snap,
  l: LinkInfo,
  counts: SubtreeCounts,
): { inner: number[]; outer: number[] } {
  const inner: number[] = [];
  const total = counts.chars[l.node]!;
  let cur = l.node;
  for (let depth = 0; depth < 4 && total > 0; depth++) {
    const kids = (s.children[cur] ?? []).filter((c) => counts.chars[c]! > 0);
    const only = kids.length === 1 ? kids[0]! : -1;
    if (only < 0 || !s.isElement(only) || counts.chars[only]! < total) break;
    inner.push(only);
    cur = only;
  }
  const outer: number[] = [];
  const maxH = Math.min(BUTTON_BOX_MAX_H, l.target!.h + BUTTON_BOX_MAX_PAD);
  cur = l.node;
  for (let depth = 0; depth < 6; depth++) {
    const p = s.parent[cur]!;
    if (p < 0 || s.names[p] === "body" || s.names[p] === "html") break;
    if (
      counts.chars[p]! - total > BUTTON_BOX_OUTSIDE_CHARS ||
      counts.links[p]! > 1 ||
      counts.imgs[p]! > counts.imgs[l.node]!
    )
      break;
    const r = s.nodeRect(p);
    if (r && r.h > maxH) break;
    if (r && r.w > 0 && r.h > 0) outer.push(p);
    cur = p;
  }
  return { inner, outer };
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Box of the outermost `<a href>` enclosing `node` (a link nested in a link), or null. */
function outerLinkBox(s: Snap, node: number): Rect | null {
  let out: Rect | null = null;
  for (const a of s.ancestors(node)) {
    if (a === node || s.names[a] !== "a" || s.attr(a, "href") === null) continue;
    const r = s.unionRect(a);
    if (r && r.w > 0 && r.h > 0) out = r;
  }
  return out;
}

/**
 * CTA candidates at 375 (§2.1 "Primary CTA"): visible links outside the footer, excluding
 * unsubscribe, preferences, view-in-browser, social and navigation-row links. `runs` (every run
 * of the pass) enables the button-box search around and inside standalone text links
 * (`buttonBoxes`); without it only the link and its sole-child parent cell are looked at.
 */
export function ctaCandidates(
  s: Snap,
  links: readonly LinkInfo[],
  opts: {
    footerStart: number;
    nav: Set<number>;
    k: number;
    containerWidth: number;
    lang: string | null;
    runs?: readonly Run[];
  },
): CtaInfo[] {
  const out: CtaInfo[] = [];
  const WHITE_BG: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const hasOwnBg = (node: number) => {
    const li = s.layoutOf[node]!;
    const c = li >= 0 ? parseColor(s.style(li, "background-color")) : null;
    return !!c && c.a > 0.05;
  };
  const soleChild = (p: number, child: number) => {
    const kids = (s.children[p] ?? []).filter((c) => s.isElement(c));
    return kids.length === 1 && kids[0] === child;
  };
  // The visual box grows from the fill through sole-child wrappers painted with the same fill.
  const grow = (node: number, fill: Rgba) => {
    let v = node;
    for (let guard = 0; guard < 6; guard++) {
      const p = s.parent[v]!;
      if (p < 0 || s.names[p] === "body" || s.names[p] === "html" || !soleChild(p, v)) break;
      if (colorDeltaE2000(s.bg[p]!, fill) >= 1) break;
      v = p;
    }
    return v;
  };
  const around = (node: number): Rgba => {
    const p = s.parent[node]!;
    return p >= 0 ? s.bg[p]! : WHITE_BG;
  };
  const contrastingBorder = (node: number, container: Rgba) => {
    const li = s.layoutOf[node]!;
    if (li < 0) return false;
    const w = Math.max(px(s.style(li, "border-top-width")), px(s.style(li, "border-bottom-width")));
    const style = s.style(li, "border-top-style");
    const color = parseColor(s.style(li, "border-top-color"));
    return (
      w >= 1 &&
      style !== "none" &&
      style !== "hidden" &&
      !!color &&
      color.a > 0.3 &&
      colorDeltaE2000(color, container) >= 15
    );
  };
  let counts: SubtreeCounts | null = null;
  for (const l of links) {
    if (l.excluded || !l.target || l.target.w <= 0 || l.target.h <= 0) continue;
    if (opts.footerStart >= 0 && l.node >= opts.footerStart) continue;
    if (opts.nav.has(l.node)) continue;
    const text = collapseWhitespace(l.runs.map((r) => r.text).join(" "));
    const live = text.length > 0;
    // Boxes that may paint the button, nearest first: the link, then (standalone text links, with
    // the runs) the wrappers inside it and the cells around it (`buttonBoxes`); otherwise its
    // sole-child parent cell (bulletproof buttons). The fill is the first box whose background
    // stands out from what surrounds its grown visual box (ΔE2000 ≥ 15); failing that, the first
    // box with any background (so a white cell still reports its fill), and failing a fill, the
    // first box with a contrasting border (outline buttons).
    const parent = s.parent[l.node]!;
    // A text link inside copy (not standalone) is painted by its own box only: a coloured card
    // holding a sentence and a link is not a button.
    let boxes: number[] = [l.node];
    if (live && l.standalone && opts.runs) {
      counts ??= subtreeCounts(s, opts.runs, links);
      const b = buttonBoxes(s, l, counts);
      boxes = [l.node, ...b.inner, ...b.outer];
    } else if ((!live || l.standalone) && parent >= 0 && soleChild(parent, l.node))
      boxes = [l.node, parent];
    let fillNode = -1;
    let fallback = -1;
    for (const n of boxes) {
      if (!hasOwnBg(n)) continue;
      if (colorDeltaE2000(s.bg[n]!, around(grow(n, s.bg[n]!))) >= 15) {
        fillNode = n;
        break;
      }
      if (fallback < 0) fallback = n;
    }
    let visualNode = l.node;
    let fill: Rgba | null = null;
    let container: Rgba = parent >= 0 ? s.bg[parent]! : WHITE_BG;
    let bordered = false;
    if (fillNode >= 0 || fallback >= 0) {
      fill = s.bg[fillNode >= 0 ? fillNode : fallback]!;
      visualNode = grow(fillNode >= 0 ? fillNode : fallback, fill);
      container = around(visualNode);
      bordered = contrastingBorder(visualNode, container);
    }
    if (fillNode < 0 && !bordered) {
      const b = boxes.find((n) => contrastingBorder(n, around(n)));
      if (b !== undefined) {
        bordered = true;
        fill = null;
        visualNode = b;
        container = around(b);
      }
    }
    const visual = (visualNode === l.node ? l.target : s.unionRect(visualNode)) ?? l.target;
    const vli = s.layoutOf[visualNode]!;
    const filled = fill !== null && colorDeltaE2000(fill, container) >= 15;
    const label = (live ? text : l.label).slice(0, 60);
    const wordsN = words(label, opts.lang).length;
    // A label of up to 7 words is a button label whenever its box is painted (filled or
    // outlined). A longer one ("Contact us to get started with AI governance", upGrad's "How is
    // India actually learning AI? Fill out form") is a button only on stronger evidence of the
    // box, never by its length alone (render-2026.5): a standalone link whose filled box holds
    // nothing else — the link's own fill, a pill inside it or a cell around it (`buttonBoxes`) —
    // at most a button's height and a short caption's length. A sentence link in copy, a
    // paragraph link or a filled card stays a link.
    const longLabel =
      wordsN > BUTTON_WORDS_MAX &&
      live &&
      l.standalone &&
      filled &&
      visual.h <= BUTTON_BOX_MAX_H &&
      countedChars(text) <= BUTTON_LABEL_MAX_CHARS;
    let buttonLike =
      (filled || bordered) &&
      visual.h >= 28 &&
      wordsN >= 1 &&
      (wordsN <= BUTTON_WORDS_MAX || longLabel);
    if (!live && l.imgs.length === 1) {
      const r = s.nodeRect(l.imgs[0]!);
      const hint = `${s.attr(l.imgs[0]!, "alt") ?? ""} ${s.attr(l.imgs[0]!, "src")?.slice(0, 300) ?? ""}`;
      if (
        r &&
        r.h >= 30 &&
        r.h <= 80 &&
        r.w / r.h >= 2 &&
        r.w / r.h <= 8 &&
        BUTTON_IMAGE_HINT.test(hint)
      )
        buttonLike = true;
    }
    const main = live ? [...l.runs].sort((a, b) => b.chars - a.chars)[0]! : null;
    const labelBg = fill ?? container;
    const labelContrast = main ? contrastRatio(main.color, labelBg) : null;
    const labelLarge = main ? isLargeText(main.px, main.weight) : false;
    // Viewport position in CSS px at 375 (k is applied to H2 only, in the scorer).
    const position = visual.y < VIEWPORT_V ? 1 : visual.y < 2 * VIEWPORT_V ? 0.7 : 0.5;
    const contrastFactor = labelContrast === null ? 1 : Math.min(labelContrast / 4.5, 1.5);
    // A filled button outranks an outline one of the same size (render-2026.4: outline buttons
    // drawn by an inner or outer box are found now, and a wide "View profile" outline beside a
    // filled "Connect" must not become the primary CTA).
    const buttonFactor = !buttonLike ? 1 : bordered && !filled ? OUTLINE_PROMINENCE : 2;
    const prominence = visual.w * visual.h * contrastFactor * buttonFactor * position;
    const hero = !live && l.imgs.length > 0 && visual.w > 0.6 * opts.containerWidth;
    // Tap area (M4): the link's own box — and, for a link nested in another link (LinkedIn's
    // `<a><table><td fill><a>Connect</a></td></table></a>` buttons), the part of the button the
    // outermost enclosing link covers (that link takes the taps around the inner one; it may wrap
    // a whole card). A box painted around the link isn't otherwise part of it.
    const outer = outerLinkBox(s, l.node);
    const covered = outer ? intersectRect(outer, visual) : null;
    const tap = covered ? unionRect(l.target, covered) : l.target;
    const textOnlyTap =
      buttonLike &&
      s.isAncestor(visualNode, l.node) &&
      intersectArea(tap, visual) < TEXT_ONLY_TAP_SHARE * visual.w * visual.h;
    out.push({
      link: l,
      label,
      normLabel: normalizeLabel(label),
      wordsN,
      live,
      visual,
      target: tap,
      fill,
      container,
      buttonLike,
      labelContrast,
      labelLarge,
      labelPx: main?.px ?? 0,
      radius: vli >= 0 ? px(s.style(vli, "border-top-left-radius")) : 0,
      prominence,
      hero,
      textOnlyTap,
      outline: buttonLike && bordered && !filled,
    });
  }
  return out;
}

export interface CtaSummary {
  primary: CtaInfo | null;
  mostProminent: boolean;
  buttonLike: CtaInfo[];
  firstTwoDistinct: number;
  buttonStyles: number;
}

/** Primary CTA, rank, H5 distinct actions and L6 button styles. */
export function summarizeCtas(cands: readonly CtaInfo[]): CtaSummary {
  const buttons = cands.filter((c) => c.buttonLike);
  const top = (list: readonly CtaInfo[]) =>
    list.reduce<CtaInfo | null>(
      (best, c) => (!best || c.prominence > best.prominence ? c : best),
      null,
    );
  let primary = top(buttons);
  // An outline button is the secondary style of a pair: beside a filled (or image) button — within
  // half a viewport — the filled one is the primary, however wide the outline's label or high its
  // label contrast (a wide white "View the agenda" under a blue "Register" had won on area ×
  // contrast). Far apart (a digest's outline "Read more" cards vs a filled button at the very
  // end), prominence decides (render-2026.4 review).
  if (primary?.outline) {
    const cy = (c: CtaInfo) => c.visual.y + c.visual.h / 2;
    const p = primary;
    primary =
      top(buttons.filter((c) => !c.outline && Math.abs(cy(c) - cy(p)) <= OUTLINE_PAIR_PX)) ?? p;
  }
  const others = cands.filter((c) => !c.hero && c !== primary);
  const mostProminent = !!primary && others.every((c) => c.prominence <= primary.prominence);
  // H5: distinct actions among button-like CTAs in the first two viewports (label or decoded target).
  const early = buttons.filter((c) => c.visual.y < 2 * VIEWPORT_V);
  const parent = early.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < early.length; i++) {
    for (let j = i + 1; j < early.length; j++) {
      const a = early[i]!;
      const b = early[j]!;
      const ta = decodedTarget(a.link.href);
      const tb = decodedTarget(b.link.href);
      if (a.normLabel === b.normLabel || (ta !== null && ta === tb)) parent[find(i)] = find(j);
    }
  }
  const firstTwoDistinct = new Set(early.map((_, i) => find(i))).size;
  // L6: button styles (fill ΔE < 5, radius ±2px, height ±4px, font size ±1px).
  const styles: CtaInfo[] = [];
  for (const b of buttons) {
    const same = styles.find(
      (st) =>
        ((st.fill === null && b.fill === null) ||
          (st.fill !== null && b.fill !== null && colorDeltaE2000(st.fill, b.fill) < 5)) &&
        Math.abs(st.radius - b.radius) <= 2 &&
        Math.abs(st.visual.h - b.visual.h) <= 4 &&
        Math.abs(st.labelPx - b.labelPx) <= 1,
    );
    if (!same) styles.push(b);
  }
  return {
    primary,
    mostProminent,
    buttonLike: buttons,
    firstTwoDistinct,
    buttonStyles: styles.length,
  };
}

/** Salience inputs of the primary CTA (§5.4 H3). */
export function salience(c: CtaInfo): { lumRatio: number | null; deltaE: number | null } {
  if (!c.fill) return { lumRatio: null, deltaE: null };
  return {
    lumRatio: contrastFromLum(luminance(c.fill), luminance(c.container)),
    deltaE: colorDeltaE2000(c.fill, c.container),
  };
}
