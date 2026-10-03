/**
 * Minimal iCalendar reader: METHOD and the first VEVENT's DTSTART, as an instant. Only the
 * first 64 KB are read; everything is bounded and failure-tolerant (returns nulls).
 */

const MAX_CALENDAR_BYTES = 64 * 1024;

/** Common Outlook/Windows TZIDs → IANA (Outlook invites use Windows names). */
const WINDOWS_TZ: Record<string, string> = {
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "atlantic standard time": "America/Halifax",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Paris",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kiev",
  "gtb standard time": "Europe/Bucharest",
  "russian standard time": "Europe/Moscow",
  "turkey standard time": "Europe/Istanbul",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "singapore standard time": "Asia/Singapore",
  "aus eastern standard time": "Australia/Sydney",
  "e. south america standard time": "America/Sao_Paulo",
  utc: "UTC",
};

export interface CalendarInfo {
  method: string | null;
  start: Date | null;
}

/** Offset (minutes, east positive) of `timeZone` at the given UTC instant; throws on bad zones. */
function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return Math.round((asUtc - utcMs) / 60000);
}

/** Wall-clock time in a zone → UTC instant (two-pass for DST edges). */
function zonedToUtc(
  fields: [number, number, number, number, number, number],
  tzid: string,
): number {
  const wall = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
  const zone = WINDOWS_TZ[tzid.toLowerCase()] ?? tzid;
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - zoneOffsetMinutes(guess, zone) * 60000;
  return guess;
}

function parseDtstart(line: string): Date | null {
  // DTSTART[;params]:YYYYMMDD[THHMMSS[Z]]
  const m = /^DTSTART((?:;[^:]{0,200})?):(\d{8})(?:T(\d{6})(Z)?)?\s*$/i.exec(line);
  if (!m) return null;
  const params = m[1] ?? "";
  const d = m[2] ?? "";
  const t = m[3] ?? "000000";
  const fields: [number, number, number, number, number, number] = [
    Number(d.slice(0, 4)),
    Number(d.slice(4, 6)),
    Number(d.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
  ];
  if (fields[1] < 1 || fields[1] > 12 || fields[2] < 1 || fields[2] > 31) return null;
  let ms: number;
  const tzid = /;TZID=("?)([^;:"]{1,64})\1/i.exec(params)?.[2];
  if (m[4] || !tzid) {
    ms = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
  } else {
    try {
      ms = zonedToUtc(fields, tzid.trim());
    } catch {
      ms = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
    }
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Reads METHOD and the first VEVENT DTSTART from a text/calendar part. */
export function parseCalendar(bytes: Uint8Array): CalendarInfo {
  const info: CalendarInfo = { method: null, start: null };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, MAX_CALENDAR_BYTES));
  } catch {
    return info;
  }
  // Unfold (RFC 5545 §3.1): CRLF followed by a space or tab continues the previous line.
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  let inEvent = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.length > 1000) continue;
    const upper = line.slice(0, 16).toUpperCase();
    if (upper.startsWith("METHOD:") && info.method === null) {
      const v = line.slice(7).trim().toUpperCase();
      if (/^[A-Z-]{1,32}$/.test(v)) info.method = v;
    } else if (upper === "BEGIN:VEVENT") {
      inEvent = true;
    } else if (upper === "END:VEVENT") {
      if (info.start) break;
      inEvent = false;
    } else if (inEvent && info.start === null && upper.startsWith("DTSTART")) {
      info.start = parseDtstart(line);
    }
  }
  return info;
}
