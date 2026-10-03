/**
 * DOMPurify profiles on one jsdom window per process (DESIGN.md §11.5; DESIGN-SCORE §2).
 *
 * The window and the DOMPurify instance are created lazily once and reused. Hooks are registered
 * once and read a per-call context that is installed and cleared in try/finally around each
 * synchronous `sanitize()` call; re-entrant calls are refused, so no state can leak between
 * calls. jsdom runs no scripts, loads no resources, and its virtual console is silent (its CSS
 * parse errors would otherwise print email content to logs).
 *
 * URL-bearing attributes (`src`, `href`, `background`) are captured in `uponSanitizeAttribute`
 * (before DOMPurify's own URI check can discard them), always removed, and re-added in
 * `afterSanitizeAttributes` only from our own strict rewrite.
 *
 * The viewer's image rewriter mints a signed token per call, so it is called only for images
 * that reach the output: a `<style>` is sanitized in `uponSanitizeElement` but its urls are
 * rewritten in `afterSanitizeElements`, once DOMPurify has kept the element (it still removes,
 * e.g., a `<style>` in a foreign namespace after the first hook), and css.ts rewrites only urls
 * it will emit. A `<template>` (forbidden) is emptied first: DOMPurify still walks its content,
 * which never reaches the output. `images` counts what was kept.
 */
import createDOMPurify, {
  type Config,
  type DOMPurify,
  type UponSanitizeAttributeHookEvent,
  type UponSanitizeElementHookEvent,
  type WindowLike,
} from "dompurify";
import { createRequire } from "node:module";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  CSS_MAX_BYTES,
  emitCss,
  prepareDeclarations,
  prepareStylesheet,
  type CssImageFilter,
  type CssImageRewriter,
  type EmitOptions,
  type PreparedCss,
} from "./css";
import {
  DATA_IMAGE_MAX_BYTES,
  REWRITTEN_URL_MAX_CHARS,
  absoluteUrl,
  contentIdOf,
  looksLikeMarkupBreakout,
  safeRewrittenUrl,
  validDataImage,
} from "./urls";

/**
 * Where a viewer image URL came from, with the attributes the email wrote on its element (raw, as
 * `@edf/core/policy` `extractImageRefs` reads them), so the rewriter can make the same tracking
 * pixel decision (size, max-size, hidden style) as the analysis did: an `<img src>` carries its
 * `width`, `height` and `style`; a `background` attribute its element's `width` and `height`; a
 * url() in a `style` attribute that attribute (a hidden element's background is a pixel too) and
 * its element's `width` and `height` (a `<td width="1" height="1">` background is a pixel however
 * it is written; this is stricter than `extractImageRefs`, which only makes the viewer drop more);
 * a url() in a `<style>` element nothing. Absent attributes are null. What only layout can tell (an
 * element hidden through a parent, or sized by a stylesheet rule) is not caught.
 */
export interface ViewerImageContext {
  kind: "img" | "background-attr" | "css";
  width: string | null;
  height: string | null;
  style: string | null;
}

export interface ViewerRewriters {
  /** Absolute http(s) image URL → proxied URL, or null to drop it (src removed, alt kept). */
  image(url: string, context: ViewerImageContext): string | null;
  /**
   * Longest URL `image` returns (default and at most REWRITTEN_URL_MAX_CHARS); a longer one is
   * dropped. A CSS url() is sent to `image` only while this much room is left in the CSS cap,
   * counted as CSS writes it: a `(`, `)`, `'`, `"`, `\` or space counts twice (CSS escapes it),
   * a control character as a hex escape.
   */
  imageMaxLength?: number;
  /** cid: Content-ID (lower-cased, no brackets) → data:/proxied URL, or null to drop. */
  cid(contentId: string): string | null;
  /** http(s) or mailto: link → app `/out?…` URL, or null to disable the link. */
  link(url: string): string | null;
  /**
   * The width (CSS px, a positive integer) of the app's phone preview frame. When set, each
   * `<style>` media query that tests the device's width also gets a copy for that frame, with the
   * device-width read as the frame's width, so the email's phone styles switch on there as on a
   * real phone; frames wider than it are unchanged (css.ts PrepareOptions.phoneWidth).
   */
  phoneWidth?: number;
}

