/**
 * The free deploy path (docs/SETUP.md §2, docs/FREE-TIER.md §11) must actually produce a working
 * app: Inngest reaches edf-app through Standard Deployment Protection (INNGEST_SERVE_ORIGIN boot
 * check), the render snapshot is built with commands that exist, the render bundle is built on
 * Vercel, the production env table names every variable env.ts requires, and the preview /v check
 * asks for an answer a preview can give. Reads files only; no database, no network.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = new URL("../../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");
const setup = () => read("docs/SETUP.md");
const freeTier = () => read("docs/FREE-TIER.md");

/** One numbered step of a markdown list: from "<n>. **<title>" to the next top-level step. */
function step(doc: string, n: number, title: string): string {
  const start = doc.indexOf(`\n${n}. **${title}`);
  expect(start, `step ${n} ${title}`).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.search(new RegExp(`\\n${n + 1}\\. \\*\\*`));
  return end === -1 ? rest : rest.slice(0, end);
}

/** FREE-TIER §11 is the numbered list after the "## 11." heading. */
function section11(doc: string): string {
  const start = doc.search(/\n## 11\. /);
  const end = doc.indexOf("\n## 12. ", start);
  return doc.slice(start, end);
}

// ---------------------------------------------------------------------------------------------
// Inngest behind Standard Deployment Protection (R1-28)
// ---------------------------------------------------------------------------------------------

const PROD: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://app_rw:pw@db.example:5432/edf",
  BETTER_AUTH_URL: "https://app.example",
  BETTER_AUTH_SECRETS: "1:secret-value-long-enough-000",
  GOOGLE_LOGIN_CLIENT_ID: "login-client-id.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "login-client-secret",
  GOOGLE_CONNECTOR_CLIENT_ID: "connector-client-id.apps.googleusercontent.com",
  GOOGLE_CONNECTOR_CLIENT_SECRET: "connector-client-secret",
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
  VIEW_KEYS: '{"k1":"secret-secret"}',
  OUT_KEYS: '{"k1":"secret-secret"}',
  STATE_KEYS: '{"k1":"secret-secret"}',
  INVITE_KEYS: '{"k1":"secret-secret"}',
  ACCESS_TOKEN_KEYS: '{"k1":"secret-secret"}',
  IMG_SIGNING_KEYS: '{"k1":"secret-secret"}',
  INNGEST_SIGNING_KEY: "signkey-prod-secret-secret",
  INNGEST_EVENT_KEY: "event-secret-secret",
  CRON_SECRET: "cron-secret-long-enough-0000000",
};
const CLEAR = ["EDF_DEV_LOGIN", "DEV_LOCAL_KEK", "RENDERER", "CHROME_PATH", "INNGEST_DEV", "TOKEN_KEKS", "INNGEST_SERVE_ORIGIN"];

