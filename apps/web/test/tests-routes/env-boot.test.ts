/**
 * src/env.ts in production mode (FREE-TIER.md §11 step 9, §1.3 rule 7): every secret required,
 * and the boot checks refuse Vercel API tokens, Inngest dev mode, development conveniences, the KEK,
 * local rendering on Vercel, a shared app/view origin, non-https origins, and a deployment that
 * can't see Vercel's system variables (`VERCEL` unset: the project's "Automatically expose System
 * Environment Variables" setting is off). Errors name fields and
 * rules only — never values. Each case re-imports the module with NODE_ENV=production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s3cr3t-value-that-must-never-appear-in-errors";

const PROD: Record<string, string> = {
  NODE_ENV: "production",
  // A Vercel deployment with its System Environment Variables exposed (the default).
  VERCEL: "1",
  DATABASE_URL: "postgres://app_rw:pw@db.example:5432/edf",
  BETTER_AUTH_URL: "https://app.example",
  BETTER_AUTH_SECRETS: `1:${SECRET}`,
  GOOGLE_LOGIN_CLIENT_ID: "login-client-id.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: SECRET,
  GOOGLE_CONNECTOR_CLIENT_ID: "connector-client-id.apps.googleusercontent.com",
  GOOGLE_CONNECTOR_CLIENT_SECRET: SECRET,
  APP_ORIGIN: "https://app.example",
  VIEW_ORIGIN: "https://edf-view.example",
  KEYS_ORIGIN: "https://edf-keys.example",
  KEYS_AUD: "https://vercel.com/team",
  OIDC_ISSUER: "https://oidc.vercel.com/team",
  VIEW_OIDC_SUB: "owner:team:project:edf-view:environment:production",
  KEYS_OIDC_SUB: "owner:team:project:edf-keys:environment:production",
  VIEW_SOURCE_AUD: "https://vercel.com/team",
  VIEW_STATS_AUD: "https://vercel.com/team",
  KEYS_AUDIT_AUD: "https://vercel.com/team",
  VIEW_KEYS: `{"k1":"${SECRET}"}`,
  OUT_KEYS: `{"k1":"${SECRET}"}`,
  STATE_KEYS: `{"k1":"${SECRET}"}`,
  INVITE_KEYS: `{"k1":"${SECRET}"}`,
  ACCESS_TOKEN_KEYS: `{"k1":"${SECRET}"}`,
  IMG_SIGNING_KEYS: `{"k1":"${SECRET}"}`,
  INNGEST_SIGNING_KEY: `signkey-prod-${SECRET}`,
  INNGEST_EVENT_KEY: `event-${SECRET}`,
  CRON_SECRET: `${SECRET}-cron`,
};

/** Development-only variables apps/web/.env.local may hold; unset for a production boot. */
const DEV_ONLY = ["EDF_DEV_LOGIN", "DEV_LOCAL_KEK", "RENDERER", "CHROME_PATH", "INNGEST_DEV", "TOKEN_KEKS", "VERCEL", "VERCEL_ENV"];

async function boot(over: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (/VERCEL/i.test(k) && /TOKEN/i.test(k)) vi.stubEnv(k, undefined);
  for (const k of DEV_ONLY) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ ...PROD, ...over })) vi.stubEnv(k, v);
  const m = await import("@/env");
  return { m, run: () => m.env() };
}

async function bootError(over: Record<string, string | undefined>): Promise<string> {
  const { run } = await boot(over);
  let msg = "";
  try {
    run();
  } catch (err) {
    msg = (err as Error).message;
  }
  expect(msg, JSON.stringify(Object.keys(over))).not.toBe("");
  expect(msg).not.toContain(SECRET);
  return msg;
}