export interface ViewerSanitizeResult {
  /** Full HTML document for the viewer frame. */
  html: string;
  /** Number of images kept (proxied). */
  images: number;
  /** Number of links rewritten to /out. */
  links: number;
}

/** Input larger than the profile's limit is refused (callers show "too large"). */
export class SanitizeInputError extends Error {
  override readonly name = "SanitizeInputError";
  constructor(readonly code: "too_large" | "not_string") {
    super(code);
  }
}

/** Viewer input cap (raw email HTML; data: images over 256 KB are dropped anyway). */
export const VIEWER_MAX_INPUT_CHARS = 10 * 1024 * 1024;
/** Analysis input cap (pre-fetched images are inlined as data: URIs, ≤ 15 MB per email). */
export const ANALYSIS_MAX_INPUT_CHARS = 32 * 1024 * 1024;
/** Total `<style>` budget per document: 64 KB in the viewer (§11.5), 1 MB for analysis. */
export const VIEWER_STYLE_BUDGET_BYTES = CSS_MAX_BYTES;
export const ANALYSIS_STYLE_BUDGET_BYTES = 1024 * 1024;
/** edf-app-generated data: URIs for cid: parts. */
const CID_DATA_MAX_BYTES = 2 * 1024 * 1024;

const VIEWER_FORBID_TAGS = Object.freeze([
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "base",
  "link",
  "meta",
  "noscript",
  "template",
  "dialog",
  "area",
  "map",
  "svg",
  "math",
  "portal",
  "script",
]);
const FORBID_ATTR = Object.freeze([
  "srcset",
  "action",
  "formaction",
  "ping",
  "poster",
  "usemap",
  "xlink:href",
]);

/** Extra hardening beyond the §11.5 lists: URL-ish or behavior-bearing attributes emails never need. */
const EXTRA_STRIP_ATTR = new Set([
  "cite",
  "longdesc",
  "download",
  "target",
  "rel",
  "nonce",
  "integrity",
  "popover",
  "popovertarget",
  "popovertargetaction",
  "command",
  "commandfor",
]);

const VIEWER_CONFIG: Config = Object.freeze({
  WHOLE_DOCUMENT: true,
  USE_PROFILES: { html: true },
  FORBID_TAGS: [...VIEWER_FORBID_TAGS],
  FORBID_ATTR: [...FORBID_ATTR],
  ALLOW_DATA_ATTR: false,
});

const ANALYSIS_CONFIG: Config = Object.freeze({
  WHOLE_DOCUMENT: true,
  USE_PROFILES: { html: true },
  ADD_TAGS: ["title", "meta"],
  ADD_ATTR: ["data-o", "content"],
  FORBID_TAGS: VIEWER_FORBID_TAGS.filter((t) => t !== "meta"),
  FORBID_ATTR: [...FORBID_ATTR],
  ALLOW_DATA_ATTR: false,
});

const META_NAMES = new Set(["viewport", "color-scheme"]);
const META_CONTENT_RE = /^[A-Za-z0-9\s=,.;:_-]{0,256}$/;
const DATA_O_RE = /^\d{1,10}$/;

type Profile = "viewer" | "analysis";

interface Ctx {
  profile: Profile;
  rw: ViewerRewriters | null;
  images: number;
  links: number;
  styleBudget: number;
  /** `<style>` elements sanitized in onElement whose urls onElementKept rewrites. */
  styles: Map<Node, PreparedCss>;
  pendingNode: Node | null;
  pending: Map<string, string>;
}

let ctx: Ctx | null = null;
let purify: DOMPurify | null = null;

// ───────────────────────── URL rewrites ─────────────────────────

const STYLESHEET_CONTEXT: ViewerImageContext = Object.freeze({
  kind: "css",
  width: null,
  height: null,
  style: null,
});

