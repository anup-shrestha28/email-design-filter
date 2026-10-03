/**
 * Render feature assembly: DOMSnapshots of passes D, M, M-nomq and M-off plus the D/D0 pixels
 * → `RenderFeatures` (DESIGN-SCORE §2.1 definitions; FREE-TIER.md §5.2 passes).
 */
import {
  CLIP_BYTES,
  LEGIBLE_MIN_CONTRAST,
  LEGIBLE_MIN_PX,
  INVISIBLE_CONTRAST,
  MOBILE_WIDTH,
  SHORT_RUN_CHARS,
  BODY_FALLBACK_CHARS,
  VIEWPORT_V,
  type ContrastGroup,
  type RenderFeatures,
  type Rgba,
  type TextRole,
  type UsedFonts,
  altStats,
  analyzeStack,
  collapseWhitespace,
  contrastRatio,
  hasMergeTag,
  hueChroma,
  isInformativeImage,
  isLargeText,
  isTrackingPixel,
  lookupUrl,
  roundTo,
  scriptProfile,
  toHex,
  weightedMedian,
  weightedQuantile,
  FINE_PRINT_MAX_PX,
  FINE_PRINT_REL,
  words,
  type ImageTableEntry,
  normalizeAlt,
  parseColor,
} from "@edf/design/render-kit";
import type { RenderJob } from "@edf/design";
import {
  type RawImage,
  colourfulness,
  dominantBackground,
  dominantColourCount,
  edgeDensity,
  pixelContrast,
  whitespaceShare,
  xyCutLeaves,
} from "../pixels";
import { type Rect, type Snap, intersectArea, px } from "../snapshot";
import { contentExtent } from "./content";
import { findFooter } from "./footer";
import { type Run, buildRuns, isRendered } from "./runs";
import {
  type CtaInfo,
  collectLinks,
  ctaCandidates,
  findPreheader,
  mainContainer,
  navigationNodes,
  salience,
  summarizeCtas,
  textColumn,
} from "./structure";
import { contentImageLoads, imageLoadOf } from "./images";
import { hiddenLinks } from "./hidden-links";

export interface PageFacts {
  /** Natural image sizes by `data-edf-i`. */
  naturals: Map<number, { w: number; h: number }>;
  axe: RenderFeatures["axe"];
}

export interface ExtractInput {
  d: Snap;
  m: Snap;
  nomq: Snap | null;
  off: Snap | null;
  dImg: RawImage;
  d0Img: RawImage;
  mask: Uint8Array;
  job: RenderJob;
  imageTable: ImageTableEntry[];
  refByDataUri: Map<string, string>;
  page: PageFacts;
  meta: RenderFeatures["meta"];
}

/**
 * Extraction result. Two pixel facts need async sharp work and are filled in by the caller:
 * `pixels.pngBytesPerPixel` (on `crop`) and `images.darkMode` (from `darkCandidates`).
 */
export interface Extracted {
  features: RenderFeatures;
  /** Main-container crop used by the pixel metrics (desktop CSS px). */
  crop: Rect;
  /** Inlined, possibly transparent images with the effective background behind them. */
  darkCandidates: Array<{ ref: string; bg: Rgba }>;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Prose: 3 lines — a block of ≥ 3 lines for M3… */
const PROSE_MIN_LINES = 3;
/** …with at least 3 lines' worth of 8 words for M3 (a card blurb or a label isn't a paragraph). */
const PROSE_MIN_WORDS = 24;
/** T4 reads blocks of at least a sentence (a wrapped version range or name cell is not prose)… */
const PROSE_MIN_SENTENCE_WORDS = 12;
/** …and needs this many characters of their soft-wrapped lines; below it, no measure… */
const PROSE_MIN_SAMPLE_CHARS = 200;
/**
 * …in ≥ 2 soft-wrapped lines (with the lines they wrap into, ≥ 3 lines of prose). Two are enough:
 * the 200-character sample already takes 2 lines of ≥ 100 characters or more lines, and a letter
 * whose paragraphs each wrap once at 110 characters has a line-length problem (requiring 3 had
 * made T4 N/A on exactly those letters; render-2026.4 review).
 */
const T4_MIN_WRAPPED_LINES = 2;
const MONO = /mono|courier|consolas|menlo|monaco/i;

function kOf(s: Snap): number {
  return Math.min(1, MOBILE_WIDTH / Math.max(1, s.contentWidth));
}

function bucket(v: number, size: number, max = Infinity): number {
  return Math.min(max, Math.floor(v / size) * size);
}

function histogram(pairs: Array<[number, number]>, limit: number): Array<[number, number]> {
  const m = new Map<number, number>();
  for (const [k, v] of pairs) m.set(k, (m.get(k) ?? 0) + v);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .sort((a, b) => a[0] - b[0]);
}

function cluster(values: number[], gap: number): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  let n = 1;
  for (let i = 1; i < v.length; i++) if (v[i]! - v[i - 1]! > gap) n++;
  return n;
}

function kendallTau(order: number[]): number | null {
  const n = order.length;
  if (n < 3) return null;
  let c = 0;
  let d = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (order[j]! > order[i]!) c++;
      else if (order[j]! < order[i]!) d++;
    }
  }
  return c + d === 0 ? 1 : (c - d) / (c + d);
}

/**
 * Median size of the main text of `runs`: fine print — < 13px and ≤ 0.9 × the runs' p75 size, as
 * CAP_CONTRAST defines it — is left out. Text set entirely in 12px keeps 12px (its p75 is 12).
 */
function mainSize(runs: readonly Run[]): number | null {
  const p75 = weightedQuantile(
    runs.map((r) => [r.px, r.chars] as const),
    0.75,
  );
  const main = runs.filter(
    (r) => !(r.px < FINE_PRINT_MAX_PX && p75 !== null && r.px <= FINE_PRINT_REL * p75),
  );
  return weightedMedian((main.length > 0 ? main : runs).map((r) => [r.px, r.chars] as const));
}

function isMonoRun(r: Run): boolean {
  const p = analyzeStack(r.family).primary;
  return !!p && (p.generic === "monospace" || p.generic === "ui-monospace" || MONO.test(p.display));
}

interface ImageFact {
  node: number;
  kind: "img" | "bg";
  ref: string;
  inlined: boolean;
  dRect: Rect;
  mRect: Rect | null;
  alt: string | null;
  linked: boolean;
  tableIndex: number | null;
}

/**
 * The `url("…")` values of a computed `background-image` (first 10, escapes kept), of any length:
 * a pre-fetched picture of up to 5 MB arrives as a ~7M-character `data:` URI. (A bounded regex
 * missed every inlined background over ~3.6 MB once the per-image limit went to 5 MB.)
 */
