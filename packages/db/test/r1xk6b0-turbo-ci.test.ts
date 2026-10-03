/**
 * CI must really run the DB/RLS suites, and turbo must not replay stale cached passes:
 * - turbo.json's `test` task passes the test-database variables through strict env mode
 *   (APP_RW_PASSWORD, EDF_TEST_DB_SUFFIX, EDF_REQUIRE_DB) and re-runs when .env.local changes;
 * - typecheck/test hashes change when a workspace dependency's source changes (transit task);
 * - test/env.ts fails instead of skipping when CI's EDF_REQUIRE_DB=1 is set without the DB env;
 * - the CI workflow sets EDF_REQUIRE_DB, builds, and checks the committed edf-view bundles (D-V5).
 * Runs the repo's own turbo binary in a throwaway two-package workspace; no database is touched.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TURBO = join(ROOT, "node_modules/.bin/turbo");
const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_NO_UPDATE_NOTIFIER: "1",
};

let ws = "";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function turbo(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync(TURBO, args, {
    cwd: ws,
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`turbo ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function hashes(): Record<string, string> {
  const dry = JSON.parse(turbo(["run", "typecheck", "test", "--dry=json"])) as {
    tasks: { taskId: string; hash: string }[];
  };
  return Object.fromEntries(dry.tasks.map((t) => [t.taskId, t.hash]));
}

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "edf-r1xk6b0-"));
  copyFileSync(join(ROOT, "turbo.json"), join(ws, "turbo.json"));
  writeJson(join(ws, "package.json"), { name: "ws", private: true, packageManager: "pnpm@11.1.3" });
  writeFileSync(join(ws, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  const printEnv =
    "node -e \"console.log('ENV=' + JSON.stringify({ rw: process.env.APP_RW_PASSWORD ?? null, suffix: process.env.EDF_TEST_DB_SUFFIX ?? null, require: process.env.EDF_REQUIRE_DB ?? null, owner: process.env.DATABASE_URL_OWNER_TEST ?? null }))\"";
  for (const [name, deps, test] of [
    ["a", {}, printEnv],
    ["b", { a: "workspace:*" }, "node -e 0"],
  ] as const) {
    mkdirSync(join(ws, "packages", name, "src"), { recursive: true });
    writeFileSync(join(ws, "packages", name, "src/index.ts"), `export const ${name} = 1;\n`);
    writeJson(join(ws, "packages", name, "package.json"), {
      name,
      version: "0.0.0",
      private: true,
      dependencies: deps,
      scripts: { typecheck: "node -e 0", test },
    });
  }
});

afterAll(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
});

describe("turbo.json test task (strict env mode)", () => {
  it("passes the test-database variables through to the test script", () => {
    const out = turbo(
      [
        "run",
        "test",
        "--filter=a",
        "--force",
        "--output-logs=full",
        `--cache-dir=${join(ws, ".tc")}`,
      ],
      {
        DATABASE_URL_OWNER_TEST: "postgres://neondb_owner:owner@127.0.0.1:1/edf_test",
        APP_RW_PASSWORD: "ci-app-rw-password-not-secret-0001",
        EDF_TEST_DB_SUFFIX: "abc",
        EDF_REQUIRE_DB: "1",
      },
    );
    const line = out.split("\n").find((l) => l.includes("ENV={"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf("ENV=") + 4))).toEqual({
      rw: "ci-app-rw-password-not-secret-0001",
      suffix: "abc",
      require: "1",
      owner: "postgres://neondb_owner:owner@127.0.0.1:1/edf_test",
    });
  });

  it("a new or changed repo-root .env.local invalidates cached test results", () => {
    const before = hashes();
    writeFileSync(join(ws, ".env.local"), "APP_RW_PASSWORD=x\n");
    try {
      expect(hashes()["b#test"]).not.toBe(before["b#test"]);
    } finally {
      rmSync(join(ws, ".env.local"));
    }
  });
});

describe("turbo.json cache keys follow workspace dependencies", () => {
  it("changing a dependency's source changes the dependent's typecheck and test hashes", () => {
    const before = hashes();
    writeFileSync(join(ws, "packages/a/src/more.ts"), "export const more = 2;\n");
    try {
      const after = hashes();
      expect(after["b#typecheck"]).not.toBe(before["b#typecheck"]);
      expect(after["b#test"]).not.toBe(before["b#test"]);
    } finally {
      rmSync(join(ws, "packages/a/src/more.ts"));
    }
  });
});

describe("test/env.ts under EDF_REQUIRE_DB", () => {
  const envTs = pathToFileURL(fileURLToPath(new URL("./env.ts", import.meta.url))).href;
  const load = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(envTs)});`],
      {
        env: {
          PATH: BASE_ENV.PATH,
          DATABASE_URL_OWNER_TEST: "postgres://neondb_owner:owner@127.0.0.1:1/edf_test",
          ...env,
        },
        encoding: "utf8",
      },
    );

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

describe(".github/workflows/ci.yml", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const runs = [...ci.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map((m) => m[1]!.trim());
  const runBlocks = ci.split(/\n\s+- /);

  it("requires the DB suites to run", () => {
    expect(ci).toMatch(/^\s+EDF_REQUIRE_DB: "1"$/m);
  });

  it("builds everything and fails when the committed edf-view bundles are stale", () => {
    expect(runs).toContain("pnpm build");
    const drift = runBlocks.find((b) => b.includes("git diff --exit-code -- apps/view/api"));
    expect(drift).toBeDefined();
    expect(drift).toContain("git status --porcelain -- apps/view/api");
    expect(runs.indexOf("pnpm build")).toBeGreaterThan(
      runs.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(ci.indexOf("git diff --exit-code -- apps/view/api")).toBeGreaterThan(
      ci.indexOf("run: pnpm build"),
    );
  });
});
