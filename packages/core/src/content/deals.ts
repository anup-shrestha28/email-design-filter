/**
 * Deal extraction (DESIGN.md §7.7): schema.org DiscountOffer / PromotionCard, then regexes over
 * visible text for % off, amount off (with currencies), BOGO, free shipping, gifts, "up to"
 * qualifiers, minimum spend and coupon codes. Expiry comes from the email's own expiry phrases or
 * keyword dates; undated deals expire 14 days after receipt with low confidence.
 *
 * Codes can be per-recipient, so they stay private to the user (never aggregated).
 */
import type { DealCandidate, DealKind, SchemaOrgItem } from "../types";
import type { DateCandidate } from "./dates";
import { parseSchemaDate } from "./dates";

const DAY = 86_400_000;
export const UNDATED_DEAL_DAYS = 14;
export const UNDATED_CONFIDENCE = 0.2;
const MAX_DEALS = 6;
const MAX_TEXT = 30_000;

// ───────────────────────── currency ─────────────────────────

const CUR_PREFIX_SRC = String.raw`(?:US\$|CA\$|C\$|A\$|AU\$|NZ\$|HK\$|S\$|MX\$|R\$|\$|€|£|¥|₹|₩|₽|₺|CHF\s?|USD\s?|EUR\s?|GBP\s?|CAD\s?|AUD\s?|JPY\s?|INR\s?|SEK\s?|NOK\s?|DKK\s?|PLN\s?|BRL\s?|MXN\s?|NZD\s?|SGD\s?|HKD\s?|ZAR\s?|CNY\s?|KRW\s?|TRY\s?)`;
const CUR_SUFFIX_SRC = String.raw`(?:€|EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|zł|kr|Kč|円|元|원|₽|₺|TL|lei|Ft)`;
const AMOUNT_SRC = String.raw`(\d{1,3}(?:[.,\s]\d{3}){1,3}(?:[.,]\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)`;

const SYMBOL_TO_ISO: Record<string, string> = {
  US$: "USD",
  CA$: "CAD",
  C$: "CAD",
  A$: "AUD",
  AU$: "AUD",
  NZ$: "NZD",
  HK$: "HKD",
  S$: "SGD",
  MX$: "MXN",
  R$: "BRL",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "₩": "KRW",
  원: "KRW",
  "₽": "RUB",
  "₺": "TRY",
  TL: "TRY",
  zł: "PLN",
  Kč: "CZK",
  円: "JPY",
  元: "CNY",
  lei: "RON",
  Ft: "HUF",
};

/** Resolves a currency token (symbol, suffix or ISO code) to ISO 4217, using language for "$"/"¥"/"kr". */
export function resolveCurrency(token: string | undefined, language: string | null): string | null {
  if (!token) return null;
  const t = token.trim();
  if (/^[A-Z]{3}$/.test(t)) return t;
  if (t === "$") return "USD";
  if (t === "¥") return language === "zh" ? "CNY" : "JPY";
  if (t.toLowerCase() === "kr") {
    if (language === "sv") return "SEK";
    if (language === "da") return "DKK";
    if (language === "no" || language === "nb") return "NOK";
    return null;
  }
  return SYMBOL_TO_ISO[t] ?? null;
}

/** Parses "1,000", "1.000,50", "24.99", "10,50" into a number (thousands vs decimal separators). */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/\s/g, "");
  let normalized: string;
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(s)) {
    // Grouped thousands; the last separator is decimal only when followed by 1–2 digits.
    const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
    const tail = s.slice(lastSep + 1);
    normalized =
      tail.length <= 2
        ? s.slice(0, lastSep).replace(/[.,]/g, "") + "." + tail
        : s.replace(/[.,]/g, "");
  } else {
    normalized = s.replace(",", ".");
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : null;
}

// ───────────────────────── offer patterns ─────────────────────────

