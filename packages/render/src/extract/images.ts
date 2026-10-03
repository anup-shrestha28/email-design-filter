/**
 * Content-image load outcomes (DESIGN-SCORE §2.1 "Content images", §5.5 I3, §4 CAP_BROKEN_IMAGES):
 * one `images.loads` entry per distinct image URL declared in the HTML, drawn or not, with the
 * reason it wasn't drawn; plus the declared vs drawn counts the image-only rule works from.
 *
 * An image the render had no picture for (too large, blocked, broken) and no declared width and
 * height lays out as a broken image — with `alt=""`, flat (500×0) — so its rendered box read as a
 * tracking pixel and it vanished from the features (upGrad's 4–5 MB PNGs, a 5000×6250 poster):
 * those are judged by their declared size instead.
 */
import {
  IMAGE_LOAD_REASONS,
  type ImageLoadReason,
  type ImageTableEntry,
  type RenderFeatures,
  isTrackingPixel,
  lookupUrl,
  normalizeHref,
} from "@edf/design/render-kit";
import type { RenderJob } from "@edf/design";
import type { Rect, Snap } from "../snapshot";

type Load = RenderFeatures["images"]["loads"][number];

/** The facts of one content image the extraction found (a subset of its `ImageFact`). */
export interface ImageRefFact {
  node: number;
  kind: "img" | "bg";
  ref: string;
  inlined: boolean;
  tableIndex: number | null;
  dRect: Rect;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(IMAGE_LOAD_REASONS);
/** `images.loads` holds at most this many entries (schema). */
const MAX_LOADS = 60;

/** A pre-fetch reason we recognise (the job is ours, but the output must validate). */
function knownReason(r: unknown): ImageLoadReason | undefined {
  return typeof r === "string" && KNOWN_REASONS.has(r) ? (r as ImageLoadReason) : undefined;
}

function withReason(load: Omit<Load, "reason">, reason: ImageLoadReason | undefined): Load {
  return reason === undefined ? load : { ...load, reason };
}

const STATUS_REASON: Record<string, ImageLoadReason> = {
  blocked: "policy",
  too_large: "too_large",
  timeout: "timeout",
  error: "network",
};

/**
 * Load outcome of one content image: the pre-fetch log's status (a number is the sender's HTTP
 * answer), whether the browser decoded a picture, and why not. An SVG the server sent with a 200
 * is `unsupported` (Gmail doesn't show SVG either): a finding, never a broken image.
 */
export function imageLoadOf(
  img: ImageRefFact,
  job: RenderJob,
  naturals: ReadonlyMap<number, { w: number; h: number }>,
): Load {
  if (!job.imagesAllowed) return { status: "blocked", decoded: false, reason: "images_off" };
  const nat = img.tableIndex !== null ? naturals.get(img.tableIndex) : undefined;
  const picture = img.kind === "bg" || (!!nat && nat.w > 0);
  const decoded = img.inlined && picture;
  if (img.ref.startsWith("data:"))
    return withReason({ status: 200, decoded: picture }, picture ? undefined : "undecodable");
  if (/^cid:/i.test(img.ref)) {
    if (!img.inlined) return { status: "missing", decoded: false, reason: "missing_cid" };
    return withReason({ status: 200, decoded }, decoded ? undefined : "undecodable");
  }
  const log = lookupUrl(job.imageLog, img.ref);
  if (!log) {
    if (!img.inlined) return { status: "missing", decoded: false, reason: "not_fetched" };
    return withReason({ status: 200, decoded }, decoded ? undefined : "undecodable");
  }
  const why = knownReason(log.reason);
  if (typeof log.status === "number") {
    if (log.status >= 200 && log.status < 300) {
      if (why === "svg") return { status: "unsupported", decoded: false, reason: "svg" };
      return withReason(
        { status: log.status, decoded },
        decoded ? undefined : (why ?? (img.inlined ? "undecodable" : "not_image")),
      );
    }
    return { status: log.status, decoded: false, reason: why ?? "http" };
  }
  return {
    status: log.status,
    decoded: false,
    reason: why ?? STATUS_REASON[log.status] ?? "policy",
  };
}

/** A px length from an attribute (`600`, `600px`), or null. */
function attrPx(v: string | null): number | null {
  const m = v ? /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(v) : null;
  return m ? parseFloat(m[1]!) : null;
}

/** A px length from an inline style declaration (`width: 600px`), or null. */
function stylePx(style: string | null, prop: "width" | "height"): number | null {
  if (!style) return null;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i").exec(style);
  return m ? parseFloat(m[1]!) : null;
}

/**
 * Declared size of an image element: width/height attributes, else inline-style px, else its
 * laid-out size when that is more than 1px (a broken image's box says nothing below that).
 */
function declaredSize(s: Snap, node: number): { w: number | null; h: number | null } {
  const style = s.attr(node, "style");
  const rect = s.nodeRect(node);
  const w = attrPx(s.attr(node, "width")) ?? stylePx(style, "width");
  const h = attrPx(s.attr(node, "height")) ?? stylePx(style, "height");
  return {
    w: w ?? (rect && rect.w > 1 ? rect.w : null),
    h: h ?? (rect && rect.h > 1 ? rect.h : null),
  };
}

/** Dedup key: the normalized URL (http/cid), or the element for an embedded picture. */
function keyOf(ref: string, node: number): string {
  if (/^(?:https?|cid):/i.test(ref)) return normalizeHref(ref);
  return `#${node}`;
}

export interface ImageLoads {
  loads: Load[];
  declared: number;
  drawn: number;
}

/**
 * `images.loads` / `declared` / `drawn` (render-2026.4). `found` are the content images the
 * extraction kept by their rendered box; an `<img>` it dropped that got no picture at all (not
 * inlined, and no declared-size placeholder) is added when its declared size isn't a tracking
 * pixel's, it isn't hidden in both passes, the pre-fetch didn't block it as a pixel, and — for a
 * tracker-host refusal — its size is known. Entries are merged by URL: the best outcome wins
 * (decoded over not), areas add up.
 */
export function contentImageLoads(input: {
  d: Snap;
  m: Snap;
  found: readonly ImageRefFact[];
  imageTable: readonly ImageTableEntry[];
  naturals: ReadonlyMap<number, { w: number; h: number }>;
  job: RenderJob;
}): ImageLoads {
  const { d, m, job, naturals } = input;
  const items: Array<{ node: number; key: string; load: Load; area: number }> = [];
  const seenNodes = new Set<number>();
  for (const img of input.found) {
    seenNodes.add(img.node);
    items.push({
      node: img.node,
      key: keyOf(img.ref, img.node),
      load: imageLoadOf(img, job, naturals),
      area: img.dRect.w * img.dRect.h,
    });
  }
  for (let i = 0; i < d.count; i++) {
    if (d.names[i] !== "img" || seenNodes.has(i) || !d.isElement(i)) continue;
    const v = d.attr(i, "data-edf-i");
    const ti = v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null;
    const entry = ti !== null ? input.imageTable[ti] : undefined;
    if (!entry || !entry.ref.trim()) continue;
    // A picture was drawn (the image or its placeholder): the extraction judged its real box.
    const nat = naturals.get(ti!);
    if (nat && nat.w > 0) continue;
    const dli = d.layoutOf[i]!;
    const mli = m.layoutOf[i] ?? -1;
    if (dli < 0 && mli < 0) continue;
    const snap = dli >= 0 ? d : m;
    const li = dli >= 0 ? dli : mli;
    if (snap.style(li, "visibility") !== "visible" || snap.cumOpacity[i]! <= 0.01) continue;
    const size = declaredSize(snap, i);
    if (isTrackingPixel({ src: entry.ref, width: size.w, height: size.h, hidden: false })) continue;
    const fact: ImageRefFact = {
      node: i,
      kind: "img",
      ref: entry.ref,
      inlined: entry.inlined,
      tableIndex: ti,
      dRect: d.nodeRect(i) ?? { x: 0, y: 0, w: 0, h: 0 },
    };
    const load = imageLoadOf(fact, job, naturals);
    if (load.reason === "pixel") continue;
    if (load.reason === "tracker" && (size.w === null || size.h === null)) continue;
    items.push({
      node: i,
      key: keyOf(entry.ref, i),
      load,
      area: size.w !== null && size.h !== null ? size.w * size.h : fact.dRect.w * fact.dRect.h,
    });
  }
  items.sort((a, b) => a.node - b.node);
  const byKey = new Map<string, { load: Load; area: number }>();
  for (const it of items) {
    const cur = byKey.get(it.key);
    if (!cur) byKey.set(it.key, { load: it.load, area: it.area });
    else {
      if (!cur.load.decoded && it.load.decoded) cur.load = it.load;
      cur.area += it.area;
    }
  }
  const merged = [...byKey.values()];
  return {
    loads: merged
      .slice(0, MAX_LOADS)
      .map((e) => ({ ...e.load, area: Math.min(1e12, Math.round(Math.max(0, e.area))) })),
    declared: merged.length,
    drawn: merged.filter((e) => e.load.decoded).length,
  };
}
