/**
 * Recreate this package's test database and apply @edf/db's migrations with its own runner.
 * app_rw's password is NOT touched (it is a cluster-wide role shared with the dev database).
 * Roles are cluster-wide, so a migration running concurrently in another test database can
 * fail with a catalog conflict: retry a few times.
 */
import { createPool } from "@edf/db";
import { migrate } from "../../db/src/migrate";
import { HAS_DB, ownerUrl, TEST_DB_NAME } from "./env";

export default async function setup(): Promise<void> {
  if (!HAS_DB) return;
  if (!/^[a-z_][a-z0-9_]*_test$/.test(TEST_DB_NAME))
    throw new Error("Refusing to recreate a non-test database");
  const admin = new URL(ownerUrl());
  admin.pathname = "/postgres";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const pool = createPool({
      connectionString: admin.toString(),
      max: 1,
      applicationName: "edf-budget-test-setup",
    });
    try {
      await pool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
      await pool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
      await pool.end();
      await migrate({ ownerUrl: ownerUrl() });
      return;
    } catch (err) {
      lastErr = err;
      await pool.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}
