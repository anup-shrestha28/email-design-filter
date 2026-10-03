/**
 * Bundled font catalog (DESIGN.md §8.1 step 4): platform fonts per OS (with localized CJK
 * names), the metric alias table, icon and emoji families, and the Google Fonts family list
 * (`data/google-fonts.json`, fetched from fonts.google.com metadata on 2026-09-27).
 *
 * Versioned as part of SCORING_VERSION (CATALOG_VERSION).
 */
import googleFonts from "./data/google-fonts.json" with { type: "json" };

export const CATALOG_VERSION = `catalog-2026.09+gf-${googleFonts.fetchedAt}`;

export type Platform = "windows" | "office" | "macos" | "ios" | "android";

/** Fonts installed with Windows 10/11 (the reader's OS for Gmail web / Outlook). */
const WINDOWS = [
  "Arial",
  "Arial Black",
  "Bahnschrift",
  "Calibri",
  "Cambria",
  "Cambria Math",
  "Candara",
  "Comic Sans MS",
  "Consolas",
  "Constantia",
  "Corbel",
  "Courier New",
  "Ebrima",
  "Franklin Gothic Medium",
  "Gabriola",
  "Gadugi",
  "Georgia",
  "Impact",
  "Ink Free",
  "Javanese Text",
  "Leelawadee UI",
  "Lucida Console",
  "Lucida Sans Unicode",
  "Malgun Gothic",
  "Microsoft Himalaya",
  "Microsoft JhengHei",
  "Microsoft Sans Serif",
  "Microsoft YaHei",
  "MingLiU-ExtB",
  "Mongolian Baiti",
  "MS Gothic",
  "MS PGothic",
  "MS UI Gothic",
  "MV Boli",
  "Myanmar Text",
  "Nirmala UI",
  "Palatino Linotype",
  "Segoe Print",
  "Segoe Script",
  "Segoe UI",
  "Segoe UI Variable",
  "Segoe UI Emoji",
  "Segoe UI Historic",
  "Segoe UI Symbol",
  "SimSun",
  "NSimSun",
  "SimHei",
  "KaiTi",
  "FangSong",
  "Sitka Text",
  "Sylfaen",
  "Symbol",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Webdings",
  "Wingdings",
  "Yu Gothic",
  "Yu Mincho",
  "Meiryo",
  "Meiryo UI",
  "MS Mincho",
  "MS PMincho",
  "PMingLiU",
  "MingLiU",
  "Gulim",
  "Dotum",
  "Batang",
  "Gungsuh",
  "Lucida Sans",
  "Segoe MDL2 Assets",
  "Segoe Fluent Icons",
] as const;

/** Fonts installed with Microsoft Office (classic Outlook readers have Office). */
const OFFICE = [
  "Aptos",
  "Aptos Display",
  "Aptos Narrow",
  "Aptos Serif",
  "Aptos Mono",
  "Book Antiqua",
  "Bookman Old Style",
  "Century",
  "Century Gothic",
  "Garamond",
  "Tw Cen MT",
  "Arial Narrow",
  "Arial Rounded MT Bold",
  "Baskerville Old Face",
  "Bodoni MT",
  "Brush Script MT",
  "Copperplate Gothic Bold",
  "Gill Sans MT",
  "Goudy Old Style",
  "Lucida Bright",
  "Lucida Calligraphy",
  "Lucida Handwriting",
  "Perpetua",
  "Rockwell",
  "Wingdings 2",
  "Wingdings 3",
  "Monotype Corsiva",
  "Haettenschweiler",
  "Agency FB",
  "Bell MT",
  "Calisto MT",
  "Footlight MT Light",
  "Gill Sans Nova",
  "Grandview",
  "Seaford",
  "Skeena",
  "Tenorite",
  "Verdana Pro",
  "Georgia Pro",
  "Avenir Next LT Pro",
  "Neue Haas Grotesk Text Pro",
] as const;