function viewerImage(c: Ctx, value: string, context: ViewerImageContext): string | null {
  const rw = c.rw as ViewerRewriters;
  const t = value.trim();
  if (/^data:/i.test(t)) return validDataImage(t, DATA_IMAGE_MAX_BYTES);
  if (/^cid:/i.test(t)) {
    const id = contentIdOf(t);
    if (id === null) return null;
    const r: unknown = rw.cid(id);
    return typeof r === "string"
      ? (safeRewrittenUrl(r) ?? validDataImage(r, CID_DATA_MAX_BYTES))
      : null;
  }
  const u = absoluteUrl(t, ["http:", "https:"]);
  return u === null ? null : safeRewrittenUrl(rw.image(u.href, context), imageMaxLength(rw));
}

function imageMaxLength(rw: ViewerRewriters): number {
  return Math.min(REWRITTEN_URL_MAX_CHARS, rw.imageMaxLength ?? REWRITTEN_URL_MAX_CHARS);
}

/** The checks of rewriteImage/viewerImage that need no rewriter call (and have no side effect). */
function viewerImageAcceptable(value: string): boolean {
  if (typeof value !== "string" || looksLikeMarkupBreakout(value)) return false;
  const t = value.trim();
  if (/^data:/i.test(t)) return validDataImage(t, DATA_IMAGE_MAX_BYTES) !== null;
  if (/^cid:/i.test(t)) return contentIdOf(t) !== null;
  return absoluteUrl(t, ["http:", "https:"]) !== null;
}

/** D-S2: `images` counts proxied http(s)/cid: images in the output; data: from content is not. */
function countImage(c: Ctx, source: string): void {
  if (c.profile === "viewer" && !/^data:/i.test(source.trim())) c.images++;
}

function analysisImage(value: string): string | null {
  const t = value.trim();
  if (/^data:/i.test(t)) return validDataImage(t, ANALYSIS_MAX_INPUT_CHARS);
  if (/^cid:/i.test(t)) return contentIdOf(t) === null ? null : t;
  return absoluteUrl(t, ["http:", "https:"])?.href ?? null;
}

function rewriteImage(c: Ctx, value: string, context: ViewerImageContext): string | null {
  if (typeof value !== "string" || looksLikeMarkupBreakout(value)) return null;
  return c.profile === "viewer" ? viewerImage(c, value, context) : analysisImage(value);
}

function rewriteLink(c: Ctx, value: string): string | null {
  if (typeof value !== "string" || looksLikeMarkupBreakout(value)) return null;
  const u = absoluteUrl(value.trim(), ["http:", "https:", "mailto:"]);
  if (u === null) return null;
  if (c.profile === "analysis") return u.href;
  return safeRewrittenUrl((c.rw as ViewerRewriters).link(u.href));
}

function cssImage(c: Ctx, context: ViewerImageContext): CssImageRewriter {
  return (url) => rewriteImage(c, url, context);
}

function cssFilter(c: Ctx): CssImageFilter {
  return c.profile === "viewer" ? viewerImageAcceptable : () => true; // analysis has no side effects
}

/**
 * A viewer http(s) url mints a token, so it is rewritten only with room for the longest one the
 * rewriter returns. A style value DOMPurify would remove after our hook (its markup probes) is
 * dropped before that.
 */
function cssOptions(c: Ctx, attribute: boolean): EmitOptions {
  return {
    reserve: (url) =>
      c.profile === "viewer" && !/^(data|cid):/i.test(url.trim())
        ? imageMaxLength(c.rw as ViewerRewriters)
        : 0,
    reject: attribute ? looksLikeMarkupBreakout : undefined,
  };
}

// ───────────────────────── hooks ─────────────────────────

function isElement(n: Node): n is Element {
  return n.nodeType === 1;
}

