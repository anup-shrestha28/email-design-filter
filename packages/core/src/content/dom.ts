/**
 * HTML parsing via cheerio with its default parse5 backend (FREE-TIER.md §4.6), exposed as a
 * minimal structural node model so the extractor can walk the tree once, iteratively (hostile
 * documents can be nested far deeper than the JS call stack allows).
 */
import { load } from "cheerio";
import { limitNesting } from "../util/nesting";

export { limitNesting, MAX_HTML_DEPTH } from "../util/nesting";

export interface DomElement {
  type: "tag" | "script" | "style";
  name: string;
  attribs: Record<string, string>;
  children: DomNode[];
  parent: DomNode | null;
}

export interface DomText {
  type: "text";
  data: string;
  parent: DomNode | null;
}

export interface DomOther {
  type: "root" | "comment" | "directive" | "cdata";
  children?: DomNode[];
  parent: DomNode | null;
}

export type DomNode = DomElement | DomText | DomOther;

export function isElement(n: DomNode): n is DomElement {
  return n.type === "tag" || n.type === "script" || n.type === "style";
}

export function isText(n: DomNode): n is DomText {
  return n.type === "text";
}

export function childrenOf(n: DomNode): readonly DomNode[] {
  return "children" in n && Array.isArray(n.children) ? n.children : [];
}

/**
 * Most HTML characters handed to parse5, for every caller (content extraction already truncates to
 * the same 2 MB, §6.2). With the nesting and formatting limits, parse time stays linear in this.
 */
export const MAX_PARSE_CHARS = 2_000_000;

/** Parses an HTML document (parse5, spec-compliant error recovery) and returns its root node. */
export function parseHtml(html: string): DomNode {
  const $ = load(
    limitNesting(html.length > MAX_PARSE_CHARS ? html.slice(0, MAX_PARSE_CHARS) : html),
  );
  // cheerio's node classes (domhandler) structurally satisfy DomNode; this is the single cast.
  return $.root()[0] as unknown as DomNode;
}

/** Text content of a subtree, bounded by `max` characters and a node budget (iterative). */
export function subtreeText(root: DomNode, max = 300): string {
  let out = "";
  const stack: DomNode[] = [root];
  let budget = 2000;
  while (stack.length > 0 && out.length < max && budget-- > 0) {
    const n = stack.pop() as DomNode;
    if (isText(n)) {
      out += n.data;
      continue;
    }
    // Nested script/style never contribute text; the root itself may be a script/style element.
    if (n !== root && isElement(n) && (n.type === "script" || n.type === "style")) continue;
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as DomNode);
  }
  return out.slice(0, max);
}
