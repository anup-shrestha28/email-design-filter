/** Pipeline tests use their own database (edf_pipeline_test) so they never collide with other suites. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (!process.env.DATABASE_URL_OWNER_TEST && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** Optional per-run suffix (EDF_TEST_DB_SUFFIX) so parallel runs of this suite use separate databases. */
const SUFFIX = process.env.EDF_TEST_DB_SUFFIX ?? "";
if (SUFFIX && !/^[a-z0-9]{1,12}$/.test(SUFFIX)) throw new Error("EDF_TEST_DB_SUFFIX must be 1-12 lowercase letters/digits");
export const TEST_DB_NAME = SUFFIX ? `edf_pipeline_${SUFFIX}_test` : "edf_pipeline_test";
const base = process.env.DATABASE_URL_OWNER_TEST ?? "";
export const APP_RW_PASSWORD = process.env.APP_RW_PASSWORD ?? "";
export const HAS_DB = base !== "" && APP_RW_PASSWORD !== "";
/** CI sets EDF_REQUIRE_DB=1: a missing test-database env then fails the run instead of skipping every DB suite. */
if (process.env.EDF_REQUIRE_DB === "1" && !HAS_DB) {
  throw new Error("EDF_REQUIRE_DB=1 but DATABASE_URL_OWNER_TEST / APP_RW_PASSWORD are not set: the DB suites would be skipped");
}

export const OWNER_URL = (() => {
  if (!base) return "";
  const u = new URL(base);
  u.pathname = `/${TEST_DB_NAME}`;
  return u.toString();
})();

export function appRwUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = "app_rw";
  u.password = APP_RW_PASSWORD;
  return u.toString();
}
