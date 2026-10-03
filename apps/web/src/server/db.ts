/**
 * One pg Pool per server instance (Fluid compute shares instances across requests).
 * Connects as app_rw (NOBYPASSRLS); `getPool()` runs the boot assertion once and refuses a role
 * that could bypass RLS (DATA-MODEL.md §4.1). Its checkouts drive the instance's usage flushes
 * (metering.ts, FREE-TIER.md §8.1).
 */
import "server-only";
import { assertRuntimeRole, createServerlessPool, type pg } from "@edf/db";
import { env } from "@/env";
import { watchPool } from "./metering";

const g = globalThis as unknown as { __edfPool?: pg.Pool; __edfPoolChecked?: Promise<void> };

/** The raw pool, without the boot check (Better Auth's adapter needs it synchronously). */
export function rawPool(): pg.Pool {
  if (!g.__edfPool) {
    g.__edfPool = createServerlessPool({ connectionString: env().DATABASE_URL, max: 5, applicationName: "edf-app" });
    watchPool(g.__edfPool);
  }
  return g.__edfPool;
}

/** The pool, after verifying the runtime role cannot bypass RLS. */
export async function getPool(): Promise<pg.Pool> {
  const pool = rawPool();
  g.__edfPoolChecked ??= assertRuntimeRole(pool).catch((err: unknown) => {
    g.__edfPoolChecked = undefined; // retry next time (e.g. Neon was suspended)
    throw err;
  });
  await g.__edfPoolChecked;
  return pool;
}
