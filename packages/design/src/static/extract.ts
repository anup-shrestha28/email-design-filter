/**
 * `extractStaticDesign` — static design features and `fonts_static` at ingest
 * (DESIGN-SCORE §2 "Static features"; FREE-TIER.md §5.4 static checks; DESIGN.md §8.1 step 1).
 *
 * Pure and deterministic, no network. Runs on hostile input: bounded traversals, capped
 * outputs, and it never throws: an internal failure yields zero counts marked `unavailable`, which
 * scoring reads as "not evaluated", never as "no links / no unsubscribe / no button".
 */
import { CLIP_BYTES, STATIC_FIRST_SCREEN_CHARS } from "../constants";
import type { FontFeatures } from "../features/fonts";
import {
  MAX_STATIC_UNSUBSCRIBE_LINKS,
  type CompatFeature,
  type StaticDesignFeatures,
} from "../features/static";
import { altStats, isInformativeImage, isTrackingPixel } from "../util/images";
import { prescanInjection } from "../ai/guards";
import {
  BUTTON_IMAGE_HINT,
  GENERIC_LABELS,
  PLACEHOLDER_HOSTS,
  PREFERENCES_TEXT,
  RECEIVING_TEXT,
  UNSUBSCRIBE_TEXT,
  VIEW_ONLINE_TEXT,
  countMergeTags,
  firstMergeTag,
  mergeTagSnippet,
  hasMergeTag,
  looksLikePostalAddress,
} from "../util/patterns";
import {
  capsChars,
  collapseWhitespace,
  countedChars,
  normalizeLabel,
  proseStats,
  scriptProfile,
  wordCount,
  words,
} from "../util/text";
import { urlHost } from "../util/url";
import { brandOf, isOtherBrandLink, isUnsubscribeLink } from "../util/links";
import { emptyCompatHits, scanDeclarations } from "./css";
import { buildStaticDocument, type LinkFact, type StaticDocument } from "./document";
import { isPointerLabel, linkSentence } from "./link-context";
import {
  attr,
  childrenOf,
  isElement,
  isText,
  parseInlineStyle,
  parsePx,
  tag,
  walk,
  type P5Element,
  type P5Node,
} from "./dom";
import { extractFontsStatic } from "./fonts-static";

/** Non-HTML facts static extraction needs (FREE-TIER.md §5.4). */
export interface StaticContext {
  /** UTF-8 bytes of the decoded text/html part (X1). */
  htmlBytes: number;
  subject: string | null;
  /** https List-Unsubscribe URIs (U1 host/path match). */
  listUnsubscribeHttps: string[];
  senderDomain: string | null;
  /** Detected language (ISO 639-1). */
  language: string | null;
}

export interface StaticExtraction {
  static: StaticDesignFeatures;
  fonts: FontFeatures;
}

// ───────────────────────── links ─────────────────────────

/** Merge-tag facts: body count, first-screen flag and the first first-screen tag (token only). */
function mergeTagFacts(
  body: number,
  firstScreenText: string,
  snippet: string | null,
): StaticDesignFeatures["mergeTags"] {
  const sample = firstMergeTag(firstScreenText);
  const out: StaticDesignFeatures["mergeTags"] = {
    body: Math.min(1000, body),
    firstScreen: sample !== null || hasMergeTag(firstScreenText),
  };
  if (sample !== null) out.sample = sample;
  if (sample !== null && snippet !== null) out.snippet = snippet;
  return out;
}

function linkName(l: LinkFact): string {
  const aria = collapseWhitespace(l.ariaLabel ?? "");
  if (aria) return aria;
  const text = collapseWhitespace(l.text);
  if (text) return text;
  const alts = collapseWhitespace(l.imgAlts.join(" "));
  if (alts) return alts;
  return collapseWhitespace(l.title ?? "");
}

