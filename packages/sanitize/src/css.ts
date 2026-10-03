/**
 * CSS rewriting with css-tree (DESIGN.md §11.5).
 *
 * Allowlist-shaped, fail-closed walk over the css-tree AST, in two steps:
 * - `prepare*` sanitizes the AST and blanks every kept `url()` (and every string inside
 *   `image-set()`/`-webkit-image-set()`); a url the side-effect-free filter refuses drops the
 *   whole declaration;
 * - `emitCss` sends a url to the image rewriter only once its declaration is otherwise valid,
 *   the paranoid scan has passed and the declaration fits the output cap (with room reserved for
 *   every rewritten url in it), so a viewer image token is not minted for a url that is then
 *   discarded; a null result, or no room, drops the whole declaration (a url with a reserve
 *   refused after another one was rewritten becomes an empty image instead); sizes count the
 *   escapes css-tree writes in a url (`\(`), and a result longer than its reserve is refused;
 * - dropped: `@import`, `@font-face`, `@namespace`, `@charset`, `@document`, `@property` and every
 *   at-rule not on the allowlist; custom properties; `behavior`, `-moz-binding`, `-o-link*`,
 *   `-ms-filter` and any property containing "behavior"/"binding"; `expression()`, `attr()`,
 *   `image()`, `src()`, `element()`, `paint()` and a url() spelled with escapes;
 * - anything css-tree could not parse (`Raw` nodes) is dropped, which neutralizes escape and
 *   comment tricks (`u\rl(`, `\75 rl(`, `ur/**\/l(`) whose meaning a browser might read
 *   differently; names are compared after CSS escape decoding and ASCII lower-casing;
 * - comments, CDO/CDC and unknown node types are dropped;
 * - output is generated from the cleaned AST, `<` before `/`, `!` or a word character is
 *   separated by a space (so no `</style` and no DOMPurify markup probe hit), and the result is
 *   capped (64 KB by default) at a rule/declaration boundary: children are emitted in order
 *   until one does not fit, url declarations that don't fit being dropped first;
 * - a paranoid text scan drops the whole output if a forbidden token still appears; it runs
 *   before any rewrite on every child that could still fit the cap, and again on the output.
 */
import {
  List,
  clone,
  generate,
  ident,
  parse,
  walk,
  type CssNode,
  type ListItem,
  type MediaQuery,
  type Url,
  url as cssUrl,
} from "css-tree";

/** Receives the raw url() value; returns the replacement URL or null to drop the declaration. */
export type CssImageRewriter = (url: string) => string | null;
/** Side-effect-free check of a raw url() value; false drops the declaration before any rewrite. */
export type CssImageFilter = (url: string) => boolean;

/** Rewritten CSS and the raw values of the urls it contains, in order. */
export interface CssRewrite {
  css: string;
  urls: string[];
}

interface PendingUrl {
  node: Url;
  value: string;
}

/** A sanitized AST whose kept urls are still blank (`url()`); nothing was rewritten yet. */
export interface PreparedCss {
  children: CssNode[];
  /** Generated text of each child with blank urls: its exact final size when it has no urls. */
  blank: string[];
  /** Whether each child has a declaration with urls (whose final size is unknown yet). */
  hasUrls: boolean[];
  /** Blanked urls of each kept declaration. */
  pending: Map<CssNode, PendingUrl[]>;
  context: "stylesheet" | "declarationList";
}

/** A 1×1 transparent GIF: stands in for a refused url whose declaration must stay. */
const BLANK_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** DESIGN.md §11.5: CSS is capped at 64 KB. */
export const CSS_MAX_BYTES = 64 * 1024;
/** Input beyond this is not parsed at all (it could never fit the output cap). */
const CSS_MAX_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_DEPTH = 16;

const ALLOWED_AT_RULES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "starting-style",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
  "-o-keyframes",
  "page",
  "top-left-corner",
  "top-left",
  "top-center",
  "top-right",
  "top-right-corner",
  "bottom-left-corner",
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "bottom-right-corner",
  "left-top",
  "left-middle",
  "left-bottom",
  "right-top",
  "right-middle",
  "right-bottom",
  "counter-style",
  "font-feature-values",
  "styleset",
  "stylistic",
  "character-variant",
  "swash",
  "ornaments",
  "annotation",
  "historical-forms",
]);

