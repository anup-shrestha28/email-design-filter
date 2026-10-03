/**
 * Test database wiring. This package uses its own database (`edf_gmail_test`) so it never
 * collides with @edf/db's `edf_test`. DB tests are skipped when the owner URL isn't configured.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (!process.env.DATABASE_URL_OWNER_TEST && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** Optional per-run suffix (EDF_TEST_DB_SUFFIX) so parallel runs of this suite use separate databases. */
const SUFFIX = process.env.EDF_TEST_DB_SUFFIX ?? "";
if (SUFFIX && !/^[a-z0-9]{1,12}$/.test(SUFFIX)) throw new Error("EDF_TEST_DB_SUFFIX must be 1-12 lowercase letters/digits");
export const TEST_DB_NAME = SUFFIX ? `edf_gmail_${SUFFIX}_test` : "edf_gmail_test";
const BASE = process.env.DATABASE_URL_OWNER_TEST ?? "";
export const APP_RW_PASSWORD = process.env.APP_RW_PASSWORD ?? "";
export const HAS_DB = BASE !== "" && APP_RW_PASSWORD !== "";
/** CI sets EDF_REQUIRE_DB=1: a missing test-database env then fails the run instead of skipping every DB suite. */
if (process.env.EDF_REQUIRE_DB === "1" && !HAS_DB) {
  throw new Error("EDF_REQUIRE_DB=1 but DATABASE_URL_OWNER_TEST / APP_RW_PASSWORD are not set: the DB suites would be skipped");
}

/** Owner URL for this package's test database. */
export function ownerUrl(): string {
  const u = new URL(BASE);
  u.pathname = `/${TEST_DB_NAME}`;
  return u.toString();
}

/** app_rw URL for this package's test database. */
export function appRwUrl(): string {
  const u = new URL(ownerUrl());
  u.username = "app_rw";
  u.password = APP_RW_PASSWORD;
  return u.toString();
}
