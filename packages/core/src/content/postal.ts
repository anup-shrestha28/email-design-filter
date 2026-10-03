/**
 * Static postal-address detection near the end of an email (CAN-SPAM physical address; trust
 * badge only, DESIGN-SCORE §5.9/§9). US, UK, EU, CA and AU patterns; all regexes are bounded and
 * run only on the footer window.
 */

const FOOTER_WINDOW = 2500;

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR";

/** "Portland, OR 97205" / "Austin TX 78701-1234". */
const US_STATE_ZIP_RE = new RegExp(
  `(?<![A-Za-z])(?:${US_STATES}),?\\s{1,3}\\d{5}(?:-\\d{4})?(?!\\d)`,
);
/** "1200 Alder Street" style street line. */
const STREET_RE =
  /(?<![\p{L}\p{N}])\d{1,6}[A-Za-z]?\s{1,3}(?:[\p{L}0-9.'’-]{1,30}\s{1,3}){0,4}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|way|court|ct\.?|place|pl\.?|parkway|pkwy\.?|highway|hwy\.?|square|sq\.?|plaza|terrace|circle|suite|ste\.?|floor)(?![\p{L}])/iu;
const PO_BOX_RE =
  /\b(?:p\.?\s?o\.?\s?box|post office box|postfach|apartado(?: postal)?|bo[iî]te postale|casella postale)\s{0,3}\d{1,8}/iu;
/** UK postcode, e.g. "SW1A 1AA", "EC2A 4NE". */
const UK_POSTCODE_RE = /(?<![A-Za-z0-9])[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}(?![A-Za-z0-9])/;
/** Canadian postal code with a province code nearby. */
const CA_RE =
  /(?<![A-Za-z])(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT),?\s{1,3}[A-Z]\d[A-Z]\s?\d[A-Z]\d(?![A-Za-z0-9])/;
/** Australian state + postcode. */
const AU_RE = /(?<![A-Za-z])(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s{1,3}\d{4}(?!\d)/;
/** European street words (de, fr, it, es, nl, pl, pt, sv…). */
const EU_STREET_RE =
  /(?:stra(?:ß|ss)e|str\.|weg|gasse|platz|allee|ring|rue|avenue|boulevard|bd|chemin|place|via|viale|corso|piazza|calle|avenida|plaza|paseo|carrer|straat|laan|plein|gracht|kade|ulica|ul\.|aleja|rua|travessa|gatan|vägen|gade|vej|katu)(?![\p{L}])/iu;
/** "10115 Berlin", "75002 Paris", "1012 AB Amsterdam", "00-950 Warszawa". */
const EU_POSTCODE_CITY_RE =
  /(?<![\p{L}\p{N}])(?:\d{5}|\d{4}\s?[A-Z]{2}|\d{4}-\d{3}|\d{2}-\d{3}|\d{4}|[A-Z]{1,2}-\d{4,5})\s{1,3}[\p{Lu}][\p{L}'’.-]{1,30}/u;

/** True when a postal address is found in the last part of the email text. */
export function hasPostalAddress(text: string): boolean {
  const tail = text.length > FOOTER_WINDOW ? text.slice(-FOOTER_WINDOW) : text;
  if (US_STATE_ZIP_RE.test(tail)) return true;
  if (CA_RE.test(tail) || AU_RE.test(tail)) return true;
  if (PO_BOX_RE.test(tail)) return true;
  if (
    UK_POSTCODE_RE.test(tail) &&
    (STREET_RE.test(tail) ||
      /\b(?:london|manchester|edinburgh|glasgow|birmingham|bristol|leeds|liverpool|cardiff|belfast|united kingdom|uk|england|scotland|wales)\b/i.test(
        tail,
      ))
  ) {
    return true;
  }
  if (EU_POSTCODE_CITY_RE.test(tail) && EU_STREET_RE.test(tail)) return true;
  // A clear street line plus a country name.
  if (
    STREET_RE.test(tail) &&
    /\b(?:usa|united states|canada|australia|new zealand|ireland|germany|france|spain|italy|netherlands)\b/i.test(
      tail,
    )
  ) {
    return true;
  }
  return false;
}

/** Case-insensitive, global versions of the address patterns whose numbers look like codes. */
const ADDRESS_NUMBER_RES: readonly RegExp[] = [US_STATE_ZIP_RE, STREET_RE, PO_BOX_RE, AU_RE].map(
  (re) => new RegExp(re.source, `${re.flags.replace(/[gi]/g, "")}gi`),
);

/**
 * `text` with every digit inside a postal-address pattern (US state + ZIP, street line, PO box,
 * AU state + postcode) replaced by "#", positions unchanged. Security detection uses it so that the
 * CAN-SPAM address in a promo footer ("CA 94103", "1234 Market St") is not read as a one-time code.
 */
export function maskPostalDigits(text: string): string {
  let out = text;
  for (const re of ADDRESS_NUMBER_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => m.replace(/\d/g, "#"));
  }
  return out;
}