const DENY_PROPERTIES = new Set([
  "behavior",
  "-ms-behavior",
  "-moz-binding",
  "binding",
  "-o-link",
  "-o-link-source",
  "-ms-filter",
  "src",
]);
const DENY_FUNCTIONS = new Set([
  "expression",
  "url",
  "src",
  "attr",
  "image",
  "-webkit-image",
  "element",
  "-moz-element",
  "paint",
]);
const IMAGE_SET_FUNCTIONS = new Set(["image-set", "-webkit-image-set"]);
const SAFE_VALUE_NODES = new Set([
  "Identifier",
  "Number",
  "Dimension",
  "Percentage",
  "Hash",
  "Operator",
  "WhiteSpace",
  "UnicodeRange",
  "Ratio",
  "String",
]);

/** ASCII-only lower-casing (CSS names are ASCII case-insensitive; no Unicode case folding). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Decode CSS escapes in a name, then ASCII-lower-case it. Undecodable names never match allowlists. */
export function cssName(raw: string): string {
  try {
    return asciiLower(ident.decode(raw));
  } catch {
    return "\u0000invalid";
  }
}

interface State {
  accept: CssImageFilter;
  pending: Map<CssNode, PendingUrl[]>;
  /** PrepareOptions.phoneWidth. */
  phoneWidth: number | null;
}

/** Options for `prepareStylesheet`. */
export interface PrepareOptions {
  /**
   * The width (CSS px) of the viewer's phone frame; absent: no rewrite. A frame no wider than this
   * is the phone preview, and every other frame is wider. `device-width` media features describe
   * the screen, so inside a frame on a desktop browser they never match as they would on a phone,
   * and an email's phone styles written with them never switch on in the phone preview. Each
   * media query that tests the device's width is therefore split in two (`phoneMediaQueries`):
   * as written, for frames wider than the phone; and with every device-width feature read as the
   * frame's width (`max-device-width` → `max-width`, `min-device-width` → `min-width`,
   * `device-width` → `width`), for the phone frame only. A frame wider than the phone evaluates
   * exactly what the email wrote; the phone frame evaluates it as a 375 px phone would.
   */
  phoneWidth?: number;
}

function forEachRemovable(list: List<CssNode>, keep: (node: CssNode) => boolean): void {
  const drop: ListItem<CssNode>[] = [];
  list.forEach((node, item) => {
    if (!keep(node)) drop.push(item);
  });
  for (const item of drop) list.remove(item);
}

/** Returns false if the declaration must be dropped. Blanks Url nodes, collecting them in `urls`. */
function sanitizeValueList(
  list: List<CssNode>,
  st: State,
  urls: PendingUrl[],
  inImageSet: boolean,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  let ok = true;
  list.forEach((node, item) => {
    if (!ok) return;
    switch (node.type) {
      case "Url": {
        if (!st.accept(node.value)) ok = false;
        else {
          urls.push({ node, value: node.value });
          node.value = "";
        }
        return;
      }
      case "String": {
        if (!inImageSet) return;
        // Strings inside image-set() are URLs.
        if (!st.accept(node.value)) ok = false;
        else {
          const url: Url = { type: "Url", value: "" };
          urls.push({ node: url, value: node.value });
          item.data = url;
        }
        return;
      }
      case "Function": {
        const name = cssName(node.name);
        if (DENY_FUNCTIONS.has(name)) {
          ok = false;
          return;
        }
        if (IMAGE_SET_FUNCTIONS.has(name)) {
          ok = sanitizeValueList(node.children, st, urls, true, depth + 1);
          return;
        }
        if (name === "type" && inImageSet) {
          // type("image/png"): a MIME type string, not a URL.
          let onlyString = true;
          node.children.forEach((c) => {
            if (c.type !== "String" && c.type !== "WhiteSpace") onlyString = false;
          });
          ok = onlyString;
          return;
        }
        ok = sanitizeValueList(node.children, st, urls, false, depth + 1);
        return;
      }
      case "Parentheses":
        ok = sanitizeValueList(node.children, st, urls, false, depth + 1);
        return;
      default:
        if (!SAFE_VALUE_NODES.has(node.type)) ok = false;
    }
  });
  return ok;
}