const OFF_WORDS = String.raw`(?:off|discount|savings?|rabatt|korting|de\s+descuento|de\s+r[ée]duction|de\s+remise|de\s+desconto|di\s+sconto|zni[żz]ki|rabatu|indirim|скидк[аи]?|オフ|割引|할인|引き)`;
const UPTO_RE =
  /(?:up\s+to|as\s+much\s+as|hasta(?:\s+(?:un|el))?|jusqu['’][àa]|bis\s+zu|fino\s+al?|at[ée]|tot|do|upp\s+till|op\s+til|jopa|最大|最高|최대|до|varan)\s*[-−–]?\s*$/iu;

const PCT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`(\d{1,2}(?:[.,]\d{1,2})?)\s?%\s?${OFF_WORDS}`, "giu"),
  new RegExp(
    String.raw`(?:save|take|get|extra|enjoy|ahorra|[ée]conomisez|spare|risparmia|economize|bespaar)\s+(?:up\s+to\s+|an\s+extra\s+|an\s+additional\s+)?(\d{1,2}(?:[.,]\d{1,2})?)\s?%`,
    "giu",
  ),
  new RegExp(String.raw`(?:^|[\s(])[-−–]\s?(\d{1,2})\s?%(?=[\s!.,)]|$)`, "gmu"),
  new RegExp(
    String.raw`(?:sconto|descuento|r[ée]duction|rabatt|desconto|korting|remise)\s+(?:del?\s+|de\s+|von\s+)?(?:hasta\s+(?:el\s+|un\s+)?)?(\d{1,2})\s?%`,
    "giu",
  ),
];
/** "3割引" = 30% off. */
const WARI_RE = /(\d)割(?:引|オフ)/gu;

const AMOUNT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`(${CUR_PREFIX_SRC})\s?${AMOUNT_SRC}\s?${OFF_WORDS}`, "giu"),
  new RegExp(String.raw`${AMOUNT_SRC}\s?(${CUR_SUFFIX_SRC})\s?${OFF_WORDS}`, "giu"),
  new RegExp(
    String.raw`(?:save|take|get|ahorra|[ée]conomisez|spare|risparmia|economize)\s+(?:up\s+to\s+|an\s+extra\s+)?(${CUR_PREFIX_SRC})\s?${AMOUNT_SRC}`,
    "giu",
  ),
];

const BOGO_RE =
  /(?<![\p{L}\p{N}])(?:bogo|buy\s+(?:one|1)[\s,]+get\s+(?:one|1)(?:\s+(?:free|half\s+off|\d{1,2}%\s+off))?|(?:two|2)\s+for\s+(?:one|1)|2\s?x\s?1|3\s+for\s+2|second\s+(?:one|item|pair)\s+(?:free|half\s+off)|2\s?por\s?1|1\s?\+\s?1\s+(?:gratis|offert|gratuit)|zweites\s+gratis)(?![\p{L}\p{N}])/iu;

const FREE_SHIPPING_RE =
  /(?<![\p{L}\p{N}])(?:free\s+(?:standard\s+|express\s+|2-day\s+)?(?:shipping|delivery)|ships\s+free|env[ií]o\s+(?:gratis|gratuito)|livraison\s+(?:gratuite|offerte)|kostenlose[rn]?\s+versand|versandkostenfrei|gratis\s+versand|spedizione\s+gratuita|frete\s+gr[aá]tis|gratis\s+verzending|darmowa\s+dostawa|fri\s+frakt|gratis\s+fragt|ilmainen\s+toimitus|бесплатная\s+доставка|[üu]cretsiz\s+kargo)(?![\p{L}\p{N}])|送料無料|免运费|包邮|무료\s?배송/iu;

const GIFT_RE =
  /(?<![\p{L}\p{N}])(?:free\s+gift|gift\s+with\s+(?:any\s+|your\s+)?purchase|gwp|bonus\s+gift|complimentary\s+gift|regalo\s+(?:gratis|de\s+regalo)|cadeau\s+offert|gratis[-\s]geschenk|geschenk\s+gratis|omaggio|brinde\s+gr[aá]tis|gratis\s+cadeau|prezent\s+gratis)(?![\p{L}\p{N}])|プレゼント|赠品|사은품|подарок/iu;

const MIN_SPEND_RE = new RegExp(
  String.raw`(?:on\s+)?(?:orders?|purchases?|pedidos?|commandes?|bestellungen?|ordini|compras?|spend(?:ing)?)?\s*(?:over|above|of|from|ab|d[èe]s|desde|a\s+partir\s+de|oltre|acima\s+de|vanaf|od|fr[åa]n|min(?:imum)?(?:\s+(?:purchase|spend|order))?(?:\s+of)?|when\s+you\s+spend)\s*(${CUR_PREFIX_SRC})?\s?${AMOUNT_SRC}\s?(${CUR_SUFFIX_SRC})?`,
  "iu",
);

