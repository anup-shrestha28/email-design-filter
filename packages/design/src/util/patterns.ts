/**
 * Lexicons and patterns (versioned with SCORING_VERSION via LEXICON_VERSION).
 *
 * Multilingual where the spec asks for it (unsubscribe/opt-out, preferences, generic link
 * labels). All regexes are linear-time (no nested quantifiers) because they run on hostile input.
 */

export const LEXICON_VERSION = "lex-2026.3";

/** Unsubscribe / opt-out link text (DESIGN-SCORE §2.1 footer marker, §5.9 U1). */
export const UNSUBSCRIBE_TEXT =
  /\b(?:unsubscribe|unsub|opt[\s-]?out|stop (?:receiving|these) emails|remove me)\b|d[ée]sinscri|d[ée]sabonner|se d[ée]sabonner|abmelden|austragen|abbestellen|darse de baja|dar de baja|cancelar (?:la )?suscripci|anular (?:la )?suscripci|disiscriv|annulla(?:re)? l'iscrizione|cancelar (?:a )?inscri|descadastr|afmelden|uitschrijven|avregistrer|avsluta prenumeration|afmeld|wypisz|odhl[áa]sit|отписаться|отказаться от рассылки|配信停止|購読解除|登録解除|退订|取消订阅|수신\s?거부|구독\s?취소|إلغاء الاشتراك|הסרה מרשימת|ביטול הרשמה/i;

/**
 * Manage-preferences / frequency links (U3, footer marker). lex-2026.3: also "Manage
 * recommendations", "Manage notifications / alerts / communications" (LinkedIn's job-alert
 * footer), whose links choose which emails arrive.
 */
export const PREFERENCES_TEXT =
  /\b(?:preferences?|manage (?:your )?(?:subscriptions?|emails?|settings|preferences|recommendations|(?:e-?mail |job )?(?:notifications|alerts)|communications)|e-?mail settings|update (?:your )?(?:profile|preferences|subscription)|subscription (?:center|centre|settings)|email frequency|change frequency|(?:change |choose |set )?how often (?:you )?(?:hear from us|get (?:these|our|this)|receive (?:these|our|this)|we (?:e-?mail|write))|notification settings)\b|pr[ée]f[ée]rences|einstellungen|pr[äa]ferenzen|preferencias|preferenze|prefer[êe]ncias|voorkeuren|inst[äa]llningar|配信設定|订阅设置|수신 설정/i;

