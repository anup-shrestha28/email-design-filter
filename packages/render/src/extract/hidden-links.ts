/**
 * Links a reader can't see (render-2026.6, `links.hidden`): the `data-o` byte offsets of the `<a>`
 * elements that draw nothing in pass D nor in pass M. U1 matches them with the static pass's
 * unsubscribe links (DESIGN-SCORE §5.9): the HTML pass reads inline styles and simple tag / class /
 * id rules only, so a link hidden by a descendant selector, an @media rule or text the colour of
 * its background still counted as a visible unsubscribe link.
 *
 * A link draws something in a pass when, inside it (nested links: what an inner link draws, its
 * outer links draw too):
 * - a text run (symbols included) is geometrically visible (§2.1: a box, `visibility: visible`,
 *   inside the document, ≥ 50% inside its clips, not transparent) and either passed the desktop
 *   paint test (on the phone, the same text node's desktop result) or stands out from a plain
 *   background (≥ `INVISIBLE_CONTRAST`; text on a background picture can't be judged by colour and
 *   counts as drawn). The colour test backs up the paint test: it doesn't run off the 8,000 px
 *   desktop screenshot or on text only the phone shows, and a link is called hidden only on
 *   positive evidence, so text that failed it but stands out from its background still counts;
 * - or a picture shows: an `<img>`, `<svg>`, `<video>`, `<canvas>` or image `<input>`, or an
 *   element with a CSS background image, laid out visible (as above) over more than 25 px² — or an
 *   `<img>` the render had no decoded picture for (blocked, broken: Gmail may show it).
 * Only `<a>` elements carrying their own `data-o` are listed (a text node's inherited offset would
 * name another element); an offset any element at it draws in either pass is not hidden.
 */
import { INVISIBLE_CONTRAST, MAX_HIDDEN_LINKS, contrastRatio } from "@edf/design/render-kit";
import type { Rect, Snap } from "../snapshot";
import type { Run } from "./runs";
import { nearestTagIndex } from "./structure";

/** One pass (D or M) as the hidden-link test reads it. */
export interface LinkPass {
  s: Snap;
  /** Text and symbol runs of the pass. */
  runs: readonly Run[];
  /** The run passed the desktop paint test (for pass M: its text node did, in pass D). */
  painted: (r: Run) => boolean;
}

/** Picture elements: what they draw isn't text. */
const PICTURE_TAGS: ReadonlySet<string> = new Set(["img", "svg", "video", "canvas", "input"]);
/** A picture smaller than this (CSS px²) shows nothing a reader can use (tracking-pixel size). */
const MIN_PICTURE_AREA = 25;

function inside(rect: Rect, clip: readonly [number, number, number, number] | null): number {
  if (!clip) return 1;
  const w = Math.min(rect.x + rect.w, clip[2]) - Math.max(rect.x, clip[0]);
  const h = Math.min(rect.y + rect.h, clip[3]) - Math.max(rect.y, clip[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (rect.w * rect.h);
}

/** A text run a reader sees (see the module comment). */
function runDrawn(p: LinkPass, r: Run): boolean {
  if (!r.geom) return false;
  if (p.painted(r)) return true;
  if (r.el < 0 || p.s.bgImage[r.el]) return true;
  return contrastRatio(r.color, p.s.bg[r.el]!) >= INVISIBLE_CONTRAST;
}

/** A picture element (or a CSS background image) a reader sees. */
function pictureShows(s: Snap, node: number, decoded: (s: Snap, node: number) => boolean): boolean {
  const tag = s.names[node]!;
  const picture =
    PICTURE_TAGS.has(tag) && (tag !== "input" || /^image$/i.test(s.attr(node, "type") ?? ""));
  const li = s.layoutOf[node]!;
  if (li < 0) return false;
  if (!picture) {
    const bgi = s.style(li, "background-image");
    if (!bgi || !bgi.includes("url(")) return false;
  }
  if (s.style(li, "visibility") !== "visible" || s.cumOpacity[node]! <= 0.01) return false;
  const r = s.rect(li);
  const docW = Math.max(s.contentWidth, 1);
  const docH = Math.max(s.contentHeight, 1);
  const parent = s.parent[node]!;
  const clip = parent >= 0 ? s.clip[parent]! : null;
  const area = r.w * r.h;
  if (area > 0) {
    if (r.x + r.w <= 0 || r.y + r.h <= 0 || r.x >= docW || r.y >= docH) return false;
    if (inside(r, clip) < 0.5) return false;
    if (area > MIN_PICTURE_AREA) return true;
  } else {
    // A flat box (a broken image without a declared size): its corner must lie in the document
    // and inside its clips (a zero-height clip shows nothing).
    if (r.x < 0 || r.y < 0 || r.x >= docW || r.y >= docH) return false;
    if (clip && !(r.x >= clip[0] && r.x < clip[2] && r.y >= clip[1] && r.y < clip[3])) return false;
  }
  return tag === "img" && !decoded(s, node);
}

/** Own `data-o` byte offset of an element, or null. */
function ownOffset(s: Snap, node: number): number | null {
  const v = s.attr(node, "data-o");
  return v !== null && /^\d{1,10}$/.test(v) ? Number(v) : null;
}

/**
 * The `data-o` offsets of the `<a>` elements that draw nothing in any of `passes` (D and M),
 * ascending, first `MAX_HIDDEN_LINKS`; `more` when there were more.
 */
export function hiddenLinks(
  passes: readonly LinkPass[],
  decoded: (s: Snap, node: number) => boolean,
): { offsets: number[]; more: boolean } {
  const all = new Set<number>();
  const shown = new Set<number>();
  for (const p of passes) {
    const s = p.s;
    const linkOf = nearestTagIndex(s, "a");
    const drawn = new Uint8Array(s.count);
    // Marks a link and its enclosing links (a marked link's enclosing links are marked already).
    const mark = (node: number) => {
      let l = linkOf[node]!;
      while (l >= 0 && !drawn[l]) {
        drawn[l] = 1;
        const parent = s.parent[l]!;
        l = parent >= 0 ? linkOf[parent]! : -1;
      }
    };
    for (const r of p.runs) if (linkOf[r.node]! >= 0 && runDrawn(p, r)) mark(r.node);
    for (let i = 0; i < s.count; i++) {
      const l = linkOf[i]!;
      if (l < 0 || drawn[l] || !s.isElement(i)) continue;
      if (pictureShows(s, i, decoded)) mark(i);
    }
    for (let i = 0; i < s.count; i++) {
      if (s.names[i] !== "a" || !s.isElement(i)) continue;
      const o = ownOffset(s, i);
      if (o === null) continue;
      all.add(o);
      if (drawn[i]) shown.add(o);
    }
  }
  const hidden = [...all].filter((o) => !shown.has(o)).sort((a, b) => a - b);
  return {
    offsets: hidden.slice(0, MAX_HIDDEN_LINKS),
    more: hidden.length > MAX_HIDDEN_LINKS,
  };
}