function onElement(node: Node, data: UponSanitizeElementHookEvent): void {
  const c = ctx;
  if (c === null || !isElement(node)) return;
  if (data.tagName === "template") {
    // Forbidden, but DOMPurify still walks its content (which never reaches the output).
    if ("content" in node) (node as HTMLTemplateElement).content.replaceChildren();
    return;
  }
  if (data.tagName === "style") {
    const phoneWidth = c.rw?.phoneWidth;
    const p =
      c.styleBudget > 0
        ? prepareStylesheet(node.textContent ?? "", cssFilter(c), phoneWidth ? { phoneWidth } : {})
        : null;
    if (p === null) {
      node.remove();
      return;
    }
    c.styles.set(node, p);
    node.textContent = ""; // filled in onElementKept; DOMPurify's markup probes never see raw CSS
    return;
  }
  if (data.tagName === "meta" && c.profile === "analysis") {
    const name = (node.getAttribute("name") ?? "").trim().toLowerCase();
    const content = node.getAttribute("content") ?? "";
    if (
      !META_NAMES.has(name) ||
      node.hasAttribute("http-equiv") ||
      node.hasAttribute("charset") ||
      !META_CONTENT_RE.test(content)
    ) {
      node.remove();
    }
  }
}

function onElementKept(node: Node): void {
  const c = ctx;
  const p = c?.styles.get(node);
  if (c === null || p === undefined || !isElement(node)) return;
  c.styles.delete(node);
  const r = emitCss(p, cssImage(c, STYLESHEET_CONTEXT), c.styleBudget, cssOptions(c, false));
  c.styleBudget -= Buffer.byteLength(r.css, "utf8");
  if (r.css === "") {
    node.remove();
    return;
  }
  node.textContent = r.css;
  for (const u of r.urls) countImage(c, u);
}

function onBeforeAttributes(node: Node): void {
  const c = ctx;
  if (c === null) return;
  c.pendingNode = node;
  c.pending.clear();
  // Read the sizing attributes up front: DOMPurify visits attributes in an unspecified order, and
  // a `style` url() needs its element's size whichever comes first.
  if (!isElement(node)) return;
  for (const name of ["width", "height"]) {
    const v = node.getAttribute(name);
    if (v !== null) c.pending.set(name, v);
  }
}

function onAttribute(node: Element, ev: UponSanitizeAttributeHookEvent): void {
  const c = ctx;
  if (c === null) return;
  const name = ev.attrName;
  // The raw style, for the image rewriter's pixel decision (ViewerImageContext); width and
  // height were read in onBeforeAttributes.
  if (name === "style" && c.pendingNode === node) c.pending.set(name, ev.attrValue);
  if (name === "src" || name === "href" || name === "background") {
    if (c.pendingNode === node) c.pending.set(name, ev.attrValue);
    ev.keepAttr = false;
    return;
  }
  if (name === "style") {
    const p = prepareDeclarations(ev.attrValue, cssFilter(c));
    const own = c.pendingNode === node;
    const context: ViewerImageContext = {
      kind: "css",
      width: own ? (c.pending.get("width") ?? null) : null,
      height: own ? (c.pending.get("height") ?? null) : null,
      style: ev.attrValue,
    };
    const r = emitCss(p, cssImage(c, context), CSS_MAX_BYTES, cssOptions(c, true));
    if (r.css === "") {
      ev.keepAttr = false;
      return;
    }
    ev.attrValue = r.css;
    for (const u of r.urls) countImage(c, u);
    return;
  }
  if (EXTRA_STRIP_ATTR.has(name)) {
    ev.keepAttr = false;
    return;
  }
  if (c.profile === "analysis") {
    const tag = node.nodeName.toLowerCase();
    if (name === "data-o") {
      if (!DATA_O_RE.test(ev.attrValue)) ev.keepAttr = false;
    } else if (tag === "meta") {
      if (name !== "name" && name !== "content") ev.keepAttr = false;
    } else if (name === "content") {
      ev.keepAttr = false;
    }
  }
}