// ───────────────────────── codes ─────────────────────────

const CODE_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:promo(?:tion(?:al)?)?\s*code|coupon(?:\s*code)?|discount\s*code|voucher(?:\s*code)?|offer\s*code|code|c[oó]digo(?:\s+(?:promocional|de\s+descuento|de\s+desconto))?|cup[oó]n|code\s+promo|codice(?:\s+sconto)?|gutscheincode|rabattcode|gutschein|kortingscode|kod(?:\s+rabatowy)?|rabattkod|rabatkode|alennuskoodi|kupon(?:\s+kodu)?|промокод|クーポンコード|コード|优惠码|折扣码|쿠폰\s?코드|할인\s?코드)\s{0,3}(?:[:：=]|is|ist|est|es|è|é)?\s{0,3}["'“”‘’«»\[(]?([A-Za-z0-9][A-Za-z0-9_-]{2,23})`,
  "giu",
);
/** "Use SAVE20" without the word "code": keywords case-insensitive, the code itself upper-case. */
const USE_CODE_RE =
  /(?<![\p{L}\p{N}])(?:[Uu]se|USE|[Ee]nter|ENTER|[Aa]pply|APPLY|[Rr]edeem|REDEEM|[Uu]tilisez|[Vv]erwende|[Gg]ebruik|[Uu]sa)\s+["'“]?([A-Z0-9][A-Z0-9_-]{3,23})(?![\p{L}\p{N}])(\s+(?:at|in)\s+(?:checkout|cart|the\s+cart))?/gu;

const CODE_STOPWORDS = new Set([
  "code",
  "codes",
  "coupon",
  "below",
  "above",
  "here",
  "now",
  "today",
  "at",
  "checkout",
  "needed",
  "required",
  "necessary",
  "applied",
  "automatically",
  "online",
  "only",
  "the",
  "your",
  "this",
  "that",
  "valid",
  "expires",
  "and",
  "for",
  "off",
  "sale",
  "free",
  "shipping",
  "when",
  "during",
  "instore",
  "in-store",
  "store",
  "use",
  "enter",
  "apply",
  "promo",
  "discount",
  "offer",
  "from",
  "with",
  "gratis",
  "none",
  "get",
  "save",
  "pour",
  "para",
  "per",
  "und",
  "avec",
  "con",
  "sin",
  "ohne",
  "kein",
  "keine",
  "nicht",
  "niet",
  "geen",
  "inga",
  "ingen",
  "sem",
  "aucun",
  "sans",
  "copy",
  "click",
  "tap",
  "button",
  "reveal",
  "unlock",
  "shop",
  "email",
  "details",
  "terms",
  "exclusions",
  "apply",
  "our",
  "all",
  "any",
  "one",
  "every",
  "is",
  "will",
  "can",
  "you",
  "it",
  "cart",
  "bag",
  "order",
  "orders",
  "link",
  "number",
  "not",
  "no",
]);

/** Text right before "code" that makes it NOT a coupon (verification codes, zip codes, …). */
const NEGATIVE_CODE_QUALIFIER_RE =
  /(?:verification|security|confirmation|access|log-?in|sign-?in|one-?time|otp|2fa|two-factor|authenti\w{0,12}|auth|zip|postal|post|area|country|error|qr|dress|source|tracking|booking|reference|referral|verif\w{0,10}|sicherheits|best[aä]tigungs|verifizierungs|v[ée]rification|s[ée]curit[ée]|verificaci[oó]n|seguridad|verifica|sicurezza|verifica[cç][aã]o|seguran[cç]a|pin)\s*$/iu;

/** Order / tracking / reference context before a code-like token. */
const ORDER_CONTEXT_RE =
  /(?:order|tracking|confirmation|reference|ref\.?|invoice|booking|reservation|ticket|account|customer|member(?:ship)?|pnr|receipt|transaction|case|shipment|parcel|pedido|commande|bestell\w{0,6}|ordine|encomenda|bestelling|zam[óo]wieni\w{0,2}|best[äa]llning|注文|订单|주문|заказ|sipari[şs])\s*(?:#|no\.?|nr\.?|number|id|n[º°o])?\s*[:#]?\s*$/iu;

/** Tokens that look like order / tracking / reference numbers. */
export function looksLikeReferenceNumber(code: string): boolean {
  const c = code.toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(c)) return true; // UPS
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c)) return true; // UPU S10 (postal)
  if (/^TBA\d{9,12}$/.test(c)) return true; // Amazon Logistics
  if (/^[A-Z]{1,4}-?\d{6,}$/.test(c)) return true; // ORD-1234567, INV123456
  const digits = c.replace(/[^0-9]/g, "").length;
  if (c.length >= 8 && digits / c.length >= 0.7) return true;
  return false;
}