async function bootMessage(over: Record<string, string | undefined>): Promise<string> {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (/VERCEL/i.test(k)) vi.stubEnv(k, undefined);
  for (const k of CLEAR) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries({ ...PROD, ...over })) vi.stubEnv(k, v);
  const m = await import("@/env");
  try {
    m.env();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

describe("Inngest serve origin (production on Vercel)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const onVercelProd = { VERCEL: "1", VERCEL_ENV: "production" };

  it("refuses to start without INNGEST_SERVE_ORIGIN (Inngest would call the protected deployment URL)", async () => {
    const msg = await bootMessage(onVercelProd);
    expect(msg).toContain("Boot checks failed: ");
    expect(msg).toContain("INNGEST_SERVE_ORIGIN must be set to APP_ORIGIN");
  });

  it("refuses an INNGEST_SERVE_ORIGIN that isn't the public app origin", async () => {
    const msg = await bootMessage({ ...onVercelProd, INNGEST_SERVE_ORIGIN: "https://edf-app-git-abc123-team.vercel.app" });
    expect(msg).toContain("INNGEST_SERVE_ORIGIN must equal APP_ORIGIN");
  });

  it("boots when it equals APP_ORIGIN, and previews / local runs don't need it", async () => {
    expect(await bootMessage({ ...onVercelProd, INNGEST_SERVE_ORIGIN: "https://app.example" })).toBe("");
    expect(await bootMessage({ ...onVercelProd, INNGEST_SERVE_ORIGIN: "https://app.example/" })).toBe("");
    expect(await bootMessage({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe("");
    // A local production build (`next start` against the Docker Postgres); off Vercel with a remote
    // database is a deployment without its system variables, which env-boot.test.ts covers.
    expect(await bootMessage({ DATABASE_URL: "postgres://app_rw:pw@localhost:5433/edf" })).toBe("");
  });

  it("both setup docs tell the operator to set it and to create the automation bypass", () => {
    for (const doc of [setup(), section11(freeTier())]) {
      expect(doc).toContain("Protection Bypass for Automation");
      expect(doc).toContain("INNGEST_SERVE_ORIGIN");
    }
    expect(step(section11(freeTier()), 4, "Inngest")).toContain("INNGEST_SERVE_ORIGIN");
    expect(step(setup(), 5, "Inngest")).toContain("INNGEST_SERVE_ORIGIN");
  });
});

// ---------------------------------------------------------------------------------------------
// Render snapshot and bundle (R1-23)
// ---------------------------------------------------------------------------------------------

describe("render snapshot and bundle", () => {
  it("SETUP §2 builds the bundle, the snapshot and records SANDBOX_SNAPSHOT_ID", () => {
    const s = setup();
    const two = s.slice(s.indexOf("## 2. "));
    expect(two).toContain("pnpm --filter @edf/render build");
    expect(two).toContain("pnpm --filter @edf/render render-vm:snapshot");
    expect(two).toMatch(/vercel env pull/);
    expect(step(two, 7, "Keys")).toContain("SANDBOX_SNAPSHOT_ID");
    expect(step(two, 8, "Environment variables")).toContain("SANDBOX_SNAPSHOT_ID");
  });

  it("every `pnpm <script>` the setup docs run from the repo root exists there", () => {
    const rootScripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);
    const builtins = new Set(["install", "exec", "dlx", "add", "run"]);
    const missing: string[] = [];
    for (const [name, doc] of [["SETUP.md", setup()], ["FREE-TIER.md §11", section11(freeTier())]] as const) {
      for (const m of doc.matchAll(/(?:^|[`\s(;&])pnpm ([a-z][\w:@./-]*)/gm)) {
        const cmd = m[1] ?? "";
        if (!builtins.has(cmd) && !rootScripts.includes(cmd)) missing.push(`${name}: pnpm ${cmd}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the Vercel build of edf-app builds packages/render/dist/render.js before next build", () => {
    const build = (JSON.parse(read("apps/web/package.json")) as { scripts: Record<string, string> }).scripts.build ?? "";
    const renderAt = build.indexOf("pnpm --filter @edf/render build");
    expect(renderAt).toBeGreaterThan(-1);
    expect(build.indexOf("next build")).toBeGreaterThan(renderAt);
    expect(build).toMatch(/&&/);
  });
});

// ---------------------------------------------------------------------------------------------
// Environment steps (R1-26)
// ---------------------------------------------------------------------------------------------

describe("environment steps", () => {
  it("FREE-TIER's edf-xxxx production row names every variable env.ts requires in production", () => {
    const envTs = read("apps/web/src/env.ts");
    const required = [...envTs.matchAll(/^\s+([A-Z][A-Z0-9_]+): req\(/gm)].map((m) => m[1] ?? "");
    expect(required.length).toBeGreaterThan(20);
    const row = section11(freeTier())
      .split("\n")
      .find((l) => l.includes("| `edf-xxxx`, Production"));
    expect(row).toBeDefined();
    // `GOOGLE_LOGIN_CLIENT_ID/SECRET` names both halves; "the 3 Inngest keys" names the Inngest ones.
    const named = new Set<string>();
    for (const m of (row ?? "").matchAll(/`([A-Z][A-Z0-9_]+)(?:\/([A-Z]+))?`/g)) {
      const full = m[1] ?? "";
      named.add(full);
      if (m[2]) named.add(full.replace(/[A-Z]+$/, m[2]));
    }
    if ((row ?? "").includes("the 3 Inngest keys")) for (const k of ["INNGEST_SIGNING_KEY", "INNGEST_EVENT_KEY"]) named.add(k);
    expect(required.filter((k) => !named.has(k))).toEqual([]);
    // Required on Vercel production by the boot checks, though optional in the schema.
    expect(named.has("INNGEST_SERVE_ORIGIN")).toBe(true);
  });

  it("the root DATABASE_URL placeholder is called out: SETUP and .env.example say to replace it", () => {
    const example = read(".env.example");
    expect(example).toContain("<APP_RW_PASSWORD>");
    const lines = example.split("\n");
    const at = lines.findIndex((l) => l.startsWith("DATABASE_URL="));
    expect(lines.slice(Math.max(0, at - 3), at).join("\n")).toMatch(/Replace <APP_RW_PASSWORD>/);
    const local = setup().slice(0, setup().indexOf("## 2. "));
    expect(local).toMatch(/in place of `<APP_RW_PASSWORD>` inside `DATABASE_URL`/);
  });
});

// ---------------------------------------------------------------------------------------------
// The preview /v check (R1-03)
// ---------------------------------------------------------------------------------------------

describe("the /v routing check", () => {
  it("never asks a preview to show an email, and names the answers a preview and production give", () => {
    const docs = [step(setup().slice(setup().indexOf("## 2. ")), 9, "Deploy"), step(section11(freeTier()), 9, "Deploy")];
    for (const d of docs) {
      expect(d).not.toMatch(/preview deploy, open a real `\/v` link and confirm it renders/);
      expect(d).toContain("/v/test/test");
      expect(d).toMatch(/503/);
      expect(d).toMatch(/403/);
      expect(d).toMatch(/400/);
      expect(d).toMatch(/404/);
      expect(d).toMatch(/production/);
    }
  });
});