export function cssUrls(value: string): string[] {
  const out: string[] = [];
  let i = value.indexOf('url("');
  while (i >= 0 && out.length < 10) {
    const start = i + 5;
    let end = start;
    for (;;) {
      end = value.indexOf('"', end);
      if (end < 0) return out;
      let slashes = 0;
      for (let b = end - 1; b >= start && value.charCodeAt(b) === 92; b--) slashes++;
      if (slashes % 2 === 0) break;
      end++;
    }
    if (end > start && value.charCodeAt(end + 1) === 41) out.push(value.slice(start, end));
    i = value.indexOf('url("', end + 1);
  }
  return out;
}

/** Assemble render features (pure over the captured passes). */
export function extractFeatures(x: ExtractInput): Extracted {
  const { d, m, job } = x;
  const lang = job.context?.language ?? null;
  const listUnsub = job.context?.listUnsubscribeHttps ?? [];
  const senderDomain = job.context?.senderDomain ?? null;
  const k = kOf(m);

  // ── Runs, paint test, preheader ──
  const dSymbols: Run[] = [];
  const dRuns = buildRuns(d, { img: x.dImg, mask: x.mask }, dSymbols);
  const mSymbols: Run[] = [];
  const mRunsRaw = buildRuns(m, null, mSymbols);
  const paintByNode = new Map<number, { ok: number; all: number }>();
  for (const r of dRuns) {
    const cur = paintByNode.get(r.node) ?? { ok: 0, all: 0 };
    cur.all += r.chars;
    if (isRendered(r)) cur.ok += r.chars;
    paintByNode.set(r.node, cur);
  }
  const preheader = findPreheader(d, dRuns);
  const nodeRendered = (node: number): boolean => {
    const p = paintByNode.get(node);
    return !p || p.ok >= 0.5 * p.all;
  };
  const mRuns = mRunsRaw.map((r) => ({ ...r, paint: r.geom ? nodeRendered(r.node) : null }));
  const live = (r: Run) => isRendered(r) && !preheader.has(r.node);
  const dLive = dRuns.filter(live);
  const mLive = mRuns.filter(live);

  // ── Structure: container, links, footer, navigation, CTA ──
  const container0 = mainContainer(d, dLive);
  const { links: mLinks, linkOf } = collectLinks(m, mRuns, listUnsub, senderDomain);
  const nav = navigationNodes(m, mLive, mLinks, linkOf, lang);
  const containerRect = container0 >= 0 ? m.unionRect(container0) : null;
  // CTA candidates over the whole email first: the footer must not swallow a filled live-text
  // button that comes before its marker (footer.ts; an image link — a social icon, a badge — never
  // moves the footer); the footer's own links are dropped after.
  const allCands = ctaCandidates(m, mLinks, {
    footerStart: -1,
    nav,
    k,
    containerWidth: containerRect?.w ?? m.contentWidth,
    lang,
    runs: mRuns,
  });
  const filledButtons = allCands
    .filter((c) => c.buttonLike && c.live && c.fill !== null && !c.outline)
    .map((c) => c.link.node);
  const footer = findFooter(m, mLive, mLinks, container0, filledButtons);
  const footerStart = footer ? footer.start : -1;
  const inFooter = (node: number) => footerStart >= 0 && node >= footerStart;
  const cands = allCands.filter((c) => !inFooter(c.link.node));
  const ctas = summarizeCtas(cands);
  const buttonNodes = new Set<number>();
  for (const c of ctas.buttonLike) for (const r of c.link.runs) buttonNodes.add(r.node);

  // ── Roles (§2.1; DESIGN.md §8.1 step 2: footer → button → navigation → heading → body) ──
  const outside = dLive.filter((r) => !inFooter(r.node));
  const medianAllD = weightedMedian(outside.map((r) => [r.px, r.chars] as const));
  const mOutside = mLive.filter((r) => !inFooter(r.node));
  const medianAllM = weightedMedian(mOutside.map((r) => [r.px, r.chars] as const));
  // The heading test compares with the main text: fine print (< 13px and ≤ 0.9 × the p75 size)
  // is left out, so an undetected footer's 12px legal lines can't turn 18px copy into "heading".
  const mainD = mainSize(outside);
  const mainM = mainSize(mOutside);
  const headingTag = (node: number) => {
    for (const a of d.ancestors(node)) {
      if (HEADING_TAGS.has(d.names[a]!) || (d.attr(a, "role") ?? "").toLowerCase() === "heading")
        return true;
    }
    return false;
  };
  const nodeStyle = new Map<number, { px: number; weight: number }>();
  for (const r of dRuns)
    if (!nodeStyle.has(r.node)) nodeStyle.set(r.node, { px: r.px, weight: r.weight });
  const roleCache = new Map<number, TextRole>();
  const roleOf = (node: number): TextRole => {
    const hit = roleCache.get(node);
    if (hit) return hit;
    let role: TextRole = "body";
    if (inFooter(node)) role = "footer";
    else if (buttonNodes.has(node)) role = "button";
    else if (nav.has(node)) role = "navigation";
    else {
      const st = nodeStyle.get(node);
      const med = st ? mainD : mainM;
      const size = st?.px ?? mRuns.find((r) => r.node === node)?.px ?? 0;
      const weight = st?.weight ?? 400;
      if (headingTag(node) || (med !== null && size >= 1.25 * med) || (weight >= 700 && size >= 20))
        role = "heading";
    }
    roleCache.set(node, role);
    return role;
  };

  // ── Content images ──
  const images: ImageFact[] = [];
  const tableIndexOf = (node: number): number | null => {
    const v = d.attr(node, "data-edf-i");
    return v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null;
  };
  for (let i = 0; i < d.count && images.length < 400; i++) {
    const rect = d.nodeRect(i);
    if (!rect || !d.isElement(i)) continue;
    if (d.names[i] === "img") {
      const ti = tableIndexOf(i);
      const entry = ti !== null ? x.imageTable[ti] : undefined;
      const hidden =
        d.style(d.layoutOf[i]!, "visibility") !== "visible" || d.cumOpacity[i]! <= 0.01;
      if (isTrackingPixel({ src: entry?.ref ?? null, width: rect.w, height: rect.h, hidden }))
        continue;
      images.push({
        node: i,
        kind: "img",
        ref: entry?.ref ?? "",
        inlined: entry?.inlined ?? false,
        dRect: rect,
        mRect: m.nodeRect(i),
        alt: d.attr(i, "alt"),
        linked: linkOf[i]! >= 0,
        tableIndex: ti,
      });
    } else {
      const bgi = d.style(d.layoutOf[i]!, "background-image");
      if (!bgi || bgi === "none" || !bgi.includes("url(")) continue;
      if (rect.w * rect.h <= 25 || d.cumOpacity[i]! <= 0.01) continue;
      const url = cssUrls(bgi)[0];
      if (!url) continue;
      const ref = x.refByDataUri.get(url) ?? (url.startsWith("data:") ? "data:" : url);
      images.push({
        node: i,
        kind: "bg",
        ref,
        inlined: x.refByDataUri.has(url),
        dRect: rect,
        mRect: m.nodeRect(i),
        alt: null,
        linked: false,
        tableIndex: null,
      });
    }
  }
  const statusOf = (img: ImageFact): RenderFeatures["images"]["loads"][number] =>
    imageLoadOf(img, job, x.page.naturals);
  const footerTop = footer?.top ?? m.contentHeight;
  const aboveArea = Math.max(1, m.contentWidth * Math.max(1, footerTop));
  let imgArea = 0;
  for (const img of images) {
    if (!img.mRect || img.mRect.y >= footerTop) continue;
    const h = Math.min(img.mRect.y + img.mRect.h, footerTop) - img.mRect.y;
    imgArea += img.mRect.w * Math.max(0, h);
  }
  const imgShare = Math.min(1, imgArea / aboveArea);
  // One entry per distinct URL, not-drawn declared images included (render-structure, images.ts).
  const imageLoads = contentImageLoads({
    d,
    m,
    found: images,
    imageTable: x.imageTable,
    naturals: x.page.naturals,
    job,
  });
  const loads = imageLoads.loads;
  const loadedRefs = new Set<string>();
  let bytes = 0;
  for (const img of images) {
    const st = statusOf(img);
    if (typeof st.status !== "number" || st.status >= 300 || loadedRefs.has(img.ref)) continue;
    loadedRefs.add(img.ref);
    const log = img.ref.startsWith("http") ? lookupUrl(job.imageLog, img.ref) : undefined;
    bytes += log?.bytes ?? 0;
  }
  const imgFacts = images.filter((i) => i.kind === "img");
  const alt = altStats(
    imgFacts.map((i) => ({
      alt: i.alt,
      informative: isInformativeImage({
        linked: i.linked,
        width: i.dRect.w,
        height: i.dRect.h,
        alt: i.alt,
      }),
    })),
  );
  const sender = (job.context?.senderDomain ?? "").split(".")[0]?.toLowerCase() ?? "";
  const logoTop = images.some((i) => {
    if (!i.mRect || i.mRect.y >= 200) return false;
    const name = `${i.alt ?? ""} ${i.ref.slice(0, 300)}`.toLowerCase();
    return (
      (i.mRect.w <= 300 && i.mRect.h <= 120) ||
      name.includes("logo") ||
      (sender.length >= 3 && name.includes(sender))
    );
  });
  const adapt = imgFacts
    .filter((i) => i.dRect.w >= 200)
    .slice(0, 30)
    .map((i) => {
      const nat =
        i.tableIndex !== null && i.inlined ? x.page.naturals.get(i.tableIndex) : undefined;
      const mr = i.mRect;
      const aspectDev =
        nat && nat.w > 0 && nat.h > 0 && mr && mr.w > 0 && mr.h > 0
          ? Math.abs(mr.w / mr.h / (nat.w / nat.h) - 1)
          : null;
      return {
        withinViewport: !!mr && mr.x >= -1 && mr.x + mr.w <= MOBILE_WIDTH + 1,
        aspectDev: aspectDev === null ? null : Math.min(1000, aspectDev),
        sharpRatio: nat && nat.w > 0 ? Math.min(1000, nat.w / i.dRect.w) : null,
        renderedWidth: i.dRect.w,
      };
    });

  // ── Contrast groups (pass D) ──
  const imgRects = images.map((i) => i.dRect);
  const groups = new Map<string, ContrastGroup>();
  const nodeRatio = new Map<number, number>();
  let legible = 0;
  const mSize = new Map<number, number>();
  for (const r of mRuns) if (!mSize.has(r.node)) mSize.set(r.node, r.px);
  // Fine print (CAP_CONTRAST excludes it from "main content"): < 13px and ≤ 0.9 × the p75 size
  // of the live text outside the footer.
  const p75D = weightedQuantile(
    outside.map((r) => [r.px, r.chars] as const),
    0.75,
  );
  const isFine = (px: number) =>
    px < FINE_PRINT_MAX_PX && p75D !== null && px <= FINE_PRINT_REL * p75D;
  // Text over a background image that didn't load (a CSS `background-image` / `background`
  // attribute whose url() wasn't inlined): the reader sees it on the picture, we see it on the
  // fallback colour. Its contrast is undecided — never "hidden, same colour as its background".
  const bgMissingCache = new Map<number, boolean>();
  // Per layout box: its background url()s (an inlined one can be millions of characters long).
  const bgUrlCache = new Map<number, string[]>();
  const bgImageMissing = (el: number): boolean => {
    const hit = bgMissingCache.get(el);
    if (hit !== undefined) return hit;
    let out = false;
    for (let a = el, guard = 0; a >= 0 && guard < 80; a = d.parent[a]!, guard++) {
      const li = d.layoutOf[a]!;
      if (li < 0) continue;
      let urls = bgUrlCache.get(li);
      if (!urls) {
        urls = cssUrls(d.style(li, "background-image"));
        bgUrlCache.set(li, urls);
      }
      if (urls.length > 0) {
        out = urls.some((u) => !u.startsWith("data:"));
        break;
      }
      if ((parseColor(d.style(li, "background-color"))?.a ?? 0) >= 0.99) break;
    }
    bgMissingCache.set(el, out);
    return out;
  };
  for (const r of dRuns) {
    if (preheader.has(r.node)) continue;
    // A run the paint test failed only because the picture behind it is missing counts as drawn.
    const bgMissing = r.el >= 0 && !!d.bgImage[r.el] && r.geom && bgImageMissing(r.el);
    const rendered = isRendered(r) || bgMissing;
    const role = roleOf(r.node);
    const large = isLargeText(r.px, r.weight);
    const short = r.chars < SHORT_RUN_CHARS;
    const fine = isFine(r.px);
    const bgColor: Rgba = r.el >= 0 ? d.bg[r.el]! : { r: 255, g: 255, b: 255, a: 1 };
    const overlapsImage = imgRects.some(
      (ir) => intersectArea(ir, r.rect) > 0.1 * r.rect.w * r.rect.h,
    );
    let method: "color" | "pixel" = "color";
    let ratio = contrastRatio(r.color, bgColor);
    let p90: number | null = null;
    let bgOut = bgColor;
    if (bgMissing) {
      // Worst case the fallback colour (p10), best case unknown (p90 = 21): undecided below AA.
      method = "pixel";
      p90 = 21;
    } else if (rendered && ((r.el >= 0 && d.bgImage[r.el]) || overlapsImage)) {
      const pc = pixelContrast(x.d0Img, r.rect, r.color);
      if (pc) {
        method = "pixel";
        ratio = pc.p10;
        p90 = pc.p90;
        bgOut = pc.bg;
      }
    }
    if (isRendered(r)) nodeRatio.set(r.node, Math.min(nodeRatio.get(r.node) ?? Infinity, ratio));
    if (!rendered && !(ratio < INVISIBLE_CONTRAST && !short)) continue;
    // Legible = ≥ 3:1 and ≥ 10px (§2.1). `k` is not applied: §2.1 applies it to T1, M3, M4, M7,
    // A7, H2 and U2 only.
    if (
      isRendered(r) &&
      role !== "footer" &&
      ratio >= LEGIBLE_MIN_CONTRAST &&
      r.px >= LEGIBLE_MIN_PX
    )
      legible += r.chars;
    const fgHex = toHex(r.color);
    const bgHex = toHex({ ...bgOut, a: 1 });
    const key =
      method === "color"
        ? `c|${fgHex}|${bgHex}|${large}|${role}|${rendered}|${short}|${fine}`
        : `p|${fgHex}|${bgHex}|${large}|${role}|${short}|${fine}|${Math.floor(ratio * 1000)}|${p90 === null ? "" : Math.floor(p90 * 1000)}`;
    const g = groups.get(key);
    if (g) {
      g.chars += r.chars;
      g.ratio = Math.min(g.ratio, ratio);
      if (p90 !== null && g.p90 !== null) g.p90 = Math.min(g.p90, p90);
    } else {
      groups.set(key, {
        fg: fgHex,
        bg: bgHex,
        ratio: clampRatio(ratio),
        p90: p90 === null ? null : clampRatio(p90),
        method,
        large,
        role,
        rendered,
        short,
        chars: r.chars,
        fine,
      });
    }
  }
  const groupList = capGroups([...groups.values()]);

  // ── Typography (desktop body text) ──
  const role = (r: Run) => roleOf(r.node);
  const bodyRunsD = outside.filter((r) => role(r) === "body");
  const bodyChars = bodyRunsD.reduce((s, r) => s + r.chars, 0);
  const fallback = bodyChars < BODY_FALLBACK_CHARS;
  const typoD = fallback ? outside : bodyRunsD;
  const typoM = fallback ? mOutside : mOutside.filter((r) => role(r) === "body");
  // Body size (T1/T2) is the size of the main text: fine print — legal lines, grey metadata,
  // disclaimers — is left out, so an undetected footer's 12px small print can't become the body
  // size under 18px copy (render-2026.4).
  const bodyDesktop = mainSize(typoD);
  const bodyMobile = mainSize(typoM);

  interface Block {
    node: number;
    runs: Run[];
    lines: Run[][];
  }
  const blocksOf = (runs: readonly Run[], s: Snap): Block[] => {
    const map = new Map<number, Run[]>();
    for (const r of runs) {
      const b = s.blockOf[r.node]!;
      const list = map.get(b) ?? [];
      list.push(r);
      map.set(b, list);
    }
    const out: Block[] = [];
    for (const [node, list] of map) {
      const sorted = [...list].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      const lines: Run[][] = [];
      for (const r of sorted) {
        const last = lines[lines.length - 1];
        const cy = r.rect.y + r.rect.h / 2;
        if (last) {
          const ref = last[0]!;
          if (Math.abs(ref.rect.y + ref.rect.h / 2 - cy) <= 0.5 * Math.min(ref.rect.h, r.rect.h)) {
            last.push(r);
            continue;
          }
        }
        lines.push([r]);
      }
      out.push({ node, runs: list, lines });
    }
    return out.sort((a, b) => a.node - b.node);
  };
  // A line ends in a soft wrap when the next line continues the same text node, or when nothing
  // between the two lines' runs forces a break (no <br>, no block-level element).
  const softWrap = (s: Snap, line: readonly Run[], next: readonly Run[]): boolean => {
    let a = line[0]!;
    for (const r of line) if (r.node > a.node || (r.node === a.node && r.box > a.box)) a = r;
    let b = next[0]!;
    for (const r of next) if (r.node < b.node || (r.node === b.node && r.box < b.box)) b = r;
    if (a.node === b.node) return true;
    const lo = Math.min(a.node, b.node);
    const hi = Math.max(a.node, b.node);
    if (hi - lo > 400) return false;
    for (let j = lo + 1; j < hi; j++)
      if (s.names[j] === "br" || (s.isElement(j) && s.blockOf[j] === j)) return false;
    return true;
  };
  // A block's soft-wrapped lines: the lines the column width ended, the measure T4 reads. Lines
  // ended by <br> (a sign-off, "Company<br>City<br>3+ years") or single-line cells are not.
  const wrappedLines = (b: Block, s: Snap): Run[][] => {
    const out: Run[][] = [];
    for (let i = 0; i < b.lines.length - 1; i++)
      if (softWrap(s, b.lines[i]!, b.lines[i + 1]!)) out.push(b.lines[i]!);
    return out;
  };
  // Prose (M3): a block of ≥ 3 lines that wraps at least twice on its own.
  const isProse = (b: Block, s: Snap): boolean =>
    b.lines.length >= PROSE_MIN_LINES && wrappedLines(b, s).length >= PROSE_MIN_LINES - 1;
  const bodyBlocks = blocksOf(bodyRunsD, d);
  let paragraphLines = 0;
  const pitch: Array<[number, number]> = [];
  const perLine: Array<[number, number]> = [];
  let proseSample = 0;
  let alignChars = 0;
  let badAlign = 0;
  for (const b of bodyBlocks) {
    paragraphLines += b.lines.length;
    const size = weightedMedian(b.runs.map((r) => [r.px, r.chars] as const)) ?? 0;
    for (let i = 1; i < b.lines.length; i++) {
      const dy = b.lines[i]![0]!.rect.y - b.lines[i - 1]![0]!.rect.y;
      if (dy > 0 && size > 0) pitch.push([dy / size, 1]);
    }
    const sentence =
      words(b.runs.map((r) => r.text).join(" "), lang).length >= PROSE_MIN_SENTENCE_WORDS;
    for (const line of sentence ? wrappedLines(b, d) : []) {
      const n = Array.from(collapseWhitespace(line.map((r) => r.text).join(" "))).length;
      perLine.push([n, 1]);
      proseSample += n;
    }
    const chars = b.runs.reduce((s, r) => s + r.chars, 0);
    const align = b.node >= 0 ? d.nodeStyle(b.node, "text-align") : "start";
    alignChars += chars;
    if (align === "justify" || (align === "center" && b.lines.length > 3)) badAlign += chars;
  }
  const sizes = histogram(
    dLive.map((r) => [roundTo(Math.round(r.px * 2) / 2, 1), r.chars] as [number, number]),
    40,
  );
  const script = scriptProfile(
    dLive
      .map((r) => r.text)
      .join(" ")
      .slice(0, 20_000),
  );
  let caps: { chars: number; caps: number } | null = null;
  if (script.cased) {
    let c = 0;
    let u = 0;
    for (const r of bodyRunsD) {
      for (const w of words(r.text, lang)) {
        const n = Array.from(w).length;
        c += n;
        if (/\p{Lu}.*\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w)) u += n;
      }
    }
    caps = { chars: c, caps: u };
  }

  // Headings (A6)
  const allBlocksD = blocksOf(outside, d);
  let visualHeadings = 0;
  let markedUp = 0;
  for (const b of allBlocksD) {
    if (!b.runs.some((r) => role(r) === "heading")) continue;
    visualHeadings++;
    if (headingTag(b.runs[0]!.node)) markedUp++;
  }
  let h1 = 0;
  for (let i = 0; i < d.count; i++)
    if (d.names[i] === "h1" && !inFooter(i) && dLive.some((r) => d.isAncestor(i, r.node))) h1++;

  // First viewport (mobile, CSS px at 375; k is only applied where §2.1 lists it)
  const firstVp = (r: Run) => r.rect.y < VIEWPORT_V;
  const fvRuns = mOutside.filter(firstVp);
  const firstViewportMaxPx = fvRuns.length > 0 ? Math.max(...fvRuns.map((r) => r.px)) : null;
  const legibleNode = (node: number, sizePx: number) =>
    (nodeRatio.get(node) ?? 0) >= LEGIBLE_MIN_CONTRAST && sizePx >= LEGIBLE_MIN_PX;
  const firstViewportLegible = fvRuns
    .filter((r) => role(r) !== "navigation" && legibleNode(r.node, r.px))
    .reduce((s, r) => s + r.chars, 0);

  // M3 block widths and M7 gutters (mobile body text)
  const mBody = typoM;
  const blockWidths = histogram(
    mBody.map((r) => {
      const b = m.blockOf[r.node]!;
      const rect = b >= 0 ? m.nodeRect(b) : null;
      return [bucket(rect?.w ?? r.rect.w, 10), r.chars] as [number, number];
    }),
    60,
  );
  // M3 prose: the same widths for paragraph text only (prose blocks of ≥ 24 words at 375), so a
  // 2-up card grid, a logo + job-title row or a label cell is never "squeezed body text".
  const proseWidths: Array<[number, number]> = [];
  for (const b of blocksOf(mBody, m)) {
    if (!isProse(b, m)) continue;
    if (words(b.runs.map((r) => r.text).join(" "), lang).length < PROSE_MIN_WORDS) continue;
    const rect = b.node >= 0 ? m.nodeRect(b.node) : null;
    for (const r of b.runs) proseWidths.push([bucket(rect?.w ?? r.rect.w, 10), r.chars]);
  }
  const gutters = histogram(
    mBody.map(
      (r) =>
        [
          bucket(Math.max(0, Math.min(r.rect.x, m.contentWidth - (r.rect.x + r.rect.w))), 2, 40),
          r.chars,
        ] as [number, number],
    ),
    30,
  );

  // A12 reading order at 375
  const mBlocks = blocksOf(mOutside, m).slice(0, 150);
  const rtl = script.rtl;
  const visualOrder = [...mBlocks]
    .map((b, i) => ({
      i,
      y: Math.min(...b.runs.map((r) => r.rect.y)),
      x: rtl
        ? -Math.max(...b.runs.map((r) => r.rect.x + r.rect.w))
        : Math.min(...b.runs.map((r) => r.rect.x)),
    }))
    .sort((a, b) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x))
    .map((v) => v.i);
  const readingOrderTau = kendallTau(visualOrder);

  // C3 scannability
  const wordsTotal = words(outside.map((r) => r.text).join(" "), lang).length;
  const avgParagraphLines = bodyBlocks.length > 0 ? paragraphLines / bodyBlocks.length : null;
  let maxBetween: number | null = null;
  let acc = 0;
  for (const b of allBlocksD) {
    const isBreak =
      b.runs.some((r) => role(r) === "heading") ||
      d.closestTag(b.runs[0]!.node, new Set(["li"])) >= 0;
    if (isBreak) {
      maxBetween = Math.max(maxBetween ?? 0, acc);
      acc = 0;
      continue;
    }
    if (b.runs.some((r) => role(r) === "body"))
      acc += words(b.runs.map((r) => r.text).join(" "), lang).length;
  }
  if (allBlocksD.length > 0) maxBetween = Math.max(maxBetween ?? 0, acc);

  // L4 alignment anchors and L6 vertical gaps (desktop)
  const lefts: number[] = [];
  const centers: number[] = [];
  const rights: number[] = [];
  const spans: Array<{ top: number; bottom: number; x0: number; x1: number }> = [];
  for (const b of allBlocksD) {
    if (b.node < 0) continue;
    const x0 = Math.min(...b.runs.map((r) => r.rect.x));
    const x1 = Math.max(...b.runs.map((r) => r.rect.x + r.rect.w));
    const top = Math.min(...b.runs.map((r) => r.rect.y));
    const bottom = Math.max(...b.runs.map((r) => r.rect.y + r.rect.h));
    spans.push({ top, bottom, x0, x1 });
    const align = d.nodeStyle(b.node, "text-align");
    const dir = d.nodeStyle(b.node, "direction");
    if (align === "center" || align === "-webkit-center") centers.push((x0 + x1) / 2);
    else if (
      align === "right" ||
      ((align === "start" || align === "") && dir === "rtl") ||
      align === "end"
    )
      rights.push(x1);
    else lefts.push(x0);
  }
  const alignmentAnchors = cluster(lefts, 4) + cluster(centers, 4) + cluster(rights, 4);
  spans.sort((a, b) => a.top - b.top);
  const gaps: number[] = [];
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1]!;
    const b = spans[i]!;
    if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) <= 0) continue;
    const g = b.top - a.bottom;
    if (g >= 2 && g <= 200) gaps.push(g);
  }

  // ── Links (A7, A8) ──
  const standalone = mLinks.filter((l) => l.standalone && l.target);
  const targets: Array<[number, number, boolean]> = [];
  const r24 = 12 / Math.max(k, 0.01);
  for (const l of standalone.slice(0, 80)) {
    const t = l.target!;
    const small = t.w * k < 24 || t.h * k < 24;
    let spacingOk = !small;
    if (small) {
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      spacingOk = standalone.every((o) => {
        if (o === l || !o.target) return true;
        const ot = o.target;
        const dx = Math.max(ot.x - cx, 0, cx - (ot.x + ot.w));
        const dy = Math.max(ot.y - cy, 0, cy - (ot.y + ot.h));
        if (Math.hypot(dx, dy) < r24) return false;
        const oSmall = ot.w * k < 24 || ot.h * k < 24;
        return !(oSmall && Math.hypot(ot.x + ot.w / 2 - cx, ot.y + ot.h / 2 - cy) < 2 * r24);
      });
    }
    targets.push([t.w, t.h, spacingOk]);
  }
  const { links: dLinks, linkOf: dLinkOf } = collectLinks(d, dRuns, listUnsub, senderDomain);
  const inlineLinks = dLinks.filter((l) => !l.standalone && l.runs.length > 0);
  let distinguishable = 0;
  for (const l of inlineLinks) {
    const main = [...l.runs].sort((a, b) => b.chars - a.chars)[0]!;
    const li = d.layoutOf[l.node]!;
    const deco = d.nodeStyle(main.node, "text-decoration-line");
    const underline =
      /underline/.test(deco) || (li >= 0 && /underline/.test(d.style(li, "text-decoration-line")));
    const border =
      li >= 0 &&
      px(d.style(li, "border-bottom-width")) >= 1 &&
      d.style(li, "border-bottom-style") !== "none";
    const block = d.blockOf[d.parent[l.node]!]!;
    const surround = dRuns
      .filter((r) => d.blockOf[r.node] === block && dLinkOf[r.node] !== l.node && isRendered(r))
      .sort((a, b) => b.chars - a.chars)[0];
    const weightDiff = surround ? Math.abs(main.weight - surround.weight) >= 300 : false;
    const ownBg = li >= 0 ? d.bg[l.node]! : null;
    const bgCue =
      !!ownBg && d.parent[l.node]! >= 0 && toHex(ownBg) !== toHex(d.bg[d.parent[l.node]!]!);
    const lumCue = surround
      ? contrastRatio({ ...main.color, a: 1 }, { ...surround.color, a: 1 }) >= 3
      : true;
    if (underline || border || weightDiff || bgCue || lumCue) distinguishable++;
  }

  // ── CTA ──
  const primary: CtaInfo | null = ctas.primary;
  const sal = primary ? salience(primary) : null;
  const ctaOut: RenderFeatures["cta"]["primary"] = primary
    ? {
        label: primary.label.slice(0, 60),
        words: Math.min(1000, primary.wordsN),
        live: primary.live,
        target: rectOut(primary.target),
        visual: rectOut(primary.visual),
        labelContrast: primary.labelContrast === null ? null : clampRatio(primary.labelContrast),
        labelLarge: primary.labelLarge,
        fillLumRatio:
          sal?.lumRatio === null || sal?.lumRatio === undefined ? null : clampRatio(sal.lumRatio),
        fillDeltaE:
          sal?.deltaE === null || sal?.deltaE === undefined ? null : Math.min(200, sal.deltaE),
        mostProminent: ctas.mostProminent,
        offset: d.offset[primary.link.node]! >= 0 ? d.offset[primary.link.node]! : null,
        textOnlyTap: primary.textOnlyTap,
      }
    : null;

  // Accent hues (L7): button fills, link colours, heading colours.
  const hues: number[] = [];
  const addHue = (c: Rgba | null) => {
    if (!c) return;
    const { hue, chroma } = hueChroma(c);
    if (chroma >= 15) hues.push(hue);
  };
  for (const c of ctas.buttonLike) addHue(c.fill);
  for (const l of dLinks) if (l.runs[0]) addHue({ ...l.runs[0].color, a: 1 });
  for (const r of outside) if (role(r) === "heading") addHue({ ...r.color, a: 1 });
  const accentHues = hueClusters(hues);

  // ── Links a reader can't see in either pass (U1 drops a static-pass link at one of them) ──
  const dPainted = new Set<number>();
  for (const r of dRuns) if (r.paint === true) dPainted.add(r.node);
  for (const r of dSymbols) if (r.paint === true) dPainted.add(r.node);
  const hidden = hiddenLinks(
    [
      { s: d, runs: [...dRuns, ...dSymbols], painted: (r) => r.paint === true },
      { s: m, runs: [...mRunsRaw, ...mSymbols], painted: (r) => dPainted.has(r.node) },
    ],
    (s, node) => {
      const ti = s.attr(node, "data-edf-i");
      if (ti === null || !/^\d{1,6}$/.test(ti)) return false;
      const nat = x.page.naturals.get(Number(ti));
      return !!x.imageTable[Number(ti)]?.inlined && !!nat && nat.w > 0;
    },
  );

  // ── Footer / unsubscribe (U2) ──
  const unsub = mLinks.find((l) => l.unsubscribe && l.runs.length > 0);
  let unsubscribe: RenderFeatures["footer"]["unsubscribe"] = null;
  if (unsub) {
    const run = [...unsub.runs].sort((a, b) => b.chars - a.chars)[0]!;
    const ratio =
      nodeRatio.get(run.node) ??
      contrastRatio(run.color, run.el >= 0 ? m.bg[run.el]! : { r: 255, g: 255, b: 255, a: 1 });
    unsubscribe = { px: Math.min(2000, run.px), contrast: clampRatio(ratio) };
  }

  // ── Clip (X1) ──
  let visibleChars = 0;
  let afterClip = 0;
  for (const r of dLive) {
    visibleChars += r.chars;
    if (d.offset[r.node]! >= CLIP_BYTES) afterClip += r.chars;
  }
  const unsubD = dLinks.find((l) => l.unsubscribe);

  // ── Merge tag in the first viewport (code excluded) ──
  const fvText = fvRuns
    .filter((r) => !(r.el >= 0 && m.inCode[r.el]) && !isMonoRun(r))
    .map((r) => r.text)
    .join(" ");

  // ── Images-off resilience (I4) ──
  const altChars = (s: Snap, imgs: ImageFact[] | null): number => {
    const seen = new Set<string>();
    let n = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.names[i] !== "img") continue;
      const rect = s.nodeRect(i);
      if (!rect || rect.y >= 2 * VIEWPORT_V) continue;
      if (imgs && !imgs.some((f) => f.node === i)) continue;
      const a = normalizeAlt(s.attr(i, "alt") ?? "");
      if (!a || seen.has(a)) continue;
      seen.add(a);
      n += Math.min(150, Array.from(a).length);
    }
    return n;
  };
  let imagesOff: RenderFeatures["imagesOff"] = null;
  if (x.off) {
    const off = x.off;
    const onChars =
      mOutside
        .filter((r) => r.rect.y < 2 * VIEWPORT_V && legibleNode(r.node, r.px))
        .reduce((s, r) => s + r.chars, 0) + altChars(m, images);
    const offRuns = buildRuns(off, null).filter(
      (r) => r.geom && !preheader.has(r.node) && !inFooter(r.node) && r.rect.y < 2 * VIEWPORT_V,
    );
    let offChars = 0;
    for (const r of offRuns) {
      const bg = r.el >= 0 ? off.bg[r.el]! : { r: 255, g: 255, b: 255, a: 1 };
      if (contrastRatio(r.color, bg) >= LEGIBLE_MIN_CONTRAST && r.px >= LEGIBLE_MIN_PX)
        offChars += r.chars;
    }
    offChars += altChars(off, null);
    imagesOff = { on: onChars, off: offChars };
  }

  // ── Fonts used (DESIGN.md §8.1 step 2) ──
  const fonts = usedFonts(dLive, roleOf);

  // ── Pixel metrics (desktop, main container) ──
  const containerD = container0 >= 0 ? d.unionRect(container0) : null;
  const crop = containerD ?? { x: 0, y: 0, w: x.dImg.width, h: x.dImg.height };
  const bgDom = dominantBackground(x.dImg, crop);
  const mainForL1 = mainContainer(d, bodyRunsD.length > 0 ? bodyRunsD : outside);
  const mainRect = textColumn(d, bodyRunsD.length > 0 ? bodyRunsD : outside, mainForL1);

  // ── Visible content extent (desktop, whole document; the gallery crops its card to it) ──
  const content = contentExtent(d, [...dLive, ...dSymbols.filter(live)], (node) => {
    const ti = tableIndexOf(node);
    const entry = ti !== null ? x.imageTable[ti] : undefined;
    if (ti === null || !entry) return { ref: null, rendered: true };
    // A picture here: inlined and decoded, or the declared-size placeholder an image with both
    // dimensions gets. Otherwise (not inlined: fetch failed / too large / timed out / over budget /
    // blocked; or undecodable) it laid out broken, and the viewer gives it another box.
    const nat = x.page.naturals.get(ti);
    return { ref: entry.ref, rendered: nat ? nat.w > 0 : entry.inlined };
  });

  // ── Regions (≤ 20) ──
  const regions: RenderFeatures["regions"] = [];
  const pushRegion = (key: string, pass: "desktop" | "mobile", r: Rect | null) => {
    if (!r || regions.length >= 20) return;
    regions.push({
      key,
      pass,
      x: roundTo(r.x, 1),
      y: roundTo(r.y, 1),
      w: roundTo(Math.max(0, r.w), 1),
      h: roundTo(Math.max(0, r.h), 1),
    });
  };
  const failing = dLive
    .filter(
      (r) =>
        ["body", "heading"].includes(role(r)) &&
        (nodeRatio.get(r.node) ?? 21) < (isLargeText(r.px, r.weight) ? 3 : 4.5),
    )
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 3);
  for (const r of failing) pushRegion("A1", "desktop", r.rect);
  if (primary) {
    pushRegion("H2", "mobile", primary.visual);
    pushRegion("H3", "mobile", primary.visual);
    pushRegion("M4", "mobile", primary.target);
  }
  for (const l of standalone
    .filter((l) => l.target && (l.target.w * k < 24 || l.target.h * k < 24))
    .slice(0, 3))
    pushRegion("A7", "mobile", l.target);
  if (unsub?.target) pushRegion("U2", "mobile", unsub.target);
  for (const img of images
    .filter((i) => {
      const st = statusOf(i);
      return (
        typeof st.status === "number" && (st.status >= 400 || (st.status < 300 && !st.decoded))
      );
    })
    .slice(0, 3))
    pushRegion("I3", "desktop", img.dRect);
  for (const img of imgFacts
    .filter((i) => i.mRect && i.mRect.x + i.mRect.w > MOBILE_WIDTH + 1)
    .slice(0, 2))
    pushRegion("M5", "mobile", img.mRect);
  if (k < 0.99) pushRegion("M1", "mobile", containerRect);
  if (mainRect) pushRegion("L1", "desktop", mainRect);

  const features: RenderFeatures = {
    v: 1,
    meta: x.meta,
    layout: {
      desktopHeight: Math.min(1_000_000, d.contentHeight),
      mobileHeight: Math.min(1_000_000, m.contentHeight),
      desktopContentWidth: d.contentWidth,
      mobileContentWidth: m.contentWidth,
      nomqContentWidth: x.nomq ? x.nomq.contentWidth : null,
      k,
      kNomq: x.nomq ? kOf(x.nomq) : null,
      mainContainer: mainRect ? rectOut(mainRect) : null,
      content,
    },
    text: {
      script: script.kind,
      cased: script.cased,
      chars: {
        total: dLive.reduce((s, r) => s + r.chars, 0),
        outsideFooter: outside.reduce((s, r) => s + r.chars, 0),
        body: bodyChars,
        heading: outside.filter((r) => role(r) === "heading").reduce((s, r) => s + r.chars, 0),
        button: outside.filter((r) => role(r) === "button").reduce((s, r) => s + r.chars, 0),
        navigation: outside
          .filter((r) => role(r) === "navigation")
          .reduce((s, r) => s + r.chars, 0),
        footer: dLive.filter((r) => inFooter(r.node)).reduce((s, r) => s + r.chars, 0),
        legible,
      },
      medianAll: { desktop: medianAllD, mobile: medianAllM },
      body: { desktop: bodyDesktop, mobile: bodyMobile, fallback },
      lineRatio: weightedMedian(pitch),
      paragraphLines,
      charsPerLine:
        perLine.length >= T4_MIN_WRAPPED_LINES && proseSample >= PROSE_MIN_SAMPLE_CHARS
          ? weightedMedian(perLine)
          : null,
      alignment: { chars: alignChars, badChars: badAlign },
      sizes,
      caps,
      headings: { visual: visualHeadings, markedUp, h1 },
      firstViewportMaxPx,
      firstViewportLegible,
      blockWidths,
      proseWidths: histogram(proseWidths, 60),
      gutters,
      readingOrderTau,
      words: wordsTotal,
      avgParagraphLines,
      maxWordsBetweenHeadings: maxBetween,
      alignmentAnchors,
    },
    contrast: { groups: groupList },
    links: {
      total: mLinks.length,
      standalone: standalone.length,
      inline: inlineLinks.length,
      inlineDistinguishable: distinguishable,
      targets,
      hidden: hidden.offsets,
      ...(hidden.more ? { hiddenMore: true } : {}),
    },
    cta: {
      primary: ctaOut,
      buttonLike: ctas.buttonLike.length,
      labels: [...new Set(ctas.buttonLike.map((c) => c.normLabel).filter(Boolean))].slice(0, 10),
      firstTwoViewportsDistinct: ctas.firstTwoDistinct,
      buttonStyles: ctas.buttonStyles,
    },
    images: {
      content: images.length,
      informative: alt.informative,
      logoTop,
      share: imgShare,
      loads,
      declared: imageLoads.declared,
      drawn: imageLoads.drawn,
      bytes: Math.min(100_000_000, bytes),
      adapt,
      alt: {
        total: imgFacts.length,
        withAlt: imgFacts.filter((i) => i.alt !== null).length,
        informative: alt.informative,
        informativeMeaningful: alt.meaningful,
      },
      darkMode: [],
    },
    imagesOff,
    footer: {
      present: footer !== null,
      top: footer ? footer.top : null,
      unsubscribe,
      postalAddress: footer?.postal ?? false,
      receiving: footer?.receiving ?? false,
    },
    clip: {
      clipBytes: CLIP_BYTES,
      visibleChars,
      afterClipChars: afterClip,
      ctaAfterClip:
        ctaOut?.offset === null || ctaOut?.offset === undefined
          ? null
          : ctaOut.offset >= CLIP_BYTES,
      unsubscribeAfterClip: unsubD ? d.offset[unsubD.node]! >= CLIP_BYTES : null,
    },
    mergeTagFirstViewport: hasMergeTag(fvText),
    pixels: {
      whitespace: whitespaceShare(x.dImg, crop, imgRects),
      edgeDensity: edgeDensity(x.dImg, crop),
      pngBytesPerPixel: null,
      xyLeaves: xyCutLeaves(x.dImg, crop, bgDom),
      dominantColours: dominantColourCount(x.dImg, crop, imgRects),
      colourfulness: colourfulness(x.dImg, crop),
    },
    components: { gapClusters: cluster(gaps, 2), accentHues },
    axe: x.page.axe,
    regions,
    info: {
      linkCount: mLinks.length,
      imageArea: Math.min(
        1e12,
        images.reduce((s, i) => s + i.dRect.w * i.dRect.h, 0),
      ),
      textArea: Math.min(
        1e12,
        dLive.reduce((s, r) => s + r.rect.w * r.rect.h, 0),
      ),
      readingTimeSec: Math.round((wordsTotal / 230) * 60),
    },
    fonts,
  };
  const darkCandidates = imgFacts
    .filter((i) => i.inlined && /^(?:https?:|cid:|data:image\/(?:png|gif|webp))/i.test(i.ref))
    .sort((a, b) => b.dRect.w * b.dRect.h - a.dRect.w * a.dRect.h)
    .slice(0, 10)
    .map((i) => ({
      ref: i.ref,
      bg: d.parent[i.node]! >= 0 ? d.bg[d.parent[i.node]!]! : { r: 255, g: 255, b: 255, a: 1 },
    }));
  return { features, crop, darkCandidates };
}

