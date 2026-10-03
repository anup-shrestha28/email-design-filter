/**
 * Security-sensitive detection (DESIGN.md §7.3 rule 3, §7.4): OTP / verification codes, password
 * resets, magic links, new sign-in alerts and security alerts. Matching mail is minimised: never
 * rendered, scored or sent to Claude, and indexed by subject/sender only.
 *
 * Rule: a security keyword plus a 4–8 digit code near it, or a confirm/reset/login link, and no
 * promo tokens *in the primary content*. A promo subject always disqualifies. A one-time code next
 * to a code keyword wins over promo tokens in the body (retailer sign-in mail carries promo
 * preheaders, banners and nav bars — missing an OTP would leak the code into renders and
 * snippets); under a promo opening only keywords that name the code count, unless the subject
 * names the OTP or a keyword is bound to the code by connecting words ("Your OTP is 482913",
 * "482913 is your passcode"; not "Enable 2FA for 5000 points"), and postal-address and
 * order/phone reference numbers in another sentence than the keyword are not codes (a promo
 * footer's "turn on two-factor … CA 94103", "use your code at checkout. Order 48291374"). A reset keyword plus a
 * password-reset link also wins over body promo tokens. For the other kinds, body promo tokens
 * count only in the opening text after the hidden preheader, and not at all when the subject
 * states the security purpose. Promo footers are ignored. Login/security alerts whose subject is
 * explicit need no link (DECISIONS.md).
 */
import type { ContentExtract, HeaderFacts, ParsedEmail, SecurityVerdict } from "../types";
import {
  CODE_DIGITS_RE,
  hit,
  LOGIN_ALERT_KW,
  MAGIC_KW,
  OTP_CODE_KW,
  OTP_KW,
  PROMO_KW,
  RESET_KW,
  SECURITY_ALERT_KW,
  VERIFY_EMAIL_KW,
} from "./patterns";
import { textView } from "./text";
import { maskPostalDigits } from "../content/postal";
import { normalizeForMatch } from "../util/text";

export interface SecurityInput {
  parsed: ParsedEmail;
  /** null for headers-only (metadata) evaluation: only the subject is checked. */
  content: ContentExtract | null;
  headers: HeaderFacts;
}

const BEFORE_WINDOW = 80;
/** Characters of body text that count as the message's primary content (promo check). */
const PRIMARY_WINDOW = 200;
const AFTER_WINDOW = 160;

function isYearLike(code: string): boolean {
  if (!/^\d{4}$/.test(code)) return false;
  const n = Number(code);
  return n >= 1900 && n <= 2099;
}

const globalCache = new WeakMap<RegExp, RegExp>();

function globalVersion(re: RegExp): RegExp {
  let g = globalCache.get(re);
  if (!g) {
    g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    globalCache.set(re, g);
  }
  g.lastIndex = 0;
  return g;
}

/** Positions of every keyword match (global scan, bounded). */
function keywordSpans(res: readonly RegExp[], s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const re of res) {
    const g = globalVersion(re);
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = g.exec(s)) !== null && guard++ < 20) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return spans;
}

/** A sentence end, a footer separator or a block break. */
const BREAK_RE = /[.!?;](?:\s|$)|[|·•\n]/u;

/**
 * A 4–8 digit code within the window around any keyword match. A code inside one of `refs`
 * (labelled reference numbers) counts only when nothing but the same sentence separates it from
 * the keyword ("your verification code for booking 482913"), not across a sentence or block
 * ("use your code at checkout. Order 48291374").
 */
export function codeNearKeyword(
  res: readonly RegExp[],
  s: string,
  refs: ReadonlyArray<readonly [number, number]> = [],
): boolean {
  const spans = keywordSpans(res, s);
  if (spans.length === 0) return false;
  CODE_DIGITS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = CODE_DIGITS_RE.exec(s)) !== null && guard++ < 200) {
    if (isYearLike(m[0])) continue;
    const at = m.index;
    const codeEnd = at + m[0].length;
    const ref = refs.find(([rs, re]) => at < re && codeEnd > rs);
    for (const [start, end] of spans) {
      if (at < start - BEFORE_WINDOW || at > end + AFTER_WINDOW) continue;
      if (!ref) return true;
      const between = ref[0] >= end ? s.slice(end, ref[0]) : s.slice(ref[1], start);
      if (!BREAK_RE.test(between)) return true;
    }
  }
  return false;
}

