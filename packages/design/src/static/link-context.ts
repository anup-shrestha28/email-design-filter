/**
 * The sentence around a link whose own text only points ("here", "click here"): in
 * "Click <a>here</a> to unsubscribe" the link is the unsubscribe link although its text says
 * nothing (DESIGN-SCORE §5.9 U1, U3). Only the link's own sentence counts, so a "here" in another
 * sentence of the same footer never borrows its neighbour's meaning.
 */
import { normalizeLabel } from "../util/text";
import { childrenOf, isElement, isText, tag, type P5Element, type P5Node } from "./dom";

/** Link texts with no meaning of their own (normalized: lower-case, punctuation stripped). */
const POINTER_LABEL =
  /^(?:(?:please )?(?:click|tap|press|clicking|tapping)(?: on)? )?(?:here|this link|the link(?: below)?)$|^(?:ici|cliquez ici|hier|hier klicken|klicken sie hier|aqu[ií]|haz clic aqu[ií]|pulsa aqu[ií]|qui|clicca qui|aqui|clique aqui)$/;

export function isPointerLabel(name: string): boolean {
  return POINTER_LABEL.test(normalizeLabel(name));
}

/** The link's text block: its nearest block-level ancestor. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "td",
  "th",
  "li",
  "dd",
  "dt",
  "blockquote",
  "center",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "address",
  "body",
]);
/** Boxes inside the block that start a new line (their text is never part of the link's sentence). */
const LINE_TAGS = new Set([...BLOCK_TAGS, "table", "tr", "ul", "ol", "hr"]);
/** Sentence ends: punctuation, separators and line boundaries. */
const SENTENCE_END = /[.!?…|•·\n]/;
/** A `<br>`; it continues the sentence after `,` `:` `;` or a dash, or before a lower-case word. */
const SOFT_BREAK = "\u2028";
const BREAK_AFTER_PUNCT = new RegExp(`([,:;\\-–—])\\s*${SOFT_BREAK}`, "g");
const BREAK_BEFORE_LOWER = new RegExp(`${SOFT_BREAK}(\\s*\\p{Ll})`, "gu");
const ANY_BREAK = new RegExp(SOFT_BREAK, "g");
const MAX_SIDE_CHARS = 300;
/**
 * Nodes read on each side of the link. The walk starts at the link and reads outwards, so a link
 * late in a long block costs no more than one at its start, and a side that runs out of budget
 * ends there, like a line boundary (never borrowing text from far away).
 */
const MAX_SIDE_NODES = 1_000;

function resolveBreaks(s: string): string {
  return s
    .replace(BREAK_AFTER_PUNCT, "$1 ")
    .replace(BREAK_BEFORE_LOWER, " $1")
    .replace(ANY_BREAK, "\n");
}

/** What a node adds to the block's text on the way in and on the way out. */
function textOf(node: P5Node, block: P5Element, visible: ReadonlySet<P5Node>): string {
  if (isText(node)) return visible.has(node) ? node.value : "";
  if (!isElement(node)) return "";
  const t = tag(node);
  if (t === "br") return SOFT_BREAK;
  // A nested block starts and ends a line.
  return node !== block && LINE_TAGS.has(t) ? "\n" : "";
}

/**
 * Up to MAX_SIDE_CHARS of the block's visible text on one side of `link`, read outwards from it
 * (step 1: the text after it; step -1: the text before it), returned in document order.
 */
function sideText(
  link: P5Element,
  block: P5Element,
  visible: ReadonlySet<P5Node>,
  step: 1 | -1,
): string {
  const parts: string[] = [];
  let chars = 0;
  let budget = MAX_SIDE_NODES;
  const push = (s: string) => {
    if (s === "") return;
    parts.push(s);
    chars += s.length;
  };
  // One sibling subtree, in reading direction; entering and leaving an element both count.
  const subtree = (root: P5Node) => {
    const stack: Array<{ node: P5Node; exit: boolean }> = [{ node: root, exit: false }];
    while (stack.length > 0 && budget-- > 0 && chars < MAX_SIDE_CHARS) {
      const { node, exit } = stack.pop()!;
      push(textOf(node, block, visible));
      if (exit || !isElement(node) || tag(node) === "br") continue;
      stack.push({ node, exit: true });
      const kids = childrenOf(node);
      if (step === 1)
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, exit: false });
      else for (const k of kids) stack.push({ node: k, exit: false });
    }
  };
  let node: P5Node = link;
  while (budget > 0 && chars < MAX_SIDE_CHARS) {
    const parent = node.parentNode as P5Node | null;
    if (!parent || !isElement(parent)) break;
    const kids = childrenOf(parent);
    for (let i = kids.indexOf(node) + step; i >= 0 && i < kids.length; i += step) {
      if (budget <= 0 || chars >= MAX_SIDE_CHARS) break;
      subtree(kids[i]!);
    }
    if (parent === block) break;
    // Leaving an ancestor of the link inside the block (its end going forward, its start going back).
    push(textOf(parent, block, visible));
    node = parent;
    budget--;
  }
  return step === 1 ? parts.join("") : parts.reverse().join("");
}

/**
 * The visible sentence containing `link` (its text included): the text of the link's block from
 * the sentence end before it to the one after it. `visible` holds the text nodes the reader sees.
 * A pointer that is the whole sentence after a question ("Rather opt out of these? Click here")
 * takes the question with it.
 */
export function linkSentence(
  link: P5Element,
  linkText: string,
  visible: ReadonlySet<P5Node>,
): string {
  let block: P5Element | null = null;
  let p = link.parentNode as P5Node | null;
  for (let guard = 0; p && isElement(p) && guard < 40; guard++) {
    if (BLOCK_TAGS.has(tag(p))) {
      block = p;
      break;
    }
    p = (p as P5Element).parentNode as P5Node | null;
  }
  if (!block) return linkText;
  const head = resolveBreaks(sideText(link, block, visible, -1).slice(-MAX_SIDE_CHARS));
  const tail = resolveBreaks(sideText(link, block, visible, 1).slice(0, MAX_SIDE_CHARS));
  let start = head.length;
  while (start > 0 && !SENTENCE_END.test(head[start - 1]!)) start--;
  let own = head.slice(start);
  let end = 0;
  while (end < tail.length && !SENTENCE_END.test(tail[end]!)) end++;
  const rest = tail.slice(0, end);
  // "…opt out of these? Click here": the pointer sentence says nothing, the question before it does.
  if (
    start > 0 &&
    head[start - 1] === "?" &&
    `${own}${rest}`.replace(/[^\p{L}]/gu, "").length < 12
  ) {
    let prev = start - 1;
    while (prev > 0 && !SENTENCE_END.test(head[prev - 1]!)) prev--;
    own = head.slice(prev);
  }
  return `${own}${linkText}${rest}`.replace(/\s+/g, " ").trim();
}
