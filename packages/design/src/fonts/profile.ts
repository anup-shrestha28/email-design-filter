/**
 * Font profile (DESIGN.md §8.1 steps 2–5; FREE-TIER.md §5.4 "Font profile per coverage level"):
 * a pure function of the raw font facts, so client-table and catalog updates only need a
 * re-score. Informational — it feeds T6 and X2 but earns no points of its own.
 */
import type { FontFeatures, FontsStatic, UsedFonts } from "../features/fonts";
import type {
  ClientFontResult,
  EmailClientId,
  FontClass,
  FontFamilyProfile,
  FontProfile,
  FontRole,
  FontSummary,
} from "../types";
import { matchKey } from "./catalog";
import {
  CLIENT_RULES,
  type DeclaredFonts,
  type StackResolution,
  declarationsFor,
  indexDeclared,
  resolveStack,
  ruleFor,
} from "./clients";
import {
  type FamilyRef,
  NO_FONT_SET,
  type StackAnalysis,
  analyzeStack,
  isWorkingFallback,
} from "./normalize";

const ROLES: readonly FontRole[] = ["heading", "body", "button", "navigation", "footer"];
/** A family is used at ≥ 1% of counted characters or ≥ 20 characters (DESIGN.md §8.1 step 2). */
const USED_SHARE = 0.01;
const USED_CHARS = 20;

interface FamilyAcc {
  ref: FamilyRef;
  chars: number;
  roles: Record<FontRole, number>;
  weights: Map<number, number>;
}

