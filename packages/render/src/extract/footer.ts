/**
 * Footer region (DESIGN-SCORE §2.1 footer markers): where the footer starts at 375 and what it
 * says. Everything from the start node on, in document order, is footer (`role: "footer"`).
 */
import {
  FOOTER_MIN_SHARE,
  FOOTER_MIN_TOP,
  RECEIVING_TEXT,
  looksLikePostalAddress,
  weightedMedian,
} from "@edf/design/render-kit";
import type { Snap } from "../snapshot";
import { type Run, isRendered } from "./runs";
import type { LinkInfo } from "./structure";

/** Rendered characters that may follow a trailing footer section (a "©" line, a tracking gap). */
const FOOTER_TRAILING_CHARS = 20;
/** A short-email footer needs this much rendered text above it (so it can't swallow the message). */
const FOOTER_MIN_TEXT_BEFORE = 40;
/** …and must start in the lower part of the email at 375 (a top-bar unsubscribe link never does). */
const FOOTER_SHORT_MIN_SHARE = 0.5;
/** A footer starts in the bottom 40% of the rendered text (its top ≥ 60% of the text bottom). */
export const FOOTER_START_SHARE = 0.6;
/** …and holds under 40% of the rendered characters, unless its text is smaller than the body's. */
export const FOOTER_MAX_TEXT_SHARE = 0.4;
/** Candidate starts examined per marker (the path to the marker and the siblings before it). */
const MAX_CANDIDATES = 400;

export interface FooterRegion {
  /** First footer node (document order): every node from here on is footer. */
  start: number;
  /** Top of the start node at 375 (CSS px). */
  top: number;
  receiving: boolean;
  postal: boolean;
}

/**
 * Footer region start (node index) and its top at 375, or null (§2.1 footer markers).
 *
 * A marker (unsubscribe or preferences link, "you are receiving" text, postal address) normally
 * qualifies only at or below max(300px, 25% of the content height). The footer is then the
 * marker's enclosing top-level section — when that section is footer-shaped: it starts in the
 * bottom 40% of the rendered text and holds under 40% of the characters, or more when its text is
 * smaller than the text above it (a short notification's long legal footer). A section that isn't
 * (one wrapper row holding the whole email, a "you're receiving this because…" box in the body)
 * is narrowed toward the marker: its first descendant on the path to the marker, or a sibling
 * before that path, that is footer-shaped starts the footer. A marker with no such candidate is
 * skipped for the next one (DECISIONS.md #8, render-2026.4).
 *
 * Short emails (a one-paragraph notification) end above 300px, so their legal footer was never
 * found and its grey fine print was read as body text. When no marker qualifies (or none gives a
 * footer), a marker still starts the footer when its section is the email's last text-bearing
 * section (≤ 20 rendered characters after it), it starts in the lower half of the rendered text,
 * and at least 40 rendered characters come before it.
 *
 * A footer never swallows a filled button that comes before its marker (`buttons`, the content
 * links painted as filled live-text buttons; render-2026.5): a start at or before such a button
 * is not a footer start, so an email's last section — its button, then the address and the
 * unsubscribe link (Tavily's "See the full results here") — keeps its button in the body and
 * the footer starts after it (in the short-email fallback too: the first node on the way down to
 * the marker after the button).
 */
