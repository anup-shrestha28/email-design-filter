/**
 * `pnpm db:migrate` against Neon must never reset the production app_rw password to the local
 * development password from the repo-root .env.local (scripts/migrate.ts resolveMigrateEnv).
 * Pure decision logic plus the package script wiring; no database is touched here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMigrateEnv } from "../scripts/migrate";

const LOCAL_OWNER = "postgres://neondb_owner:owner@localhost:5433/edf";
const NEON_OWNER = "postgres://neondb_owner:x@ep-example.us-east-1.aws.neon.tech/neondb";
const DEV_PW = "local-dev-password-000000000000";
const PROD_PW = "brand-new-production-password-0000";
const FILE = { DATABASE_URL_OWNER: LOCAL_OWNER, APP_RW_PASSWORD: DEV_PW };

describe("resolveMigrateEnv", () => {
  it("a later Neon migration without APP_RW_PASSWORD leaves app_rw unchanged", () => {
    const r = resolveMigrateEnv({ DATABASE_URL_OWNER: NEON_OWNER }, FILE);
    expect(r.ownerUrl).toBe(NEON_OWNER);
    expect(r.appRwPassword).toBeUndefined();
    expect(r.ignoredFilePassword).toBe(true);
  });

  it("the dev password sourced into the shell is still not sent to another database", () => {
    const r = resolveMigrateEnv({ DATABASE_URL_OWNER: NEON_OWNER, APP_RW_PASSWORD: DEV_PW }, FILE);
    expect(r.appRwPassword).toBeUndefined();
    expect(r.ignoredFilePassword).toBe(true);
  });

  it("an explicit new password on the command line is set on Neon", () => {
    const r = resolveMigrateEnv({ DATABASE_URL_OWNER: NEON_OWNER, APP_RW_PASSWORD: PROD_PW }, FILE);
    expect(r).toEqual({ ownerUrl: NEON_OWNER, appRwPassword: PROD_PW, ignoredFilePassword: false });
  });

  it("local runs keep using the file's owner URL and password", () => {
    expect(resolveMigrateEnv({}, FILE)).toEqual({ ownerUrl: LOCAL_OWNER, appRwPassword: DEV_PW, ignoredFilePassword: false });
    expect(resolveMigrateEnv({ ...FILE }, FILE)).toEqual({ ownerUrl: LOCAL_OWNER, appRwPassword: DEV_PW, ignoredFilePassword: false });
    expect(resolveMigrateEnv({ APP_RW_PASSWORD: PROD_PW }, FILE).appRwPassword).toBe(PROD_PW);
  });

  it("a Neon owner URL written into .env.local never gets that file's dev password", () => {
    const neonFile = { DATABASE_URL_OWNER: NEON_OWNER, APP_RW_PASSWORD: DEV_PW };
    expect(resolveMigrateEnv({}, neonFile)).toEqual({ ownerUrl: NEON_OWNER, appRwPassword: undefined, ignoredFilePassword: true });
    // Also after `set -a; . .env.local` (the same values now in the shell too).
    expect(resolveMigrateEnv({ ...neonFile }, neonFile).appRwPassword).toBeUndefined();
    // An explicit different password is still an explicit request.
    expect(resolveMigrateEnv({ APP_RW_PASSWORD: PROD_PW }, neonFile).appRwPassword).toBe(PROD_PW);
    // Loopback forms other than "localhost" count as local.
    for (const url of ["postgres://o:p@127.0.0.1:5433/edf", "postgres://o:p@[::1]:5433/edf"]) {
      expect(resolveMigrateEnv({}, { DATABASE_URL_OWNER: url, APP_RW_PASSWORD: DEV_PW }).appRwPassword).toBe(DEV_PW);
    }
    // A look-alike host is not local.
    const lookAlike = { DATABASE_URL_OWNER: "postgres://o:p@localhost.example.com/edf", APP_RW_PASSWORD: DEV_PW };
    expect(resolveMigrateEnv({}, lookAlike).appRwPassword).toBeUndefined();
  });

  it("no file at all: only the shell counts", () => {
    expect(resolveMigrateEnv({ DATABASE_URL_OWNER: NEON_OWNER }, {})).toEqual({ ownerUrl: NEON_OWNER, appRwPassword: undefined, ignoredFilePassword: false });
    expect(resolveMigrateEnv({}, {}).ownerUrl).toBeUndefined();
  });

  it("the migrate script does not preload .env.local into process.env (that would hide where values came from)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.migrate).toContain("scripts/migrate.ts");
    expect(pkg.scripts.migrate).not.toMatch(/--env-file/);
  });
});