const MACOS = [
  "Helvetica",
  "Helvetica Neue",
  "Arial",
  "Arial Black",
  "Arial Narrow",
  "Arial Rounded MT Bold",
  "Avenir",
  "Avenir Next",
  "Avenir Next Condensed",
  "Baskerville",
  "Big Caslon",
  "Bodoni 72",
  "Charter",
  "Cochin",
  "Copperplate",
  "Courier",
  "Courier New",
  "Didot",
  "Futura",
  "Geneva",
  "Georgia",
  "Gill Sans",
  "Hoefler Text",
  "Impact",
  "Lucida Grande",
  "Menlo",
  "Monaco",
  "Optima",
  "Palatino",
  "Tahoma",
  "Times",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "American Typewriter",
  "Andale Mono",
  "Apple Chancery",
  "Chalkboard",
  "Chalkboard SE",
  "Comic Sans MS",
  "Marker Felt",
  "Noteworthy",
  "Papyrus",
  "Skia",
  "Zapfino",
  "Rockwell",
  "Seravek",
  "Iowan Old Style",
  "Superclarendon",
  "Bradley Hand",
  "Snell Roundhand",
  "Phosphate",
  "Trattatello",
  "Brush Script MT",
  "Athelas",
  "Kefa",
  "SF Pro",
  "SF Pro Text",
  "SF Pro Display",
  "SF Mono",
  "New York",
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Hiragino Kaku Gothic Pro",
  "Hiragino Mincho ProN",
  "Hiragino Sans GB",
  "PingFang SC",
  "PingFang TC",
  "PingFang HK",
  "Apple SD Gothic Neo",
  "Songti SC",
  "STHeiti",
  "Heiti SC",
  "Heiti TC",
  "Apple Color Emoji",
  "Webdings",
  "Wingdings",
  "Symbol",
  "Silom",
  "Krungthep",
  "Luminari",
  "Herculanum",
  "Savoye LET",
  "Party LET",
  "Academy Engraved LET",
  "Mishafi",
  "Al Nile",
  "Geeza Pro",
  "Damascus",
  "Farah",
  "Kailasa",
  "Kohinoor Devanagari",
] as const;

const IOS = [
  "Helvetica",
  "Helvetica Neue",
  "Arial",
  "Arial Rounded MT Bold",
  "Avenir",
  "Avenir Next",
  "Avenir Next Condensed",
  "Baskerville",
  "Bodoni 72",
  "Bodoni 72 Oldstyle",
  "Chalkboard SE",
  "Charter",
  "Cochin",
  "Copperplate",
  "Courier",
  "Courier New",
  "Didot",
  "Futura",
  "Georgia",
  "Gill Sans",
  "Hoefler Text",
  "Iowan Old Style",
  "Marker Felt",
  "Menlo",
  "Noteworthy",
  "Optima",
  "Palatino",
  "Papyrus",
  "Party LET",
  "Rockwell",
  "Savoye LET",
  "Snell Roundhand",
  "Symbol",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Zapfino",
  "American Typewriter",
  "Academy Engraved LET",
  "Bradley Hand",
  "Chalkduster",
  "DIN Alternate",
  "DIN Condensed",
  "Euphemia UCAS",
  "Galvji",
  "Kailasa",
  "Kefa",
  "Khmer Sangam MN",
  "Kohinoor Bangla",
  "Kohinoor Devanagari",
  "Mishafi",
  "Noto Nastaliq Urdu",
  "Hiragino Sans",
  "Hiragino Mincho ProN",
  "PingFang SC",
  "PingFang TC",
  "PingFang HK",
  "Apple SD Gothic Neo",
  "Apple Color Emoji",
  "SF Pro",
  "SF Pro Text",
  "SF Pro Display",
  "New York",
  "Al Nile",
  "Geeza Pro",
  "Damascus",
  "Farah",
] as const;

const ANDROID = [
  "Roboto",
  "Roboto Condensed",
  "Roboto Mono",
  "Roboto Serif",
  "Noto Sans",
  "Noto Serif",
  "Noto Color Emoji",
  "Droid Sans",
  "Droid Serif",
  "Droid Sans Mono",
  "Cutive Mono",
  "Coming Soon",
  "Dancing Script",
  "Carrois Gothic SC",
  "Source Sans Pro",
  "Google Sans",
  "Noto Sans CJK SC",
  "Noto Sans CJK TC",
  "Noto Sans CJK JP",
  "Noto Sans CJK KR",
  "Noto Serif CJK SC",
] as const;

const PLATFORM_LISTS: Record<Platform, readonly string[]> = {
  windows: WINDOWS,
  office: [...WINDOWS, ...OFFICE],
  macos: MACOS,
  ios: IOS,
  android: ANDROID,
};

/**
 * Android font aliases (fonts.xml): web-safe names that Android maps to its own families
 * (DESIGN.md §8.1 step 3, Gmail Android row).
 */