function sanitizeDeclaration(node: CssNode, st: State): boolean {
  if (node.type !== "Declaration") return false;
  const prop = cssName(node.property);
  if (prop.startsWith("--")) return false;
  if (DENY_PROPERTIES.has(prop) || prop.includes("behavior") || prop.includes("binding"))
    return false;
  if (node.value.type !== "Value") return false;
  const urls: PendingUrl[] = [];
  if (!sanitizeValueList(node.value.children, st, urls, false, 0)) return false;
  if (node.value.children.isEmpty) return false;
  if (urls.length > 0) st.pending.set(node, urls);
  return true;
}

/** True if a prelude contains anything that could fetch or that we could not parse. */
function preludeUnsafe(prelude: CssNode): boolean {
  let bad = false;
  walk(prelude, (n) => {
    if (n.type === "Raw" || n.type === "Url") bad = true;
    else if (n.type === "Function") {
      const name = cssName(n.name);
      if (DENY_FUNCTIONS.has(name) || IMAGE_SET_FUNCTIONS.has(name)) bad = true;
    }
  });
  return bad;
}

function sanitizeBlockChildren(list: List<CssNode>, st: State, depth: number): void {
  forEachRemovable(list, (child) => {
    switch (child.type) {
      case "Declaration":
        return sanitizeDeclaration(child, st);
      case "Rule":
        return sanitizeRule(child, st, depth + 1);
      case "Atrule":
        return sanitizeAtrule(child, st, depth + 1);
      default:
        return false;
    }
  });
}

function sanitizeRule(node: CssNode, st: State, depth: number): boolean {
  if (node.type !== "Rule" || depth > MAX_DEPTH) return false;
  if (node.prelude.type !== "SelectorList" || preludeUnsafe(node.prelude)) return false;
  sanitizeBlockChildren(node.block.children, st, depth);
  return !node.block.children.isEmpty;
}

function sanitizeAtrule(node: CssNode, st: State, depth: number): boolean {
  if (node.type !== "Atrule" || depth > MAX_DEPTH) return false;
  const name = cssName(node.name);
  if (!ALLOWED_AT_RULES.has(name)) return false;
  if (node.prelude !== null && (node.prelude.type === "Raw" || preludeUnsafe(node.prelude)))
    return false;
  if (name === "media" && st.phoneWidth !== null && node.prelude !== null)
    phoneMediaQueries(node.prelude, st.phoneWidth);
  if (node.block === null) return name === "layer"; // `@layer a, b;` is the only statement form kept
  sanitizeBlockChildren(node.block.children, st, depth);
  return !node.block.children.isEmpty;
}

/** The device-width media features and the frame-width features a phone frame reads them as. */
const DEVICE_WIDTH_FEATURES: Readonly<Record<string, string>> = {
  "device-width": "width",
  "min-device-width": "min-width",
  "max-device-width": "max-width",
};

/** The frame-width name of a device-width feature name (`max-device-width` → `max-width`), else null. */
function frameWidthName(name: string): string | null {
  return DEVICE_WIDTH_FEATURES[cssName(name)] ?? null;
}

/** Calls `visit` for every device-width feature in `node`: a `(max-device-width: …)` or a range's name. */
function forEachDeviceWidth(
  node: CssNode,
  visit: (n: { type: "Feature"; name: string } | { type: "Identifier"; name: string }) => void,
): void {
  walk(node, (n) => {
    if (n.type === "Feature" && frameWidthName(n.name) !== null) visit(n);
    else if (n.type === "FeatureRange") {
      for (const side of [n.left, n.middle, n.right]) {
        if (side?.type === "Identifier" && cssName(side.name) === "device-width") visit(side);
      }
    }
  });
}

/** `(min-width: Npx)` / `(max-width: Npx)`: the frame-width guard of a split query. */
function widthFeature(name: "min-width" | "max-width", px: number): CssNode {
  return {
    type: "Feature",
    kind: "media",
    name,
    value: { type: "Dimension", value: String(px), unit: "px" },
  } as CssNode;
}