function isPlausibleCode(code: string, before: string, refs: ReadonlySet<string>): boolean {
  const c = code.replace(/[-_]+$/, "");
  if (c.length < 4 || c.length > 20) return false;
  if (!/[A-Za-z]/.test(c)) return false;
  if (CODE_STOPWORDS.has(c.toLowerCase())) return false;
  if (/^[a-z]+$/.test(c)) return false; // ordinary lower-case word
  if (/^[A-Z][a-z]+$/.test(c)) return false; // capitalised sentence word
  if (looksLikeReferenceNumber(c)) return false;
  if (refs.has(c.toLowerCase())) return false;
  if (ORDER_CONTEXT_RE.test(before)) return false;
  return true;
}

// ───────────────────────── extraction ─────────────────────────

interface RawDeal {
  kind: DealKind;
  value: number | null;
  currency: string | null;
  isUpTo: boolean;
  minSpend: number | null;
  code: string | null;
  index: number;
  startsAt: Date | null;
  endsAt: Date | null;
  endsAtConfidence: number;
  source: DealCandidate["source"];
}

export interface DealInput {
  /** NFKC-normalised visible text (subject + preheader + body), original case. */
  text: string;
  receivedAt: Date;
  language: string | null;
  schemaOrg: readonly SchemaOrgItem[];
  referenceNumbers: ReadonlySet<string>;
  /** Expiry candidates found in the same text (indices refer to `text`). */
  expiries: readonly DateCandidate[];
}

function minSpendAfter(
  text: string,
  end: number,
  language: string | null,
): { value: number; currency: string | null } | null {
  const window = text.slice(end, end + 70);
  const m = MIN_SPEND_RE.exec(window);
  if (!m || m.index > 25) return null;
  const amount = parseAmount(m[2] ?? "");
  if (amount === null) return null;
  return { value: amount, currency: resolveCurrency((m[1] ?? m[3])?.trim(), language) };
}

function isUpToBefore(text: string, index: number): boolean {
  return UPTO_RE.test(text.slice(Math.max(0, index - 18), index));
}

function pushDeal(
  deals: RawDeal[],
  d: Omit<RawDeal, "startsAt" | "endsAt" | "endsAtConfidence" | "source" | "code">,
): void {
  deals.push({
    ...d,
    code: null,
    startsAt: null,
    endsAt: null,
    endsAtConfidence: 0,
    source: "regex",
  });
}

function regexDeals(text: string, language: string | null): RawDeal[] {
  const deals: RawDeal[] = [];
  for (const re of PCT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 20) {
      const value = Number((m[1] ?? "").replace(",", "."));
      if (!(value >= 1 && value <= 95)) continue;
      const start = m.index + (m[0].length - m[0].trimStart().length);
      const min = minSpendAfter(text, m.index + m[0].length, language);
      pushDeal(deals, {
        kind: "percent_off",
        value,
        currency: null,
        isUpTo: isUpToBefore(text, start) || /up\s+to/i.test(m[0]),
        minSpend: min?.value ?? null,
        index: m.index,
      });
    }
  }
  WARI_RE.lastIndex = 0;
  let w: RegExpExecArray | null;
  while ((w = WARI_RE.exec(text)) !== null && deals.length < 40) {
    const value = Number(w[1]) * 10;
    if (value >= 10 && value <= 90) {
      pushDeal(deals, {
        kind: "percent_off",
        value,
        currency: null,
        isUpTo: isUpToBefore(text, w.index),
        minSpend: null,
        index: w.index,
      });
    }
  }
  for (let p = 0; p < AMOUNT_PATTERNS.length; p++) {
    const re = AMOUNT_PATTERNS[p] as RegExp;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 20) {
      const currencyToken = p === 1 ? m[2] : m[1];
      const amountToken = p === 1 ? m[1] : m[2];
      const value = parseAmount(amountToken ?? "");
      if (value === null || value > 100_000) continue;
      const min = minSpendAfter(text, m.index + m[0].length, language);
      pushDeal(deals, {
        kind: "amount_off",
        value,
        currency: resolveCurrency(currencyToken?.trim(), language),
        isUpTo: isUpToBefore(text, m.index) || /up\s+to/i.test(m[0]),
        minSpend: min?.value ?? null,
        index: m.index,
      });
    }
  }
  const simple: Array<[DealKind, RegExp]> = [
    ["bogo", BOGO_RE],
    ["free_shipping", FREE_SHIPPING_RE],
    ["gift", GIFT_RE],
  ];
  for (const [kind, re] of simple) {
    const m = re.exec(text);
    if (!m) continue;
    const min = minSpendAfter(text, m.index + m[0].length, language);
    pushDeal(deals, {
      kind,
      value: null,
      currency: null,
      isUpTo: false,
      minSpend: min?.value ?? null,
      index: m.index,
    });
  }
  return deals;
}

