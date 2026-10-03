/**
 * HTML preparation for the renderer (DESIGN-SCORE §2 inputs; DESIGN.md §6.2; FREE-TIER.md §5.1):
 *
 * 1. `stampByteOffsets(raw)`: before sanitizing, every element gets `data-o` = the UTF-8 byte
 *    offset of its start tag in the raw decoded HTML (parse5 source locations), so the Gmail
 *    clip offset maps to DOM elements. Hostile pre-existing `data-o`/`data-edf-*` are removed.
 *    Nesting is bounded first (parse5 is quadratic in depth: core's 400-level flattening, then a
 *    cut where parse5's own depth passes 512), exactly as static extraction does, so both see
 *    the same offsets.
 * 2. `prepareRenderDocument(sanitized, images)`: after sanitizing, inject the zero-specificity
 *    `__default__` font sentinel before the email CSS, inline pre-fetched images as `data:` URIs
 *    (everything else stays blocked: a sized placeholder when a width is declared), and tag
 *    each `<img>` with `data-edf-i` for the image table.
 */
import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { ByteOffsetMapper } from "../util/bytes";
import { parseBoundedDocument } from "../static/parse-bound";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/** DOM cap (DESIGN.md §6.2: DOM ≤ 20k nodes). */
export const MAX_DOM_NODES = 20_000;
/** HTML cap (DESIGN.md §6.2: HTML ≤ 2 MB → `too_large`). */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export class RenderInputError extends Error {
  constructor(readonly code: "too_large" | "too_many_nodes" | "parse_error") {
    super(code);
  }
}

/**
 * The "no font set" sentinel, then Gmail's default text stack. Text the email sets no font on
 * computes to `"__default__", Arial, Helvetica, sans-serif` (font analysis reads the leading
 * sentinel as "No font set") and renders in Arial as in Gmail web — not in Chromium's default
 * Times, whose wider, shorter lines skewed line length and wrapping (render-2026.4). Zero
 * specificity and first in `<head>`, so any font the email declares, however it declares it,
 * wins. The viewer injects the same selector with the same stack (apps/web view-source.ts).
 */
export const DEFAULT_FONT_STACK = "Arial, Helvetica, sans-serif";
const SENTINEL_CSS = `:where(html){font-family:"__default__", ${DEFAULT_FONT_STACK}}`;

function isElement(n: Node): n is Element {
  return "tagName" in n;
}

function kids(n: Node): Node[] {
  if (n.nodeName === "template" && "content" in n)
    return (n as DefaultTreeAdapterTypes.Template).content.childNodes;
  return "childNodes" in n ? (n.childNodes as Node[]) : [];
}

/** Iterative traversal with a node budget; returns the number of nodes visited. */
function forEachNode(root: Node, fn: (n: Node) => void, budget: number): number {
  const stack: Node[] = [root];
  let count = 0;
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (++count > budget) throw new RenderInputError("too_many_nodes");
    fn(n);
    const c = kids(n);
    for (let i = c.length - 1; i >= 0; i--) stack.push(c[i]!);
  }
  return count;
}

function dropInternalAttrs(el: Element): void {
  el.attrs = el.attrs.filter((a) => a.name !== "data-o" && !a.name.startsWith("data-edf-"));
}

function getAttr(el: Element, name: string): string | null {
  for (const a of el.attrs) if (a.name === name) return a.value;
  return null;
}

function setAttr(el: Element, name: string, value: string): void {
  const hit = el.attrs.find((a) => a.name === name);
  if (hit) hit.value = value;
  else el.attrs.push({ name, value });
}

/**
 * Stamp `data-o` UTF-8 byte offsets on the raw HTML (DESIGN-SCORE §2). Throws
 * `RenderInputError("too_large")` above 2 MB.
 */