export const ANDROID_ALIASES: Readonly<Record<string, string>> = {
  arial: "Roboto",
  helvetica: "Roboto",
  "helvetica neue": "Roboto",
  tahoma: "Roboto",
  verdana: "Roboto",
  times: "Noto Serif",
  "times new roman": "Noto Serif",
  georgia: "Noto Serif",
  palatino: "Noto Serif",
  baskerville: "Noto Serif",
  goudy: "Noto Serif",
  courier: "Cutive Mono",
  "courier new": "Cutive Mono",
  monaco: "Cutive Mono",
};

/** Localized and full-width names → canonical family (DESIGN.md §8.1 step 4). */
export const LOCALIZED_NAMES: Readonly<Record<string, string>> = {
  微软雅黑: "Microsoft YaHei",
  微軟雅黑: "Microsoft YaHei",
  "ＭＳ Ｐゴシック": "MS PGothic",
  "ＭＳ ゴシック": "MS Gothic",
  "ＭＳ Ｐ明朝": "MS PMincho",
  "ＭＳ 明朝": "MS Mincho",
  メイリオ: "Meiryo",
  "맑은 고딕": "Malgun Gothic",
  宋体: "SimSun",
  新宋体: "NSimSun",
  黑体: "SimHei",
  楷体: "KaiTi",
  仿宋: "FangSong",
  微軟正黑體: "Microsoft JhengHei",
  新細明體: "PMingLiU",
  細明體: "MingLiU",
  游ゴシック: "Yu Gothic",
  游明朝: "Yu Mincho",
  "ヒラギノ角ゴ Pro W3": "Hiragino Kaku Gothic Pro",
  "ヒラギノ角ゴ ProN W3": "Hiragino Kaku Gothic ProN",
  "ヒラギノ明朝 ProN": "Hiragino Mincho ProN",
  ヒラギノ角ゴシック: "Hiragino Sans",
  굴림: "Gulim",
  돋움: "Dotum",
  바탕: "Batang",
  궁서: "Gungsuh",
  나눔고딕: "Nanum Gothic",
  苹方: "PingFang SC",
  "苹方-简": "PingFang SC",
  华文黑体: "STHeiti",
  冬青黑体: "Hiragino Sans GB",
  "Apple SD 산돌고딕 Neo": "Apple SD Gothic Neo",
};

/** Metric-compatible alias groups (DESIGN-SCORE §5.3 T6). The first name is the group label. */
export const METRIC_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ["Arial", "Helvetica", "Arimo", "Liberation Sans"],
  ["Times New Roman", "Times", "Tinos", "Liberation Serif"],
  ["Courier New", "Courier", "Cousine", "Liberation Mono"],
  ["Georgia", "Gelasio"],
];

/** Families that cover CJK (for crediting CJK characters, DESIGN.md §8.1 step 2). */
const CJK_FAMILIES = [
  "Microsoft YaHei",
  "SimSun",
  "NSimSun",
  "SimHei",
  "KaiTi",
  "FangSong",
  "Microsoft JhengHei",
  "PMingLiU",
  "MingLiU",
  "MingLiU-ExtB",
  "MS Gothic",
  "MS PGothic",
  "MS UI Gothic",
  "MS Mincho",
  "MS PMincho",
  "Meiryo",
  "Meiryo UI",
  "Yu Gothic",
  "Yu Mincho",
  "Malgun Gothic",
  "Gulim",
  "Dotum",
  "Batang",
  "Gungsuh",
  "PingFang SC",
  "PingFang TC",
  "PingFang HK",
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Hiragino Kaku Gothic Pro",
  "Hiragino Mincho ProN",
  "Hiragino Sans GB",
  "Apple SD Gothic Neo",
  "Songti SC",
  "STHeiti",
  "Heiti SC",
  "Heiti TC",
  "Noto Sans CJK SC",
  "Noto Sans CJK TC",
  "Noto Sans CJK JP",
  "Noto Sans CJK KR",
  "Noto Serif CJK SC",
  "Source Han Sans",
  "Source Han Serif",
];

/** Emoji families, removed from stacks before the primary is chosen. */
export const EMOJI_FAMILY =
  /^(?:applecoloremoji|segoeuiemoji|segoeuisymbol|notocoloremoji|notoemoji|androidemoji|emojisymbols|twemoji.*|emojione.*|joypixels|openmoji)$/;

/** Icon fonts (loose keys), excluded from every count. */
export const ICON_FAMILY =
  /^(?:fontawesome.*|fa(?:solid|regular|brands|light|thin|duotone)?\d*(?:free|pro)?|materialicons.*|materialsymbols.*|glyphicons.*|icomoon.*|ionicons.*|segoemdl2assets|segoefluenticons|webdings|wingdings.*|feather|bootstrapicons|remixicon|linearicons.*|themify.*|simplelineicons)$/;

