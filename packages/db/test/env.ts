/** Test database wiring. DB tests are skipped when DATABASE_URL_OWNER_TEST is not configured. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (!process.env.DATABASE_URL_OWNER_TEST && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** Optional per-run suffix (EDF_TEST_DB_SUFFIX) so parallel runs of this suite use separate databases. */
const SUFFIX = process.env.EDF_TEST_DB_SUFFIX ?? "";
if (SUFFIX && !/^[a-z0-9]{1,12}$/.test(SUFFIX)) throw new Error("EDF_TEST_DB_SUFFIX must be 1-12 lowercase letters/digits");
export const OWNER_URL = (() => {
  const base = process.env.DATABASE_URL_OWNER_TEST ?? "";
  if (!base || !SUFFIX) return base;
  const u = new URL(base);
  u.pathname = u.pathname.replace(/_test$/, `_${SUFFIX}_test`);
  return u.toString();
})();
export const APP_RW_PASSWORD = process.env.APP_RW_PASSWORD ?? "";
export const HAS_DB = OWNER_URL !== "" && APP_RW_PASSWORD !== "";
/** CI sets EDF_REQUIRE_DB=1: a missing test-database env then fails the run instead of skipping every DB suite. */
if (process.env.EDF_REQUIRE_DB === "1" && !HAS_DB) {
  throw new Error("EDF_REQUIRE_DB=1 but DATABASE_URL_OWNER_TEST / APP_RW_PASSWORD are not set: the DB suites would be skipped");
}

/** app_rw connection string for the test database (same host/db as the owner URL). */
export function appRwUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = "app_rw";
  u.password = APP_RW_PASSWORD;
  return u.toString();
}