export function stampByteOffsets(raw: string): string {
  const rawMapper = new ByteOffsetMapper(raw);
  if (rawMapper.total > MAX_HTML_BYTES) throw new RenderInputError("too_large");
  const { html, doc } = parseBoundedDocument(raw);
  const mapper = html === raw ? rawMapper : new ByteOffsetMapper(html);
  forEachNode(
    doc,
    (n) => {
      if (!isElement(n)) return;
      dropInternalAttrs(n);
      const loc = n.sourceCodeLocation?.startTag;
      if (loc) n.attrs.push({ name: "data-o", value: String(mapper.toBytes(loc.startOffset)) });
    },
    MAX_DOM_NODES * 5,
  );
  return serialize(doc);
}

export interface RenderImages {
  /** Pre-fetched, policy-allowed images keyed by absolute URL, as data: URIs. */
  images: Record<string, string>;
  /** Inline cid: images keyed by lower-cased Content-ID, as data: URIs. */
  cid: Record<string, string>;
}

export interface ImageTableEntry {
  /** Original reference (absolute URL, or `cid:<id>`), for joining with the fetch log. */
  ref: string;
  /** The image was inlined as a data: URI in the images-on document. */
  inlined: boolean;
}

export interface PreparedDocument {
  /** Images-on document (passes D, D0, M, M-nomq). */
  html: string;
  /** Images-off document (pass M-off): identical structure, no image sources resolved. */
  htmlImagesOff: string;
  /** `<img data-edf-i=n>` → image reference (same indices in both documents). */
  imageTable: ImageTableEntry[];
  /** data: URI → original reference, to recognise CSS background images in computed styles. */
  refByDataUri: Map<string, string>;
  /** Element + text node count of the prepared document. */
  nodeCount: number;
}

const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;

