/**
 * Static sender lists: consumer mailbox providers ("free-mail", DESIGN.md §7.2 negative signal),
 * no-reply local parts, and mailbox normalisation for "is this one of my addresses?" checks.
 */

/** Consumer mailbox providers (registrable domains). */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "passport.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "hotmail.nl",
  "hotmail.be",
  "hotmail.ca",
  "hotmail.com.au",
  "hotmail.com.br",
  "outlook.fr",
  "outlook.de",
  "outlook.es",
  "outlook.it",
  "outlook.co.uk",
  "outlook.jp",
  "outlook.com.br",
  "live.co.uk",
  "live.fr",
  "live.de",
  "live.nl",
  "live.it",
  "live.ca",
  "live.com.au",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.it",
  "yahoo.es",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.com.br",
  "yahoo.co.jp",
  "yahoo.co.in",
  "yahoo.com.mx",
  "yahoo.com.ar",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "comcast.net",
  "cox.net",
  "charter.net",
  "optonline.net",
  "earthlink.net",
  "frontier.com",
  "windstream.net",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "tuta.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "zoho.com",
  "zohomail.com",
  "zohomail.eu",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "gmx.fr",
  "web.de",
  "t-online.de",
  "freenet.de",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "neuf.fr",
  "libero.it",
  "virgilio.it",
  "tiscali.it",
  "alice.it",
  "tin.it",
  "seznam.cz",
  "centrum.cz",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "interia.pl",
  "op.pl",
  "yandex.ru",
  "yandex.com",
  "ya.ru",
  "mail.ru",
  "bk.ru",
  "inbox.ru",
  "list.ru",
  "rambler.ru",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "ntlworld.com",
  "talktalk.net",
  "bigpond.com",
  "optusnet.com.au",
  "shaw.ca",
  "rogers.com",
  "sympatico.ca",
  "telus.net",
  "qq.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sohu.com",
  "aliyun.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "nate.com",
  "rediffmail.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
]);

/** Normalised no-reply local-part stems (after lower-casing and removing separators). */
const NO_REPLY_STEMS = [
  "noreply",
  "donotreply",
  "dontreply",
  "donotrespond",
  "noresponse",
  "norespond",
  "noreplies",
  "nepasrepondre", // fr
  "nerepondezpas", // fr
  "noresponder", // es
  "norespondas", // es
  "nocontestar", // es
  "naoresponda", // pt
  "naoresponder", // pt
  "nichtantworten", // de
  "keineantwort", // de
  "nonrispondere", // it
  "nietantwoorden", // nl
  "neodpovidat", // cs
  "nieodpowiadaj", // pl
  "svaraej", // sv
  "mailerdaemon",
];

/** True when a local part is a no-reply style address (DESIGN.md §7.2, +5). */
export function isNoReplyLocalPart(local: string): boolean {
  const base = local.toLowerCase().split("+")[0] ?? "";
  const squashed = base.replace(/[^a-z0-9]/g, "");
  if (squashed.length === 0 || squashed.length > 64) return false;
  return NO_REPLY_STEMS.some((stem) => squashed.includes(stem));
}

/**
 * Canonical mailbox for equality checks: lower-case, "+tag" removed, and Gmail's dot-insensitive
 * local parts collapsed (googlemail.com ≡ gmail.com).
 */
export function canonicalMailbox(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return a;
  let local = a.slice(0, at);
  let domain = a.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