function emptyRoles(): Record<FontRole, number> {
  return { heading: 0, body: 0, button: 0, navigation: 0, footer: 0 };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function classify(
  ref: FamilyRef,
  declared: DeclaredFonts,
): { cls: FontClass; provider: string | null } {
  if (ref.generic || ref.display === "System UI") return { cls: "system", provider: null };
  const decls = declarationsFor(ref, declared);
  if (decls.length > 0)
    return { cls: "web", provider: decls.find((d) => d.provider)?.provider ?? null };
  if (ref.entry && ref.entry.platforms.length > 0) return { cls: "system", provider: null };
  if (!ref.entry && declared.providerLinks.length > 0)
    return { cls: "likely_web", provider: declared.providerLinks[0]! };
  return { cls: "not_loaded", provider: null };
}

function declaredWeights(
  ref: FamilyRef,
  declared: DeclaredFonts,
): { weights: number[]; variable: [number, number] | null } {
  const decls = declarationsFor(ref, declared);
  const weights = new Set<number>();
  let variable: [number, number] | null = null;
  for (const d of decls) {
    for (const w of d.weights) weights.add(w);
    if (d.variable)
      variable = variable
        ? [Math.min(variable[0], d.variable[0]), Math.max(variable[1], d.variable[1])]
        : d.variable;
  }
  return { weights: [...weights].sort((a, b) => a - b), variable };
}

function weightNote(variable: [number, number] | null): string | null {
  return variable ? `variable ${variable[0]}–${variable[1]}` : null;
}

/** Measured families from the used stacks (CJK credited to the first CJK-capable family). */
function measuredFamilies(used: UsedFonts): {
  accs: FamilyAcc[];
  noFontSet: number;
  total: number;
  analyses: Array<[StackAnalysis, UsedFonts["stacks"][number]]>;
} {
  const byKey = new Map<string, FamilyAcc>();
  let noFontSet = 0;
  const analyses: Array<[StackAnalysis, UsedFonts["stacks"][number]]> = [];
  const credit = (
    ref: FamilyRef,
    chars: number,
    stack: UsedFonts["stacks"][number],
    fraction: number,
  ) => {
    if (chars <= 0) return;
    let acc = byKey.get(ref.key);
    if (!acc) {
      acc = { ref, chars: 0, roles: emptyRoles(), weights: new Map() };
      byKey.set(ref.key, acc);
    }
    acc.chars += chars;
    for (const r of ROLES) acc.roles[r] += stack.roles[r] * fraction;
    for (const [w, c] of stack.weights)
      acc.weights.set(w, (acc.weights.get(w) ?? 0) + c * fraction);
  };
  for (const stack of used.stacks) {
    const a = analyzeStack(stack.css);
    if (a.icon) continue;
    analyses.push([a, stack]);
    if (a.noFontSet) {
      noFontSet += stack.chars;
      continue;
    }
    const primary = a.primary;
    if (!primary || stack.chars <= 0) continue;
    const cjk = Math.min(stack.cjkChars, stack.chars);
    const cjkTarget = cjk > 0 ? (a.families.find((f) => f.entry?.cjk) ?? primary) : primary;
    credit(primary, stack.chars - cjk, stack, (stack.chars - cjk) / stack.chars);
    credit(cjkTarget, cjk, stack, cjk / stack.chars);
  }
  const total = Math.max(
    used.totalChars,
    [...byKey.values()].reduce((s, a) => s + a.chars, 0) + noFontSet,
    1,
  );
  return {
    accs: [...byKey.values()].sort((a, b) => b.chars - a.chars),
    noFontSet,
    total,
    analyses,
  };
}

interface ProfileInputs {
  declared: DeclaredFonts;
  /** Stacks that matter, with their weight (chars), main stack first. */
  stacks: Array<{ analysis: StackAnalysis; weight: number }>;
  familyNames: FontFamilyProfile[];
}

function clientResults(inp: ProfileInputs): {
  clients: ClientFontResult[];
  tnr: boolean;
  resolutions: Map<EmailClientId, StackResolution>;
} {
  const main = inp.stacks[0]?.analysis ?? null;
  const resolutions = new Map<EmailClientId, StackResolution>();
  let tnr = false;
  const clients: ClientFontResult[] = CLIENT_RULES.map((rule) => {
    const fallbackFrom = new Set<string>();
    let anyTnr = false;
    let anyWeb = false;
    for (const { analysis } of inp.stacks) {
      const r = resolveStack(analysis, rule, inp.declared);
      for (const f of r.fallbackFrom) fallbackFrom.add(f);
      anyTnr ||= r.tnr;
      anyWeb ||= r.showsWebFont;
    }
    const res = main
      ? resolveStack(main, rule, inp.declared)
      : {
          likely: rule.defaults.unset,
          fallbackFrom: [],
          tnr: false,
          outlookFallback: false,
          showsWebFont: false,
        };
    resolutions.set(rule.id, res);
    if (rule.outlookClassic) tnr = anyTnr;
    const fb = [...fallbackFrom];
    let note: string;
    let warning = false;
    if (rule.outlookClassic && anyTnr) {
      warning = true;
      note =
        "Likely shows Times New Roman — the web fonts are linked with no Outlook fallback (no mso-font-alt, no Outlook-safe wrapper).";
    } else if (rule.outlookClassic && res.outlookFallback) {
      note = `Likely shows ${res.likely} (the email sets an Outlook fallback).`;
    } else if (anyWeb && fb.length === 0) {
      note = "Shows the web fonts.";
    } else if (fb.length > 0) {
      note = `Doesn't load ${joinNames(fb)} — readers likely see ${res.likely}.`;
      warning = rule.id === "gmail_web";
    } else {
      note = `Likely shows ${res.likely}.`;
    }
    if (rule.id === "gmail_web" && main) {
      const mac = resolveStack(main, rule, inp.declared, "macos").likely;
      if (mac !== res.likely) note = `${note.replace(/\.$/, "")} (${mac} on Mac).`;
    }
    return {
      client: rule.id,
      label: rule.label,
      likely: res.likely,
      fallbackFrom: fb,
      warning,
      note,
    };
  });
  return { clients, tnr, resolutions };
}

function warningsFor(inp: ProfileInputs, clients: ClientFontResult[], tnr: boolean): string[] {
  const warnings: string[] = [];
  const gmail = clients.find((c) => c.client === "gmail_web");
  const android = clients.find((c) => c.client === "gmail_android");
  const webShown = inp.familyNames.filter(
    (f) =>
      (f.class === "web" || f.class === "likely_web") &&
      (f.share === null || f.share >= USED_SHARE),
  );
  const gmailFallback = webShown.filter((f) =>
    gmail?.fallbackFrom.some((n) => matchKey(n) === matchKey(f.name)),
  );
  if (gmail && gmailFallback.length > 0) {
    const onAndroid =
      android && android.likely !== gmail.likely ? ` (${android.likely} on Android)` : "";
    warnings.push(
      `Gmail doesn't load web fonts — Gmail readers likely see ${gmail.likely}${onAndroid} instead of ${joinNames(gmailFallback.map((f) => f.name))}.`,
    );
  }
  if (tnr) {
    warnings.push(
      "Outlook for Windows (classic) likely shows Times New Roman — the web fonts are linked with no Outlook fallback (no mso-font-alt, no Outlook-safe wrapper).",
    );
  }
  for (const f of inp.familyNames) {
    if (f.class !== "not_loaded") continue;
    const stack = inp.stacks.find(
      (s) => s.analysis.primary && matchKey(s.analysis.primary.display) === matchKey(f.name),
    );
    const rest = stack ? stack.analysis.families.slice(1) : [];
    const firstWorking = rest.find(isWorkingFallback);
    const readersSee = firstWorking
      ? firstWorking.generic
        ? "the device default font"
        : firstWorking.display
      : "the device default font";
    warnings.push(
      `${f.name} isn't loaded by this email — readers see ${readersSee} unless it's installed.`,
    );
    if (warnings.length >= 6) break;
  }
  return warnings;
}

function fallbacksOf(
  stacks: Array<{ analysis: StackAnalysis; weight: number }>,
  primaries: Set<string>,
): string[] {
  const score = new Map<string, { name: string; n: number }>();
  for (const { analysis, weight } of stacks) {
    for (const ref of analysis.families.slice(1)) {
      if (ref.generic || primaries.has(ref.key)) continue;
      const cur = score.get(ref.key) ?? { name: ref.display, n: 0 };
      cur.n += 1 + weight / 1e6;
      score.set(ref.key, cur);
    }
  }
  return [...score.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((s) => s.name);
}

/** `email.font_families`: ≤ 12 display names, one per case-folded name, no generics or "No font set". */
function fontFamiliesColumn(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (name === NO_FONT_SET || isGenericName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 12) break;
  }
  return out;
}

/** A family reference for a declared family name (quoted, so it is never a generic). */
function declaredRef(family: string): FamilyRef | null {
  return analyzeStack(`"${family.replace(/["\\]/g, "")}"`).primary;
}

function measuredProfile(
  fonts: FontFeatures,
  used: UsedFonts,
  source: "render" | "template",
): FontProfile {
  const declared = indexDeclared(fonts.static);
  const { accs, noFontSet, total, analyses } = measuredFamilies(used);
  const usedAccs = accs.filter((a) => a.chars >= USED_SHARE * total || a.chars >= USED_CHARS);
  const families: FontFamilyProfile[] = usedAccs.map((a) => {
    const { cls, provider } = classify(a.ref, declared);
    const dw = declaredWeights(a.ref, declared);
    const roles = ROLES.filter((r) => a.roles[r] >= 0.2 * a.chars)
      .sort((x, y) => a.roles[y] - a.roles[x])
      .slice(0, 2);
    const weights = [...a.weights.entries()]
      .filter(([, c]) => c >= 0.05 * a.chars)
      .sort((x, y) => x[0] - y[0])
      .map(([w]) => ({
        weight: w,
        synthesized:
          cls === "web" &&
          (dw.weights.length > 0 || dw.variable !== null) &&
          !dw.weights.includes(w) &&
          !(dw.variable && w >= dw.variable[0] && w <= dw.variable[1]),
      }));
    return {
      name: a.ref.display,
      share: a.chars / total,
      roles,
      class: cls,
      provider,
      weights,
      weightNote: weightNote(dw.variable),
    };
  });
  const usedKeys = new Set(usedAccs.map((a) => a.ref.key));
  const allCreditedKeys = new Set(accs.map((a) => a.ref.key));
  const declaredUnused = [
    ...new Set((fonts.static?.declarations ?? []).map((d) => d.family)),
  ].filter((name) => !allCreditedKeys.has(matchKey(name)));
  const stacks = analyses
    .filter(([a]) => !a.noFontSet)
    .map(([analysis, s]) => ({
      analysis,
      weight: s.roles.body > 0 ? s.roles.body * 10 + s.chars : s.chars,
    }))
    .sort((x, y) => y.weight - x.weight);
  const inputs: ProfileInputs = { declared, stacks, familyNames: families };
  const { clients, tnr } = clientResults(inputs);
  const warnings = warningsFor(inputs, clients, tnr);
  return {
    source,
    measured: true,
    families,
    noFontSetShare: noFontSet / total,
    fallbacks: fallbacksOf(stacks, usedKeys),
    declaredUnused,
    clients,
    warnings,
    imageTextCount: used.imageTextCount,
    fontFamilies: fontFamiliesColumn(families.map((f) => f.name)),
    usesWebFonts: families.some((f) => f.class === "web" && (f.share ?? 0) >= USED_SHARE),
  };
}

function isGenericName(name: string): boolean {
  return /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/.test(
    name,
  );
}

function staticProfile(fonts: FontFeatures): FontProfile {
  const fsFacts: FontsStatic | null = fonts.static;
  const declared = indexDeclared(fsFacts);
  const stacks = (fsFacts?.stacks ?? [])
    .map((s) => ({ analysis: analyzeStack(s.css), weight: s.chars }))
    .filter((s) => !s.analysis.icon && !s.analysis.noFontSet && s.analysis.primary);
  const byKey = new Map<string, FontFamilyProfile>();
  const add = (ref: FamilyRef) => {
    if (byKey.has(ref.key)) return;
    const { cls, provider } = classify(ref, declared);
    const dw = declaredWeights(ref, declared);
    byKey.set(ref.key, {
      name: ref.display,
      share: null,
      roles: [],
      class: cls,
      provider,
      weights: dw.weights.map((w) => ({ weight: w, synthesized: false })),
      weightNote: weightNote(dw.variable),
    });
  };
  for (const s of stacks) add(s.analysis.primary!);
  for (const d of fsFacts?.declarations ?? []) {
    const ref = declaredRef(d.family);
    if (ref) add(ref);
  }
  const families = [...byKey.values()];
  const inputs: ProfileInputs = { declared, stacks, familyNames: families };
  const { clients, tnr } = clientResults(inputs);
  const primaries = new Set(stacks.map((s) => s.analysis.primary!.key));
  const stackFamilies = stacks.map((s) => s.analysis.primary!.display);
  return {
    source: "static",
    measured: false,
    families,
    noFontSetShare: null,
    fallbacks: fallbacksOf(stacks, primaries),
    declaredUnused: [],
    clients,
    warnings: warningsFor(inputs, clients, tnr),
    imageTextCount: null,
    fontFamilies: fontFamiliesColumn(stackFamilies),
    usesWebFonts: stacks.some((s) => declarationsFor(s.analysis.primary!, declared).length > 0),
  };
}

/**
 * Derive the Fonts card from raw font facts (DESIGN.md §8.1 "Derived at read time").
 * `source` is the coverage level; without measured stacks the profile is static
 * ("Fonts declared in the email code (not measured)").
 */
export function fontProfile(
  fonts: FontFeatures,
  opts: { source: "render" | "template" | "static" },
): FontProfile {
  if (opts.source !== "static" && fonts.used && fonts.used.stacks.length > 0) {
    return measuredProfile(fonts, fonts.used, opts.source);
  }
  return staticProfile(fonts);
}

/** Compact font summary kept after feature compaction (≤ 0.3 KB, FREE-TIER.md §5.4). */
export function fontSummary(profile: FontProfile): FontSummary {
  const gmail = profile.clients.find((c) => c.client === "gmail_web");
  const outlook = profile.clients.find((c) => c.client === "outlook_classic");
  return {
    families: profile.families
      .filter((f) => f.name !== NO_FONT_SET)
      .slice(0, 3)
      .map((f) => ({
        name: f.name.slice(0, 40),
        share: f.share === null ? null : Math.round(f.share * 1000) / 1000,
        role: f.roles[0] ?? null,
        class: f.class,
      })),
    gmailWeb: gmail ? gmail.likely.slice(0, 40) : null,
    outlookClassic: outlook ? outlook.likely.slice(0, 40) : null,
    outlookClassicWarning: outlook?.warning ?? false,
  };
}

/** Rebuild a (reduced) profile from a saved summary; labelled "saved summary". */
export function fontProfileFromSummary(s: FontSummary): FontProfile {
  const families: FontFamilyProfile[] = s.families.map((f) => ({
    name: f.name,
    share: f.share,
    roles: f.role ? [f.role] : [],
    class: f.class,
    provider: null,
    weights: [],
    weightNote: null,
  }));
  const clients: ClientFontResult[] = [];
  if (s.gmailWeb) {
    const rule = ruleFor("gmail_web");
    clients.push({
      client: "gmail_web",
      label: rule.label,
      likely: s.gmailWeb,
      fallbackFrom: [],
      warning: false,
      note: `Likely shows ${s.gmailWeb}.`,
    });
  }
  if (s.outlookClassic) {
    const rule = ruleFor("outlook_classic");
    clients.push({
      client: "outlook_classic",
      label: rule.label,
      likely: s.outlookClassic,
      fallbackFrom: [],
      warning: s.outlookClassicWarning,
      note: s.outlookClassicWarning
        ? "Likely shows Times New Roman — the web fonts are linked with no Outlook fallback (no mso-font-alt, no Outlook-safe wrapper)."
        : `Likely shows ${s.outlookClassic}.`,
    });
  }
  const warnings = s.outlookClassicWarning
    ? [
        "Outlook for Windows (classic) likely shows Times New Roman — the web fonts are linked with no Outlook fallback (no mso-font-alt, no Outlook-safe wrapper).",
      ]
    : [];
  return {
    source: "summary",
    measured: families.some((f) => f.share !== null),
    families,
    noFontSetShare: null,
    fallbacks: [],
    declaredUnused: [],
    clients,
    warnings,
    imageTextCount: null,
    fontFamilies: fontFamiliesColumn(families.map((f) => f.name)),
    usesWebFonts: families.some((f) => f.class === "web"),
  };
}

export interface WebFontCompat {
  /** A stack whose primary is a declared web font has no working fallback (X2, severity 0.5). */
  noFallbackStack: boolean;
  /** The classic-Outlook Times New Roman condition holds for a used stack (X2). */
  outlookTnr: boolean;
}

/** X2 inputs from the font facts (DESIGN-SCORE §5.8 X2; DESIGN.md §8.1 step 3). */
export function webFontCompat(fonts: FontFeatures, measured: boolean): WebFontCompat {
  const declared = indexDeclared(fonts.static);
  const cssList: string[] = [];
  if (measured && fonts.used) {
    const total = Math.max(1, fonts.used.totalChars);
    for (const s of fonts.used.stacks)
      if (s.chars >= USED_SHARE * total || s.chars >= USED_CHARS) cssList.push(s.css);
  } else {
    for (const s of fonts.static?.stacks ?? []) cssList.push(s.css);
  }
  let noFallbackStack = false;
  let outlookTnr = false;
  const outlook = ruleFor("outlook_classic");
  for (const css of cssList) {
    const a = analyzeStack(css);
    if (!a.primary || a.noFontSet || a.icon) continue;
    if (declarationsFor(a.primary, declared).length === 0) continue;
    if (!a.families.slice(1).some(isWorkingFallback)) noFallbackStack = true;
    if (resolveStack(a, outlook, declared).tnr) outlookTnr = true;
  }
  return { noFallbackStack, outlookTnr };
}

const ROLE_LABEL: Record<FontRole, string> = {
  heading: "headings",
  body: "body text",
  button: "buttons",
  navigation: "navigation",
  footer: "footer",
};

const CLASS_LABEL: Record<FontClass, string> = {
  web: "web font",
  likely_web: "likely web font",
  system: "system font",
  not_loaded: "not loaded",
};

/**
 * Plain-text Fonts card (DESIGN.md §8.1 "What the user sees"), one line per entry. The web UI
 * renders the same facts; this form serves the CLI, logs-free debugging and tests.
 */
export function fontCardLines(profile: FontProfile): string[] {
  const lines: string[] = [];
  if (!profile.measured) lines.push("Fonts declared in the email code (not measured)");
  const width =
    Math.max(
      8,
      ...profile.families.map((f) => f.name.length),
      ...profile.fallbacks.slice(0, 2).map((n) => n.length),
    ) + 2;
  for (const f of profile.families) {
    const parts: string[] = [];
    if (f.roles.length > 0) parts.push(f.roles.map((r) => ROLE_LABEL[r]).join(" and "));
    if (f.share !== null) parts.push(`${Math.round(f.share * 100)}% of text`);
    parts.push(
      f.provider && (f.class === "web" || f.class === "likely_web")
        ? `${CLASS_LABEL[f.class]} (${f.class === "likely_web" ? `likely from ${f.provider}` : f.provider})`
        : CLASS_LABEL[f.class],
    );
    if (f.weights.length > 0) {
      parts.push(
        `weights ${f.weights.map((w) => (w.synthesized ? `${w.weight} (synthesized)` : String(w.weight))).join(", ")}`,
      );
    }
    if (f.weightNote) parts.push(f.weightNote);
    lines.push(`${f.name.padEnd(width)}${parts.join(" · ")}`);
  }
  if (profile.noFontSetShare !== null && profile.noFontSetShare >= 0.01) {
    lines.push(`${NO_FONT_SET} · ${Math.round(profile.noFontSetShare * 100)}% of text`);
  }
  for (const fb of profile.fallbacks.slice(0, 2)) {
    lines.push(`${fb.padEnd(width)}backup font in the font stacks`);
  }
  for (const w of profile.warnings) lines.push(`⚠ ${w}`);
  const apple = profile.clients.find((c) => c.client === "apple_mail");
  if (apple && apple.note === "Shows the web fonts.")
    lines.push("  Apple Mail and iOS Mail show the web fonts.");
  if (profile.declaredUnused.length > 0)
    lines.push(`Loaded but not used: ${profile.declaredUnused.join(", ")}`);
  if (profile.imageTextCount !== null && profile.imageTextCount > 0) {
    lines.push(
      `At least ${profile.imageTextCount} image${profile.imageTextCount === 1 ? "" : "s"} contain text — fonts inside images can't be identified.`,
    );
  }
  return lines;
}
