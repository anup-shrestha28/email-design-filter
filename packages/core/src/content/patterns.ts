/**
 * Multilingual body-link and footer patterns (DESIGN-SCORE U1/U3/U4 and footer markers §2.1):
 * unsubscribe / opt-out, manage-preferences, "why you're receiving this", view-in-browser and
 * security action links. Every fragment is a bounded alternation (no nested quantifiers), and all
 * regexes run against NFKC-lower-cased text.
 */
import type { SecurityLinkKind } from "../types";
import { phraseRegex } from "../util/text";

/**
 * Unsubscribe / opt-out phrases: en, es, fr, de, it, pt, nl, pl, sv, da, no, fi, ja, zh, ko, ru,
 * tr, plus a few extras (cs, hu, ro, uk, el).
 */
const UNSUBSCRIBE_SOURCES = [
  // en
  "unsubscribe",
  "un-subscribe",
  "unsub",
  "opt[- ]?out",
  "remove me",
  "stop (?:receiving|getting) (?:these |our |this )?(?:e-?mails?|messages|newsletters?)",
  "stop (?:these|all) e-?mails",
  "cancel (?:my |your )?subscription",
  // es
  "dar(?:se|te|me)? de baja",
  "darte de baja",
  "cancelar (?:la |tu |su )?suscripci[oó]n",
  "anular (?:la )?suscripci[oó]n",
  "desuscribir(?:se|te)?",
  "desinscribir(?:se|te)?",
  "no deseo recibir",
  // fr
  "(?:se |vous )?d[ée]sabonner",
  "(?:se |vous )?d[ée]sinscrire",
  "d[ée]sinscription",
  "d[ée]sabonnement",
  "ne plus recevoir",
  // de
  "abmelden",
  "abmeldung",
  "abbestellen",
  "newsletter abbestellen",
  "austragen",
  "keine (?:e-mails|newsletter) mehr",
  // it
  "annulla (?:l['’])?iscrizione",
  "annullare (?:l['’])?iscrizione",
  "cancella (?:l['’])?iscrizione",
  "cancellati",
  "disiscriviti",
  "disiscrizione",
  // pt
  "cancelar (?:a |sua )?(?:inscri[cç][aã]o|subscri[cç][aã]o|assinatura)",
  "descadastr(?:ar|e-se|ar-se)",
  "remover (?:inscri[cç][aã]o|meu e-?mail)",
  "anular (?:a )?subscri[cç][aã]o",
  "sair da lista",
  // nl
  "afmelden",
  "uitschrijven",
  "abonnement opzeggen",
  // pl
  "wypisz si[eę]",
  "wypisa[cć] si[eę]",
  "rezygnacja z subskrypcji",
  "zrezygnuj z subskrypcji",
  "anuluj subskrypcj[eę]",
  // sv
  "avregistrera",
  "avsluta prenumeration(?:en)?",
  "avprenumerera",
  "avanm[aä]l",
  // da / no
  "afmeld",
  "frameld",
  "afmelde",
  "meld (?:deg|dig) av",
  "avslutt abonnement(?:et)?",
  "avmelding",
  "avmeld",
  // fi
  "peruuta tilaus",
  "peru tilaus",
  "lopeta tilaus",
  "tilauksen peruutus",
  // cs / hu / ro / uk / el
  "odhl[aá]sit",
  "leiratkoz[aá]s",
  "dezabonare",
  "dezaboneaz[aă]",
  "відписатися",
  "διαγραφή",
  // ru / tr
  "отписаться",
  "отказаться от рассылки",
  "отписка",
  "abonelikten [cç][iı]k",
  "abonelikten ayr[iı]l",
  "listeden [cç][iı]k",
  "e-posta almak istemiyorum",
];

/** CJK phrases (no word boundaries). */
const UNSUBSCRIBE_CJK = [
  "配信停止",
  "購読停止",
  "配信解除",
  "購読解除",
  "メール配信の停止",
  "登録解除",
  "取消订阅",
  "退订",
  "取消訂閱",
  "退訂",
  "수신거부",
  "수신 거부",
  "구독 취소",
  "구독취소",
  "수신 해지",
  "수신해지",
];

export const UNSUBSCRIBE_RE = phraseRegex(UNSUBSCRIBE_SOURCES);
export const UNSUBSCRIBE_CJK_RE = phraseRegex(UNSUBSCRIBE_CJK, { boundary: false });

/** Link texts that only mean "unsubscribe" when the text around them says so. */
export const GENERIC_LINK_TEXT_RE =
  /^(?:click here|here|this link|aqu[ií]|haz clic aqu[ií]|ici|cliquez ici|hier|klicken sie hier|qui|clicca qui|aqui|clique aqui|hier klikken|tutaj|h[äa]r|her|t[äa]st[äa]|ここ|こちら|这里|點擊這裡|여기|здесь|buraya)$/iu;

/** Exact link texts that are an unsubscribe action on their own. */
export const EXACT_UNSUBSCRIBE_TEXT_RE =
  /^(?:baja|dar de baja|opt out|abmelden|afmelden|avregistrera)$/iu;

