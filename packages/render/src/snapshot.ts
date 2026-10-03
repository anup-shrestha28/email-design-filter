/**
 * A compact, typed view of a CDP `DOMSnapshot.captureSnapshot` result (DESIGN-SCORE §2 render
 * passes: text boxes plus a computed-style whitelist), with the per-node inherited facts the
 * §2.1 definitions need: cumulative opacity, ancestor clip rects, effective background colour,
 * background-image ancestry, block ancestor and the `data-o` byte offset.
 *
 * DOMSnapshot node arrays are in document (pre-)order, so `parent[i] < i` and one forward pass
 * computes every inherited fact.
 */
import { type Rgba, WHITE, composite, parseColor } from "@edf/design/render-kit";

/** Computed-style whitelist (DESIGN-SCORE §2 pass D, plus what the §2.1 definitions read). */
export const STYLE_PROPS = [
  "display",
  "visibility",
  "opacity",
  "overflow-x",
  "overflow-y",
  "position",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "color",
  "-webkit-text-fill-color",
  "background-color",
  "background-image",
  "text-align",
  "text-transform",
  "text-decoration-line",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-bottom-color",
  "border-top-style",
  "border-bottom-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-left-radius",
  "direction",
  // Visible-content extent (`layout.content`): a box drawn only by a side border. A computed border
  // width is 0 whenever its style is none/hidden, so a width ≥ 1 plus the colour decides it.
  "border-left-color",
  "border-right-color",
] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];
const PROP_INDEX = new Map<string, number>(STYLE_PROPS.map((p, i) => [p, i]));

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextBox {
  layout: number;
  node: number;
  rect: Rect;
  start: number;
  length: number;
}

const BLOCK_DISPLAYS = new Set([
  "block",
  "list-item",
  "table-cell",
  "table-caption",
  "flex",
  "grid",
  "flow-root",
  "inline-block",
  "table",
  "inline-table",
  "inline-flex",
  "inline-grid",
]);

/** Minimal structural type of the CDP result we read (validated defensively). */
export interface RawSnapshot {
  documents: Array<{
    nodes: {
      parentIndex?: number[];
      nodeType?: number[];
      nodeName?: number[];
      nodeValue?: number[];
      backendNodeId?: number[];
      attributes?: number[][];
    };
    layout: { nodeIndex: number[]; styles: number[][]; bounds: number[][]; text: number[] };
    textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] };
    contentWidth?: number;
    contentHeight?: number;
  }>;
  strings: string[];
}

export class Snap {
  readonly count: number;
  readonly parent: Int32Array;
  readonly type: Uint8Array;
  readonly names: string[];
  readonly values: Array<string | null>;
  readonly attrs: Array<Map<string, string> | null>;
  readonly layoutOf: Int32Array;
  readonly layoutNode: Int32Array;
  readonly bounds: Float64Array;
  readonly styles: string[][];
  readonly layoutText: Array<string | null>;
  readonly boxes: TextBox[];
  readonly boxesOfNode: Map<number, number[]>;
  readonly children: number[][];
  readonly contentWidth: number;
  readonly contentHeight: number;
  // Inherited facts
  readonly cumOpacity: Float64Array;
  readonly clip: Array<[number, number, number, number] | null>;
  readonly bg: Rgba[];
  readonly bgImage: Uint8Array;
  readonly blockOf: Int32Array;
  readonly offset: Float64Array;
  readonly inCode: Uint8Array;