describe("env() in production", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("boots with a complete production environment (sandbox renderer by default)", async () => {
    const { m, run } = await boot();
    expect(m.IS_PROD).toBe(true);
    const e = run();
    expect(e.RENDERER).toBe("sandbox");
    expect(e.EDF_DEV_LOGIN).toBe("0");
    // VERCEL_OIDC_TOKEN is the function's own identity, not an API token.
    const { run: run2 } = await boot({ VERCEL_OIDC_TOKEN: "eyJ.test.token", VERCEL: "1" });
    expect(() => run2()).not.toThrow();
  });

  it("every secret is required: a missing one names the field, not a value", async () => {
    for (const k of ["BETTER_AUTH_SECRETS", "CRON_SECRET", "STATE_KEYS", "OIDC_ISSUER", "KEYS_ORIGIN", "INNGEST_SIGNING_KEY", "VIEW_OIDC_SUB"]) {
      expect(await bootError({ [k]: undefined })).toBe(`Invalid environment: ${k}`);
    }
    expect(await bootError({ CRON_SECRET: "too-short" })).toBe("Invalid environment: CRON_SECRET");
    expect(await bootError({ VIEW_OIDC_SUB: "project:edf-view" })).toBe("Invalid environment: VIEW_OIDC_SUB");
  });

  it.each([
    ["a Vercel API token", { VERCEL_TOKEN: "x" }, "forbidden VERCEL_TOKEN"],
    ["a Vercel token under another name", { MY_VERCEL_DEPLOY_TOKEN: "x" }, "forbidden MY_VERCEL_DEPLOY_TOKEN"],
    ["Inngest dev mode", { INNGEST_DEV: "1" }, "INNGEST_DEV must be unset in production"],
    ["development sign-in", { EDF_DEV_LOGIN: "1" }, "EDF_DEV_LOGIN must be 0 in production"],
    ["a local KEK", { DEV_LOCAL_KEK: '{"v1":"x"}' }, "DEV_LOCAL_KEK must not be set in production"],
    ["the KEK itself", { TOKEN_KEKS: '{"v1":"x"}' }, "edf-app must not hold the KEK (TOKEN_KEKS)"],
    ["local Chromium on Vercel", { RENDERER: "local", VERCEL: "1" }, "RENDERER=local is not allowed on Vercel"],
    ["the same origin for app and viewer", { VIEW_ORIGIN: "https://app.example/" }, "APP_ORIGIN and VIEW_ORIGIN must differ"],
    ["the same origin, differently written", { VIEW_ORIGIN: "https://APP.example:443/v" }, "APP_ORIGIN and VIEW_ORIGIN must differ"],
    ["an http viewer origin", { VIEW_ORIGIN: "http://edf-view.example" }, "origins must be https"],
    ["an http app origin", { APP_ORIGIN: "http://app.example" }, "origins must be https"],
  ] as const)("refuses %s", async (_name, over, problem) => {
    const msg = await bootError(over);
    expect(msg.startsWith("Boot checks failed: ")).toBe(true);
    expect(msg.split(": ").slice(1).join(": ").split("; ")).toContain(problem);
  });

  it("refuses a deployment without VERCEL, naming the Vercel setting; a local production build needs none", async () => {
    const msg = await bootError({ VERCEL: undefined });
    expect(msg.startsWith("Boot checks failed: ")).toBe(true);
    expect(msg).toContain("VERCEL is not set");
    expect(msg).toContain("Automatically expose System Environment Variables");
    // `next build && next start` on a laptop against the Docker Postgres: not a deployment.
    for (const url of ["postgres://app_rw:pw@localhost:5433/edf", "postgres://app_rw:pw@127.0.0.1:5433/edf"]) {
      const { run } = await boot({ VERCEL: undefined, DATABASE_URL: url });
      expect(() => run(), url).not.toThrow();
    }
  });

  it("reports every problem at once", async () => {
    const msg = await bootError({ INNGEST_DEV: "1", EDF_DEV_LOGIN: "1", VIEW_ORIGIN: "https://app.example" });
    expect(msg.split("; ")).toHaveLength(3);
  });

  it("local rendering is fine off Vercel, and development needs none of the secrets", async () => {
    // Off Vercel in production mode is a local production build (its database is on this machine).
    const { run } = await boot({ RENDERER: "local", VERCEL: undefined, DATABASE_URL: "postgres://app_rw:pw@localhost:5433/edf" });
    expect(run().RENDERER).toBe("local");

    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
    for (const k of ["CRON_SECRET", "STATE_KEYS", "OIDC_ISSUER", "KEYS_ORIGIN", "BETTER_AUTH_SECRETS"]) vi.stubEnv(k, undefined);
    vi.stubEnv("EDF_DEV_LOGIN", "1");
    vi.stubEnv("INNGEST_DEV", "1");
    const dev = await import("@/env");
    expect(dev.IS_PROD).toBe(false);
    expect(dev.env().CRON_SECRET).toBeUndefined();
  });
});