function findCodes(
  text: string,
  refs: ReadonlySet<string>,
): Array<{ code: string; index: number }> {
  const out: Array<{ code: string; index: number }> = [];
  const seen = new Set<string>();
  const consider = (code: string, index: number, before: string): void => {
    const c = code.replace(/[-_]+$/, "");
    if (seen.has(c.toUpperCase()) || out.length >= 3) return;
    if (!isPlausibleCode(c, before, refs)) return;
    seen.add(c.toUpperCase());
    out.push({ code: c, index });
  };
  CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = CODE_RE.exec(text)) !== null && guard++ < 30) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (NEGATIVE_CODE_QUALIFIER_RE.test(before)) continue;
    consider(m[1] ?? "", m.index, before);
  }
  USE_CODE_RE.lastIndex = 0;
  guard = 0;
  while ((m = USE_CODE_RE.exec(text)) !== null && guard++ < 30) {
    const code = m[1] ?? "";
    // "use" contexts are generic: require a digit in the code or an explicit "at checkout".
    if (!/[0-9]/.test(code) && !m[2]) continue;
    consider(code, m.index, text.slice(Math.max(0, m.index - 30), m.index));
  }
  return out;
}

function schemaDeals(items: readonly SchemaOrgItem[], receivedAt: Date): RawDeal[] {
  const out: RawDeal[] = [];
  for (const item of items) {
    if (item.type !== "DiscountOffer" && item.type !== "PromotionCard" && item.type !== "Offer")
      continue;
    const f = item.fields;
    if (item.type === "Offer" && !f.discountCode) continue;
    const code =
      f.discountCode && /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(f.discountCode)
        ? f.discountCode
        : null;
    const desc = `${f.description ?? ""} ${f.discountValue ?? ""} ${f.headline ?? ""}`;
    const pct = /(\d{1,2}(?:[.,]\d{1,2})?)\s?%/.exec(desc);
    const amt = new RegExp(String.raw`(${CUR_PREFIX_SRC})\s?${AMOUNT_SRC}`, "u").exec(desc);
    let kind: DealKind = "other";
    let value: number | null = null;
    let currency: string | null = null;
    if (pct) {
      kind = "percent_off";
      value = Number((pct[1] ?? "").replace(",", "."));
    } else if (amt) {
      kind = "amount_off";
      value = parseAmount(amt[2] ?? "");
      currency =
        resolveCurrency(amt[1]?.trim(), null) ??
        (f.priceCurrency && /^[A-Z]{3}$/.test(f.priceCurrency) ? f.priceCurrency : null);
    } else if (FREE_SHIPPING_RE.test(desc)) {
      kind = "free_shipping";
    }
    const startsAt = parseSchemaDate(f.availabilityStarts);
    let endsAt = parseSchemaDate(f.availabilityEnds);
    // Stale or bogus markup: an end before receipt means the date can't be trusted.
    if (endsAt && endsAt.getTime() < receivedAt.getTime()) endsAt = null;
    if (endsAt && endsAt.getTime() > receivedAt.getTime() + 366 * DAY) endsAt = null;
    if (kind === "other" && !code && !endsAt) continue;
    out.push({
      kind,
      value,
      currency,
      isUpTo: /up\s+to/i.test(desc),
      minSpend: null,
      code,
      index: -1,
      startsAt,
      endsAt,
      endsAtConfidence: endsAt ? 0.9 : 0,
      source: "jsonld",
    });
  }
  return out;
}

