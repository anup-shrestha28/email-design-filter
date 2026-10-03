/**
 * Versioned per-client "likely shows" table (DESIGN.md §8.1 step 3), keyed by client and
 * declaration method, built from caniemail data (snapshot 2026-09-16, MIT) plus the platform
 * font lists in the catalog. Every result is "likely": it depends on the device.
 */
import type { EmailClientId } from "../types";
import type { FontsStatic } from "../features/fonts";
import { ANDROID_ALIASES, type Platform, installedOn, looseKey, matchKey } from "./catalog";
import { type FamilyRef, type StackAnalysis, SYSTEM_UI, isWorkingFallback } from "./normalize";

export const CLIENT_TABLE_VERSION = "clients-2026.09";

type WebFontSupport = "never" | "declared" | "font-face-style";

export interface ClientRule {
  id: EmailClientId;
  label: string;
  platform: Platform;
  webFonts: WebFontSupport;
  /** Families that render even though web fonts don't load (Gmail's own UI fonts). */
  alwaysAvailable: readonly string[];
  androidAliases: boolean;
  outlookClassic: boolean;
  defaults: { sans: string; serif: string; mono: string; system: string; unset: string };
}

/** DESIGN.md §8.1 step 3 table. */
export const CLIENT_RULES: readonly ClientRule[] = [
  {
    id: "gmail_web",
    label: "Gmail (web)",
    platform: "windows",
    webFonts: "never",
    alwaysAvailable: ["Roboto", "Google Sans"],
    androidAliases: false,
    outlookClassic: false,
    defaults: {
      sans: "Arial",
      serif: "Times New Roman",
      mono: "Courier New",
      system: "Segoe UI",
      unset: "Arial",
    },
  },
  {
    id: "gmail_android",
    label: "Gmail (Android)",
    platform: "android",
    webFonts: "never",
    alwaysAvailable: [],
    androidAliases: true,
    outlookClassic: false,
    defaults: {
      sans: "Roboto",
      serif: "Noto Serif",
      mono: "Droid Sans Mono",
      system: "Roboto",
      unset: "Roboto",
    },
  },
  {
    id: "gmail_ios",
    label: "Gmail (iOS)",
    platform: "ios",
    webFonts: "never",
    alwaysAvailable: [],
    androidAliases: false,
    outlookClassic: false,
    defaults: {
      sans: "Helvetica",
      serif: "Times New Roman",
      mono: "Courier",
      system: "San Francisco",
      unset: "Helvetica",
    },
  },
  {
    id: "outlook_classic",
    label: "Outlook for Windows (classic)",
    platform: "office",
    webFonts: "never",
    alwaysAvailable: [],
    androidAliases: false,
    outlookClassic: true,
    defaults: {
      sans: "Arial",
      serif: "Times New Roman",
      mono: "Courier New",
      system: "Segoe UI",
      unset: "Aptos or Calibri",
    },
  },
  {
    id: "outlook_new",
    label: "New Outlook / Outlook.com",
    platform: "windows",
    webFonts: "never",
    alwaysAvailable: [],
    androidAliases: false,
    outlookClassic: false,
    defaults: {
      sans: "Arial",
      serif: "Times New Roman",
      mono: "Courier New",
      system: "Segoe UI",
      unset: "Aptos",
    },
  },
  {
    id: "apple_mail",
    label: "Apple Mail / iOS Mail",
    platform: "ios",
    webFonts: "declared",
    alwaysAvailable: [],
    androidAliases: false,
    outlookClassic: false,
    defaults: {
      sans: "Helvetica",
      serif: "Times",
      mono: "Courier",
      system: "San Francisco",
      unset: "Helvetica",
    },
  },
  {
    id: "samsung",
    label: "Samsung Email",
    platform: "android",
    webFonts: "font-face-style",
    alwaysAvailable: [],
    androidAliases: true,
    outlookClassic: false,
    defaults: {
      sans: "Roboto",
      serif: "Noto Serif",
      mono: "Droid Sans Mono",
      system: "Roboto",
      unset: "Roboto",
    },
  },
];

/** Declared web fonts of one email, indexed for lookups. */
export interface DeclaredFonts {
  byKey: Map<string, FontsStatic["declarations"]>;
  byLoose: Map<string, FontsStatic["declarations"]>;
  msoOverrides: string[];
  /** Adobe Fonts / Fonts.com / unknown stylesheet providers. */
  providerLinks: string[];
}

export function indexDeclared(fs: FontsStatic | null): DeclaredFonts {
  const byKey = new Map<string, FontsStatic["declarations"]>();
  const byLoose = new Map<string, FontsStatic["declarations"]>();
  for (const d of fs?.declarations ?? []) {
    const k = matchKey(d.family);
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
    const lk = looseKey(d.family);
    byLoose.set(lk, [...(byLoose.get(lk) ?? []), d]);
  }
  return {
    byKey,
    byLoose,
    msoOverrides: fs?.msoOverrides ?? [],
    providerLinks: [...new Set((fs?.providerLinks ?? []).map((p) => p.provider))],
  };
}

