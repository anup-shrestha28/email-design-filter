/**
 * Offer-expiry and deadline dates (DESIGN.md §7.7 step 3, §7.5 "deal or deadline within 48h").
 *
 * Relative phrases are anchored to the email's receipt time in the sender's timezone (taken from
 * the Date header offset), never to processing time. chrono-node only runs on short windows after
 * expiry/deadline keywords, which keeps CPU low and avoids picking up unrelated dates.
 */
import * as chrono from "chrono-node";

export interface DateCandidate {
  at: Date;
  /** 0..1 */
  confidence: number;
  /** Character offset in the scanned text (for associating expiries with nearby deals). */
  index: number;
  source: "phrase" | "chrono";
}

export interface DateContext {
  receivedAt: Date;
  /** Sender timezone offset in minutes (east positive). */
  tzOffsetMinutes: number;
  language: string | null;
  /** Use day-first numeric dates (UK/AU/NZ/IE/IN/ZA senders). */
  dayFirst: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Plausible range for offer/deadline dates relative to receipt. */
const MAX_AHEAD_MS = 180 * DAY;
const MAX_WINDOWS = 12;

/** End of the local calendar day containing `instant` (+ `addDays`), as a UTC instant. */
export function endOfLocalDay(instant: Date, tzOffsetMinutes: number, addDays = 0): Date {
  const local = new Date(instant.getTime() + tzOffsetMinutes * 60_000);
  const end = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + addDays,
    23,
    59,
    59,
  );
  return new Date(end - tzOffsetMinutes * 60_000);
}

function endOfComponentsDay(y: number, m: number, d: number, tzOffsetMinutes: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59) - tzOffsetMinutes * 60_000);
}

/** Days until the coming Sunday (0 when today is Sunday) in the sender's timezone. */
function daysToSunday(instant: Date, tzOffsetMinutes: number): number {
  const local = new Date(instant.getTime() + tzOffsetMinutes * 60_000);
  return (7 - local.getUTCDay()) % 7;
}

function inRange(at: Date, ctx: DateContext): boolean {
  const t = at.getTime();
  const r = ctx.receivedAt.getTime();
  return t >= r - HOUR && t <= r + MAX_AHEAD_MS;
}

type PhraseRule = [RegExp, (m: RegExpExecArray, ctx: DateContext) => Date | null, number];

const HOURS_WORD =
  "(?:hours?|hrs?|horas?|heures?|stunden|ore|uur|timmar|timer|tuntia|часов|часа|saat)";
const DAYS_WORD =
  "(?:days?|d[ií]as|jours|tage|giorni|dias|dagen|dagar|dage|dager|päivää|дней|дня|gün)";