  constructor(raw: RawSnapshot) {
    const doc = raw.documents[0];
    if (!doc) throw new Error("snapshot: no document");
    const str = (i: number | undefined): string | null =>
      i === undefined || i < 0 || i >= raw.strings.length ? null : (raw.strings[i] ?? null);
    const n = doc.nodes.parentIndex?.length ?? 0;
    this.count = n;
    this.parent = Int32Array.from(doc.nodes.parentIndex ?? []);
    this.type = Uint8Array.from(doc.nodes.nodeType ?? []);
    this.names = (doc.nodes.nodeName ?? []).map((i) => (str(i) ?? "").toLowerCase());
    this.values = (doc.nodes.nodeValue ?? []).map((i) => str(i));
    this.attrs = (doc.nodes.attributes ?? []).map((pairs) => {
      if (!pairs || pairs.length === 0) return null;
      const m = new Map<string, string>();
      for (let k = 0; k + 1 < pairs.length; k += 2)
        m.set((str(pairs[k]) ?? "").toLowerCase(), str(pairs[k + 1]) ?? "");
      return m;
    });
    this.children = Array.from({ length: n }, () => [] as number[]);
    for (let i = 0; i < n; i++) {
      const p = this.parent[i]!;
      if (p >= 0 && p < n) this.children[p]!.push(i);
    }
    const L = doc.layout.nodeIndex.length;
    this.layoutOf = new Int32Array(n).fill(-1);
    this.layoutNode = Int32Array.from(doc.layout.nodeIndex);
    this.bounds = new Float64Array(L * 4);
    this.styles = [];
    this.layoutText = [];
    for (let li = 0; li < L; li++) {
      const ni = doc.layout.nodeIndex[li]!;
      if (ni >= 0 && ni < n && this.layoutOf[ni] === -1) this.layoutOf[ni] = li;
      const b = doc.layout.bounds[li] ?? [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) this.bounds[li * 4 + k] = Number.isFinite(b[k]) ? b[k]! : 0;
      this.styles.push((doc.layout.styles[li] ?? []).map((si) => str(si) ?? ""));
      this.layoutText.push(str(doc.layout.text[li]));
    }
    this.boxes = [];
    this.boxesOfNode = new Map();
    const tb = doc.textBoxes;
    for (let k = 0; k < tb.layoutIndex.length; k++) {
      const li = tb.layoutIndex[k]!;
      const ni = this.layoutNode[li] ?? -1;
      if (ni < 0) continue;
      const b = tb.bounds[k] ?? [0, 0, 0, 0];
      const box: TextBox = {
        layout: li,
        node: ni,
        rect: { x: b[0] ?? 0, y: b[1] ?? 0, w: b[2] ?? 0, h: b[3] ?? 0 },
        start: tb.start[k] ?? 0,
        length: tb.length[k] ?? 0,
      };
      const list = this.boxesOfNode.get(ni) ?? [];
      list.push(this.boxes.length);
      this.boxesOfNode.set(ni, list);
      this.boxes.push(box);
    }
    this.contentWidth = doc.contentWidth ?? 0;
    this.contentHeight = doc.contentHeight ?? 0;

    // Inherited facts in one forward pass (parent[i] < i).
    this.cumOpacity = new Float64Array(n).fill(1);
    this.clip = new Array(n).fill(null);
    this.bg = new Array<Rgba>(n).fill(WHITE);
    this.bgImage = new Uint8Array(n);
    this.blockOf = new Int32Array(n).fill(-1);
    this.offset = new Float64Array(n).fill(-1);
    this.inCode = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.parent[i]!;
      const hasP = p >= 0 && p < i;
      const baseOpacity = hasP ? this.cumOpacity[p]! : 1;
      const baseClip = hasP ? this.clip[p]! : null;
      const baseBg = hasP ? this.bg[p]! : WHITE;
      this.bgImage[i] = hasP ? this.bgImage[p]! : 0;
      this.blockOf[i] = hasP ? this.blockOf[p]! : -1;
      this.inCode[i] = hasP ? this.inCode[p]! : 0;
      const dataO = this.attrs[i]?.get("data-o");
      this.offset[i] =
        dataO !== undefined && /^\d{1,10}$/.test(dataO)
          ? Number(dataO)
          : i > 0
            ? this.offset[i - 1]!
            : -1;
      const li = this.layoutOf[i]!;
      if (this.type[i] !== 1 || li < 0) {
        this.cumOpacity[i] = baseOpacity;
        this.clip[i] = baseClip;
        this.bg[i] = baseBg;
        continue;
      }
      const op = parseFloat(this.style(li, "opacity"));
      const cum = baseOpacity * (Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 1);
      this.cumOpacity[i] = cum;
      const own = parseColor(this.style(li, "background-color"));
      this.bg[i] = own && own.a > 0 ? composite({ ...own, a: own.a * cum }, baseBg) : baseBg;
      const bgi = this.style(li, "background-image");
      if (bgi && bgi !== "none") this.bgImage[i] = 1;
      const ox = this.style(li, "overflow-x");
      const oy = this.style(li, "overflow-y");
      let clip = baseClip;
      if ((ox && ox !== "visible") || (oy && oy !== "visible")) {
        const r = this.rect(li);
        const own4: [number, number, number, number] = [
          ox && ox !== "visible" ? r.x : -Infinity,
          oy && oy !== "visible" ? r.y : -Infinity,
          ox && ox !== "visible" ? r.x + r.w : Infinity,
          oy && oy !== "visible" ? r.y + r.h : Infinity,
        ];
        clip = baseClip
          ? [
              Math.max(baseClip[0], own4[0]),
              Math.max(baseClip[1], own4[1]),
              Math.min(baseClip[2], own4[2]),
              Math.min(baseClip[3], own4[3]),
            ]
          : own4;
      }
      this.clip[i] = clip;
      if (BLOCK_DISPLAYS.has(this.style(li, "display"))) this.blockOf[i] = i;
      const tag = this.names[i];
      if (tag === "code" || tag === "pre" || tag === "kbd" || tag === "samp") this.inCode[i] = 1;
    }
  }

  style(li: number, prop: StyleProp): string {
    const idx = PROP_INDEX.get(prop);
    if (idx === undefined || li < 0) return "";
    return this.styles[li]?.[idx] ?? "";
  }

  /** Computed style of a node (text nodes share their parent's computed style). */
  nodeStyle(node: number, prop: StyleProp): string {
    let li = this.layoutOf[node] ?? -1;
    if (li < 0) {
      const p = this.parent[node] ?? -1;
      li = p >= 0 ? (this.layoutOf[p] ?? -1) : -1;
    }
    return this.style(li, prop);
  }

  rect(li: number): Rect {
    return {
      x: this.bounds[li * 4]!,
      y: this.bounds[li * 4 + 1]!,
      w: this.bounds[li * 4 + 2]!,
      h: this.bounds[li * 4 + 3]!,
    };
  }

  /** Layout rect of a node, or null when it has no layout. */
  nodeRect(node: number): Rect | null {
    const li = this.layoutOf[node] ?? -1;
    return li < 0 ? null : this.rect(li);
  }

  attr(node: number, name: string): string | null {
    return this.attrs[node]?.get(name) ?? null;
  }

  isElement(node: number): boolean {
    return this.type[node] === 1;
  }

  /** Ancestor elements from the parent upwards. */
  *ancestors(node: number): Generator<number> {
    let p = this.parent[node] ?? -1;
    let guard = 0;
    while (p >= 0 && guard++ < 5000) {
      yield p;
      p = this.parent[p] ?? -1;
    }
  }

  isAncestor(anc: number, node: number): boolean {
    for (const a of this.ancestors(node)) if (a === anc) return true;
    return false;
  }

  /** Nearest ancestor-or-self element with the given tag. */
  closestTag(node: number, tags: ReadonlySet<string>): number {
    if (this.isElement(node) && tags.has(this.names[node]!)) return node;
    for (const a of this.ancestors(node)) if (tags.has(this.names[a]!)) return a;
    return -1;
  }

  /** Text of one text box (the rendered, transformed text). */
  boxText(b: TextBox): string {
    const t = this.layoutText[b.layout] ?? this.values[b.node] ?? "";
    return t.slice(b.start, b.start + b.length);
  }

  /** Union of an element's own layout rect and every descendant's layout rect. */
  unionRect(node: number, maxNodes = 2000): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const stack = [node];
    let seen = 0;
    while (stack.length > 0 && seen++ < maxNodes) {
      const cur = stack.pop()!;
      const r = this.nodeRect(cur);
      if (r && r.w > 0 && r.h > 0) {
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
      for (const c of this.children[cur] ?? []) stack.push(c);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}

export function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