/** Counted non-link characters in the nearest `p`/`li`/`td` around a link (A3 generic rule). */
function surroundingNonLinkChars(el: P5Element): number {
  let container: P5Element | null = null;
  let p = el.parentNode;
  let guard = 0;
  while (p && isElement(p as P5Element) && guard++ < 200) {
    const t = tag(p as P5Element);
    if (t === "p" || t === "li" || t === "td" || t === "th") {
      container = p as P5Element;
      break;
    }
    p = (p as P5Element).parentNode;
  }
  if (!container) return 0;
  let chars = 0;
  walk(container, (n) => {
    if (chars > 40) return false;
    if (isElement(n) && tag(n) === "a") return false;
    if (isText(n)) chars += countedChars(n.value);
    return true;
  });
  return chars;
}

// ───────────────────────── tables (A5) ─────────────────────────

/** Static data-table heuristic after axe-core's `isDataTable` (the markup-only rules). */
export function isLayoutTableStatic(table: P5Element): {
  layout: boolean;
  presentational: boolean;
} {
  const role = (attr(table, "role") ?? "").trim().toLowerCase();
  if (role === "presentation" || role === "none") return { layout: true, presentational: true };
  if (role === "table" || role === "grid" || role === "treegrid")
    return { layout: false, presentational: false };
  if (attr(table, "summary")) return { layout: false, presentational: false };
  let rows = 0;
  let maxCols = 0;
  let dataSignal = false;
  let nested = false;
  walk(table, (n) => {
    if (!isElement(n) || n === table) return true;
    const t = tag(n);
    if (t === "table") {
      nested = true;
      return false;
    }
    if (
      t === "caption" ||
      t === "thead" ||
      t === "tfoot" ||
      t === "colgroup" ||
      t === "col" ||
      t === "th"
    )
      dataSignal = true;
    if ((t === "td" || t === "th") && (attr(n, "scope") || attr(n, "headers") || attr(n, "abbr")))
      dataSignal = true;
    if (t === "tr") {
      rows++;
      const cols = childrenOf(n).filter((c) => isElement(c) && /^t[dh]$/.test(tag(c))).length;
      maxCols = Math.max(maxCols, cols);
    }
    return true;
  });
  if (dataSignal) return { layout: false, presentational: false };
  if (nested) return { layout: true, presentational: false };
  if (rows <= 1 || maxCols <= 1) return { layout: true, presentational: false };
  if (rows >= 20) return { layout: false, presentational: false };
  return { layout: true, presentational: false };
}

// ───────────────────────── CTA (H1/H4 static heuristic) ─────────────────────────

/** A class token naming a button ("btn", "cta-primary", "button_block")… */
const BUTTON_CLASS = /(?:^|[_-])(?:btn|button|cta)(?:$|[_-])/i;
/** …unless it names a CTA styled as a text link ("single-text-cta", "btn-link", "cta_txt"). */
const TEXT_LINK_CLASS = /(?:^|[_-])(?:text|txt|link)(?:$|[_-])/i;

function hasButtonClass(el: P5Element): boolean {
  for (const c of (attr(el, "class") ?? "").split(/\s+/).slice(0, 20))
    if (BUTTON_CLASS.test(c) && !TEXT_LINK_CLASS.test(c)) return true;
  return false;
}

function hasFill(decls: Map<string, string>, el: P5Element): boolean {
  if (attr(el, "bgcolor")) return true;
  const bg = `${decls.get("background-color") ?? ""} ${decls.get("background") ?? ""}`
    .trim()
    .toLowerCase();
  return bg !== "" && !/^(?:transparent|none|inherit|initial|rgba\([^)]*,\s*0\))$/.test(bg);
}

function hasPaddingOrHeight(decls: Map<string, string>): boolean {
  const pad = decls.get("padding") ?? decls.get("padding-top") ?? decls.get("padding-left") ?? "";
  if (/[1-9]/.test(pad)) return true;
  const display = (decls.get("display") ?? "").toLowerCase();
  if (display === "inline-block" || display === "block") return true;
  const h = parsePx(decls.get("height")) ?? parsePx(decls.get("line-height"));
  return h !== null && h >= 28;
}

function hasBorder(decls: Map<string, string>): boolean {
  const b = decls.get("border") ?? decls.get("border-top") ?? "";
  return /[1-9]\d*(?:\.\d+)?px/.test(b) && !/none|hidden/.test(b);
}

