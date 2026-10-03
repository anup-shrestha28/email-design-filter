/**
 * Environment (FREE-TIER.md §11 step 8) with boot checks (§11 step 9, §1.3 rule 7).
 * Parsed lazily on first use so that static public pages build without secrets.
 */
import "server-only";
import { z } from "zod";
import { isHostedProduction } from "@edf/budget";

const isProd = process.env.NODE_ENV === "production";
const onVercel = Boolean(process.env.VERCEL);

/** In production every secret is required; locally some have safe development fallbacks. */
const req = (s: z.ZodString) => (isProd ? s : s.optional());

const schema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRETS: req(z.string().min(20)),
  GOOGLE_LOGIN_CLIENT_ID: req(z.string().min(10)),
  GOOGLE_LOGIN_CLIENT_SECRET: req(z.string().min(10)),
  GOOGLE_CONNECTOR_CLIENT_ID: req(z.string().min(10)),
  GOOGLE_CONNECTOR_CLIENT_SECRET: req(z.string().min(10)),
  APP_ORIGIN: z.string().url(),
  VIEW_ORIGIN: z.string().url(),
  /** edf-keys service (FREE-TIER.md §9.2). Absent locally → LocalKeyWrapper (development only). */
  KEYS_ORIGIN: req(z.string().url()),
  KEYS_AUD: req(z.string().min(3)),
  /** https://oidc.vercel.com/<team> (Team issuer mode). */
  OIDC_ISSUER: req(z.string().url()),
  VIEW_OIDC_SUB: req(z.string().startsWith("owner:")),
  KEYS_OIDC_SUB: req(z.string().startsWith("owner:")),
  /** Audiences edf-app accepts on its machine-to-machine endpoints. */
  VIEW_SOURCE_AUD: req(z.string().min(3)),
  VIEW_STATS_AUD: req(z.string().min(3)),
  KEYS_AUDIT_AUD: req(z.string().min(3)),
  VIEW_KEYS: req(z.string().min(10)),
  OUT_KEYS: req(z.string().min(10)),
  STATE_KEYS: req(z.string().min(10)),
  INVITE_KEYS: req(z.string().min(10)),
  ACCESS_TOKEN_KEYS: req(z.string().min(10)),
  IMG_SIGNING_KEYS: req(z.string().min(10)),
  INNGEST_SIGNING_KEY: req(z.string().min(10)),
  INNGEST_SIGNING_KEY_FALLBACK: z.string().optional(),
  INNGEST_EVENT_KEY: req(z.string().min(10)),
  /**
   * Read by the Inngest SDK itself: the URL it registers and Inngest calls. Standard Deployment
   * Protection answers 401 on generated deployment URLs, so production pins it to APP_ORIGIN, the
   * public production domain (boot check below; docs/SETUP.md step 5).
   */
  INNGEST_SERVE_ORIGIN: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CRON_SECRET: req(z.string().min(24)),
  TICK_EVERY: z.enum(["30", "60"]).default("30"),
  SANDBOX_SNAPSHOT_ID: z.string().optional(),
  GITHUB_ALERT_TOKEN: z.string().optional(),
  GITHUB_ALERT_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  /** Renderer driver: "sandbox" in production; "local" (puppeteer + CHROME_PATH) in development. */
  RENDERER: z.enum(["sandbox", "local", "off"]).default(isProd ? "sandbox" : "local"),
  CHROME_PATH: z.string().optional(),
  /** Development-only conveniences (refused in production by the boot checks). */
  EDF_DEV_LOGIN: z.enum(["0", "1"]).default("0"),
  DEV_LOCAL_KEK: z.string().optional(),
  /**
   * "1": meter Vercel, Neon and Inngest usage off Vercel too, as if this were production (testing
   * the governor locally). Default "0": off Vercel none of it is recorded (@edf/budget platform.ts,
   * which reads it from process.env; packages/budget/DECISIONS.md "Local development"). On Vercel,
   * and in any production build whose database isn't on this machine, everything is metered either
   * way; there is no setting that turns that off.
   */
  EDF_METER_LOCAL: z.enum(["0", "1"]).default("0"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${fields}`);
  }
  bootChecks(parsed.data);
  cached = parsed.data;
  return cached;
}

/** FREE-TIER.md §11 step 9 boot checks that don't need the network or the database. */
function bootChecks(e: Env): void {
  if (!isProd) return;
  const problems: string[] = [];
  // No Vercel API token in any runtime environment (§1.3 rule 7). VERCEL_OIDC_TOKEN is not an API token.
  for (const name of Object.keys(process.env)) {
    if (/VERCEL/i.test(name) && /TOKEN/i.test(name) && name !== "VERCEL_OIDC_TOKEN") problems.push(`forbidden ${name}`);
  }
  // A deployment (production build, database not on this machine) must see Vercel's system
  // variables: `VERCEL` exists only while the project's "Automatically expose System Environment
  // Variables" setting is on, and the pool's suspend handling, the Inngest origin check below and the
  // local-renderer refusal read it. (Usage is metered either way: @edf/budget platform.ts.)
  if (!onVercel && isHostedProduction(process.env))
    problems.push(
      "VERCEL is not set: in the Vercel project, Settings → Environment Variables, turn on \"Automatically expose System Environment Variables\" and redeploy",
    );
  if (process.env.INNGEST_DEV) problems.push("INNGEST_DEV must be unset in production");
  if (e.EDF_DEV_LOGIN === "1") problems.push("EDF_DEV_LOGIN must be 0 in production");
  if (e.DEV_LOCAL_KEK) problems.push("DEV_LOCAL_KEK must not be set in production");
  if (process.env.TOKEN_KEKS) problems.push("edf-app must not hold the KEK (TOKEN_KEKS)");
  if (e.RENDERER === "local" && onVercel) problems.push("RENDERER=local is not allowed on Vercel");
  if (new URL(e.APP_ORIGIN).origin === new URL(e.VIEW_ORIGIN).origin) problems.push("APP_ORIGIN and VIEW_ORIGIN must differ");
  if (!e.APP_ORIGIN.startsWith("https://") || !e.VIEW_ORIGIN.startsWith("https://")) problems.push("origins must be https");
  // Only the production deployment is connected to Inngest (FREE-TIER.md §11 step 4).
  if (onVercel && process.env.VERCEL_ENV === "production") {
    if (!e.INNGEST_SERVE_ORIGIN) problems.push("INNGEST_SERVE_ORIGIN must be set to APP_ORIGIN");
    else if (new URL(e.INNGEST_SERVE_ORIGIN).origin !== new URL(e.APP_ORIGIN).origin) problems.push("INNGEST_SERVE_ORIGIN must equal APP_ORIGIN");
  }
  if (problems.length) throw new Error(`Boot checks failed: ${problems.join("; ")}`);
}

/**
 * A renderer is set up: not `RENDERER=off`, and the Sandbox renderer has its snapshot. Without one
 * nothing can render (server/pipeline-deps.ts `makeRenderer` returns none), so "Analyze" refuses
 * instead of queueing a request no VM would ever take, and the gallery says scoring is off.
 */
export function rendererSetUp(e: Env = env()): boolean {
  if (e.RENDERER === "off") return false;
  return e.RENDERER !== "sandbox" || Boolean(e.SANDBOX_SNAPSHOT_ID);
}

export const IS_PROD = isProd;