export function declarationsFor(
  ref: FamilyRef,
  declared: DeclaredFonts,
): FontsStatic["declarations"] {
  if (ref.generic) return [];
  return (
    declared.byKey.get(matchKey(ref.raw)) ??
    declared.byKey.get(ref.key) ??
    declared.byLoose.get(looseKey(ref.raw)) ??
    []
  );
}

export interface StackResolution {
  /** What readers likely see, e.g. "Arial", "Times New Roman". */
  likely: string;
  /** Declared web fonts in the stack that this client skips. */
  fallbackFrom: string[];
  /** Classic Outlook's Times New Roman fallback applies. */
  tnr: boolean;
  /** Classic Outlook used an Outlook-specific fallback (mso-font-alt / [if mso]). */
  outlookFallback: boolean;
  /** The client shows a declared web font. */
  showsWebFont: boolean;
}

function genericDefault(generic: string, rule: ClientRule): string {
  if (generic === "serif" || generic === "ui-serif") return rule.defaults.serif;
  if (generic === "monospace" || generic === "ui-monospace") return rule.defaults.mono;
  if (generic === "system-ui" || generic === "ui-sans-serif" || generic === "ui-rounded")
    return rule.defaults.system;
  return rule.defaults.sans;
}

function availability(
  ref: FamilyRef,
  rule: ClientRule,
  declared: DeclaredFonts,
  platform: Platform,
): { ok: boolean; shown: string; web: boolean } {
  const decls = declarationsFor(ref, declared);
  if (decls.length > 0) {
    if (rule.webFonts === "declared") return { ok: true, shown: ref.display, web: true };
    if (rule.webFonts === "font-face-style" && decls.some((d) => d.method === "font-face")) {
      return { ok: true, shown: ref.display, web: true };
    }
  }
  if (rule.alwaysAvailable.some((n) => matchKey(n) === ref.key))
    return { ok: true, shown: ref.display, web: false };
  if (installedOn(ref.display, platform)) return { ok: true, shown: ref.display, web: false };
  if (rule.androidAliases) {
    const alias = ANDROID_ALIASES[ref.key];
    if (alias) return { ok: true, shown: alias, web: false };
  }
  return { ok: false, shown: ref.display, web: false };
}

/**
 * Resolve what `rule` likely shows for one stack (DESIGN.md §8.1 step 3), including the
 * classic-Outlook Times New Roman rule.
 */
export function resolveStack(
  stack: StackAnalysis,
  rule: ClientRule,
  declared: DeclaredFonts,
  platform: Platform = rule.platform,
): StackResolution {
  const none: StackResolution = {
    likely: rule.defaults.unset,
    fallbackFrom: [],
    tnr: false,
    outlookFallback: false,
    showsWebFont: false,
  };
  if (stack.noFontSet) return none;
  if (stack.systemUi) return { ...none, likely: rule.defaults.system };
  const families = stack.families;
  if (families.length === 0) return none;

  if (rule.outlookClassic) {
    const first = families[0]!;
    const decls = declarationsFor(first, declared);
    if (decls.length > 0 && decls.some((d) => !d.hiddenFromOutlook)) {
      const alt = decls.find((d) => d.msoFontAlt)?.msoFontAlt ?? null;
      if (alt)
        return {
          likely: alt,
          fallbackFrom: [first.display],
          tnr: false,
          outlookFallback: true,
          showsWebFont: false,
        };
      const override = declared.msoOverrides[0];
      if (override)
        return {
          likely: override,
          fallbackFrom: [first.display],
          tnr: false,
          outlookFallback: true,
          showsWebFont: false,
        };
      return {
        likely: "Times New Roman",
        fallbackFrom: [first.display],
        tnr: true,
        outlookFallback: false,
        showsWebFont: false,
      };
    }
  }

  const fallbackFrom: string[] = [];
  for (const ref of families) {
    if (ref.generic) {
      if (!isWorkingFallback(ref)) continue;
      return {
        likely: genericDefault(ref.generic, rule),
        fallbackFrom,
        tnr: false,
        outlookFallback: false,
        showsWebFont: false,
      };
    }
    const a = availability(ref, rule, declared, platform);
    if (a.ok)
      return {
        likely: a.shown,
        fallbackFrom,
        tnr: false,
        outlookFallback: false,
        showsWebFont: a.web,
      };
    const likelyWeb = declared.providerLinks.length > 0 && ref.entry === null;
    if (declarationsFor(ref, declared).length > 0 || likelyWeb) fallbackFrom.push(ref.display);
  }
  return {
    likely: `device default ${families.some((f) => f.generic === "serif") ? "serif" : "sans-serif"}`,
    fallbackFrom,
    tnr: false,
    outlookFallback: false,
    showsWebFont: false,
  };
}

export function ruleFor(id: EmailClientId): ClientRule {
  return CLIENT_RULES.find((r) => r.id === id)!;
}

/** Display helper: System UI stays "System UI" in family lists. */
export const SYSTEM_UI_NAME = SYSTEM_UI;
