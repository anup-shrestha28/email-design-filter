/**
 * Independent safety oracle: re-parses sanitizer output with a fresh jsdom and css-tree and
 * asserts that nothing executable or unproxied survives.
 */
import { parse, walk } from "css-tree";
import { JSDOM, VirtualConsole } from "jsdom";

export const IMG_PREFIX = "https://view.example/img/";
export const CID_PREFIX = "https://view.example/cid/";
export const OUT_PREFIX = "https://app.example/out?u=";

export const rw = {
  image: (u: string) => `${IMG_PREFIX}${Buffer.from(u).toString("base64url")}`,
  cid: (c: string) => `${CID_PREFIX}${encodeURIComponent(c)}`,
  link: (u: string) => `${OUT_PREFIX}${encodeURIComponent(u)}`,
};

const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "link",
  "meta",
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
  "noscript",
  "template",
  "dialog",
  "area",
  "map",
  "svg",
  "math",
  "portal",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  "isindex",
  "title",
]);
const FORBIDDEN_ATTRS = new Set([
  "srcset",
  "action",
  "formaction",
  "ping",
  "poster",
  "usemap",
  "xlink:href",
  "srcdoc",
  "http-equiv",
  "content",
  "data",
  "codebase",
  "cite",
  "longdesc",
  "lowsrc",
  "dynsrc",
  "manifest",
  "download",
  "popover",
  "is",
]);

const DATA_IMAGE = /^data:image\/(png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function urlOk(v: string, kind: "img" | "link"): boolean {
  if (kind === "link") return v.startsWith(OUT_PREFIX);
  return v.startsWith(IMG_PREFIX) || v.startsWith(CID_PREFIX) || DATA_IMAGE.test(v);
}

export function cssProblems(css: string, context: "stylesheet" | "declarationList"): string[] {
  const problems: string[] = [];
  if (/<[/!\w]/.test(css)) problems.push(`markup in css: ${css.slice(0, 80)}`);
  const ast = parse(css, {
    context,
    parseValue: true,
    onParseError: () => problems.push("css parse error"),
  });
  walk(ast, (node) => {
    if (node.type === "Url" && !urlOk(node.value, "img"))
      problems.push(`unproxied url: ${node.value}`);
    if (node.type === "Raw") problems.push(`raw css: ${node.value.slice(0, 60)}`);
    if (
      node.type === "Atrule" &&
      /import|font-face|namespace|document|charset|property/i.test(node.name)
    ) {
      problems.push(`at-rule: ${node.name}`);
    }
    if (node.type === "Declaration" && /behavior|binding|^-o-link|^--/i.test(node.property)) {
      problems.push(`property: ${node.property}`);
    }
    if (
      node.type === "Function" &&
      /^(expression|url|attr|image|src|element|-moz-element|paint)$/i.test(node.name)
    ) {
      problems.push(`function: ${node.name}`);
    }
  });
  if (/expression\s*\(|javascript:|vbscript:/i.test(css)) problems.push("script-ish css");
  return problems;
}

/** Returns a list of problems (empty = safe). */
export function problems(html: string): string[] {
  const out: string[] = [];
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tag = el.localName;
    if (FORBIDDEN_ELEMENTS.has(tag)) out.push(`element <${tag}>`);
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") out.push(`foreign element ${tag}`);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) out.push(`handler ${name} on <${tag}>`);
      if (FORBIDDEN_ATTRS.has(name)) out.push(`attr ${name} on <${tag}>`);
      if (name.startsWith("data-")) out.push(`data attr ${name}`);
      if ((name === "src" || name === "background") && !urlOk(attr.value, "img"))
        out.push(`unproxied ${name}=${attr.value.slice(0, 80)}`);
      if (name === "src" && tag !== "img") out.push(`src on <${tag}>`);
      if (name === "href" && (tag !== "a" || !urlOk(attr.value, "link")))
        out.push(`bad href on <${tag}>: ${attr.value.slice(0, 80)}`);
      if (name === "style") out.push(...cssProblems(attr.value, "declarationList"));
      if (/javascript:|vbscript:|data:text/i.test(attr.value))
        out.push(`script-ish value in ${name}`);
    }
    if (tag === "a" && el.hasAttribute("href")) {
      if (el.getAttribute("target") !== "_blank") out.push("link without target=_blank");
      if (el.getAttribute("rel") !== "noopener noreferrer nofollow") out.push("link without rel");
    }
    if (tag === "style") out.push(...cssProblems(el.textContent ?? "", "stylesheet"));
  }
  if (!html.startsWith("<!DOCTYPE html>")) out.push("missing doctype");
  return out;
}