/**
 * `query` with `guard` added: `<query> and <guard>`, its condition wrapped in parentheses first
 * when it has a top-level `or` / `not` (which can't take a further `and` unparenthesized).
 */
function withGuard(query: MediaQuery, guard: CssNode): MediaQuery {
  const q = clone(query) as MediaQuery;
  const condition = q.condition;
  if (!condition) return q; // no condition, no device-width feature: never split
  let bare = true;
  condition.children.forEach((c) => {
    if (c.type === "Identifier" && ["or", "not"].includes(cssName(c.name))) bare = false;
  });
  const and: CssNode = { type: "Identifier", name: "and" };
  q.condition = {
    type: "Condition",
    kind: "media",
    children: bare
      ? new List<CssNode>().fromArray([...condition.children.toArray(), and, guard])
      : new List<CssNode>().fromArray([condition, and, guard]),
  };
  return q;
}

/**
 * PrepareOptions.phoneWidth: every query of an `@media` prelude that tests the device's width
 * becomes two, `<query> and (min-width: phone + 1px)` and `<query, device-width read as width>
 * and (max-width: phone px)`. Whole px on purpose: the phone frame is exactly `phoneWidth` wide
 * and every other frame far wider, and the classic syntax works in every browser that shows the
 * app. A negated query (`not screen and …`) can't take the guard, so it stays as written.
 */
function phoneMediaQueries(prelude: CssNode, phoneWidth: number): void {
  walk(prelude, {
    visit: "MediaQueryList",
    enter(list) {
      const out: CssNode[] = [];
      let changed = false;
      list.children.forEach((query) => {
        let device = false;
        if (query.type === "MediaQuery" && query.condition)
          forEachDeviceWidth(query.condition, () => (device = true));
        if (!device || query.type !== "MediaQuery" || cssName(query.modifier ?? "") === "not") {
          out.push(query);
          return;
        }
        changed = true;
        out.push(withGuard(query, widthFeature("min-width", phoneWidth + 1)));
        const phone = withGuard(query, widthFeature("max-width", phoneWidth));
        forEachDeviceWidth(phone, (n) => {
          n.name = n.type === "Feature" ? (frameWidthName(n.name) as string) : "width";
        });
        out.push(phone);
      });
      if (changed) list.children = new List<CssNode>().fromArray(out);
    },
  });
}

/** Break `</`, `<!` and `<x` so the text can never close a <style> or look like markup. */
function neutralizeAngles(s: string): string {
  return s.replace(/<(?=[/!?\w])/g, "< ");
}

