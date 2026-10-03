/**
 * Redaction for anything stored or displayed outside the live viewer (DESIGN.md §7.4):
 * 4–8 digit runs near code keywords, and token-bearing URLs. Also used on the text sent to
 * Claude and on search excerpts. Linear-time, bounded input.
 */
import { looksLikeRecipientToken } from "../policy";
import { shannonEntropy } from "../util/text";

const MAX_INPUT = 20_000;
const WINDOW = 80;

/** Code keywords (multilingual, lower-case, no boundaries needed for CJK). */
const CODE_KEYWORD_RE =
  /(?:code|passcode|password|pin|otp|one[- ]time|verification|verify|security|token|login|sign[- ]?in|2fa|c[oó]digo|codice|kod|koodi|kode|mot de passe|contrase[nñ]a|senha|passwort|wachtwoord|has[lł]o|l[oö]senord|код|пароль|kodu|şifre|コード|認証|验证码|驗證碼|인증)/giu;

const DIGIT_RUN_RE = /(?<![\p{N}])(?:\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{4,8})(?![\p{N}])/gu;

const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]{1,2048}/giu;

/** Query/path keys that always carry secrets. */
const SECRET_PARAM_RE =
  /[?&#;](?:token|access_token|auth|code|key|otp|sig|signature|hash|reset|magic|session|sid|jwt|t|k|nonce|ticket|confirm(?:ation)?|verify|verification|login|email)=/i;

/** True when a URL carries a token (secret query key, or a long high-entropy path/query token). */
export function isTokenBearingUrl(url: string): boolean {
  if (url.length > 1024) return true;
  if (SECRET_PARAM_RE.test(url)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  for (const seg of u.pathname.split("/")) {
    for (const piece of seg.split(/[.,;:=@]+/))
      if (looksLikeRecipientToken(piece, true)) return true;
  }
  for (const [, v] of u.searchParams) {
    for (const piece of v.split(/[.,;:|@\s]+/)) if (isShortSecret(piece)) return true;
  }
  return false;
}

/**
 * Query values of 16+ chars mixing letters and digits with high entropy (one-time tokens are
 * often shorter than the 24-char per-recipient threshold used for images).
 */
function isShortSecret(v: string): boolean {
  if (v.length < 16 || v.length > 2048) return v.length > 2048;
  if (!/^[A-Za-z0-9+/=_~-]+$/.test(v)) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return looksLikeRecipientToken(v, false) || shannonEntropy(v) >= 3.4;
}

/** Removes codes near code keywords and token-bearing URLs (DESIGN.md §7.4). */
export function redactSensitive(text: string): string {
  const input = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  // 1. Token-bearing URLs.
  let out = input.replace(URL_RE, (url) => (isTokenBearingUrl(url) ? "[link removed]" : url));
  // 2. Digit runs within WINDOW characters of a code keyword.
  const keywordPositions: number[] = [];
  CODE_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = CODE_KEYWORD_RE.exec(out)) !== null && guard++ < 500) {
    keywordPositions.push(m.index, m.index + m[0].length);
  }
  if (keywordPositions.length === 0) return out;
  out = out.replace(DIGIT_RUN_RE, (run, offset: number) => {
    let i = 0;
    while (i < keywordPositions.length) {
      const start = keywordPositions[i] as number;
      const end = keywordPositions[i + 1] as number;
      if (offset + run.length >= start - WINDOW && offset <= end + WINDOW) return "••••";
      i += 2;
    }
    return run;
  });
  return out;
}