function clampRatio(r: number): number {
  return Math.min(21, Math.max(1, r));
}

function rectOut(r: Rect): { x: number; y: number; w: number; h: number } {
  return {
    x: roundTo(r.x, 1),
    y: roundTo(r.y, 1),
    w: roundTo(Math.max(0, r.w), 1),
    h: roundTo(Math.max(0, r.h), 1),
  };
}

function hueClusters(hues: number[]): number {
  if (hues.length === 0) return 0;
  const sorted = [...hues].sort((a, b) => a - b);
  let n = 1;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! > 30) n++;
  if (n > 1 && sorted[0]! + 360 - sorted[sorted.length - 1]! <= 30) n--;
  return n;
}

/** Keep at most 80 groups: merge the tail by (role, large, rendered, short, method) with worst ratios. */
function capGroups(groups: ContrastGroup[]): ContrastGroup[] {
  const sorted = [...groups].sort((a, b) => b.chars - a.chars);
  if (sorted.length <= 80) return sorted;
  const head = sorted.slice(0, 60);
  const tail = new Map<string, ContrastGroup>();
  for (const g of sorted.slice(60)) {
    const key = `${g.role}|${g.large}|${g.rendered}|${g.short}|${g.fine === true}|${g.method}|${g.ratio >= (g.large ? 3 : 4.5)}`;
    const t = tail.get(key);
    if (!t) tail.set(key, { ...g });
    else {
      t.chars += g.chars;
      t.ratio = Math.min(t.ratio, g.ratio);
      t.p90 = t.p90 === null || g.p90 === null ? (t.p90 ?? g.p90) : Math.min(t.p90, g.p90);
    }
  }
  return [...head, ...tail.values()].slice(0, 80);
}