/** CSS generic family keywords (DESIGN.md §8.1 step 4 "Parsing"). */
export const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

// ───────────────────────── keys ─────────────────────────

/** Match key: NFKC, then case-fold, then collapse whitespace. */
export function matchKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const WEIGHT_SUFFIX =
  /(?:thin|hairline|extralight|ultralight|light|regular|book|normal|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|w[1-9])$/;

/**
 * Loose key (lookup only): spaces, hyphens and underscores dropped, then up to two trailing
 * weight/style suffixes removed (DESIGN.md §8.1 step 4).
 */
export function looseKey(name: string): string {
  let k = matchKey(name).replace(/[\s\-_]+/g, "");
  for (let i = 0; i < 2; i++) {
    const stripped = k.replace(WEIGHT_SUFFIX, "");
    if (stripped === k || stripped.length < 2) break;
    k = stripped;
  }
  return k;
}

// ───────────────────────── catalog index ─────────────────────────

export interface CatalogEntry {
  name: string;
  platforms: Platform[];
  google: boolean;
  googleCategory: string | null;
  cjk: boolean;
}

interface CatalogIndex {
  byMatch: Map<string, CatalogEntry>;
  byLoose: Map<string, CatalogEntry[]>;
}

let index: CatalogIndex | null = null;

function buildIndex(): CatalogIndex {
  const byMatch = new Map<string, CatalogEntry>();
  const get = (name: string): CatalogEntry => {
    const key = matchKey(name);
    let e = byMatch.get(key);
    if (!e) {
      e = { name, platforms: [], google: false, googleCategory: null, cjk: false };
      byMatch.set(key, e);
    }
    return e;
  };
  for (const [platform, list] of Object.entries(PLATFORM_LISTS) as Array<
    [Platform, readonly string[]]
  >) {
    for (const name of list) {
      const e = get(name);
      if (!e.platforms.includes(platform)) e.platforms.push(platform);
    }
  }
  const categories = googleFonts.categories as Record<string, string>;
  for (const row of googleFonts.families as unknown as Array<[string, string, number?]>) {
    const e = get(row[0]);
    e.google = true;
    e.googleCategory = categories[row[1]] ?? null;
    if (row[2] === 1) e.cjk = true;
  }
  for (const name of CJK_FAMILIES) get(name).cjk = true;
  for (const group of METRIC_ALIAS_GROUPS) for (const name of group) get(name);
  // Localized names resolve to the canonical entry (by match key).
  for (const [local, canonical] of Object.entries(LOCALIZED_NAMES)) {
    byMatch.set(matchKey(local), get(canonical));
  }
  const byLoose = new Map<string, CatalogEntry[]>();
  for (const e of new Set(byMatch.values())) {
    const lk = looseKey(e.name);
    const list = byLoose.get(lk) ?? [];
    if (!list.includes(e)) list.push(e);
    byLoose.set(lk, list);
  }
  return { byMatch, byLoose };
}

function catalog(): CatalogIndex {
  index ??= buildIndex();
  return index;
}

/**
 * Look a family up: exact match key first, then the loose key when it matches exactly one
 * entry (DESIGN.md §8.1 step 4).
 */
export function lookupFamily(name: string): CatalogEntry | null {
  const c = catalog();
  const exact = c.byMatch.get(matchKey(name));
  if (exact) return exact;
  const loose = c.byLoose.get(looseKey(name));
  return loose && loose.length === 1 ? loose[0]! : null;
}

/** Is `name` installed on `platform`? */
export function installedOn(name: string, platform: Platform): boolean {
  const e = lookupFamily(name);
  return !!e && e.platforms.includes(platform);
}

/** Canonical display name of the metric-alias group containing `name`, else the name. */
export function metricGroup(displayName: string): string {
  const key = matchKey(displayName);
  for (const group of METRIC_ALIAS_GROUPS) {
    if (group.some((n) => matchKey(n) === key)) return group[0]!;
  }
  return displayName;
}

/** Map a Bunny/Adobe slug ("open-sans", "proxima-nova") to a display name. */
export function displayNameFromSlug(slug: string): string {
  const e = lookupFamily(slug.replace(/[-_]+/g, " "));
  if (e) return e.name;
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function googleFamilyCount(): number {
  return googleFonts.count;
}