/**
 * Not a call to action: mail/phone links, unsubscribe / preferences / view-online links, and other
 * brands' social icons and store badges — the sender's own brand (LinkedIn's "Connect" →
 * linkedin.com) is content, as in the renderer (`isOtherBrandLink`; `senderBrand` =
 * `brandOf(senderDomain)`).
 */
function isExcludedCtaLink(l: LinkFact, label: string, senderBrand: string | null): boolean {
  const href = l.href ?? "";
  if (/^(?:mailto|tel|sms):/i.test(href)) return true;
  if (UNSUBSCRIBE_TEXT.test(label) || PREFERENCES_TEXT.test(label) || VIEW_ONLINE_TEXT.test(label))
    return true;
  return isOtherBrandLink(href, label, collapseWhitespace(l.text) === "", senderBrand);
}

/**
 * Wrappers inside a link that can carry its button fill (`<a><span style="background…">`); a table
 * inside a link is a card, not a pill.
 */
const INNER_BOX = /^(?:span|div|p|strong|b|font|center)$/;
/** A filled pill that labels rather than acts ("pill-badge", "tag", "chip"): not a button. */
const BADGE_CLASS = /(?:^|[\s_-])(?:badge|tag|chip)(?:$|[\s_-])/i;
/** Single-child boxes around a link that can carry its button fill, up to its table. */
const OUTER_BOX = /^(?:td|th|div|p|span|center|tr|tbody|thead|table)$/;

/** The box holds only `child` (no other element, no visible text beside it). */
function onlyChild(box: P5Element): P5Element | null {
  let only: P5Element | null = null;
  for (const k of childrenOf(box)) {
    if (isElement(k)) {
      if (only) return null;
      only = k;
    } else if (isText(k) && k.value.trim() !== "") return null;
  }
  return only;
}

/**
 * The box has exactly one element child. Stops at the second, so a link among thousands of
 * siblings costs O(1), not a scan of its parent (2 MB of sibling links stayed quadratic).
 */
function soleElementChild(box: P5Element): boolean {
  let n = 0;
  for (const k of childrenOf(box)) if (isElement(k) && ++n > 1) return false;
  return n === 1;
}

/** 100% or ≥ 400px wide: a coloured section or row around the link, not a button. */
function fullWidth(sd: StaticDocument, el: P5Element): boolean {
  const w = (attr(el, "width") ?? sd.styles.rules.styleOf(el).get("width") ?? "").trim();
  if (/^100(?:\.0+)?%$/.test(w)) return true;
  const px = parsePx(w);
  return px !== null && px >= 400;
}

/**
 * The boxes that can paint a link as a button: the link; the wrappers inside it that hold all of
 * its content (Google-style pills `<a><span style="background…;padding…">`); its parent when the
 * link is that parent's only element (the rule before 2026-09-30); and further single-child boxes up
 * to the link's table (`<table style="background…"><tr><td><a style="padding…">`), stopping at text
 * beside the link or a full-width box. An image-only link keeps the old rule (a logo in a coloured
 * header is not a button; image buttons have their own rule).
 */
function buttonBoxes(sd: StaticDocument, link: P5Element, textual: boolean): P5Element[] {
  const out = [link];
  let inner = link;
  for (let i = 0; textual && i < 4; i++) {
    const child = onlyChild(inner);
    if (!child || !INNER_BOX.test(tag(child))) break;
    if (BADGE_CLASS.test(attr(child, "class") ?? "")) return [];
    out.push(child);
    inner = child;
  }
  let cur = link;
  for (let level = 0; level < 5; level++) {
    const p = cur.parentNode;
    if (!p || !isElement(p as P5Node)) break;
    const box = p as P5Element;
    const t = tag(box);
    if (level === 0) {
      if (!/^(?:td|th|div|p|span|center)$/.test(t)) break;
      if (!soleElementChild(box)) break;
      out.push(box);
      // Text beside the link: the parent is a paragraph, not the button's box; look no further.
      if (!textual || onlyChild(box) !== link) break;
    } else {
      if (!OUTER_BOX.test(t) || onlyChild(box) !== cur || fullWidth(sd, box)) break;
      out.push(box);
    }
    if (t === "table") break;
    cur = box;
  }
  return out;
}