/** Most characters between a keyword and the code it is bound to. */
const BOUND_WINDOW = 40;
/** Words that may sit between a keyword and its code ("your OTP for login is 482913"). */
const BOUND_WORDS = new Set([
  "code",
  "pin",
  "number",
  "password",
  "authentication",
  "verification",
  "login",
  "log",
  "logging",
  "sign",
  "signing",
  "signin",
  "in",
  "is",
  "as",
  "your",
  "the",
  "to",
  "for",
  "account",
  "sms",
  "valid",
  "only",
  "expires",
  "within",
]);
/** After "for", this many words of any kind may follow ("for your acme account", "for order 123"). */
const FOR_SPAN = 4;
/** A word that ties the next number to the keyword before it ("OTP is 482913", "2FA code 482913"). */
const BINDERS = new Set(["is", "code", "pin", "number", "password", "passcode", "otp"]);
/** A word that ties the number before it to the keyword after it ("482913 is your OTP"). */
const REVERSE_BINDERS = new Set(["is", "as", "was"]);
const CONNECT_SPLIT_RE = /[\s:=,()–—-]+/u;
/**
 * Loyalty/reward units. With no binder word, a number right after "… points:" or right before
 * "points" is the reward, not a code ("2FA for extra points: 5000", "Enable 2FA for your account:
 * 5000 points"). A reward word elsewhere in the phrase never vetoes a bound code ("Your OTP for
 * credit card payment is 482913", "Your OTP for Rewards login: 482913").
 */
const REWARD_UNITS = new Set([
  "point",
  "points",
  "pts",
  "mile",
  "miles",
  "bonus",
  "reward",
  "rewards",
  "credit",
  "credits",
  "coins",
  "stars",
  "entries",
  "cashback",
  "discount",
  "off",
  "voucher",
  "coupon",
]);

interface Connectors {
  tokens: string[];
  /** Some words were admitted only because they follow "for" ("for extra points"). */
  loose: boolean;
}

/** The words of `between`, or null when it is too long or crosses a sentence or a footer separator. */
function connectorTokens(between: string): Connectors | null {
  if (between.length > BOUND_WINDOW || /[.!?;](?:\s|$)|[|·•]/u.test(between)) return null;
  const tokens = between.split(CONNECT_SPLIT_RE).filter(Boolean);
  if (tokens.length > 8) return null;
  let free = 0;
  let loose = false;
  for (const tok of tokens) {
    if (tok === "for") {
      free = FOR_SPAN;
    } else if (BOUND_WORDS.has(tok)) continue;
    else if (free > 0) {
      free--;
      loose = true;
    } else return null;
  }
  return { tokens, loose };
}

/** A binder word among the connectors ("the number of points" names a count, not a code). */
function hasBinder(tokens: readonly string[]): boolean {
  return tokens.some((tok, i) => BINDERS.has(tok) && !(tok === "number" && tokens[i + 1] === "of"));
}

/** Only "your"/"the" before the keyword on its line ("Your OTP …", not "Enable 2FA …"). */
function keywordOpensLine(s: string, kwStart: number): boolean {
  const lineStart = s.lastIndexOf("\n", kwStart - 1) + 1;
  const lead = s.slice(lineStart, kwStart).split(CONNECT_SPLIT_RE).filter(Boolean);
  return lead.length <= 2 && lead.every((tok) => tok === "your" || tok === "the");
}

/**
 * Keyword, then code: the words in between are connectors and the last one (or a ":"/"=") binds the
 * number to the keyword. With nothing but spaces or a dash in between ("Your OTP - 482913"), the
 * keyword must open its line and the code must end the sentence — not a footer's "Turn on 2FA — 15000
 * members", "Enable 2FA for 5000 points" or "turn on 2FA" above a separate "5550199" block.
 */
