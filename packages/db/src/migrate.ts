/**
 * Migration runner. Runs as the database OWNER (Neon's neondb_owner) from a laptop or CI —
 * never from the app (FREE-TIER.md §11 step 3). Applies migrations/*.sql in order, each in its
 * own transaction, records a SHA-256 checksum, refuses to run if an applied file changed, and
 * serializes concurrent runners with an advisory lock.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { scramSha256Verifier } from "./scram";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LOCK_KEY = 0x0edf_0001;

export interface MigrateOptions {
  ownerUrl: string;
  /** Sets app_rw's password (as a SCRAM verifier). Omit to leave it unchanged. */
  appRwPassword?: string;
  dir?: string;
  log?: (line: string) => void;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(dir, name), "utf8");
    files.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return files;
}

export async function migrate(opts: MigrateOptions): Promise<{ applied: string[] }> {
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString: opts.ownerUrl, application_name: "edf-migrate" });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query("REVOKE ALL ON _migrations FROM PUBLIC");
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM _migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const file of await loadMigrations(opts.dir)) {
      const prior = done.get(file.name);
      if (prior !== undefined) {
        if (prior !== file.checksum) {
          throw new Error(`Migration ${file.name} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      log(`applying ${file.name}`);
      // Roles are cluster-wide while advisory locks are per database, so two databases migrating at
      // the same moment (parallel test suites) can race on CREATE ROLE: retry that race only.
      for (let attempt = 1; ; attempt++) {
        await client.query("BEGIN");
        try {
          await client.query(file.sql);
          await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [file.name, file.checksum]);
          await client.query("COMMIT");
          break;
        } catch (err) {
          await client.query("ROLLBACK");
          const code = (err as { code?: string }).code;
          const roleRace = code === "42710" || (code === "23505" && /pg_authid|pg_auth_members/.test((err as Error).message));
          if (roleRace && attempt < 4) {
            await new Promise((r) => setTimeout(r, 200 * attempt));
            continue;
          }
          throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
        }
      }
      applied.push(file.name);
    }
    if (opts.appRwPassword) {
      const verifier = scramSha256Verifier(opts.appRwPassword);
      try {
        await client.query(`ALTER ROLE app_rw PASSWORD ${client.escapeLiteral(verifier)}`);
        log("app_rw password set (SCRAM verifier)");
      } catch (err) {
        // Neon forwards role changes to its control plane, which accepts only a plaintext password
        // ("Neon only supports being given plaintext passwords"). The statement still travels over
        // the TLS connection only; the verifier stays the default everywhere else.
        if (!/only supports being given plaintext passwords/i.test((err as Error).message)) throw err;
        await client.query(`ALTER ROLE app_rw PASSWORD ${client.escapeLiteral(opts.appRwPassword)}`);
        log("app_rw password set (plaintext: the server accepts no SCRAM verifier)");
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return { applied };
}
