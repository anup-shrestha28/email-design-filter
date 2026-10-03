/**
 * Recreate the test database from scratch and apply every migration, as the Neon-like owner.
 * app_rw is a cluster-wide role, so its password is set to the same APP_RW_PASSWORD the local
 * dev database uses (never a different one: that would break the dev connection string).
 */
import pg from "pg";
import { migrate } from "../src/migrate";
import { APP_RW_PASSWORD, HAS_DB, OWNER_URL } from "./env";

export default async function setup(): Promise<void> {
  if (!HAS_DB) return;
  const target = new URL(OWNER_URL);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*_test$/.test(dbName)) throw new Error(`Refusing to recreate non-test database "${dbName}"`);
  const admin = new URL(OWNER_URL);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${dbName}`);
  await client.end();
  await migrate({ ownerUrl: OWNER_URL, appRwPassword: APP_RW_PASSWORD });
}