function boundForward(s: string, kwStart: number, kwEnd: number, at: number, codeEnd: number) {
  const between = s.slice(kwEnd, at);
  const conn = connectorTokens(between);
  if (!conn) return false;
  const { tokens, loose } = conn;
  // Fail safe: only an unbound number next to a reward unit is a reward; a binder always wins.
  if (!hasBinder(tokens)) {
    const next = /^[\s:=]*([a-z]+)/u.exec(s.slice(codeEnd))?.[1];
    if (
      REWARD_UNITS.has(tokens[tokens.length - 1] ?? "") ||
      (next !== undefined && REWARD_UNITS.has(next))
    )
      return false;
  }
  // A ":" after free words that follow "for" binds only when a binder word or a keyword that opens
  // its line vouches for it ("Your OTP is valid for 10 minutes: 482913", "Your OTP for your order:
  // 482913"), not a footer's "Enable 2FA for extra points: 5000".
  if (/[:=]\s*$/u.test(between)) return !loose || hasBinder(tokens) || keywordOpensLine(s, kwStart);
  const last = tokens[tokens.length - 1];
  if (last !== undefined) return BINDERS.has(last);
  if (between.includes("\n")) return false;
  return keywordOpensLine(s, kwStart) && /^[ \t]*(?:$|[\n.!?;,)])/u.test(s.slice(codeEnd));
}

/** Code, then keyword: "482913 is your OTP", "Use 482913 as your passcode". */
function boundBackward(s: string, codeEnd: number, kwStart: number) {
  const first = connectorTokens(s.slice(codeEnd, kwStart))?.tokens[0];
  return first !== undefined && REVERSE_BINDERS.has(first);
}

/**
 * A 4–8 digit code bound to a keyword match by connecting words (either order), never across a
 * sentence, a footer separator or a block with nothing tying the two together. Used under a promo
 * opening, where the generic 2FA words ("OTP", "passcode", "2FA") count only this way.
 */
function codeBoundToKeyword(res: readonly RegExp[], s: string): boolean {
  const spans = keywordSpans(res, s);
  if (spans.length === 0) return false;
  CODE_DIGITS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = CODE_DIGITS_RE.exec(s)) !== null && guard++ < 200) {
    if (isYearLike(m[0])) continue;
    const at = m.index;
    const codeEnd = at + m[0].length;
    for (const [start, end] of spans) {
      if (at >= end && at - end <= BOUND_WINDOW && boundForward(s, start, end, at, codeEnd))
        return true;
      if (codeEnd <= start && start - codeEnd <= BOUND_WINDOW && boundBackward(s, codeEnd, start))
        return true;
    }
  }
  return false;
}

/**
 * Numbers labelled as an order, invoice, tracking, item or phone reference ("Order 48291374",
 * "Order #: 48291374", "Your order number is 48291374", "Tracking: 1Z 4829 1374", "Tel. 5550199",
 * "Call us: 5550199", "Confirmation number: 48291374"). Label and number must share a line, so a
 * brand name ending in "Store" above a separate code block is not a label. Under a promo opening
 * such a number is not a code for the keyword-near-code check unless it sits in the same sentence
 * as the keyword: a promo's "use your code at checkout. Order 48291374" is not an OTP, while "your
 * verification code for booking 482913" still is.
 */
const REFERENCE_NUMBER_RE =
  /(?<![\p{L}\p{N}])(?:order|invoice|receipt|ref(?:erence)?|tracking|shipment|parcel|booking|reservation|confirmation|item|sku|style|model|article|art|phone|tel|fax|call(?:[ \t]{1,3}us)?|customer|member(?:ship)?|store)(?:[ \t]{0,3}(?:no|nr|num|number|id|confirmation))?\.?(?:[ \t]{1,3}(?:is|was))?(?:[ \t]{0,3}[:#]){0,2}[ \t]{0,3}(?=\p{L}{0,3}\d)[\p{L}\p{N}]{1,20}(?:[ -](?=\p{L}{0,3}\d)[\p{L}\p{N}]{1,12}){0,3}(?![\p{L}\p{N}])/giu;

/** [start, end) of every labelled reference number in `text` (bounded). */
function referenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  REFERENCE_NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_NUMBER_RE.exec(text)) !== null && spans.length < 200) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** The first PRIMARY_WINDOW characters of the body text, the hidden preheader left out. */
function openingText(body: string, preheader: string | null): string {
  const pre = preheader ? normalizeForMatch(preheader) : "";
  const start = pre && body.startsWith(pre) ? pre.length : 0;
  return body
    .slice(start, start + PRIMARY_WINDOW + 1)
    .trimStart()
    .slice(0, PRIMARY_WINDOW);
}