/** Relative-expiry phrase table (multilingual where cheap). Each regex is bounded. */
const PHRASES: readonly PhraseRule[] = [
  [
    /(?:ends?|ending|expires?|over|finishes|closes?) (?:at )?(?:tonight|midnight|today|at midnight tonight)|(?:tonight|today) only|only today|last day|final day|until midnight|till midnight|by midnight|midnight tonight|ends tonight|termina (?:hoy|esta noche)|s[oó]lo hoy|[uú]ltimo d[ií]a|hasta (?:la )?medianoche|(?:se termine|finit) (?:ce soir|aujourd['’]hui)|dernier jour|aujourd['’]hui seulement|jusqu['’][àa] minuit|endet heute(?: nacht)?|nur heute|letzter tag|bis mitternacht|termina (?:stasera|oggi)|ultimo giorno|solo oggi|fino a mezzanotte|termina hoje|s[oó] hoje|somente hoje|at[eé] meia-noite|eindigt (?:vandaag|vanavond)|laatste dag|alleen vandaag|tot middernacht|本日限り|本日まで|今日まで|本日終了|今夜まで|今天结束|仅限今天|今晚截止|오늘까지|오늘 마감|только сегодня|последний день/iu,
    (_m, ctx) => endOfLocalDay(ctx.receivedAt, ctx.tzOffsetMinutes, 0),
    0.75,
  ],
  [
    /(?:ends?|ending|expires?|over) tomorrow|until tomorrow|last chance[:,]? tomorrow|termina ma[nñ]ana|se termine demain|endet morgen|termina domani|termina amanh[aã]|eindigt morgen|明日まで|明天结束|내일까지/iu,
    (_m, ctx) => endOfLocalDay(ctx.receivedAt, ctx.tzOffsetMinutes, 1),
    0.7,
  ],
  [
    new RegExp(
      `(?:only|next|final|last|for|in|ends in|just) (\\d{1,3}) ?${HOURS_WORD}|(\\d{1,3}) ?${HOURS_WORD} (?:only|left|to go|remaining|sale|flash)|(\\d{1,3})[- ]hour (?:sale|flash|event|deal|offer|window)|(?:solo|seulement|nur|solo|apenas|alleen) (\\d{1,3}) ?${HOURS_WORD}|(\\d{1,3})時間限定`,
      "iu",
    ),
    (m, ctx) => {
      const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
      return n >= 1 && n <= 168 ? new Date(ctx.receivedAt.getTime() + n * HOUR) : null;
    },
    0.7,
  ],
  [
    new RegExp(
      `(?:only|next|final|last|ends in|just) (\\d{1,2}) ?${DAYS_WORD}|(\\d{1,2}) ?${DAYS_WORD} (?:only|left|to go|remaining)`,
      "iu",
    ),
    (m, ctx) => {
      const n = Number(m[1] ?? m[2]);
      return n >= 1 && n <= 60 ? endOfLocalDay(ctx.receivedAt, ctx.tzOffsetMinutes, n) : null;
    },
    0.6,
  ],
  [
    /this weekend(?: only)?|weekend only|all weekend|ends sunday|este fin de semana|ce week-end|dieses wochenende|questo weekend|neste fim de semana|dit weekend/iu,
    (_m, ctx) =>
      endOfLocalDay(
        ctx.receivedAt,
        ctx.tzOffsetMinutes,
        daysToSunday(ctx.receivedAt, ctx.tzOffsetMinutes),
      ),
    0.6,
  ],
  [
    /this week only|ends this week|esta semana solamente|cette semaine seulement|nur diese woche/iu,
    (_m, ctx) =>
      endOfLocalDay(
        ctx.receivedAt,
        ctx.tzOffsetMinutes,
        daysToSunday(ctx.receivedAt, ctx.tzOffsetMinutes),
      ),
    0.5,
  ],
  [
    /last chance|final hours|ending soon|almost over|hours left|don['’]t miss out|[uú]ltima oportunidad|derni[èe]re chance|letzte chance|ultima occasione|[uú]ltima chance|laatste kans/iu,
    (_m, ctx) => new Date(ctx.receivedAt.getTime() + 24 * HOUR),
    0.4,
  ],
];

/** Finds relative expiry phrases. */
export function findPhraseExpiries(textNorm: string, ctx: DateContext): DateCandidate[] {
  const out: DateCandidate[] = [];
  for (const [re, fn, confidence] of PHRASES) {
    const m = re.exec(textNorm);
    if (!m) continue;
    const at = fn(m, ctx);
    if (at && inRange(at, ctx)) out.push({ at, confidence, index: m.index, source: "phrase" });
  }
  return out;
}

type ChronoParser = { parse: typeof chrono.parse };

function parserFor(ctx: DateContext): ChronoParser {
  switch (ctx.language) {
    case "es":
      return chrono.es.casual;
    case "fr":
      return chrono.fr.casual;
    case "de":
      return chrono.de.casual;
    case "it":
      return chrono.it.casual;
    case "pt":
      return chrono.pt.casual;
    case "nl":
      return chrono.nl.casual;
    case "ja":
      return chrono.ja.casual;
    case "zh":
      return chrono.zh.casual;
    case "ru":
      return chrono.ru.casual;
    case "sv":
      return chrono.sv.casual;
    case "fi":
      return chrono.fi.casual;
    case "uk":
      return chrono.uk.casual;
    default:
      return ctx.dayFirst ? chrono.en.GB : chrono.casual;
  }
}

/** Offer-expiry keywords; the date is expected right after them. */
export const EXPIRY_KEYWORDS_RE =
  /(?<![\p{L}\p{N}])(?:ends?|ending|expires?|expiring|expiration|valid (?:until|through|thru|till)|good (?:until|through|thru)|available (?:until|through)|until|through|thru|till|termina|hasta|v[aá]lid[oa] hasta|jusqu['’]au|valable jusqu['’]au|se termine|g[uü]ltig bis|endet|bis zum|fino al|valid[oa] fino al|scade|at[eé]|v[aá]lid[oa] at[eé]|geldig tot|t\/m|ważn[ey] do|g[aä]ller till)(?![\p{L}\p{N}])/giu;

/** Deadline keywords (payment due, event start, renewal, trial end…). */
export const DEADLINE_KEYWORDS_RE =
  /(?<![\p{L}\p{N}])(?:payment due|amount due|due (?:date|on|by)|due|pay by|deadline|expires on|expiring on|expiration date|renews? on|renewal date|trial ends?(?: on)?|starts? (?:on|at)|begins? (?:on|at)|join us (?:on|at)|live on|takes place on|when:|fecha l[ií]mite|vence(?: el)?|vencimiento|[ée]ch[ée]ance|date limite|f[aä]llig(?: am)?|zahlbar bis|scadenza|vencimento|vervaldatum|termin p[lł]atno[sś]ci|f[oö]rfallodag)(?![\p{L}\p{N}])\s?:?/giu;

/**
 * Runs chrono on short windows after each keyword match. Date-only results mean "end of that
 * day" in the sender's timezone; "midnight" at 00:00 means the end of that day (how marketers
 * use it), so offers aren't treated as expired a day early.
 */
export function findKeywordDates(
  text: string,
  keywordRe: RegExp,
  ctx: DateContext,
  confidence: number,
): DateCandidate[] {
  const out: DateCandidate[] = [];
  const parser = parserFor(ctx);
  const ref = { instant: ctx.receivedAt, timezone: ctx.tzOffsetMinutes };
  keywordRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  let windows = 0;
  while ((m = keywordRe.exec(text)) !== null && windows < MAX_WINDOWS) {
    if (m[0].length === 0) {
      keywordRe.lastIndex++;
      continue;
    }
    windows++;
    const start = m.index + m[0].length;
    // A date never spans lines ("ends Sunday\n20% off" must not become Sunday 20:00).
    const raw = text.slice(start, start + 48);
    const nl = raw.indexOf("\n");
    const window = nl >= 0 ? raw.slice(0, nl) : raw;
    let results: chrono.ParsedResult[];
    try {
      results = parser.parse(window, ref, { forwardDate: true });
    } catch {
      continue;
    }
    const r = results[0];
    if (!r || r.index > 6) continue;
    let at: Date;
    const s = r.start;
    const y = s.get("year");
    const mo = s.get("month");
    const d = s.get("day");
    if (y === null || mo === null || d === null) continue;
    if (!s.isCertain("hour")) {
      at = endOfComponentsDay(y, mo, d, ctx.tzOffsetMinutes);
    } else if (
      s.get("hour") === 0 &&
      (s.get("minute") ?? 0) === 0 &&
      /midnight|minuit|mitternacht|medianoche|mezzanotte|meia-noite|middernacht/i.test(
        r.text + window,
      )
    ) {
      at = endOfComponentsDay(y, mo, d, ctx.tzOffsetMinutes);
    } else {
      at = r.date();
    }
    if (Number.isNaN(at.getTime()) || !inRange(at, ctx)) continue;
    out.push({ at, confidence, index: m.index, source: "chrono" });
  }
  return out;
}

/** Parses an ISO-8601-ish schema.org date; null when invalid. */
export function parseSchemaDate(v: string | undefined): Date | null {
  if (!v || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
