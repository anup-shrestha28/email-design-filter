import { pg } from "@edf/db";
import { migrate } from "@edf/db/migrate";
import { APP_RW_PASSWORD, HAS_DB, OWNER_URL, TEST_DB_NAME } from "./env";

export default async function setup(): Promise<void> {
  if (!HAS_DB) return;
  const admin = new URL(OWNER_URL);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await client.end();
  await migrate({ ownerUrl: OWNER_URL, appRwPassword: APP_RW_PASSWORD });
}