/** Last line of defense: tokens that must never survive, even inside strings. */
function paranoidScanOk(css: string): boolean {
  const decoded = css
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : "�";
    })
    .replace(/\\([^\n])/g, "$1");
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  const squashed = asciiLower(decoded).replace(/[\s\u0000-\u001f]+/g, "");
  if (
    /expression\(|javascript:|vbscript:|-moz-binding|behavior:|@import|@font-face|@namespace/.test(
      squashed,
    )
  ) {
    return false;
  }
  // Markup breakouts are checked on the literal text (neutralizeAngles guarantees none survive).
  return !/<[/!?\w]/.test(css);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Bytes a blank `url()` grows by when its value is `value`, as generateChild writes it. */
function urlBytes(value: string): number {
  return byteLength(neutralizeAngles(cssUrl.encode(value))) - "url()".length;
}

function parseSafely(css: string, context: "stylesheet" | "declarationList"): CssNode | null {
  try {
    return parse(css.length > CSS_MAX_INPUT_CHARS ? css.slice(0, CSS_MAX_INPUT_CHARS) : css, {
      context,
      positions: false,
      parseValue: true,
      parseAtrulePrelude: true,
      parseRulePrelude: true,
      parseCustomProperty: false,
      onParseError: () => undefined,
    });
  } catch {
    return null; // e.g. stack exhaustion on absurd nesting
  }
}

function generateChild(child: CssNode): string {
  const g = neutralizeAngles(generate(child));
  return child.type === "Atrule" && child.block === null && !g.endsWith(";") ? `${g};` : g;
}

function prepare(
  css: string,
  context: PreparedCss["context"],
  accept: CssImageFilter,
  { phoneWidth }: PrepareOptions = {},
): PreparedCss | null {
  if (typeof css !== "string" || css.length === 0) return null;
  const ast = parseSafely(css, context);
  const st: State = { accept, pending: new Map(), phoneWidth: phoneWidth ?? null };
  const withUrls = new Set<CssNode>();
  const keep = (child: CssNode, sanitize: (child: CssNode) => boolean): boolean => {
    const before = st.pending.size;
    const ok = sanitize(child);
    if (st.pending.size > before) withUrls.add(child);
    return ok;
  };
  if (ast?.type === "StyleSheet") {
    forEachRemovable(ast.children, (child) =>
      keep(child, (c) => {
        if (c.type === "Rule") return sanitizeRule(c, st, 0);
        if (c.type === "Atrule") return sanitizeAtrule(c, st, 0);
        return false;
      }),
    );
  } else if (ast?.type === "DeclarationList") {
    forEachRemovable(ast.children, (child) => keep(child, (c) => sanitizeDeclaration(c, st)));
  } else {
    return null;
  }
  const children: CssNode[] = [];
  const blank: string[] = [];
  const hasUrls: boolean[] = [];
  try {
    ast.children.forEach((child) => {
      children.push(child);
      blank.push(generateChild(child));
      hasUrls.push(withUrls.has(child));
    });
  } catch {
    return null;
  }
  return children.length === 0 ? null : { children, blank, hasUrls, pending: st.pending, context };
}

/** Sanitize a stylesheet (the contents of a `<style>` element); urls stay blank. */
export function prepareStylesheet(
  css: string,
  accept: CssImageFilter,
  options: PrepareOptions = {},
): PreparedCss | null {
  return prepare(css, "stylesheet", accept, options);
}

/** Sanitize a declaration list (the value of a `style=""` attribute); urls stay blank. */
export function prepareDeclarations(css: string, accept: CssImageFilter): PreparedCss | null {
  return prepare(css, "declarationList", accept);
}

/**
 * Bytes of room a url needs before it may be rewritten: its longest accepted output (as written,
 * escapes included) if rewriting it has a side effect, else 0 (those urls are rewritten first,
 * their real size known).
 */
export type CssImageReserve = (url: string) => number;

export interface EmitOptions {
  reserve?: CssImageReserve;
  /** Extra check on the text (before any rewrite, and on the output); true drops everything. */
  reject?: (css: string) => boolean;
}

interface Resolver {
  rewrite: CssImageRewriter;
  reserve: CssImageReserve;
  pending: Map<CssNode, PendingUrl[]>;
  maxBytes: number;
  /**
   * Output bytes if the current child is emitted: its blank text, minus dropped declarations,
   * plus the urls rewritten so far (escaped). Never below the real size.
   */
  bytes: number;
  /** Raw values of the rewritten urls kept in the current child. */
  urls: string[];
}

function resolveDeclaration(node: CssNode, urls: PendingUrl[], r: Resolver): boolean {
  const drop = (): false => {
    for (const u of urls) u.node.value = "";
    r.bytes -= byteLength(generate(node)); // the blank declaration, as counted in `bytes`
    return false;
  };
  // Urls without side effects first; then the others only if all of them fit with their reserve.
  const later: { u: PendingUrl; need: number }[] = [];
  const kept: string[] = [];
  let reserved = 0;
  let added = 0;
  for (const u of urls) {
    const need = r.reserve(u.value);
    if (need > 0) {
      later.push({ u, need });
      // A reserved url after the first may end up as BLANK_IMAGE, so it needs room for that too.
      reserved += later.length === 1 ? need : Math.max(need, urlBytes(BLANK_IMAGE));
      continue;
    }
    const out = r.rewrite(u.value);
    if (out === null) return drop();
    u.node.value = out;
    added += urlBytes(out);
    kept.push(u.value);
  }
  if (r.bytes + added + reserved > r.maxBytes) return drop();
  let sideEffect = false;
  for (const { u, need } of later) {
    let out = r.rewrite(u.value);
    // Only its reserve was checked for room, so a longer result is refused.
    if (out !== null && urlBytes(out) > need) out = null;
    // Once a rewrite had its side effect, a refused sibling becomes an empty image instead of
    // dropping the declaration (and the rewritten url with it).
    if (out === null && !sideEffect) return drop();
    u.node.value = out ?? BLANK_IMAGE;
    added += urlBytes(u.node.value);
    if (out !== null) {
      sideEffect = true;
      kept.push(u.value);
    }
  }
  r.bytes += added;
  for (const u of kept) r.urls.push(u);
  return true;
}

/** Rewrites the blank urls under `node`, dropping declarations that are refused or don't fit. */
function resolveNode(node: CssNode, r: Resolver): boolean {
  if (node.type === "Declaration") {
    const urls = r.pending.get(node);
    return urls === undefined || resolveDeclaration(node, urls, r);
  }
  if ((node.type === "Rule" || node.type === "Atrule") && node.block !== null) {
    forEachRemovable(node.block.children, (child) => resolveNode(child, r));
    return !node.block.children.isEmpty;
  }
  return true;
}

/**
 * Emit children in order while they fit in `maxBytes`, rewriting their urls on the way. The
 * paranoid scan (and `reject`) runs first, on the blank text of every child that could still be
 * emitted. A url with a reserve is rewritten only if its child still fits with the reserves of
 * every such url in its declaration; otherwise the declaration is dropped. A reserved url the
 * rewriter refuses after one it accepted in the same declaration is replaced by an empty image;
 * a result longer than its reserve (escapes included) counts as refused. So `rewrite` is called
 * with a reserved url only if its result ends up in the output, unless that result is longer
 * than the reserve promised.
 */
export function emitCss(
  p: PreparedCss | null,
  rewrite: CssImageRewriter,
  maxBytes: number,
  { reserve = () => 0, reject = () => false }: EmitOptions = {},
): CssRewrite {
  if (p === null || maxBytes <= 0) return { css: "", urls: [] };
  const sep = p.context === "stylesheet" ? "" : ";";
  const ok = (css: string) => paranoidScanOk(css) && !reject(css);
  // A child is reached only if every earlier child without urls was emitted at its exact blank
  // size, so once those alone overflow, no later child can be emitted. (No token can span two
  // children: each ends with `}` or is followed by `;`.)
  let reachable = 0;
  for (let fixed = 0; reachable < p.children.length; reachable++) {
    if (p.hasUrls[reachable] === true) continue;
    fixed += byteLength(p.blank[reachable] as string);
    if (fixed > maxBytes) break;
  }
  if (!ok(p.blank.slice(0, reachable).join(sep))) return { css: "", urls: [] };
  let out = "";
  let bytes = 0;
  const urls: string[] = [];
  for (let i = 0; i < p.children.length; i++) {
    const child = p.children[i] as CssNode;
    const prefix = out === "" ? "" : sep;
    const r: Resolver = {
      rewrite,
      reserve,
      pending: p.pending,
      maxBytes,
      bytes: bytes + byteLength(prefix + (p.blank[i] as string)),
      urls: [],
    };
    if (!resolveNode(child, r)) continue;
    let piece: string;
    try {
      piece = prefix + generateChild(child);
    } catch {
      return { css: "", urls: [] };
    }
    const b = byteLength(piece);
    if (bytes + b > maxBytes) break;
    out += piece;
    bytes += b;
    for (const u of r.urls) urls.push(u);
  }
  return ok(out) ? { css: out, urls } : { css: "", urls: [] };
}

/** Rewrite a stylesheet (the contents of a `<style>` element). */
export function rewriteStylesheet(
  css: string,
  image: CssImageRewriter,
  maxBytes: number = CSS_MAX_BYTES,
): string {
  return emitCss(
    prepareStylesheet(css, () => true),
    image,
    maxBytes,
  ).css;
}

/** Rewrite a declaration list (the value of a `style=""` attribute). */
export function rewriteDeclarations(
  css: string,
  image: CssImageRewriter,
  maxBytes: number = CSS_MAX_BYTES,
): string {
  return emitCss(
    prepareDeclarations(css, () => true),
    image,
    maxBytes,
  ).css;
}