function nearestExpiry(index: number, expiries: readonly DateCandidate[]): DateCandidate | null {
  let best: DateCandidate | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of expiries) {
    const dist = Math.abs(e.index - index);
    if (
      dist <= 400 &&
      (dist < bestDist || (dist === bestDist && best !== null && e.confidence > best.confidence))
    ) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

/** Email-level fallback expiry: the most confident candidate, earliest among equals. */
function globalExpiry(expiries: readonly DateCandidate[]): DateCandidate | null {
  let best: DateCandidate | null = null;
  for (const e of expiries) {
    if (
      !best ||
      e.confidence > best.confidence ||
      (e.confidence === best.confidence && e.at.getTime() < best.at.getTime())
    ) {
      best = e;
    }
  }
  return best;
}

/** Extracts deals (deduplicated by kind/value/code, ≤ 6). */
export function extractDeals(input: DealInput): DealCandidate[] {
  const text = input.text.length > MAX_TEXT ? input.text.slice(0, MAX_TEXT) : input.text;
  const regex = regexDeals(text, input.language);
  const codes = findCodes(text, input.referenceNumbers);

  // Attach codes to the nearest code-less deal (by text distance), else create an "other" deal.
  const byIndex = [...regex].sort((a, b) => a.index - b.index);
  for (const { code, index } of codes) {
    let target: RawDeal | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const d of byIndex) {
      if (d.code !== null) continue;
      const dist = Math.abs(d.index - index);
      const preferred = d.kind === "percent_off" || d.kind === "amount_off" ? 0 : 150;
      if (dist + preferred < best && dist <= 600) {
        best = dist + preferred;
        target = d;
      }
    }
    if (target) {
      target.code = code;
    } else {
      pushDeal(regex, {
        kind: "other",
        value: null,
        currency: null,
        isUpTo: false,
        minSpend: null,
        index,
      });
      (regex[regex.length - 1] as RawDeal).code = code;
    }
  }

  // Merge schema.org deals with regex deals that share a code or kind/value.
  const merged: RawDeal[] = [...regex];
  for (const s of schemaDeals(input.schemaOrg, input.receivedAt)) {
    const match = merged.find(
      (d) =>
        (s.code !== null && d.code !== null && d.code.toUpperCase() === s.code.toUpperCase()) ||
        (s.kind !== "other" && d.kind === s.kind && d.value === s.value),
    );
    if (match) {
      match.source = "jsonld";
      match.code = match.code ?? s.code;
      match.startsAt = s.startsAt;
      if (s.endsAt) {
        match.endsAt = s.endsAt;
        match.endsAtConfidence = s.endsAtConfidence;
      }
      if (match.kind === "other" && s.kind !== "other") {
        match.kind = s.kind;
        match.value = s.value;
        match.currency = s.currency;
      }
    } else {
      merged.push(s);
    }
  }

  // Expiry: explicit (schema) > nearest text expiry > email-level expiry > undated (+14 d).
  const fallback = globalExpiry(input.expiries);
  const out: DealCandidate[] = [];
  const keys = new Set<string>();
  for (const d of merged) {
    if (!d.endsAt) {
      const e = (d.index >= 0 ? nearestExpiry(d.index, input.expiries) : null) ?? fallback;
      if (e) {
        d.endsAt = e.at;
        d.endsAtConfidence = e.confidence;
      } else {
        d.endsAt = new Date(input.receivedAt.getTime() + UNDATED_DEAL_DAYS * DAY);
        d.endsAtConfidence = UNDATED_CONFIDENCE;
      }
    }
    const key = `${d.kind}|${d.value ?? ""}|${(d.code ?? "").toUpperCase()}`;
    if (keys.has(key)) continue;
    // A code-less duplicate of a coded deal (same kind/value) adds nothing.
    if (
      !d.code &&
      merged.some((o) => o !== d && o.code && o.kind === d.kind && o.value === d.value)
    )
      continue;
    keys.add(key);
    out.push({
      kind: d.kind,
      value: d.value,
      currency: d.currency,
      isUpTo: d.isUpTo,
      minSpend: d.minSpend,
      code: d.code,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      endsAtConfidence: d.endsAtConfidence,
      source: d.source,
    });
    if (out.length >= MAX_DEALS) break;
  }
  return out;
}