export function isUnsubscribeText(s: string): boolean {
  return UNSUBSCRIBE_RE.test(s) || UNSUBSCRIBE_CJK_RE.test(s);
}

/** Unsubscribe-like href (path or query keys), for footer markers. */
export const UNSUBSCRIBE_HREF_RE =
  /unsub|opt[-_]?out|optout|abmeld|desinscri|d%c3%a9sinscri|desabon|darse-de-baja|afmeld|avregistr|uitschrijv|remove-?me|stop-?email/i;

const PREFERENCES_SOURCES = [
  "(?:manage|update|change|edit|set) (?:your |my |email |e-mail |notification |subscription |communication )?(?:preferences|settings|subscriptions?)",
  "(?:e-?mail|notification|subscription|communication|newsletter) (?:preferences|settings)",
  "preference cent(?:er|re)",
  "preferences",
  "change how often",
  "email frequency",
  "manage (?:what|which) (?:emails|messages)",
  "preferencias",
  "pr[ée]f[ée]rences",
  "g[ée]rer (?:mes |vos )?(?:abonnements|pr[ée]f[ée]rences)",
  "einstellungen",
  "pr[aä]ferenzen",
  "newsletter-einstellungen",
  "preferenze",
  "prefer[êe]ncias",
  "voorkeuren",
  "preferencje",
  "ustawienia (?:powiadomie[nń]|subskrypcji)",
  "inst[aä]llningar",
  "preferenser",
  "pr[æa]ferencer",
  "indstillinger",
  "innstillinger",
  "preferanser",
  "asetukset",
  "настройки (?:рассылки|подписки|уведомлений)",
  "tercihler",
  "tercihlerini",
];
const PREFERENCES_CJK = [
  "配信設定",
  "メール設定",
  "偏好设置",
  "订阅设置",
  "訂閱設定",
  "수신 설정",
  "수신설정",
];

export const PREFERENCES_RE = phraseRegex(PREFERENCES_SOURCES);
export const PREFERENCES_CJK_RE = phraseRegex(PREFERENCES_CJK, { boundary: false });
export const PREFERENCES_HREF_RE =
  /preference|\/prefs\b|manage[-_]?subscription|subscription[-_]?cent|email[-_]?settings|notification[-_]?settings|\/profile\b/i;

export function isPreferencesText(s: string): boolean {
  return PREFERENCES_RE.test(s) || PREFERENCES_CJK_RE.test(s);
}

/** "You're receiving this because…" statements (DESIGN-SCORE U4 / footer marker). */
const RECEIVING_SOURCES = [
  "you(?:['’]re| are) receiving this",
  "you received this (?:e-?mail|message|newsletter|notification)",
  "you(?:['’]re| are) getting this (?:e-?mail|message)",
  "this (?:e-?mail|message|newsletter) (?:was|has been) sent to",
  "(?:e-?mail|message) (?:was )?sent to [^\\s]{1,80}@",
  "because you (?:signed up|subscribed|opted in|registered|created an account|are (?:a|an) (?:customer|member|subscriber|user)|made a purchase|have an account)",
  "you(?:['’]ve| have) (?:subscribed|signed up|opted in)",
  "you subscribed to",
  "why (?:did )?(?:i|you) (?:get|receive|receiving) this",
  "recibes este (?:correo|e-?mail|mensaje)",
  "has recibido este (?:correo|e-?mail|mensaje)",
  "este (?:correo|e-?mail|mensaje) (?:fue|ha sido) enviado a",
  "est[aá]s recibiendo este",
  "vous recevez (?:cet|ce) (?:e-?mail|message|courriel)",
  "cet (?:e-?mail|courriel) (?:a [ée]t[ée]|vous a [ée]t[ée]) envoy[ée]",
  "vous (?:[êe]tes|etes) inscrit",
  "sie erhalten diese (?:e-mail|nachricht|newsletter)",
  "du erh[aä]ltst diese",
  "diese (?:e-mail|nachricht) wurde an",
  "ricevi questa (?:e-?mail|comunicazione|newsletter)",
  "hai ricevuto questa",
  "questa e-?mail [èe] stata inviata a",
  "voc[êe] est[aá] recebendo (?:este|esta)",
  "recebeu (?:este|esta) (?:e-?mail|mensagem)",
  "este e-?mail foi enviado para",
  "je ontvangt deze",
  "u ontvangt deze",
  "deze e-?mail (?:is|werd) verzonden naar",
  "otrzymujesz t[eę] wiadomo[sś][cć]",
  "ta wiadomo[sś][cć] zosta[lł]a wys[lł]ana",
  "du f[aå]r (?:detta|dette|denne) (?:mejl|e-?post|nyhetsbrev|mail)",
  "(?:detta|dette) (?:mejl|e-?post(?:meddelande)?) (?:skickades|blev sendt) till",
  "saat t[aä]m[aä]n viestin",
  "вы получили это письмо",
  "вы получаете это письмо",
  "bu e-postay[iı] (?:al[iı]yorsunuz|ald[iı]n[iı]z)",
];
const RECEIVING_CJK = [
  "このメールは",
  "配信しています",
  "您收到此邮件",
  "您收到这封邮件",
  "此邮件发送至",
  "이 메일은",
  "본 메일은",
];

