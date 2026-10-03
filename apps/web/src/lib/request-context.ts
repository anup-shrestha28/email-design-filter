import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { withUser } from "@edf/db";
import { getPool } from "@/server/db";

const TZ_COOKIE = "edf-tz";

/**
 * The value user_settings.timezone starts with (its column default), which means "not chosen":
 * dates then follow the device's own zone (the edf-tz cookie). Someone who wants UTC itself picks
 * "Etc/UTC" in Settings (shown as "UTC"), which is a real choice and overrides the device.
 */
export const AUTOMATIC_TIME_ZONE = "UTC";

function validTimeZone(tz: string | undefined): string | null {
  if (!tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * English UI, so dates use an English locale: the browser's own en-* variant when it has one,
 * otherwise en-GB (day-month order, 24-hour clock, like most of the world).
 */
function pickLocale(acceptLanguage: string | null): string {
  const first = acceptLanguage?.split(",")[0]?.split(";")[0]?.trim() ?? "";
  if (/^en(-[A-Za-z]{2})?$/.test(first)) {
    try {
      return Intl.DateTimeFormat.supportedLocalesOf([first])[0] ?? "en-US";
    } catch {
      return "en-US";
    }
  }
  return first ? "en-GB" : "en-US";
}

/**
 * The zone dates render in: the zone chosen in Settings, or (while it is still "Automatic") the zone
 * this device reported, or UTC before the device has reported one.
 */
export function effectiveTimeZone(saved: string | null | undefined, device: string | null | undefined): string {
  const chosen = saved === AUTOMATIC_TIME_ZONE ? null : validTimeZone(saved ?? undefined);
  return chosen ?? validTimeZone(device ?? undefined) ?? "UTC";
}

/** The signed-in user's saved time zone; null when it can't be read (dates then follow the device). */
async function savedTimeZone(userId: string): Promise<string | null> {
  try {
    const pool = await getPool();
    return await withUser(pool, userId, async (_db, client) => {
      const r = await client.query<{ timezone: string }>("SELECT timezone FROM user_settings WHERE user_id = $1", [userId]);
      return r.rows[0]?.timezone ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * The zone this request shows dates in — the same rule as requestContext's `clock.timeZone`: the
 * zone chosen in Settings, or while that is "Automatic" the zone this device reported (edf-tz), or
 * UTC. The gallery's "Pick dates" reads days in it, so a picked day holds exactly the cards dated
 * that day. Outside a request (no cookies) it's the saved zone alone. Once per request.
 */
export const requestTimeZone = cache(async (userId: string): Promise<string> => {
  const device = async () => {
    try {
      return (await cookies()).get(TZ_COOKIE)?.value ?? null;
    } catch {
      return null; // not in a request (a script or test): no device to follow
    }
  };
  const [reported, saved] = await Promise.all([device(), savedTimeZone(userId)]);
  return effectiveTimeZone(saved, reported);
});

/**
 * Values every dynamic page needs to render: CSP nonce, date locale/time zone, request time.
 * With `userId`, dates use that user's saved time zone (Settings → Time zone) unless it is
 * "Automatic". `deviceTimeZone` is the zone the browser last reported, for TimeZoneSync.
 */
export async function requestContext(userId?: string): Promise<{
  nonce: string | undefined;
  clock: { serverNow: number; locale: string; timeZone: string; zoneKnown: boolean };
  deviceTimeZone: string;
}> {
  const [h, c, saved] = await Promise.all([headers(), cookies(), userId ? savedTimeZone(userId) : null]);
  const reported = validTimeZone(c.get(TZ_COOKIE)?.value);
  const device = reported ?? "UTC";
  const chosen = saved === AUTOMATIC_TIME_ZONE ? null : validTimeZone(saved ?? undefined);
  return {
    nonce: h.get("x-nonce") ?? undefined,
    clock: {
      serverNow: Date.now(),
      locale: pickLocale(h.get("accept-language")),
      timeZone: effectiveTimeZone(saved, device),
      // False when the zone is only the UTC fallback (a device that hasn't reported its zone yet):
      // times then wait for the browser's own zone instead of showing UTC and jumping.
      zoneKnown: chosen !== null || reported !== null,
    },
    deviceTimeZone: device,
  };
}
