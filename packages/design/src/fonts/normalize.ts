/**
 * Font-stack normalization (DESIGN.md §8.1 step 4): css-tree parsing, generics, match and
 * loose keys, catalog lookup, emoji removal, System UI collapse and icon-font detection.
 */
import * as csstree from "css-tree";
import {
  EMOJI_FAMILY,
  GENERIC_FAMILIES,
  ICON_FAMILY,
  type CatalogEntry,
  lookupFamily,
  looseKey,
  matchKey,
} from "./catalog";

/** The renderer's "no font set" sentinel (DESIGN.md §8.1 step 2). */
export const DEFAULT_SENTINEL = "__default__";
export const NO_FONT_SET = "No font set (each app's default)";
export const SYSTEM_UI = "System UI";

export interface FamilyRef {
  /** As written (decoded by css-tree). */
  raw: string;
  /** Catalog spelling if known, else the designer's spelling. */
  display: string;
  /** Match key of the display name. */
  key: string;
  /** The generic keyword this token names (quoted or not), else null. */
  generic: string | null;
  /** True for a quoted token: a quoted generic is shown as the generic but is not a fallback. */
  quoted: boolean;
  entry: CatalogEntry | null;
}

export interface StackAnalysis {
  families: FamilyRef[];
  /** First non-emoji family (after System UI collapse). */
  primary: FamilyRef | null;
  /** The stack is the renderer's "no font set" sentinel. */
  noFontSet: boolean;
  systemUi: boolean;
  icon: boolean;
}

const cache = new Map<string, StackAnalysis>();

/** Split a `font-family` value into family tokens with css-tree (escapes decoded). */
export function parseFamilyList(css: string): Array<{ name: string; quoted: boolean }> {
  const value = css.length > 500 ? css.slice(0, 500) : css;
  const out: Array<{ name: string; quoted: boolean }> = [];
  try {
    const ast = csstree.parse(value, { context: "value", onParseError: () => undefined });
    let idents: string[] = [];
    const flush = () => {
      if (idents.length > 0) out.push({ name: idents.join(" "), quoted: false });
      idents = [];
    };
    csstree.walk(ast, (node) => {
      if (node.type === "Identifier") idents.push(csstree.ident.decode(node.name));
      else if (node.type === "String") {
        flush();
        out.push({ name: node.value, quoted: true });
      } else if (node.type === "Operator" && node.value === ",") flush();
    });
    flush();
  } catch {
    // Fall through to the manual split below.
  }
  if (out.length > 0) return out.slice(0, 16);
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 16)
    .map((s) => {
      const quoted = /^(['"]).*\1$/.test(s);
      return { name: quoted ? s.slice(1, -1) : s, quoted };
    });
}

function toRef(name: string, quoted: boolean): FamilyRef {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  const generic = GENERIC_FAMILIES.has(lower) ? lower : null;
  const entry = generic ? null : lookupFamily(trimmed);
  const display = entry ? entry.name : (generic ?? trimmed);
  return { raw: trimmed, display, key: matchKey(display), generic, quoted, entry };
}

export function isEmojiFamily(name: string): boolean {
  return EMOJI_FAMILY.test(looseKey(name));
}

export function isIconFamily(name: string): boolean {
  return ICON_FAMILY.test(looseKey(name));
}

function isSystemUiToken(ref: FamilyRef): boolean {
  if (ref.generic && !ref.quoted)
    return ref.generic === "system-ui" || ref.generic.startsWith("ui-");
  const k = ref.key;
  return k === "-apple-system" || k === "blinkmacsystemfont" || k === "system-ui";
}

/** Analyse a computed or declared `font-family` value (memoised). */
export function analyzeStack(css: string): StackAnalysis {
  const cached = cache.get(css);
  if (cached) return cached;
  const tokens = parseFamilyList(css).map((t) => toRef(t.name, t.quoted));
  const noFontSet = tokens.length > 0 && tokens[0]!.raw === DEFAULT_SENTINEL;
  const families = tokens.filter((t) => !isEmojiFamily(t.raw) && t.raw !== DEFAULT_SENTINEL);
  let primary = families[0] ?? null;
  let systemUi = false;
  if (primary && isSystemUiToken(primary)) {
    systemUi = true;
    primary = {
      raw: primary.raw,
      display: SYSTEM_UI,
      key: matchKey(SYSTEM_UI),
      generic: null,
      quoted: false,
      entry: null,
    };
  }
  const icon = !!primary && !primary.generic && isIconFamily(primary.raw);
  const result: StackAnalysis = {
    families,
    primary: noFontSet ? null : primary,
    noFontSet,
    systemUi,
    icon,
  };
  if (cache.size > 5000) cache.clear();
  cache.set(css, result);
  return result;
}

/** A token that works as a fallback in a font stack (unquoted generic or a real family). */
export function isWorkingFallback(ref: FamilyRef): boolean {
  return ref.generic ? !ref.quoted : true;
}
