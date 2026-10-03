/**
 * `pnpm db:reset` — DEVELOPMENT ONLY: drop and recreate the local database's public schema,
 * then migrate. Refuses to touch anything but localhost.
 */
import pg from "pg";
import { migrate } from "../src/migrate";

const ownerUrl = process.env.DATABASE_URL_OWNER ?? "";
const host = (() => {
  try {
    return new URL(ownerUrl).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(host) || process.env.NODE_ENV === "production") {
  console.error("db:reset only runs against a local database.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP TABLE IF EXISTS _migrations");
await client.end();
await migrate({ ownerUrl, appRwPassword: process.env.APP_RW_PASSWORD, log: (l) => console.log(l) });
console.log("Local database reset.");