/** "View in browser" style links (excluded from CTA candidates; C2 boilerplate). */
export const VIEW_ONLINE_TEXT =
  /\b(?:view (?:it |this )?(?:e-?mail |message |newsletter )?(?:in|on) (?:your |a )?(?:web )?browser|view (?:it )?online|view as (?:a )?web ?page|web version|online version|having trouble (?:viewing|reading)|can'?t see (?:this|images)|trouble viewing|display problems?)\b|version en ligne|voir (?:la version )?en ligne|im browser (?:ansehen|anzeigen|öffnen)|online ansehen|ver (?:en el|en tu) navegador|ver versi[óo]n web|visualizza (?:nel|sul) browser|ver no navegador|bekijk (?:in je|online)/i;

/**
 * "Why you're receiving this" statements (U4, footer marker). lex-2026.3: also LinkedIn's "You are
 * receiving Messages digest emails" / "…People You May Know notification emails", "This email was
 * intended for …", "Learn why we included this", "The email was sent to …", "This message has
 * been sent to you for registering…", "We're sending you this because…", "You're on this list
 * because…", and every contraction with a typographic apostrophe ("You’re receiving this email
 * because…"); "you're getting" only as "…getting this / these / our…" (not "You're getting
 * closer", "You're getting 20% off").
 */
export const RECEIVING_TEXT =
  /\b(?:you(?:['’]re| are) receiving (?:this|these)|you(?:['’]re| are) receiving [^.\n]{1,80}? (?:e-?mails?|notifications?|alerts|newsletters?|digests?|updates)\b|you received this|you(?:['’]re| are) getting (?:this|these|our)\b|you(?:['’]re| are) subscribed|you(?:['’]ve| have)? subscribed (?:to|for)|you signed up|you opted in|(?:this|the) (?:e-?mail|message) (?:was|has been|is being) (?:sent|intended) (?:to|for)|learn why we included this|we(?:['’]re| are) sending you this|you(?:['’]re| are) on (?:this|our) (?:list|mailing list) because|sent to [^\s@]{1,64}@|because you (?:signed up|subscribed|opted|registered|are a|have an? )|why (?:did|am) i (?:get|getting|receive|receiving) this|you have received this)\b|vous recevez (?:cet|ce)|vous avez re[çc]u (?:cet|ce)|sie erhalten diese|sie haben diese|recibes este|has recibido este|ricevi questa|hai ricevuto questa|voc[êe] est[áa] recebendo|u ontvangt deze|je ontvangt deze/i;

/** Social-network link hosts (excluded from CTA candidates). */
export const SOCIAL_HOST =
  /(?:^|\.)(?:facebook|fb|instagram|twitter|x|linkedin|youtube|youtu|tiktok|pinterest|snapchat|threads|mastodon|bsky|discord|reddit|tumblr|whatsapp|telegram|vimeo)\.(?:com|be|net|app|gg|me|social)$/i;

/** Known ESP unsubscribe/preference paths (U1 host/path match, footer markers). */
export const ESP_UNSUB_PATH =
  /\/(?:unsubscribe|unsub|opt-?out|optout|manage[-_]?preferences|email[-_]?preferences|preferences?[-_]?center|subscriptions?\/unsubscribe|hs\/manage-preferences|wf\/unsubscribe|e\/unsub|oc\/|u\/)(?:[/?#.]|$)/i;

/**
 * Generic link / CTA labels, per language (A3, H4). Matched against the normalized label
 * (lower-case, punctuation stripped).
 */
export const GENERIC_LABELS: ReadonlySet<string> = new Set([
  // en
  "click here",
  "click",
  "here",
  "tap here",
  "read more",
  "learn more",
  "more",
  "more info",
  "more information",
  "details",
  "see details",
  "link",
  "this link",
  "go",
  "continue",
  "submit",
  "see more",
  "find out more",
  "view more",
  "click to view",
  "info",
  "read",
  "view",
  "open",
  "ok",
  "start",
  "next",
  "button",
  // fr
  "cliquez ici",
  "ici",
  "en savoir plus",
  "lire la suite",
  "plus",
  "voir plus",
  "suite",
  // de
  "hier klicken",
  "hier",
  "mehr erfahren",
  "weiterlesen",
  "mehr",
  "mehr infos",
  "details ansehen",
  // es
  "haga clic aquí",
  "haz clic aquí",
  "aquí",
  "más información",
  "leer más",
  "ver más",
  "más",
  // it
  "clicca qui",
  "qui",
  "scopri di più",
  "leggi di più",
  "leggi tutto",
  "altro",
  // pt
  "clique aqui",
  "aqui",
  "saiba mais",
  "leia mais",
  "ver mais",
  // nl
  "klik hier",
  "lees meer",
  "meer informatie",
  "meer",
]);

/** Verbs that start a specific action label (H4), per language, normalized lower-case. */
export const ACTION_VERBS: ReadonlySet<string> = new Set([
  // en
  "shop",
  "buy",
  "get",
  "grab",
  "start",
  "try",
  "book",
  "reserve",
  "register",
  "sign",
  "join",
  "download",
  "install",
  "claim",
  "redeem",
  "unlock",
  "discover",
  "explore",
  "order",
  "reorder",
  "subscribe",
  "upgrade",
  "renew",
  "activate",
  "confirm",
  "verify",
  "rsvp",
  "watch",
  "listen",
  "save",
  "apply",
  "donate",
  "give",
  "create",
  "add",
  "browse",
  "track",
  "manage",
  "pay",
  "checkout",
  "compare",
  "find",
  "schedule",
  "contact",
  "reply",
  "call",
  "chat",
  "meet",
  "attend",
  "vote",
  "take",
  "complete",
  "finish",
  "review",
  "rate",
  "share",
  "invite",
  "refer",
  "upload",
  "print",
  "enroll",
  "enrol",
  "sell",
  "rent",
  "plan",
  "customize",
  "customise",
  "personalize",
  "build",
  "design",
  "choose",
  "pick",
  "select",
  "reset",
  "update",
  "change",
  "access",
  "use",
  "enter",
  "play",
  "stream",
  "read",
  "see",
  "view",
  "visit",
  "check",
  "go",
  "learn",
  "request",
  "accept",
  "decline",
  "cancel",
  "return",
  "exchange",
  "send",
  "support",
  // fr
  "acheter",
  "découvrir",
  "decouvrir",
  "commander",
  "réserver",
  "reserver",
  "profiter",
  "télécharger",
  "telecharger",
  "voir",
  "essayer",
  "commencer",
  "rejoindre",
  "inscrivez",
  "s'inscrire",
  "obtenir",
  "j'en profite",
  "je",
  "magasiner",
  // de
  "jetzt",
  "kaufen",
  "entdecken",
  "bestellen",
  "buchen",
  "sichern",
  "herunterladen",
  "ansehen",
  "starten",
  "anmelden",
  "registrieren",
  "testen",
  "shoppen",
  // es
  "comprar",
  "descubre",
  "descubrir",
  "reservar",
  "compra",
  "obtén",
  "obten",
  "descargar",
  "ver",
  "empieza",
  "empezar",
  "únete",
  "unete",
  "regístrate",
  "registrate",
  "pedir",
  // it
  "acquista",
  "scopri",
  "prenota",
  "ordina",
  "scarica",
  "iscriviti",
  "inizia",
  "compra",
  // pt
  "comprar",
  "descobrir",
  "reservar",
  "baixar",
  "assinar",
  "começar",
  "comecar",
  "garanta",
  // nl
  "bestel",
  "koop",
  "ontdek",
  "boek",
  "download",
  "bekijk",
  "shop",
  "probeer",
  "meld",
]);

/**
 * Merge-tag patterns (DESIGN-SCORE §5.8 X3). Global flags are applied by the caller; the
 * sources are kept here so every consumer uses the identical list.
 */
export const MERGE_TAG_SOURCES: readonly string[] = [
  String.raw`\*\|[A-Z0-9_:]+\|\*`,
  String.raw`\{\{\s*[\w.]+\s*\}\}`,
  String.raw`%%[\w=.:-]+%%`,
  // The only case-insensitive family (DESIGN-SCORE §5.8), via an inline `(?i:)` modifier.
  String.raw`(?i:\[(?:first_?name|fname|last_?name|name|email|company)\])`,
  String.raw`\{\$[\w.]+\}`,
  String.raw`%recipient\.\w+%`,
];

const MERGE_TAG_RE = new RegExp(MERGE_TAG_SOURCES.map((s) => `(?:${s})`).join("|"));

/** Does `text` contain an unrendered merge tag? (Only the `[name]` family is case-insensitive.) */
export function hasMergeTag(text: string): boolean {
  if (!text) return false;
  return MERGE_TAG_RE.test(text.length > 500_000 ? text.slice(0, 500_000) : text);
}

/** The first unrendered merge tag in `text` (≤ 40 characters), or null — for explanations. */
export function firstMergeTag(text: string): string | null {
  if (!text) return null;
  const m = MERGE_TAG_RE.exec(text.length > 500_000 ? text.slice(0, 500_000) : text);
  if (!m) return null;
  const tag = m[0].replace(/\s+/g, " ");
  return tag.length <= 40 ? tag : `${tag.slice(0, 39)}…`;
}

/**
 * The first merge tag in `text` with a few words around it, as a reader sees it
 * ("Hi {{ first_name }}"), ≤ ~60 characters; null when there is none.
 */
export function mergeTagSnippet(text: string): string | null {
  if (!text) return null;
  const hay = text.length > 500_000 ? text.slice(0, 500_000) : text;
  const m = MERGE_TAG_RE.exec(hay);
  if (!m) return null;
  const tag = m[0].replace(/\s+/g, " ").slice(0, 40);
  const before = (hay.slice(Math.max(0, m.index - 80), m.index).split(/[,.!?;:|–—\n]/).pop() ?? "")
    .replace(/\s+/g, " ")
    .trimStart();
  const after = (hay.slice(m.index + m[0].length, m.index + m[0].length + 80).split(/[,.!?;:|–—\n]/)[0] ?? "")
    .replace(/\s+/g, " ")
    .trimEnd();
  const lead = before.length > 16 ? `…${before.slice(-15).replace(/^\S*\s/, "")}` : before;
  const tail = after.length > 16 ? `${after.slice(0, 15).replace(/\s\S*$/, "")}…` : after;
  return `${lead}${tag}${tail}`.trim().slice(0, 60);
}

/** Count merge-tag occurrences (bounded). */
export function countMergeTags(text: string, max = 100): number {
  if (!text) return 0;
  const re = new RegExp(MERGE_TAG_RE.source, "g");
  let n = 0;
  const hay = text.length > 500_000 ? text.slice(0, 500_000) : text;
  while (re.exec(hay) !== null && n < max) n++;
  return n;
}

/** Placeholder link domains (X3 defect class 3). */
export const PLACEHOLDER_HOSTS =
  /^(?:(?:www\.)?example\.(?:com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0|test|invalid|(?:[a-z0-9-]+\.)+(?:test|invalid|localhost|example))$/i;

/**
 * Postal address heuristics (footer marker; trust badge). Deliberately conservative:
 * a street number + street type, a PO box, or a postcode next to a city-like token.
 */
const STREET =
  /\b\d{1,6}[a-z]?\s+(?:[\p{L}'.-]{1,30}\s){0,4}(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|way|court|ct\.?|place|pl\.?|square|sq\.?|parkway|pkwy|highway|hwy|suite|floor|terrace|circle)\b/iu;
const EURO_STREET =
  /\b(?:[\p{L}-]{1,40}(?:straße|strasse|str\.|weg|gasse|platz|allee|laan|straat|gatan|vej|gade)|(?:rue|avenue|boulevard|chemin|via|viale|piazza|calle|avenida|rua|plaza)\s+[\p{L}' -]{2,40})\s*\d{0,5}/iu;
const PO_BOX = /\b(?:p\.?\s?o\.?\s?box|postfach|apartado|bo[iî]te postale|casella postale)\s*\d+/iu;
const US_ZIP =
  /\b[A-Z][a-z]{1,30},?\s+(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\s+\d{5}(?:-\d{4})?\b/;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/;
const EU_POSTCODE = /\b(?:\d{4,5}|\d{2}-\d{3})\s+[A-ZÄÖÜÉÈ][\p{L}-]{2,40}/u;

/** A postal address is detected in `text` (a footer block or the whole email). */
export function looksLikePostalAddress(text: string): boolean {
  if (!text || text.length > 20_000)
    return text ? looksLikePostalAddress(text.slice(-20_000)) : false;
  if (PO_BOX.test(text) || US_ZIP.test(text)) return true;
  const hasStreet = STREET.test(text) || EURO_STREET.test(text);
  return (
    hasStreet &&
    (UK_POSTCODE.test(text) || EU_POSTCODE.test(text) || /\b\d{5}\b/.test(text) || /,/.test(text))
  );
}

/** Link separators allowed between navigation-row links (DESIGN-SCORE §2.1). */
export const NAV_SEPARATORS = /^[\s|•·–—\-/]*$/u;

/** Words suggesting an image is a button (DESIGN-SCORE §2.1 button-like image links). */
export const BUTTON_IMAGE_HINT =
  /\b(?:button|btn|cta|shop|buy|order|book|get|start|download|learn|read|view|see|claim|join|sign ?up|register|subscribe)\b/i;

/** Alt texts that are generic words, not descriptions (A2(b)). */
export const GENERIC_ALT: ReadonlySet<string> = new Set([
  "image",
  "img",
  "picture",
  "photo",
  "graphic",
  "banner",
  "logo",
  "icon",
  "spacer",
  "pixel",
  "blank",
  "untitled",
  "placeholder",
  "hero",
  "header",
  "footer",
  "button",
  "btn",
  "click",
  "click here",
  "here",
  "link",
  "alt",
  "alt text",
  "image description",
  "bild",
  "imagen",
  "immagine",
  "imagem",
  "afbeelding",
  "photo1",
  "image1",
  "img1",
  "_",
  "-",
  "*",
  "null",
  "undefined",
]);

/** Filename / URL-looking alt text (A2(b)). */
export const FILENAME_ALT =
  /(?:^|\/)[\w.-]+\.(?:jpe?g|png|gif|webp|svg|bmp|tiff?|avif)(?:\?|$)|^https?:\/\/|^www\./i;