/** Used stacks (≤ 20) with characters per role and weight (DESIGN.md §8.1 step 2). */
function usedFonts(runs: readonly Run[], roleOf: (node: number) => TextRole): UsedFonts {
  const map = new Map<
    string,
    {
      chars: number;
      cjk: number;
      roles: Record<"heading" | "body" | "button" | "navigation" | "footer", number>;
      weights: Map<number, number>;
    }
  >();
  let total = 0;
  for (const r of runs) {
    if (r.pua >= 0.8 * r.chars) continue;
    const css = r.family.slice(0, 200);
    if (analyzeStack(css).icon) continue;
    total += r.chars;
    const cur = map.get(css) ?? {
      chars: 0,
      cjk: 0,
      roles: { heading: 0, body: 0, button: 0, navigation: 0, footer: 0 },
      weights: new Map<number, number>(),
    };
    cur.chars += r.chars;
    cur.cjk += r.cjk;
    cur.roles[roleOf(r.node)] += r.chars;
    cur.weights.set(r.weight, (cur.weights.get(r.weight) ?? 0) + r.chars);
    map.set(css, cur);
  }
  const all = [...map.entries()].sort((a, b) => b[1].chars - a[1].chars);
  const stacks = all.slice(0, 20).map(([css, v]) => {
    const ws = [...v.weights.entries()].sort((a, b) => b[1] - a[1]);
    const top = ws
      .slice(0, 6)
      .map(([w, c]) => [Math.min(1000, Math.max(1, Math.round(w))), c] as [number, number]);
    return {
      css,
      chars: v.chars,
      cjkChars: v.cjk,
      roles: v.roles,
      weights: top,
      otherWeightChars: ws.slice(6).reduce((s, [, c]) => s + c, 0),
    };
  });
  return {
    v: 1,
    stacks,
    otherChars: all.slice(20).reduce((s, [, v]) => s + v.chars, 0),
    totalChars: total,
    imageTextCount: null,
  };
}
