/**
 * Minimal HTML character-reference decoding for attribute values (URLs, styles): numeric
 * references and the named entities that occur in URLs and CSS. Unknown names are left as-is.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sol: "/",
  colon: ":",
  equals: "=",
  quest: "?",
  num: "#",
  percnt: "%",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
  semi: ";",
  plus: "+",
  lowbar: "_",
  dash: "-",
  hyphen: "-",
};

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

/** Decodes character references in an attribute value. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY_RE, (m: string, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
        return m;
      return String.fromCodePoint(cp);
    }
    const v = name !== undefined ? NAMED[name.toLowerCase()] : undefined;
    return v ?? m;
  });
}