/**
 * Viewer only: every kept `<img>` gets `loading="lazy"` and `decoding="async"`, overriding what the
 * email wrote (DOMPurify allows both attributes, so `loading="eager"` would otherwise survive).
 * Set after DOMPurify's own attribute pass, so nothing removes them; the values are constants, so
 * no email text reaches them. Never in analysis mode: the renderer must load every image before it
 * measures and screenshots.
 *
 * Limit (verified in headless Chrome, 2026-09): browsers ignore `loading="lazy"` in a document
 * whose scripting is disabled (an HTML-spec anti-tracking rule), and edf-view serves the email in a
 * script-free sandbox (CSP `sandbox` without allow-scripts, and the frame's sandbox attribute).
 * So today every image of a previewed email is still fetched, even far below a gallery card's
 * visible top. `decoding="async"` does apply (images decode off the main thread). Capacity plans
 * must not count on lazy loading (FREE-TIER.md §8.4).
 */
function markLazy(node: Element): void {
  node.setAttribute("loading", "lazy");
  node.setAttribute("decoding", "async");
}

function onAfterAttributes(node: Node): void {
  const c = ctx;
  if (c === null) return;
  const pending = c.pendingNode === node ? new Map(c.pending) : new Map<string, string>();
  c.pendingNode = null;
  c.pending.clear();
  if (!isElement(node)) return;
  const tag = node.nodeName.toLowerCase();

  const width = pending.get("width") ?? null;
  const height = pending.get("height") ?? null;
  const src = pending.get("src");
  if (tag === "img" && src !== undefined) {
    const style = pending.get("style") ?? null;
    const r = rewriteImage(c, src, { kind: "img", width, height, style });
    if (r !== null) {
      node.setAttribute("src", r);
      countImage(c, src);
      if (c.profile === "viewer") markLazy(node);
    }
  }
  const bg = pending.get("background");
  if (bg !== undefined) {
    const r = rewriteImage(c, bg, { kind: "background-attr", width, height, style: null });
    if (r !== null) {
      node.setAttribute("background", r);
      countImage(c, bg);
    }
  }
  if (tag === "a") {
    const href = pending.get("href");
    const r = href === undefined ? null : rewriteLink(c, href);
    if (r !== null) {
      node.setAttribute("href", r);
      if (c.profile === "viewer") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
        c.links++;
      }
    }
  }
}

const WINDOW_MARK = Symbol.for("@edf/sanitize.window");
const PATCHED = Symbol.for("@edf/sanitize.inline-style-patch");

/**
 * Performance (DECISIONS.md D-S3): jsdom eagerly parses every `style` attribute into a CSSOM
 * declaration (`el.style`), which costs ~80% of parse time on email HTML. Neither DOMPurify nor
 * serialization ever reads `el.style` — attribute values are untouched — so for documents that
 * belong to OUR private window only, skip that sync. Other jsdom windows in the process are
 * unaffected. Best effort: if jsdom's internals move, the patch is skipped (slower, still correct).
 */
function skipInlineStyleCssom(win: object): void {
  (win as Record<symbol, unknown>)[WINDOW_MARK] = true;
  let req: NodeJS.Require;
  try {
    req = createRequire(import.meta.url);
  } catch {
    return;
  }
  for (const path of [
    "jsdom/lib/jsdom/living/nodes/HTMLElement-impl.js",
    "jsdom/lib/jsdom/living/nodes/SVGElement-impl.js",
  ]) {
    try {
      const proto = (req(path) as { implementation?: { prototype?: Record<PropertyKey, unknown> } })
        .implementation?.prototype;
      if (
        proto === undefined ||
        proto[PATCHED] === true ||
        typeof proto._attributeChangeSteps !== "function"
      )
        continue;
      const original = proto._attributeChangeSteps as (...a: unknown[]) => unknown;
      const parent = Object.getPrototypeOf(proto) as Record<PropertyKey, unknown>;
      const elementSteps = parent._attributeChangeSteps;
      if (typeof elementSteps !== "function") continue;
      proto._attributeChangeSteps = function (
        this: { _globalObject?: Record<symbol, unknown> },
        localName: unknown,
        oldValue: unknown,
        value: unknown,
        namespace: unknown,
      ) {
        if (
          namespace === null &&
          localName === "style" &&
          this._globalObject?.[WINDOW_MARK] === true
        ) {
          return (elementSteps as (...a: unknown[]) => unknown).call(
            this,
            localName,
            oldValue,
            value,
            namespace,
          );
        }
        return original.call(this, localName, oldValue, value, namespace);
      };
      proto[PATCHED] = true;
    } catch {
      // best effort only
    }
  }
}

