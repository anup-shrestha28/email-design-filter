/**
 * CI sets EDF_REQUIRE_DB=1 (.github/workflows/ci.yml): the test-database wiring must then fail
 * the run when DATABASE_URL_OWNER_TEST / APP_RW_PASSWORD are missing, instead of letting every
 * describe.skipIf(!HAS_DB) suite skip and the job pass. Loads the env module in a child process.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Not `new URL(rel, import.meta.url)`: under jsdom, Vite rewrites that pattern to an http: asset URL.
const ENV_TS = pathToFileURL(
  resolve(fileURLToPath(import.meta.url), "..", "../support/env.ts"),
).href;

function load(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(ENV_TS)});`],
    {
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        DATABASE_URL_OWNER_TEST: "postgres://neondb_owner:owner@127.0.0.1:1/edf_test",
        ...env,
      },
      encoding: "utf8",
    },
  );
}

describe("test env under EDF_REQUIRE_DB", () => {
  it("fails instead of silently skipping the DB suites when APP_RW_PASSWORD is missing", () => {
    const r = load({ EDF_REQUIRE_DB: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("EDF_REQUIRE_DB=1");
  });

  it("still loads when the DB env is complete, or when the DB is not required", () => {
    expect(load({ EDF_REQUIRE_DB: "1", APP_RW_PASSWORD: "pw" }).status).toBe(0);
    expect(load({}).status).toBe(0);
  });
});
