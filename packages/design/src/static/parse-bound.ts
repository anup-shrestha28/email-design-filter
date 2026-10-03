/**
 * Depth-bounded parse5 parsing for hostile HTML (static extraction and the renderer's byte-offset
 * stamping both use it, so both see the same string and the same offsets).
 *
 * core's `limitNesting` flattens deep nesting with a linear tag scan, but that scan cannot follow
 * every tree-building rule: stray end tags (`<div></x>`), `<noscript>` parsed as HTML
 * (`scriptingEnabled: false`), `<!-->` and `<rt>`/`<rb>` outside `<ruby>` all nest in parse5 while
 * the scan counts them as closed. parse5 is quadratic in the depth of its open-element stack, so
 * the depth is also measured where it happens: a tree adapter counts the stack (`onItemPush` /
 * `onItemPop`) and stops the parse as soon as it passes MAX_PARSED_DEPTH. The document is then cut
 * before the first too-deep start tag, and the rest is kept as text only (tags removed).
 *
 * Depth alone does not bound the work: when parse5 reconstructs its list of active formatting
 * elements (`<p><b id=1>…<b id=400></p><p>x` repeated), every text token re-creates up to ~400
 * elements that each stay under the depth limit, so an 84 KB email built ~4M elements (9 s, 2 GB)
 * and a 180 KB one exhausted the heap. The same adapter therefore also counts what parse5 creates
 * (`createElement`: elements, plus the attribute characters each clone carries) and stops the parse
 * the same way once MAX_PARSED_ELEMENTS or the attribute budget is passed. Without amplification an
 * element and its attributes come from the source once, so real email stays far below both.
 * Normal email never reaches a limit and is parsed exactly once.
 *
 * Only parse5 and `@edf/core/nesting` are imported (the render kit uses this module).
 */
import {
  defaultTreeAdapter,
  parse,
  parseFragment,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type TreeAdapter,
} from "parse5";
import { limitNesting } from "@edf/core/nesting";

/**
 * Deepest open-element stack parse5 may build. Above core's MAX_HTML_DEPTH (400 counted tags)
 * because parse5 adds `html`/`body` and table wrappers (`tbody`, `tr`, `td`) the scan does not
 * count; real email stays below ~150.
 */
export const MAX_PARSED_DEPTH = 512;

/**
 * Most elements parse5 may create for one document (reconstructed and adoption-agency clones
 * included). The same figure as the static walks' MAX_NODES (`dom.ts`), so every element a walk
 * could reach is still built; a large newsletter has a few thousand. Past it the rest is text.
 */
export const MAX_PARSED_ELEMENTS = 200_000;

/**
 * Attribute characters (names + values) all created elements may carry together: twice the input
 * plus 1M. A clone shares its source's attributes, so without this a long `style` on a formatting
 * element would be multiplied by every reconstruction when the tree is walked or serialized.
 */
function attrBudgetOf(html: string): number {
  return 2 * html.length + 1_000_000;
}

class ParseLimit extends Error {
  /** Start of the last token parse5 had located: a token boundary the parse reached safely. */
  constructor(readonly offset: number) {
    super("html_parse_limit");
  }
}

function depthGuard(
  maxDepth: number,
  maxElements: number,
  maxAttrChars: number,
): TreeAdapter<DefaultTreeAdapterMap> {
  let depth = 0;
  let offset = 0;
  let elements = 0;
  let attrChars = 0;
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      for (const a of attrs) attrChars += a.name.length + a.value.length;
      if (++elements > maxElements || attrChars > maxAttrChars) throw new ParseLimit(offset);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    setNodeSourceCodeLocation(node, location) {
      defaultTreeAdapter.setNodeSourceCodeLocation(node, location);
      if (location && location.startOffset > offset) offset = location.startOffset;
    },
    onItemPush() {
      if (++depth > maxDepth) throw new ParseLimit(offset);
    },
    onItemPop() {
      depth--;
    },
  };
}

/** Text of `html` with every tag removed (linear: `[^<>]` never rescans a character). */
function textOnly(html: string): string {
  return html.replace(/<[^<>]*>/g, " ").replace(/</g, "&lt;");
}

function bounded<T>(
  html: string,
  run: (html: string, treeAdapter: TreeAdapter<DefaultTreeAdapterMap>) => T,
  maxDepth: number,
  maxElements: number,
): { html: string; result: T } {
  let candidate = html;
  const maxAttrChars = attrBudgetOf(html);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { html: candidate, result: run(candidate, depthGuard(maxDepth, maxElements, maxAttrChars)) };
    } catch (e) {
      if (!(e instanceof ParseLimit)) throw e;
      // First cut: keep the rest's text. If even that passes a limit (text re-opening a long list
      // of formatting elements), keep only the part before the cut, which stayed within them.
      candidate =
        attempt === 0
          ? candidate.slice(0, e.offset) + textOnly(candidate.slice(e.offset))
          : candidate.slice(0, e.offset);
    }
  }
  candidate = textOnly(html);
  return { html: candidate, result: run(candidate, defaultTreeAdapter) };
}

/**
 * Parse a document with nesting bounded both by core's `limitNesting` and by parse5's actual
 * open-element depth, and with the elements parse5 creates bounded too. `html` is the string the returned document (and its source locations)
 * describes: the input itself unless it was pathological.
 */
export function parseBoundedDocument(
  input: string,
  maxDepth = MAX_PARSED_DEPTH,
  maxElements = MAX_PARSED_ELEMENTS,
): { html: string; doc: DefaultTreeAdapterTypes.Document } {
  const { html, result } = bounded(
    limitNesting(input),
    (h, treeAdapter) => parse(h, { sourceCodeLocationInfo: true, scriptingEnabled: false, treeAdapter }),
    maxDepth,
    maxElements,
  );
  return { html, doc: result };
}

/** `parseBoundedDocument` for a fragment. */
export function parseBoundedFragment(
  input: string,
  maxDepth = MAX_PARSED_DEPTH,
  maxElements = MAX_PARSED_ELEMENTS,
): DefaultTreeAdapterTypes.DocumentFragment {
  return bounded(
    limitNesting(input),
    (h, treeAdapter) => parseFragment(h, { sourceCodeLocationInfo: true, scriptingEnabled: false, treeAdapter }),
    maxDepth,
    maxElements,
  ).result;
}
