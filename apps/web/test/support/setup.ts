/**
 * Per-file setup: the development key set from apps/web/.env.local (non-production keys only), with
 * DATABASE_URL pointed at this run's test database as app_rw. NODE_ENV stays "test" (not production),
 * so env() applies the development fallbacks; tests of production-only rules set NODE_ENV themselves
 * and re-import modules (vi.resetModules()).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appRwUrl, HAS_DB } from "./env";

// Not `new URL(rel, import.meta.url)`: under jsdom, Vite rewrites that pattern to an http: asset URL.
const webEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env.local");
if (existsSync(webEnv)) process.loadEnvFile(webEnv);
if (HAS_DB) process.env.DATABASE_URL = appRwUrl();