export function findFooter(
  s: Snap,
  runs: readonly Run[],
  links: readonly LinkInfo[],
  container: number,
  buttons: readonly number[] = [],
): FooterRegion | null {
  const minTop = Math.max(FOOTER_MIN_TOP, FOOTER_MIN_SHARE * s.contentHeight);
  const markers: Array<{ node: number; top: number }> = [];
  for (const l of links) {
    if ((l.unsubscribe || l.preferences) && l.target)
      markers.push({ node: l.node, top: l.target.y });
  }
  const blockText = new Map<
    number,
    { text: string; top: number; receiving: boolean; postal: boolean }
  >();
  const live: Run[] = [];
  let textBottom = 0;
  for (const r of runs) {
    if (!isRendered(r)) continue;
    live.push(r);
    textBottom = Math.max(textBottom, r.rect.y + r.rect.h);
    const b = s.blockOf[r.node]!;
    const cur = blockText.get(b) ?? { text: "", top: r.rect.y, receiving: false, postal: false };
    if (cur.text.length < 3000) cur.text += ` ${r.text}`;
    cur.top = Math.min(cur.top, r.rect.y);
    blockText.set(b, cur);
  }
  let receiving = false;
  let postal = false;
  for (const [b, v] of blockText) {
    v.receiving = RECEIVING_TEXT.test(v.text);
    v.postal = looksLikePostalAddress(v.text);
    if (v.receiving || v.postal) markers.push({ node: b >= 0 ? b : 0, top: v.top });
    if (v.top >= minTop) {
      receiving ||= v.receiving;
      postal ||= v.postal;
    }
  }
  // Enclosing top-level section: the marker's ancestor that is a direct child row of the main
  // container (single-child wrappers such as <tbody> are looked through), or — for a footer
  // outside the container — the ancestor that sits beside one of the container's ancestors.
  const containerChain = new Set<number>([container]);
  let w = container;
  for (let guard = 0; guard < 5; guard++) {
    const kids = (s.children[w] ?? []).filter((c) => s.isElement(c));
    if (kids.length !== 1) break;
    w = kids[0]!;
    containerChain.add(w);
  }
  const sectionOf = (node: number): number => {
    let cur = node;
    for (let guard = 0; guard < 500; guard++) {
      const p = s.parent[cur]!;
      if (p < 0) return -1;
      if (containerChain.has(p) || (container >= 0 && s.isAncestor(p, container))) return cur;
      cur = p;
    }
    return -1;
  };
  const byNode = (a: { node: number }, b: { node: number }) => a.node - b.node;
  // A start at or before a filled button that precedes the marker would swallow the button.
  const swallows = (start: number, marker: number) => buttons.some((b) => b >= start && b < marker);
  const shape = footerShape(live, textBottom);
  for (const mk of markers.filter((m) => m.top >= minTop).sort(byNode)) {
    const section = sectionOf(mk.node);
    if (section < 0) continue;
    const isFooter: ShapeTest = (node, top) => !swallows(node, mk.node) && shape(node, top);
    const start = narrowToFooter(s, section, mk.node, isFooter);
    if (start) return { start: start.node, top: start.top, receiving, postal };
  }
  // Short-email fallback: the trailing section that carries a marker. "Lower half" is measured
  // against the bottom of the rendered text (a short email's page is padded to the viewport).
  // When that section also holds a filled button before the marker, the footer starts at the
  // first node on the way down to the marker after the button (the button stays in the body);
  // the trailing text is still measured after the section.
  for (const m of [...markers].sort(byNode)) {
    const section = sectionOf(m.node);
    if (section < 0) continue;
    const start = swallows(section, m.node)
      ? (narrowToFooter(s, section, m.node, (node) => !swallows(node, m.node))?.node ?? -1)
      : section;
    if (start < 0) continue;
    const rect = s.unionRect(start);
    const top = rect ? rect.y : m.top;
    if (top < FOOTER_SHORT_MIN_SHARE * textBottom) continue;
    let before = 0;
    let after = 0;
    for (const r of live) {
      if (r.node < start) before += r.chars;
      else if (r.node !== section && !s.isAncestor(section, r.node)) after += r.chars;
    }
    if (before < FOOTER_MIN_TEXT_BEFORE || after > FOOTER_TRAILING_CHARS) continue;
    let rec = false;
    let post = false;
    for (const [b, v] of blockText) {
      if (b >= start) {
        rec ||= v.receiving;
        post ||= v.postal;
      }
    }
    return { start, top, receiving: rec, postal: post };
  }
  return null;
}

/** Is a footer starting at `node` (top `top`) footer-shaped? */
type ShapeTest = (node: number, top: number) => boolean;

/**
 * The footer-shape test over the rendered runs: starts in the bottom 40% of the rendered text,
 * and holds < 40% of the characters — or its median size is below the median size of the text
 * before it (or < 40 characters come before it: an image email whose only text is its footer).
 */
function footerShape(live: readonly Run[], textBottom: number): ShapeTest {
  const sorted = [...live].sort((a, b) => a.node - b.node);
  const total = sorted.reduce((n, r) => n + r.chars, 0);
  const firstAt = (node: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.node < node) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (node, top) => {
    if (total === 0 || top < FOOTER_START_SHARE * textBottom) return false;
    const i = firstAt(node);
    const after = sorted.slice(i);
    const inside = after.reduce((n, r) => n + r.chars, 0);
    if (inside < FOOTER_MAX_TEXT_SHARE * total) return true;
    const before = sorted.slice(0, i);
    if (total - inside < FOOTER_MIN_TEXT_BEFORE) return true;
    const mFooter = weightedMedian(after.map((r) => [r.px, r.chars] as const));
    const mBefore = weightedMedian(before.map((r) => [r.px, r.chars] as const));
    return mFooter !== null && mBefore !== null && mFooter < mBefore;
  };
}

/**
 * The earliest footer-shaped start between `section` and `marker`: the section itself, then —
 * level by level down the path to the marker — each child before the one holding the marker,
 * then that child. Null when none is footer-shaped.
 */
function narrowToFooter(
  s: Snap,
  section: number,
  marker: number,
  isFooter: ShapeTest,
): { node: number; top: number } | null {
  let tried = 0;
  const test = (node: number): { node: number; top: number } | null => {
    tried++;
    const rect = s.unionRect(node);
    return rect && isFooter(node, rect.y) ? { node, top: rect.y } : null;
  };
  let p = section;
  const hit = test(p);
  if (hit) return hit;
  while (p !== marker && tried < MAX_CANDIDATES) {
    let next = -1;
    for (const c of s.children[p] ?? []) {
      if (!s.isElement(c)) continue;
      const onPath = c === marker || s.isAncestor(c, marker);
      const h = test(c);
      if (h) return h;
      if (onPath) {
        next = c;
        break;
      }
      if (tried >= MAX_CANDIDATES) return null;
    }
    if (next < 0) return null;
    p = next;
  }
  return null;
}
