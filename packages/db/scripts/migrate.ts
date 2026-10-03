/**
 * `pnpm db:migrate` — apply migrations as the owner. Env: DATABASE_URL_OWNER, APP_RW_PASSWORD.
 *
 * The repo-root .env.local is read here (not through `--env-file`) so the script knows where each
 * value came from. Its APP_RW_PASSWORD is the local development password: it is used only when the
 * owner URL also comes from that file and points at this machine (localhost / 127.x / ::1). So even a
 * Neon owner URL pasted into .env.local never gets the dev password. Against any other database the
 * app_rw password is changed only when APP_RW_PASSWORD is given on the command line, so a later
 * `DATABASE_URL_OWNER='…' pnpm db:migrate` can never reset production app_rw to the dev password.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { migrate } from "../src/migrate";

type Vars = Readonly<Record<string, string | undefined>>;

const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

/** True only for a connection string whose host is this machine (the local Docker database). */
function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Decides the owner URL and whether (and to what) the app_rw password is set. Never logs values. */
export function resolveMigrateEnv(
  shell: Vars,
  file: Vars,
): { ownerUrl: string | undefined; appRwPassword: string | undefined; ignoredFilePassword: boolean } {
  const shellOwner = nonEmpty(shell.DATABASE_URL_OWNER);
  const fileOwner = nonEmpty(file.DATABASE_URL_OWNER);
  const ownerUrl = shellOwner ?? fileOwner;
  const shellPassword = nonEmpty(shell.APP_RW_PASSWORD);
  const filePassword = nonEmpty(file.APP_RW_PASSWORD);
  const localTarget =
    ownerUrl !== undefined && (shellOwner === undefined || shellOwner === fileOwner) && isLoopbackUrl(ownerUrl);
  // Given on the command line: an explicit request, for whichever database — unless it is just the
  // file's development password again (e.g. after `set -a; . .env.local`) aimed at another database.
  if (shellPassword && (localTarget || shellPassword !== filePassword)) {
    return { ownerUrl, appRwPassword: shellPassword, ignoredFilePassword: false };
  }
  if (!filePassword) return { ownerUrl, appRwPassword: undefined, ignoredFilePassword: false };
  // The file's (development) password goes only to the file's own database, and only when it is local.
  return localTarget
    ? { ownerUrl, appRwPassword: filePassword, ignoredFilePassword: false }
    : { ownerUrl, appRwPassword: undefined, ignoredFilePassword: true };
}

function readRootEnvFile(): Vars {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../../.env.local");
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const { ownerUrl, appRwPassword, ignoredFilePassword } = resolveMigrateEnv(process.env, readRootEnvFile());
  if (!ownerUrl) {
    console.error("DATABASE_URL_OWNER is required (the Neon owner connection string, unpooled).");
    process.exit(1);
  }
  if (ignoredFilePassword) {
    console.log(
      "app_rw password left unchanged: the .env.local development password is only ever set on the local (localhost) database from that file (pass a different APP_RW_PASSWORD on the command line to change it).",
    );
  }
  const { applied } = await migrate({ ownerUrl, appRwPassword, log: (l) => console.log(l) });
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database is up to date.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
