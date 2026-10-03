/**
 * Data access layer entry points (DATA-MODEL.md §4.2).
 *
 *  - `withUser(pool, userId, fn)`: one transaction with the transaction-local `app.user_id`
 *    (required under Neon's PgBouncer transaction mode). RLS then scopes every tenant table.
 *  - `withSystem(pool, fn)`: one transaction with an explicitly empty tenant context, for system
 *    tables and the SECURITY DEFINER functions. Tenant tables return nothing here (fails closed).
 *
 * Every checkout is recorded by the metering hook (FREE-TIER.md §8.1) and refused on routes
 * that must never wake the database (§8.4).
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import pg from "pg";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";
import { assertDbAllowed, recordCheckout } from "./meter";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  connectionString: string;
  /** Per-instance cap. Neon's pooler multiplexes; keep this small on serverless. */
  max?: number;
  /** Short idle timeout so an idle instance doesn't keep the Neon compute awake. */
  idleTimeoutMillis?: number;
  /** Application name reported to Postgres (never includes user data). */
  applicationName?: string;
}

/** Create a pg Pool. On Vercel, pass it to `attachDatabasePool()` (see `createServerlessPool`). */
export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName ?? "edf",
    // Fail fast instead of hanging a function when the database is suspended or unreachable.
    // (No `statement_timeout` here: it would be a startup parameter, which Neon's pooled endpoint
    // drops or rejects. It is app_rw's database default (migration 0009) and inTransaction sets it too.)
    query_timeout: 30_000,
  });
  // A broken idle client must never crash the process.
  pool.on("error", () => {});
  return pool;
}

/** Pool for Vercel Fluid compute: idle clients are released before the instance suspends. */
export function createServerlessPool(opts: PoolOptions): pg.Pool {
  const pool = createPool(opts);
  if (process.env.VERCEL) attachDatabasePool(pool);
  return pool;
}

const dbByClient = new WeakMap<pg.PoolClient, Db>();
const clientByDb = new WeakMap<Db, pg.PoolClient>();
function dbFor(client: pg.PoolClient): Db {
  let db = dbByClient.get(client);
  if (!db) {
    db = drizzle(client, { schema });
    dbByClient.set(client, db);
    clientByDb.set(db, client);
  }
  return db;
}

const dialect = new PgDialect();

/**
 * Run a Drizzle `sql` template through the raw pg client of a `withUser`/`withSystem` transaction.
 * Unlike `db.execute`, which leaves timestamps as strings, this uses pg's native parsers
 * (timestamptz → Date, int4 → number, bool, arrays; int8/numeric stay strings).
 *
 *   const { rows } = await raw(db).execute<Row>(sql`SELECT …`);
 */
export function raw(db: Db): { execute<T extends object = Record<string, unknown>>(q: SQL): Promise<{ rows: T[] }> } {
  const client = clientByDb.get(db);
  if (!client) throw new Error("raw(db): db must come from withUser/withSystem");
  return {
    async execute<T extends object>(q: SQL): Promise<{ rows: T[] }> {
      const { sql: text, params } = dialect.sqlToQuery(q);
      const res = await client.query<T & pg.QueryResultRow>(text, params);
      return { rows: res.rows };
    },
  };
}

async function checkout(pool: pg.Pool): Promise<pg.PoolClient> {
  assertDbAllowed();
  const client = await pool.connect();
  recordCheckout();
  return client;
}

/** Server-side limit per statement, below the client's query_timeout so the server cancels first. */
const STATEMENT_TIMEOUT = "25s";

async function inTransaction<T>(
  pool: pg.Pool,
  tenant: string,
  fn: (db: Db, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await checkout(pool);
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    // Both transaction-local (SET LOCAL), as PgBouncer transaction mode requires.
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('statement_timeout', $2, true)", [
      tenant,
      STATEMENT_TIMEOUT,
    ]);
    const result = await fn(dbFor(client), client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error("rollback failed");
    }
    throw err;
  } finally {
    // Destroy the connection if it's in an unknown state; otherwise return it to the pool.
    client.release(broken);
  }
}

/** Run `fn` in one transaction scoped to `userId` by RLS. */
export function withUser<T>(
  pool: pg.Pool,
  userId: string,
  fn: (db: Db, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 128) {
    return Promise.reject(new Error("withUser: a non-empty user id is required"));
  }
  return inTransaction(pool, userId, fn);
}

/** Run `fn` in one transaction with an empty tenant context (system tables + definer functions). */
export function withSystem<T>(
  pool: pg.Pool,
  fn: (db: Db, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, "", fn);
}

/** A Drizzle instance over the pool without a tenant context — only for tables without RLS (Better Auth's). */
export function drizzleForAuthTables(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export { pg };