function staticButtonLike(
  sd: StaticDocument,
  l: LinkFact,
  label: string,
  lang: string | null,
): boolean {
  const labelWords = wordCount(label, lang);
  if (labelWords === 0 || labelWords > 7) return false;
  const textual = collapseWhitespace(l.text) !== "";
  const boxes = buttonBoxes(sd, l.el, textual).map((el) => ({
    el,
    decls: sd.styles.rules.styleOf(el),
  }));
  if (boxes.length === 0) return false;
  const filled = boxes.some((b) => hasFill(b.decls, b.el));
  const sized = boxes.some((b) => hasPaddingOrHeight(b.decls));
  if (filled && sized) return true;
  if (boxes.some((b) => hasBorder(b.decls) && hasPaddingOrHeight(b.decls))) return true;
  if (boxes.some((b) => hasButtonClass(b.el))) return true;
  if (l.hasImage && !textual) {
    const img = sd.images.find((i) => i.el && i.linked && ancestorIs(i.el, l.el));
    if (img && img.width && img.height) {
      const aspect = img.width / img.height;
      const hint = BUTTON_IMAGE_HINT.test(`${img.alt ?? ""} ${img.src ?? ""}`);
      return aspect >= 2 && aspect <= 8 && img.height >= 30 && img.height <= 80 && hint;
    }
  }
  return false;
}

/** At most this size (px) a "button" is a sliver: unreadable text on a coloured speck. */
const SLIVER_FONT_PX = 3;
const SLIVER_HEIGHT_PX = 4;

/**
 * A link with text painted as a filled button (its own fill or its sole-child cell's) but shrunk to
 * a sliver — font-size or height ≤ 3–4px on the link or that cell. Readers see a coloured speck
 * with unreadable text: a stray button fragment (e.g. fixture design/13's six 1px "Buy now" boxes).
 */
function strayButtonFragment(sd: StaticDocument, l: LinkFact, label: string): boolean {
  if (!collapseWhitespace(label)) return false;
  const decls = sd.styles.rules.styleOf(l.el);
  const parent =
    l.el.parentNode && isElement(l.el.parentNode as P5Element)
      ? (l.el.parentNode as P5Element)
      : null;
  const cell =
    parent && /^(?:td|th|div|p|span|center)$/.test(tag(parent)) && soleElementChild(parent)
      ? parent
      : null;
  const cellDecls = cell ? sd.styles.rules.styleOf(cell) : null;
  const filled =
    hasFill(decls, l.el) || (cell !== null && cellDecls !== null && hasFill(cellDecls, cell));
  if (!filled) return false;
  const sliver = (d: Map<string, string> | null) => {
    if (!d) return false;
    const font = parsePx(d.get("font-size"));
    const height = parsePx(d.get("height")) ?? parsePx(d.get("max-height"));
    return (
      (font !== null && font <= SLIVER_FONT_PX) || (height !== null && height <= SLIVER_HEIGHT_PX)
    );
  };
  return sliver(decls) || sliver(cellDecls);
}

function ancestorIs(el: P5Element, target: P5Element): boolean {
  let p = el.parentNode;
  let guard = 0;
  while (p && guard++ < 50) {
    if (p === target) return true;
    p = (p as P5Element).parentNode ?? null;
  }
  return false;
}

// ───────────────────────── wrapper (A4, A11) ─────────────────────────

/** Elements on the path from `<body>` into the content wrapper (≥ 80% of visible text). */
function wrapperPath(sd: StaticDocument): P5Element[] {
  if (!sd.body) return [];
  const chars = new Map<P5Element, number>();
  for (const t of sd.texts) {
    const n = countedChars(t.text);
    if (n === 0) continue;
    let p: P5Element | null = t.parent;
    let guard = 0;
    while (p && guard++ < 400) {
      chars.set(p, (chars.get(p) ?? 0) + n);
      if (p === sd.body) break;
      const next = p.parentNode;
      p = next && isElement(next as P5Element) ? (next as P5Element) : null;
    }
  }
  const path: P5Element[] = [];
  let cur: P5Element = sd.body;
  for (let depth = 0; depth < 40; depth++) {
    const total = chars.get(cur) ?? 0;
    if (total === 0) break;
    let best: P5Element | null = null;
    let bestChars = 0;
    for (const c of childrenOf(cur)) {
      if (!isElement(c)) continue;
      const n = chars.get(c) ?? 0;
      if (n > bestChars) {
        best = c;
        bestChars = n;
      }
    }
    if (!best || bestChars < 0.8 * total) break;
    path.push(best);
    cur = best;
  }
  return path;
}

