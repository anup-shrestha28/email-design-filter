/**
 * Raw font facts (DESIGN.md §8.1 "Storage"): `fonts_static` extracted at ingest from the raw
 * HTML, plus the used stacks measured in render pass D. Everything the Fonts card shows is
 * derived at read time by `fontProfile()`, so a client-table update needs only a re-score.
 *
 * Only provider names, family names, weights and raw `font-family` values are stored — never
 * font or stylesheet URLs.
 */
import { z } from "zod";
import { count, shortText } from "./common";

export const FONT_ROLES = ["heading", "body", "button", "navigation", "footer"] as const;

/** A web-font declaration: an `@font-face` rule or a family requested from a font service. */
export const fontDeclarationSchema = z.object({
  family: shortText(64),
  /** "Google Fonts", "Bunny Fonts", "Adobe Fonts", "Fonts.com", a registrable domain, or null (data:/relative). */
  provider: shortText(64).nullable(),
  method: z.enum(["font-face", "link", "import"]),
  /** Declared weights (css2 axis tuples, css v1 styles, @font-face font-weight). */
  weights: z.array(z.number().int().min(1).max(1000)).max(12),
  /** Variable weight range, e.g. [100, 900] for `wght@100..900`. */
  variable: z
    .tuple([z.number().int().min(1).max(1000), z.number().int().min(1).max(1000)])
    .nullable(),
  italic: z.boolean(),
  /** `mso-font-alt` inside the @font-face (Outlook's substitute), else null. */
  msoFontAlt: shortText(64).nullable(),
  /** Hidden from classic Outlook: inside `@media` or `<!--[if !mso]><!-->…<!--<![endif]-->`. */
  hiddenFromOutlook: z.boolean(),
});
export type FontDeclaration = z.infer<typeof fontDeclarationSchema>;

/** A provider-only stylesheet (Adobe Fonts / Fonts.com kit, other hosts): no family names. */
export const fontProviderLinkSchema = z.object({
  provider: shortText(64),
  method: z.enum(["link", "import"]),
  hiddenFromOutlook: z.boolean(),
});

/** A `font-family` value found in the static CSS / inline styles, with its static text reach. */
export const staticStackSchema = z.object({
  /** Raw `font-family` value (≤ 200 chars), parsed at read time. */
  css: z.string().max(200),
  /** Counted characters of text whose inlined font-family is this stack (juice). */
  chars: count(),
});

/** DESIGN.md §8.1 step 1 (`fonts_static`, ≤ 2 KB). */
export const fontsStaticSchema = z.object({
  v: z.literal(1),
  declarations: z.array(fontDeclarationSchema).max(16),
  providerLinks: z.array(fontProviderLinkSchema).max(6),
  /** Primary families set in `<!--[if mso]>` / `<!--[if gte mso 9]>` style blocks. */
  msoOverrides: z.array(shortText(64)).max(6),
  /** Static font-family stacks by static reach (for static coverage and `font_families`). */
  stacks: z.array(staticStackSchema).max(12),
  /** Adobe's page-view counter `p.typekit.net` was referenced (provider evidence + tracker). */
  typekitCounter: z.boolean(),
  /** Some facts were dropped to stay within 2 KB. */
  truncated: z.boolean(),
});
export type FontsStatic = z.infer<typeof fontsStaticSchema>;

const roleCharsSchema = z.object({
  heading: count(),
  body: count(),
  button: count(),
  navigation: count(),
  footer: count(),
});

/** One used stack from pass D (DESIGN.md §8.1 step 2). */
export const usedStackSchema = z.object({
  /** Raw computed `font-family` (the declared stack; `"__default__"` = no font set). */
  css: z.string().max(200),
  /** Counted characters (CJK ×2), rendered runs only, preheader excluded. */
  chars: count(),
  /** CJK characters (already ×2), credited to the first CJK-capable family at read time. */
  cjkChars: count(),
  roles: roleCharsSchema,
  /** Computed weights with their characters (top 6; the rest in `otherWeightChars`). */
  weights: z.array(z.tuple([z.number().int().min(1).max(1000), count()])).max(6),
  otherWeightChars: count(),
});
export type UsedStack = z.infer<typeof usedStackSchema>;

export const usedFontsSchema = z.object({
  v: z.literal(1),
  /** Up to 20 stacks by characters. */
  stacks: z.array(usedStackSchema).max(20),
  /** Characters in stacks beyond the top 20. */
  otherChars: count(),
  totalChars: count(),
  /** Images containing text (OCR); null when OCR is off (FREE-TIER.md §5.7). */
  imageTextCount: count(1000).nullable(),
});
export type UsedFonts = z.infer<typeof usedFontsSchema>;

/** `email_analysis.features.fonts` (≤ 4 KB). */
export const fontFeaturesSchema = z.object({
  v: z.literal(1),
  static: fontsStaticSchema.nullable(),
  used: usedFontsSchema.nullable(),
});
export type FontFeatures = z.infer<typeof fontFeaturesSchema>;

export const FONT_FEATURES_VERSION = 1;