function instance(): DOMPurify {
  if (purify !== null) return purify;
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    virtualConsole: new VirtualConsole(),
  });
  skipInlineStyleCssom(dom.window);
  const p = createDOMPurify(dom.window as unknown as WindowLike);
  if (!p.isSupported) throw new Error("DOMPurify is not supported on this jsdom window");
  p.addHook("uponSanitizeElement", onElement);
  p.addHook("afterSanitizeElements", onElementKept);
  p.addHook("beforeSanitizeAttributes", onBeforeAttributes);
  p.addHook("uponSanitizeAttribute", onAttribute);
  p.addHook("afterSanitizeAttributes", onAfterAttributes);
  purify = p;
  return p;
}

function run(profile: Profile, html: string, rw: ViewerRewriters | null): ViewerSanitizeResult {
  if (typeof html !== "string") throw new SanitizeInputError("not_string");
  const max = profile === "viewer" ? VIEWER_MAX_INPUT_CHARS : ANALYSIS_MAX_INPUT_CHARS;
  if (html.length > max) throw new SanitizeInputError("too_large");
  const p = instance();
  if (ctx !== null) throw new Error("sanitize is not re-entrant");
  const c: Ctx = {
    profile,
    rw,
    images: 0,
    links: 0,
    styleBudget: profile === "viewer" ? VIEWER_STYLE_BUDGET_BYTES : ANALYSIS_STYLE_BUDGET_BYTES,
    styles: new Map(),
    pendingNode: null,
    pending: new Map(),
  };
  ctx = c;
  try {
    const out = p.sanitize(html, profile === "viewer" ? VIEWER_CONFIG : ANALYSIS_CONFIG);
    return { html: `<!DOCTYPE html>\n${out}`, images: c.images, links: c.links };
  } finally {
    ctx = null;
    p.removed = []; // don't keep references to the last email's nodes
  }
}

/**
 * Analysis profile, used INSIDE the renderer before Chromium sees the HTML.
 * WHOLE_DOCUMENT; keeps <head> <style>, <title>, meta[name=viewport|color-scheme],
 * html[lang|dir] and every `data-o` attribute (byte-offset stamps for the clip mapping);
 * removes scripts, forms, event handlers, <link rel=dns-prefetch|preconnect|preload>, and
 * everything the viewer profile forbids except that images keep their original src
 * (the renderer intercepts every request). Returns a full HTML document string.
 */
export function sanitizeForAnalysis(html: string): string {
  return run("analysis", html, null).html;
}

/**
 * Viewer profile (DESIGN.md §11.5): the exact FORBID_TAGS / FORBID_ATTR lists, then
 * `afterSanitizeAttributes` rewrites img[src] / [background] / a[href] through `rw`,
 * data:image/(png|gif|jpeg|webp) ≤ 256 KB allowed, relative URLs removed, and CSS in <style>
 * and style= rewritten with css-tree (see rewriteCss). Links get
 * target=_blank rel="noopener noreferrer nofollow". Kept images get loading="lazy" and
 * decoding="async" (see markLazy for why lazy has no effect in today's script-free frame).
 */
export function sanitizeForViewer(html: string, rw: ViewerRewriters): ViewerSanitizeResult {
  if (
    typeof rw !== "object" ||
    rw === null ||
    typeof rw.image !== "function" ||
    typeof rw.cid !== "function" ||
    typeof rw.link !== "function"
  ) {
    throw new TypeError("sanitizeForViewer: rewriters required");
  }
  const max = rw.imageMaxLength;
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
    throw new TypeError("sanitizeForViewer: imageMaxLength must be a positive integer");
  }
  const phone = rw.phoneWidth;
  if (phone !== undefined && !(Number.isInteger(phone) && phone > 0)) {
    throw new TypeError("sanitizeForViewer: phoneWidth must be a positive integer");
  }
  return run("viewer", html, rw);
}
