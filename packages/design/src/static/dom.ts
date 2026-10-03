/**
 * Minimal, allocation-light helpers over the parse5 default tree (static extraction runs on
 * hostile input: every traversal is iterative and bounded, and so is every parse — parse5 is
 * quadratic in nesting depth, so input is truncated and flattened first).
 */
import type { DefaultTreeAdapterTypes } from "parse5";
import { parseBoundedDocument, parseBoundedFragment } from "./parse-bound";

export type P5Node = DefaultTreeAdapterTypes.Node;
export type P5Element = DefaultTreeAdapterTypes.Element;
export type P5Text = DefaultTreeAdapterTypes.TextNode;
export type P5Comment = DefaultTreeAdapterTypes.CommentNode;
export type P5Parent = DefaultTreeAdapterTypes.ParentNode;
export type P5Document = DefaultTreeAdapterTypes.Document;

/** Hard cap on visited nodes per traversal (the renderer caps DOM at 20k; ingest is laxer). */
export const MAX_NODES = 200_000;

/** Longest HTML handed to static extraction (the same 2 M characters core's extraction reads). */
export const MAX_STATIC_HTML_CHARS = 2_000_000;

/**
 * Hostile-input bound applied once before static extraction: truncate at MAX_STATIC_HTML_CHARS,
 * flatten nesting beyond 400 levels (core `limitNesting`) and cut the document where parse5's own
 * open-element depth would pass MAX_PARSED_DEPTH (`parse-bound.ts`). Normal email is returned as
 * is. Byte offsets are then offsets into this string (they differ from the raw HTML only for
 * pathological documents).
 */
export function boundHtml(html: string): string {
  return parseStaticHtml(html).html;
}

/** `boundHtml` and its parsed document in one parse: `doc`'s source locations refer to `html`. */
export function parseStaticHtml(raw: string): { html: string; doc: P5Document } {
  return parseBoundedDocument(raw.length > MAX_STATIC_HTML_CHARS ? raw.slice(0, MAX_STATIC_HTML_CHARS) : raw);
}

/**
 * Parse a document. Nesting is bounded again here (a linear no-op for bounded input), so no caller
 * can hand parse5 a pathologically deep document; callers that map source offsets use
 * `parseStaticHtml` (or `boundHtml(html)`) so their offsets match the parsed string.
 */
export function parseDocument(html: string): P5Document {
  return parseBoundedDocument(html).doc;
}

export function parseHtmlFragment(html: string): DefaultTreeAdapterTypes.DocumentFragment {
  return parseBoundedFragment(html);
}

export function isElement(n: P5Node): n is P5Element {
  return "tagName" in n;
}

export function isText(n: P5Node): n is P5Text {
  return n.nodeName === "#text";
}

export function isComment(n: P5Node): n is P5Comment {
  return n.nodeName === "#comment";
}

export function childrenOf(n: P5Node): P5Node[] {
  if (n.nodeName === "template" && "content" in n)
    return (n as DefaultTreeAdapterTypes.Template).content.childNodes;
  return "childNodes" in n ? (n.childNodes as P5Node[]) : [];
}

export function attr(el: P5Element, name: string): string | null {
  for (const a of el.attrs) if (a.name === name) return a.value;
  return null;
}

export function hasAttr(el: P5Element, name: string): boolean {
  return el.attrs.some((a) => a.name === name);
}

/** Tag name without namespace prefix, lower-case (`v:roundrect` stays `v:roundrect`). */
export function tag(el: P5Element): string {
  return el.tagName.toLowerCase();
}

/**
 * Iterative pre-order traversal. `enter` may return false to skip an element's subtree.
 * Stops after MAX_NODES nodes.
 */
export function walk(root: P5Node, enter: (node: P5Node, depth: number) => boolean | void): void {
  const stack: Array<[P5Node, number]> = [[root, 0]];
  let visited = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (++visited > MAX_NODES) return;
    if (enter(node, depth) === false) continue;
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1]);
  }
}

/** First element matching `pred` in document order. */
export function find(root: P5Node, pred: (el: P5Element) => boolean): P5Element | null {
  let found: P5Element | null = null;
  walk(root, (n) => {
    if (found) return false;
    if (isElement(n) && pred(n)) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

export function findAll(root: P5Node, pred: (el: P5Element) => boolean, max = 50_000): P5Element[] {
  const out: P5Element[] = [];
  walk(root, (n) => {
    if (out.length >= max) return false;
    if (isElement(n) && pred(n)) out.push(n);
    return true;
  });
  return out;
}

/** Concatenated text content (bounded). */
export function textContent(root: P5Node, limit = 20_000): string {
  let s = "";
  walk(root, (n) => {
    if (s.length >= limit) return false;
    if (isText(n)) s += n.value;
    if (isElement(n)) {
      const t = tag(n);
      if (t === "script" || t === "style" || t === "template") return false;
    }
    return true;
  });
  return s.length > limit ? s.slice(0, limit) : s;
}

/** Ancestors from the parent up to the document. */
export function* ancestors(n: P5Node): Generator<P5Element> {
  let p = "parentNode" in n ? n.parentNode : null;
  let guard = 0;
  while (p && isElement(p as P5Node) && guard++ < 10_000) {
    yield p as P5Element;
    p = (p as P5Element).parentNode;
  }
}

export function closest(n: P5Node, pred: (el: P5Element) => boolean): P5Element | null {
  if (isElement(n) && pred(n)) return n;
  for (const a of ancestors(n)) if (pred(a)) return a;
  return null;
}

/**
 * Parse an inline `style` attribute into lower-cased property → value (last wins).
 * A tolerant hand-rolled splitter: ignores `;` inside quotes and parentheses.
 */
export function parseInlineStyle(style: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!style) return out;
  const s = style.length > 8000 ? style.slice(0, 8000) : style;
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const push = (end: number) => {
    const decl = s.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) {
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl
        .slice(colon + 1)
        .replace(/!\s*important\s*$/i, "")
        .trim();
      if (prop && /^-?[a-z][a-z0-9-]*$/.test(prop)) out.set(prop, value);
    }
    start = end + 1;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) push(i);
  }
  push(s.length);
  return out;
}

/** Parse a CSS length in px from an attribute or style value ("600", "600px", "37.5em"≈). */
export function parsePx(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(px|pt|em|rem)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "px").toLowerCase();
  if (unit === "pt") return (n * 4) / 3;
  if (unit === "em" || unit === "rem") return n * 16;
  return n;
}