function dirOf(el: P5Element | null): "ltr" | "rtl" | "auto" | null {
  if (!el) return null;
  const d = (attr(el, "dir") ?? "").trim().toLowerCase();
  return d === "ltr" || d === "rtl" || d === "auto" ? d : null;
}

// ───────────────────────── main ─────────────────────────

const PROSE_BLOCKS = new Set(["p", "li", "td", "th", "div", "blockquote", "dd"]);
const FOOTERISH = /©|&copy;|copyright|all rights reserved/i;

/**
 * The facts of an email the static pass could not read (an internal error, never seen on real mail
 * so far): zero counts, flagged `unavailable` so no check reads them as findings.
 */
function unavailableStatic(ctx: StaticContext): StaticDesignFeatures {
  return {
    v: 1,
    unavailable: true,
    htmlBytes: Math.max(0, Math.round(ctx.htmlBytes)),
    lang: { html: null, wrapper: null },
    dir: { html: null, wrapper: null },
    script: { kind: "latin", cased: true },
    title: false,
    aria: { roleButtonOnLink: 0, vmlWithoutAlt: 0, ariaHiddenBody: false },
    tables: { total: 0, layout: 0, presentational: 0 },
    images: {
      total: 0,
      withAlt: 0,
      informative: 0,
      informativeMeaningful: 0,
      pixels: 0,
      content: 0,
    },
    links: {
      total: 0,
      named: 0,
      generic: 0,
      http: 0,
      https: 0,
      emptyOrHash: 0,
      javascript: 0,
      placeholder: 0,
    },
    mergeTags: { body: 0, firstScreen: false },
    clip: { visibleChars: 0, afterClipChars: 0, clipBytes: CLIP_BYTES },
    style: { bytes: 0, mediaRules: 0, mediaAfterLimit: false },
    compat: [],
    footer: {
      unsubscribe: "none",
      unsubscribeByHeader: false,
      preferences: false,
      receiving: false,
      postalAddress: false,
    },
    cta: { buttonLike: 0, labels: [], primaryLabel: null, primaryOffset: null },
    caps: { chars: 0, caps: 0 },
    prose: null,
    text: { visibleChars: 0, words: 0, codeShare: 0 },
    hasViewport: false,
  };
}

/**
 * Extract static design features and `fonts_static` from the raw decoded HTML.
 * DESIGN-SCORE §2 (static features) · FREE-TIER.md §5.4 · DESIGN.md §8.1 step 1.
 */
export function extractStaticDesign(html: string, ctx: StaticContext): StaticExtraction {
  try {
    return extract(html, ctx);
  } catch {
    return { static: unavailableStatic(ctx), fonts: { v: 1, static: null, used: null } };
  }
}

