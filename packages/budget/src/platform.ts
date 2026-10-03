/**
 * Where platform usage is real (packages/budget/DECISIONS.md, "Local development: platform usage
 * is metered only on the platform"). The meter and every direct ledger writer record a platform's
 * resources only when this process really uses that platform, so `pnpm dev` on a laptop (local
 * Postgres, the Inngest Dev Server, browser automation, scripts) never hands the governor usage
 * that Vercel, Neon or Inngest never saw.
 *
 *  - Vercel (`vercel.*`: Active CPU, invocations, provisioned memory, Fast Origin Transfer, and
 *    edf-view's reported traffic): only on Vercel.
 *  - Neon (`neon.*`, and the awake minutes in `neon_awake`): on Vercel (production's database is
 *    Neon), or when `DATABASE_URL` points at a Neon host (`*.neon.tech`).
 *  - Inngest (`inngest.*`): on Vercel, or whenever the SDK is not using the Inngest Dev Server
 *    (`INNGEST_DEV` unset or false: requests then come from Inngest Cloud, which bills them).
 *  - `EDF_METER_LOCAL=1` meters all three wherever the code runs (testing the governor locally).
 *
 * "On Vercel" fails safe: it is `VERCEL` being set **or** a production build (`NODE_ENV=production`)
 * whose database is not on this machine (`isHostedProduction`). Vercel sets `VERCEL` only while the
 * project's "Automatically expose System Environment Variables" setting is on; with it off, a
 * deployment that relied on `VERCEL` alone would record no Vercel usage at all and the governor
 * would never throttle. A production deployment always has a remote (Neon) database, so it is
 * metered either way (and edf-app's boot checks refuse to start it without `VERCEL`, naming the
 * setting). `next build && next start` on a laptop against the local Postgres (loopback host) is
 * NODE_ENV=production too, and stays unmetered like `pnpm dev`: no usage Vercel never saw. There is
 * deliberately no switch that turns metering off: one copied into a Vercel project by mistake would
 * be the silent failure this rule exists to prevent.
 *
 * Everything else is real or app-level usage wherever the code runs and is always recorded:
 * Sandbox VMs (`sandbox.*`), Anthropic spend, Gmail units, `keys.*`, `backfill.*`,
 * `view.unsignable_urls`.
 */

export interface PlatformMetering {
  vercel: boolean;
  neon: boolean;
  inngest: boolean;
}
export type Platform = keyof PlatformMetering;

/** Every platform metered: what Vercel always gets, and what `EDF_METER_LOCAL=1` restores locally. */
export const ALL_PLATFORMS: Readonly<PlatformMetering> = Object.freeze({
  vercel: true,
  neon: true,
  inngest: true,
});

/** The opt-in that meters every platform off Vercel too ("1"; anything else: off). */
export const METER_LOCAL_ENV = "EDF_METER_LOCAL";

type Env = Readonly<Record<string, string | undefined>>;

/** Which platforms this process meters, from its environment (rules above). */
export function platformMetering(env: Env = process.env): PlatformMetering {
  if (env.VERCEL || env[METER_LOCAL_ENV] === "1" || isHostedProduction(env)) return { ...ALL_PLATFORMS };
  return {
    vercel: false,
    neon: isNeonDatabaseUrl(env.DATABASE_URL),
    inngest: !usesInngestDevServer(env.INNGEST_DEV),
  };
}

/**
 * A production build that is not running on the owner's machine: `NODE_ENV=production` and a
 * `DATABASE_URL` that isn't a loopback address. Every Vercel deployment of edf-app matches (its
 * database is Neon), whether or not Vercel exposes `VERCEL`; a local `next start` against the
 * Docker Postgres (`localhost`) doesn't. Unset or unparsable `DATABASE_URL` counts as hosted (the
 * safe side: metered).
 */
export function isHostedProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" && !isLoopbackDatabaseUrl(env.DATABASE_URL);
}

/**
 * The database is on this machine: `localhost` (or `*.localhost`), `127.0.0.0/8`, `::1`, or no host
 * at all (a Unix socket). Never true for a deployment: Vercel functions have no local Postgres.
 */
export function isLoopbackDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** The database is a Neon endpoint (`ep-….<region>.aws.neon.tech`, pooled or direct). */
export function isNeonDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "neon.tech" || host.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

/**
 * The Inngest SDK talks to the Dev Server, read as the SDK (v4 `Inngest.mode`) reads `INNGEST_DEV`:
 * "1" / "true" or a URL select the Dev Server; "0" / "false", empty or unset select Inngest Cloud.
 */
export function usesInngestDevServer(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "undefined" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  try {
    new URL(value.includes("://") ? value : `http://${value}`);
    return true;
  } catch {
    return false;
  }
}

/** The platform whose usage a resource code measures (`vercel.*`, `neon.*`, `inngest.*`), else null. */
export function platformOf(resource: string): Platform | null {
  const prefix = resource.slice(0, Math.max(0, resource.indexOf(".")));
  return prefix === "vercel" || prefix === "neon" || prefix === "inngest" ? prefix : null;
}

/** Whether a resource is recorded under these settings (codes of no platform always are). */
export function isMetered(platforms: PlatformMetering, resource: string): boolean {
  const p = platformOf(resource);
  return p === null || platforms[p];
}
