/**
 * DEVELOPMENT ONLY: serve raw messages for fixture mailboxes (provider_account_id "fixture:…")
 * from `fixtures/emails/**.eml`, so the viewer, renderer and pipeline run locally without Gmail.
 * Refuses to run in production or on Vercel.
 */
import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { IS_PROD } from "@/env";

export const FIXTURE_ACCOUNT_PREFIX = "fixture:";

export function isFixtureAccount(providerAccountId: string | null | undefined): boolean {
  return !IS_PROD && !process.env.VERCEL && typeof providerAccountId === "string" && providerAccountId.startsWith(FIXTURE_ACCOUNT_PREFIX);
}

/** Stable message id for a fixture file: its path under fixtures/emails with separators → "__". */
export function fixtureMessageId(relPath: string): string {
  return relPath.replace(/\.eml$/i, "").replace(/[^A-Za-z0-9_-]/g, "__").slice(0, 120);
}

function fixturesRoot(): string {
  // apps/web → repo root
  return path.resolve(process.cwd(), "..", "..", "fixtures", "emails");
}

let index: Map<string, string> | null = null;

async function walk(dir: string, base: string, out: Map<string, string>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".eml")) out.set(fixtureMessageId(path.relative(base, full)), full);
  }
}

export async function readFixtureRaw(messageId: string): Promise<Uint8Array | null> {
  if (IS_PROD || process.env.VERCEL) throw new Error("Fixture source is development-only");
  if (!index) {
    index = new Map();
    await walk(fixturesRoot(), fixturesRoot(), index);
  }
  const file = index.get(messageId);
  return file ? new Uint8Array(await readFile(file)) : null;
}