function extract(html: string, ctx: StaticContext): StaticExtraction {
  const sd: StaticDocument = buildStaticDocument(html);
  const lang = ctx.language;
  const senderBrand = brandOf(ctx.senderDomain);

  // Visible text (merge tags, clip, script, caps).
  let visibleChars = 0;
  let afterClip = 0;
  let codeChars = 0;
  let firstScreenText = "";
  let firstScreenCount = 0;
  let firstScreenSnippet: string | null = null;
  let mergeBody = 0;
  let allText = "";
  for (const t of sd.texts) {
    const n = countedChars(t.text);
    if (n === 0) continue;
    visibleChars += n;
    if (t.byteOffset >= CLIP_BYTES) afterClip += n;
    if (t.code) {
      codeChars += n;
      continue;
    }
    if (allText.length < 200_000) allText += ` ${t.text}`;
    if (firstScreenCount < STATIC_FIRST_SCREEN_CHARS) {
      firstScreenText += ` ${t.text.slice(0, 2000)}`;
      firstScreenCount += n;
      // The tag's own text node, so the quoted words around it are what the reader sees together.
      if (firstScreenSnippet === null) firstScreenSnippet = mergeTagSnippet(t.text.slice(0, 2000));
    }
  }
  mergeBody += countMergeTags(allText);
  for (const l of sd.links) {
    if (l.href && hasMergeTag(l.href)) mergeBody++;
  }
  for (const img of sd.images) if (img.alt && hasMergeTag(img.alt)) mergeBody++;
  const script = scriptProfile(allText);

  // Images (A2).
  const contentImages = sd.images.filter(
    (i) =>
      i.kind === "vml" ||
      !isTrackingPixel({ src: i.src, width: i.width, height: i.height, hidden: i.hidden }),
  );
  const pixels = sd.images.length - contentImages.length;
  const alt = altStats(
    contentImages.map((i) => ({
      alt: i.alt,
      informative:
        i.kind !== "img"
          ? true
          : isInformativeImage({ linked: i.linked, width: i.width, height: i.height, alt: i.alt }),
    })),
  );

  // Links (A3, X3, U1, U3).
  let named = 0;
  let generic = 0;
  let http = 0;
  let https = 0;
  let emptyOrHash = 0;
  let javascript = 0;
  let placeholder = 0;
  let unsubBefore = false;
  let unsubAfter = false;
  let unsubByHeader = false;
  // The unsubscribe links' start-tag offsets (the render's `data-o`): U1 drops the ones the
  // email's own render shows a reader can't see. null once one has no source position.
  let unsubOffsets: number[] | null = [];
  let preferences = false;
  let roleButtonOnLink = 0;
  const ctaLabels: string[] = [];
  let buttonLike = 0;
  let primaryLabel: string | null = null;
  let primaryOffset: number | null = null;
  const buttonLinks = new Set<P5Element>();
  let strayButtons = 0;
  let visibleNodes: Set<P5Node> | null = null;
  for (const l of sd.links) {
    const name = linkName(l);
    if (name) named++;
    const norm = normalizeLabel(name);
    if (!l.ariaLabel && GENERIC_LABELS.has(norm) && surroundingNonLinkChars(l.el) < 20) generic++;
    const href = (l.href ?? "").trim();
    if (href === "" || href === "#") emptyOrHash++;
    else if (/^javascript:/i.test(href)) javascript++;
    else if (/^https:/i.test(href)) https++;
    else if (/^http:/i.test(href)) http++;
    const host = urlHost(href);
    if (host && PLACEHOLDER_HOSTS.test(host)) placeholder++;
    if ((attr(l.el, "role") ?? "").toLowerCase() === "button") roleButtonOnLink++;
    const u = isUnsubscribeLink(name, l.href, ctx.listUnsubscribeHttps);
    // "Click <a>here</a> to unsubscribe": a pointer's meaning is in its own sentence.
    let byContext = false;
    if (!u.match && isPointerLabel(name)) {
      visibleNodes ??= new Set(sd.texts.map((t) => t.node));
      const sentence = linkSentence(l.el, l.text, visibleNodes);
      byContext = UNSUBSCRIBE_TEXT.test(sentence);
      if (PREFERENCES_TEXT.test(sentence)) preferences = true;
    }
    if (u.match || byContext) {
      if (l.byteOffset < CLIP_BYTES) unsubBefore = true;
      else unsubAfter = true;
      unsubByHeader ||= u.byHeader;
      if (!l.el.sourceCodeLocation) unsubOffsets = null;
      else if (unsubOffsets && unsubOffsets.length < MAX_STATIC_UNSUBSCRIBE_LINKS)
        unsubOffsets.push(l.byteOffset);
    }
    if (PREFERENCES_TEXT.test(name)) preferences = true;
    if (byContext) continue;
    const excluded = isExcludedCtaLink(l, name, senderBrand);
    if (!excluded && strayButtonFragment(sd, l, name)) strayButtons++;
    else if (!excluded && staticButtonLike(sd, l, name, lang)) {
      buttonLike++;
      buttonLinks.add(l.el);
      if (primaryLabel === null) {
        primaryLabel = norm || null;
        primaryOffset = l.byteOffset;
      }
      if (norm && !ctaLabels.includes(norm) && ctaLabels.length < 10) ctaLabels.push(norm);
    }
  }

  // Tables (A5).
  let layoutTables = 0;
  let presentational = 0;
  for (const t of sd.tables) {
    const r = isLayoutTableStatic(t);
    if (r.layout) {
      layoutTables++;
      if (r.presentational) presentational++;
    }
  }

  // Caps (T7) and prose (T8).
  let capsTotal = 0;
  let capsHit = 0;
  const blockText = new Map<P5Element, string>();
  for (const t of sd.texts) {
    if (t.code || t.heading) continue;
    if (t.link && buttonLinks.has(t.link)) continue;
    const c = capsChars(t.text, lang);
    capsTotal += c.chars;
    capsHit += t.uppercase ? c.chars : c.caps;
    if (t.link) continue;
    let block: P5Element | null = t.parent;
    let guard = 0;
    while (block && !PROSE_BLOCKS.has(tag(block)) && guard++ < 20) {
      const next = block.parentNode;
      block = next && isElement(next as P5Element) ? (next as P5Element) : null;
    }
    if (block) blockText.set(block, (blockText.get(block) ?? "") + t.text);
  }
  let prose: StaticDesignFeatures["prose"] = null;
  if (script.kind === "latin") {
    const acc = { words: 0, sentences: 0, syllables: 0 };
    for (const text of blockText.values()) {
      const clean = collapseWhitespace(text);
      if (words(clean, "en").length < 8) continue;
      if (
        UNSUBSCRIBE_TEXT.test(clean) ||
        RECEIVING_TEXT.test(clean) ||
        FOOTERISH.test(clean) ||
        looksLikePostalAddress(clean)
      )
        continue;
      const s = proseStats(clean);
      acc.words += s.words;
      acc.sentences += s.sentences;
      acc.syllables += s.syllables;
    }
    prose = acc.words > 0 ? acc : null;
  }

  // Footer statements (U4, badge).
  const tail = allText.slice(Math.floor(allText.length * 0.6)).slice(-8000);
  const receiving = RECEIVING_TEXT.test(allText.length > 60_000 ? allText.slice(-60_000) : allText);
  const postalAddress = looksLikePostalAddress(tail);

  // Language and direction (A4, A11).
  const path = wrapperPath(sd);
  const htmlLang =
    (sd.htmlEl && attr(sd.htmlEl, "lang")) || (sd.body && attr(sd.body, "lang")) || null;
  let wrapperLang: string | null = null;
  let wrapperDir: "ltr" | "rtl" | "auto" | null = null;
  for (const el of path) {
    wrapperLang ??= attr(el, "lang") || attr(el, "xml:lang") || null;
    wrapperDir ??= dirOf(el);
  }

  // X2 feature detection (style blocks + inline styles + markup).
  const hits = emptyCompatHits();
  for (const block of sd.styles.blocks) scanDeclarations(block, hits, null);
  let bgAttrImage = false;
  let svgImage = sd.hasSvg;
  let webp = false;
  walk(sd.body ?? sd.doc, (n) => {
    if (!isElement(n)) return true;
    const style = attr(n, "style");
    if (style) scanDeclarations(parseInlineStyle(style), hits, n);
    const bgAttr = attr(n, "background");
    if (bgAttr && bgAttr.trim()) {
      bgAttrImage = true;
      if (!attr(n, "bgcolor")) hits.backgroundImageColorFallback = false;
    }
    if (tag(n) === "img") {
      const src = (attr(n, "src") ?? "").toLowerCase();
      if (/\.svg(?:[?#]|$)|^data:image\/svg/.test(src)) svgImage = true;
      if (/\.webp(?:[?#]|$)|^data:image\/webp/.test(src)) webp = true;
    }
    return true;
  });
  const compat: Array<{ id: CompatFeature; fallback: boolean }> = [];
  const push = (id: CompatFeature, used: boolean, fallback: boolean) => {
    if (used) compat.push({ id, fallback });
  };
  const ghost = sd.msoGhostTable;
  push("flex", hits.flex, ghost);
  push("grid", hits.grid, ghost);
  push("position", hits.position, false);
  push("float", hits.float, ghost);
  push("max_width", hits.maxWidth, ghost);
  push(
    "background_image",
    hits.backgroundImage || bgAttrImage,
    sd.vml.shapes > 0 || hits.backgroundImageColorFallback,
  );
  push("border_radius", hits.borderRadius, sd.vml.roundrects > 0);
  push("linear_gradient", hits.gradient, hits.gradientFallback);
  push("box_shadow", hits.boxShadow, false);
  push("svg_image", svgImage, false);
  push("webp_image", webp, false);
  push("video", sd.hasVideo, false);
  push("picture", sd.hasPicture, true);

  const staticFeatures: StaticDesignFeatures = {
    v: 1,
    htmlBytes: Math.max(0, Math.round(ctx.htmlBytes)),
    lang: {
      html: htmlLang ? htmlLang.slice(0, 35) : null,
      wrapper: wrapperLang ? wrapperLang.slice(0, 35) : null,
    },
    dir: { html: dirOf(sd.htmlEl) ?? dirOf(sd.body), wrapper: wrapperDir },
    script: { kind: script.kind, cased: script.cased },
    title: collapseWhitespace(sd.title).length > 0,
    aria: {
      roleButtonOnLink,
      vmlWithoutAlt: sd.vml.withoutAlt,
      ariaHiddenBody: !!sd.body && (attr(sd.body, "aria-hidden") ?? "").toLowerCase() === "true",
    },
    tables: { total: sd.tables.length, layout: layoutTables, presentational },
    images: {
      total: sd.images.length,
      withAlt: contentImages.filter((i) => i.alt !== null).length,
      informative: alt.informative,
      informativeMeaningful: alt.meaningful,
      pixels,
      content: contentImages.length,
    },
    links: {
      total: sd.links.length,
      named,
      generic,
      http,
      https,
      emptyOrHash,
      javascript,
      placeholder,
    },
    mergeTags: mergeTagFacts(mergeBody, firstScreenText, firstScreenSnippet),
    clip: { visibleChars, afterClipChars: afterClip, clipBytes: CLIP_BYTES },
    ...(prescanInjection(allText) ? { instructionText: true } : {}),
    ...(strayButtons > 0 ? { strayButtons: Math.min(1000, strayButtons) } : {}),
    style: {
      bytes: sd.styles.bytes,
      mediaRules: sd.styles.mediaRules,
      mediaAfterLimit: sd.styles.mediaAfterLimit,
    },
    compat,
    footer: {
      unsubscribe: unsubBefore ? "before_clip" : unsubAfter ? "after_clip" : "none",
      unsubscribeOffsets: unsubOffsets,
      unsubscribeByHeader: unsubByHeader,
      preferences,
      receiving,
      postalAddress,
    },
    cta: {
      buttonLike,
      labels: ctaLabels,
      primaryLabel: primaryLabel ? primaryLabel.slice(0, 60) : null,
      primaryOffset,
    },
    caps: { chars: capsTotal, caps: capsHit },
    prose,
    text: {
      visibleChars,
      words: wordCount(allText, lang),
      codeShare: visibleChars > 0 ? codeChars / visibleChars : 0,
    },
    hasViewport: sd.hasViewport,
  };

  let fontsStatic: FontFeatures["static"];
  try {
    fontsStatic = extractFontsStatic(
      {
        // The bounded HTML (truncated, nesting flattened), never the raw input.
        html: sd.html,
        fontFaces: sd.styles.fontFaces,
        imports: sd.styles.imports,
        links: sd.fontLinks,
        msoBlocks: sd.msoBlocks,
        // Its parse: the juice plan reads every <style> and the element count/depth from it.
        doc: sd.doc,
      },
      sd.styles.fontFamilies,
    );
  } catch {
    fontsStatic = null;
  }
  return { static: staticFeatures, fonts: { v: 1, static: fontsStatic, used: null } };
}