/** A neutral placeholder with the declared intrinsic size (height:auto keeps the ratio). */
export function placeholderSvg(w: number, h: number): string {
  const W = Math.max(1, Math.min(4000, Math.round(w)));
  const H = Math.max(1, Math.min(4000, Math.round(h)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#e6e6e6"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function attrNumber(el: Element, name: string): number | null {
  const v = getAttr(el, name);
  if (!v) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(v);
  return m ? parseFloat(m[1]!) : null;
}

const STYLE_PX: Record<"width" | "height", RegExp> = {
  width: /(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px\s*(?:!important\s*)?(?:;|$)/i,
  height: /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px\s*(?:!important\s*)?(?:;|$)/i,
};

/** A `width`/`height` in px: the attribute, else the inline style's declaration. */
function declaredPx(el: Element, name: "width" | "height"): number | null {
  const attr = attrNumber(el, name);
  if (attr !== null) return attr;
  const m = STYLE_PX[name].exec(getAttr(el, "style") ?? "");
  return m ? parseFloat(m[1]!) : null;
}

/** WHATWG-normalized href (the sanitizer normalizes URLs), or the input when unparseable. */
export function normalizeHref(url: string): string {
  try {
    return new URL(url.trim()).href;
  } catch {
    return url.trim();
  }
}

/** Look a URL up in a record keyed by original URLs, tolerating WHATWG normalization. */
export function lookupUrl<T>(record: Readonly<Record<string, T>>, url: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(record, url)) return record[url];
  const norm = normalizeHref(url);
  if (Object.prototype.hasOwnProperty.call(record, norm)) return record[norm];
  for (const key of Object.keys(record)) if (normalizeHref(key) === norm) return record[key];
  return undefined;
}

function resolve(ref: string, imgs: RenderImages): string | null {
  const r = ref.trim();
  if (/^cid:/i.test(r)) {
    const id = r.slice(4).replace(/^<|>$/g, "").toLowerCase();
    const hit = Object.prototype.hasOwnProperty.call(imgs.cid, id) ? imgs.cid[id] : undefined;
    return hit && DATA_IMAGE.test(hit) ? hit : null;
  }
  if (DATA_IMAGE.test(r)) return r;
  if (!/^https?:/i.test(r)) return null;
  const hit = lookupUrl(imgs.images, r);
  return hit && DATA_IMAGE.test(hit) ? hit : null;
}

const CSS_URL = /url\(\s*(['"]?)([^'")\s]{1,4096})\1\s*\)/gi;

function rewriteCssUrls(
  css: string,
  imgs: RenderImages,
  register: (ref: string, uri: string) => void,
): string {
  return css.replace(CSS_URL, (whole, _q: string, ref: string) => {
    const uri = resolve(ref, imgs);
    if (!uri) return whole;
    register(ref, uri);
    return `url("${uri}")`;
  });
}

function findChild(parent: ParentNode, tagName: string): Element | null {
  for (const c of parent.childNodes as Node[]) if (isElement(c) && c.tagName === tagName) return c;
  return null;
}

/**
 * Build the images-on and images-off documents from sanitized HTML. Throws
 * `RenderInputError("too_many_nodes")` beyond 20k nodes.
 */
export function prepareRenderDocument(sanitized: string, imgs: RenderImages): PreparedDocument {
  const build = (imagesOn: boolean) => {
    const doc = parse(sanitized, { scriptingEnabled: false });
    const table: ImageTableEntry[] = [];
    const refByDataUri = new Map<string, string>();
    const register = (ref: string, uri: string): void => {
      if (!refByDataUri.has(uri)) refByDataUri.set(uri, ref.slice(0, 2048));
    };
    const nodeCount = forEachNode(
      doc,
      (n) => {
        if (!isElement(n)) return;
        n.attrs = n.attrs.filter((a) => !a.name.startsWith("data-edf-"));
        if (n.tagName === "img") {
          const src = getAttr(n, "src") ?? "";
          const uri = imagesOn ? resolve(src, imgs) : null;
          table.push({ ref: src.slice(0, 2048), inlined: uri !== null });
          setAttr(n, "data-edf-i", String(table.length - 1));
          if (uri) {
            setAttr(n, "src", uri);
            register(src, uri);
          } else if (imagesOn) {
            // An image that didn't load lays out as a picture of its declared size, as it would for
            // the reader. With a width only, a 2:1 box (CSS's default for a replaced element with
            // no height). A broken image (no placeholder) is not a picture: its alt-text box ignores
            // `max-width:100%` in a table and kept a width="624" banner 624px wide at 375, so the
            // whole email measured 656px (Booking; render-2026.4).
            const w = declaredPx(n, "width");
            const h = declaredPx(n, "height");
            if (w !== null && w > 1 && (h === null || h > 1))
              setAttr(n, "src", placeholderSvg(w, h ?? w / 2));
          } else {
            // Images off: no source at all (embedded data: images are off too).
            n.attrs = n.attrs.filter((a) => a.name !== "src");
          }
        }
        if (imagesOn) {
          const bg = getAttr(n, "background");
          if (bg) {
            const uri = resolve(bg, imgs);
            if (uri) {
              register(bg, uri);
              setAttr(n, "background", uri);
            }
          }
          const style = getAttr(n, "style");
          if (style && /url\(/i.test(style))
            setAttr(n, "style", rewriteCssUrls(style, imgs, register));
          if (n.tagName === "style") {
            for (const c of n.childNodes as Node[]) {
              if (
                c.nodeName === "#text" &&
                /url\(/i.test((c as DefaultTreeAdapterTypes.TextNode).value)
              ) {
                const t = c as DefaultTreeAdapterTypes.TextNode;
                t.value = rewriteCssUrls(t.value, imgs, register);
              }
            }
          }
        }
      },
      MAX_DOM_NODES,
    );
    const htmlEl = findChild(doc, "html");
    const head = htmlEl ? findChild(htmlEl, "head") : null;
    if (head) {
      const style: Element = {
        nodeName: "style",
        tagName: "style",
        attrs: [{ name: "data-edf-sentinel", value: "" }],
        namespaceURI: head.namespaceURI,
        parentNode: head,
        childNodes: [],
      };
      style.childNodes.push({ nodeName: "#text", value: SENTINEL_CSS, parentNode: style });
      head.childNodes.unshift(style);
    }
    return { html: serialize(doc), table, refByDataUri, nodeCount };
  };
  const on = build(true);
  const off = build(false);
  return {
    html: on.html,
    htmlImagesOff: off.html,
    imageTable: on.table,
    refByDataUri: on.refByDataUri,
    nodeCount: on.nodeCount,
  };
}