export const RECEIVING_RE = phraseRegex(RECEIVING_SOURCES);
export const RECEIVING_CJK_RE = phraseRegex(RECEIVING_CJK, { boundary: false });

export function hasReceivingStatement(s: string): boolean {
  return RECEIVING_RE.test(s) || RECEIVING_CJK_RE.test(s);
}

/** View-in-browser labels (excluded from CTA labels). */
export const VIEW_ONLINE_RE = phraseRegex([
  "view (?:this )?(?:e-?mail |message )?(?:in|on) (?:your |a )?(?:browser|web|web ?page)",
  "view (?:it )?online",
  "view as (?:a )?web ?page",
  "web version",
  "trouble viewing",
  "ver (?:en|no) (?:el )?navegador",
  "version en ligne",
  "im browser (?:ansehen|anzeigen|öffnen)",
  "visualizza (?:nel|sul) browser",
  "bekijk (?:in|online)",
]);

/** Security action link texts / hrefs (DESIGN.md §7.4). */
const SECURITY_LINK_TEXT: Array<[SecurityLinkKind, RegExp]> = [
  [
    "reset",
    phraseRegex([
      "reset (?:your |my )?password",
      "(?:choose|create|set) (?:a )?new password",
      "change (?:your |my )?password",
      "restablecer (?:tu |su |la )?contrase[nñ]a",
      "r[ée]initialiser (?:votre |mon |le )?mot de passe",
      "passwort (?:zur[uü]cksetzen|[aä]ndern)",
      "reimposta(?:re)? (?:la )?password",
      "redefinir (?:sua |a )?senha",
      "wachtwoord (?:opnieuw instellen|resetten|wijzigen)",
    ]),
  ],
  [
    "verify",
    phraseRegex([
      "verify (?:your |my |this )?(?:e-?mail|account|address|identity|device|login|sign[- ]?in)?",
      "confirm (?:your |my |this )?(?:e-?mail|account|address|subscription|identity|sign[- ]?up|registration)",
      "activate (?:your |my )?account",
      "(?:verificar|confirmar) (?:tu |su )?(?:correo|cuenta|e-?mail)",
      "(?:v[ée]rifier|confirmer) (?:votre |mon )?(?:adresse|compte|e-?mail)",
      "(?:e-?mail(?:-adresse)?|konto) (?:best[aä]tigen|verifizieren)",
      "best[aä]tigen",
      "conferma (?:il tuo |la tua )?(?:account|e-?mail|indirizzo)",
      "confirmar (?:seu |sua )?(?:e-?mail|conta)",
    ]),
  ],
  [
    "login",
    phraseRegex([
      "(?:sign|log) (?:me )?in(?: to [^\\n]{1,40})?",
      "(?:sign|log)-in",
      "magic link",
      "login link",
      "sign-?in link",
      "iniciar sesi[oó]n",
      "se connecter",
      "anmelden",
      "accedi",
      "entrar",
      "inloggen",
    ]),
  ],
  [
    "secure",
    phraseRegex([
      "secure (?:your |my )?account",
      "review (?:your )?(?:account )?(?:activity|devices|security)",
      "check (?:your )?(?:account )?activity",
      "(?:it )?wasn['’]t me",
      "(?:this )?(?:was|wasn['’]t) (?:not )?(?:you|me)",
      "not you\\??",
      "security (?:settings|checkup|check-?up)",
      "protect your account",
      "(?:proteger|asegurar) (?:tu |su )?cuenta",
      "s[ée]curiser (?:votre |mon )?compte",
      "konto sch[uü]tzen",
    ]),
  ],
];

const SECURITY_HREF: Array<[SecurityLinkKind, RegExp]> = [
  ["reset", /(?:reset|recover|forgot)[-_]?(?:password|pass|pwd)|password[-_/]?reset|\/reset\b/i],
  ["verify", /verif|confirm|activat|validate/i],
  [
    "login",
    /magic[-_]?link|login[-_]?link|\/(?:login|signin|sign-in|auth|sso)\b|otp|one[-_]?time/i,
  ],
  ["secure", /secur|recovery|activity|devices|signin-alert|account-alert/i],
];

/**
 * Security link kinds indicated by a link's text and its URL **path + query** (the host is
 * deliberately excluded: "secure.example.com" says nothing about the link's purpose).
 */
export function securityLinkKindsOf(textNorm: string, pathAndQuery: string): SecurityLinkKind[] {
  const kinds: SecurityLinkKind[] = [];
  for (const [kind, re] of SECURITY_LINK_TEXT) if (re.test(textNorm)) kinds.push(kind);
  if (pathAndQuery.length > 0) {
    const h = pathAndQuery.slice(0, 1024);
    for (const [kind, re] of SECURITY_HREF)
      if (!kinds.includes(kind) && re.test(h)) kinds.push(kind);
  }
  return kinds;
}