/** Detects security-sensitive mail (DESIGN.md §7.4). */
export function detectSecuritySensitive(input: SecurityInput): SecurityVerdict {
  const { parsed, content } = input;
  const t = textView(parsed, content);
  const links = new Set(content?.securityLinkKinds ?? []);
  const actionLink = links.has("reset") || links.has("verify") || links.has("login");
  const anyLink = actionLink || links.has("secure");
  // Deals are not used here because they are extracted from the whole text, promo footers included.
  const none: SecurityVerdict = { securitySensitive: false, reason: null };
  if (hit(PROMO_KW, t.subject)) return none;

  const text = t.all;
  const opening = openingText(t.body, content?.preheader ?? null);
  // A marketing template: promo tokens in the preheader or the opening text.
  const promoOpening = hit(PROMO_KW, t.body.slice(0, PRIMARY_WINDOW)) || hit(PROMO_KW, opening);
  // 1. A one-time code next to a code keyword always wins (the code itself must be minimised), also
  //    over promo tokens in a marketing template's preheader, banner or nav bar. Under a promo
  //    opening the evidence must be specific: a keyword that names the code (the generic
  //    "two-factor"/"passcode"/"2FA" of a promo footer counts only when the subject names the OTP
  //    or the keyword is bound to the code: "Your OTP is 482913") and a number that is not part
  //    of the footer's postal address ("CA 94103", "1234 Market St", "PO Box 5521") or an
  //    order/phone reference in another sentence ("use your code at checkout. Order 48291374"). A
  //    labelled number in the keyword's own sentence still counts ("your security code for
  //    booking 482913"), as does a code bound to any OTP keyword.
  const otpSubject = hit(OTP_KW, t.subject);
  const otpKw = promoOpening && !otpSubject ? OTP_CODE_KW : OTP_KW;
  const addressFree = promoOpening ? maskPostalDigits(text) : text;
  const refs = promoOpening ? referenceSpans(addressFree) : [];
  if (hit(otpKw, addressFree) && codeNearKeyword(otpKw, addressFree, refs))
    return { securitySensitive: true, reason: "otp" };
  if (promoOpening && codeBoundToKeyword(OTP_KW, addressFree))
    return { securitySensitive: true, reason: "otp" };
  if (hit(VERIFY_EMAIL_KW, addressFree) && codeNearKeyword(VERIFY_EMAIL_KW, addressFree, refs)) {
    return { securitySensitive: true, reason: "otp" };
  }

  // 2. Other kinds: the subject states the purpose, so subject matches outrank body matches.
  type Kind = Exclude<SecurityVerdict["reason"], null>;
  const qualifies: Array<[Kind, readonly RegExp[], (inSubject: boolean) => boolean]> = [
    ["password_reset", RESET_KW, () => actionLink || codeNearKeyword(RESET_KW, text)],
    ["magic_link", MAGIC_KW, () => links.has("login") || links.has("verify")],
    ["magic_link", VERIFY_EMAIL_KW, () => links.has("verify") || links.has("login")],
    [
      "login_alert",
      LOGIN_ALERT_KW,
      (inSubject) => inSubject || anyLink || codeNearKeyword(LOGIN_ALERT_KW, text),
    ],
    ["security_alert", SECURITY_ALERT_KW, (inSubject) => inSubject || anyLink],
  ];
  // Primary content: a subject that states a security purpose outranks promo tokens in the body;
  // so does a reset keyword in the body plus a password-reset link (text or path) — a nav bar's
  // "Sale" must not hide a reset. Otherwise the opening text after the hidden preheader (a
  // template's marketing line) counts.
  const securitySubject = qualifies.some(([, res]) => hit(res, t.subject));
  const resetWithLink = links.has("reset") && hit(RESET_KW, t.body);
  if (!securitySubject && !resetWithLink && hit(PROMO_KW, opening)) return none;
  for (const where of ["subject", "body"] as const) {
    const s = where === "subject" ? t.subject : t.body;
    for (const [reason, res, ok] of qualifies) {
      if (hit(res, s) && ok(where === "subject")) return { securitySensitive: true, reason };
    }
  }
  return none;
}
