/**
 * Chromium launch configuration (DESIGN.md §6.2 "Chromium hardening"; FREE-TIER.md §5.1).
 *
 * puppeteer-core's own default arguments are used (not the @sparticuz/chromium defaults), so the
 * insecure `--disable-web-security`, `--allow-running-insecure-content` and
 * `--disable-site-isolation-trials` are never present; `assertSafeArgs` enforces that.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";

/** DESIGN.md §6.2 additions, plus rendering-determinism flags. */
export const CHROMIUM_ARGS: readonly string[] = [
  "--disable-background-networking",
  "--dns-prefetch-disable",
  "--js-flags=--jitless",
  "--disk-cache-size=0",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-sync",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
];

/** Flags that must never be passed (DESIGN.md §6.2). */
export const FORBIDDEN_ARGS: readonly string[] = [
  "--disable-web-security",
  "--allow-running-insecure-content",
  "--disable-site-isolation-trials",
];

export function assertSafeArgs(args: readonly string[]): void {
  for (const a of args) {
    if (FORBIDDEN_ARGS.some((f) => a === f || a.startsWith(`${f}=`)))
      throw new Error(`forbidden chromium flag: ${f(a)}`);
  }
}

function f(a: string): string {
  return a.split("=")[0] ?? a;
}

export interface LaunchOptions {
  /** Chromium binary; defaults to $CHROME_PATH, then /usr/bin/google-chrome. */
  executablePath?: string;
  /**
   * Disable Chromium's own sandbox. Off by default; only for hosts where the sandbox can't
   * start (FREE-TIER.md §5.1: "on, if the week-1 check shows it starts in the VM").
   */
  noSandbox?: boolean;
}

export function defaultChromePath(): string {
  return process.env.CHROME_PATH && process.env.CHROME_PATH.length > 0
    ? process.env.CHROME_PATH
    : "/usr/bin/google-chrome";
}

/** Launch a hardened headless Chromium over a pipe (no DevTools port is opened). */
export async function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
  const args = [...CHROMIUM_ARGS, ...(opts.noSandbox ? ["--no-sandbox"] : [])];
  assertSafeArgs(args);
  return puppeteer.launch({
    executablePath: opts.executablePath ?? defaultChromePath(),
    headless: true,
    pipe: true,
    args,
    dumpio: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

let axeCache: string | null | undefined;

/** axe-core 4.13 source (axe.min.js), resolved next to this package (or the VM bundle). */
export function loadAxeSource(): string | null {
  if (axeCache !== undefined) return axeCache;
  try {
    const req = createRequire(import.meta.url);
    axeCache = readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    axeCache = null;
  }
  return axeCache;
}
