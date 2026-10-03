/**
 * In-VM entry (`node render.js <jobDir> <outDir>`, FREE-TIER.md §5.1 step 4). Renders every job
 * file with the local Chromium from the snapshot and writes one result file per job.
 *
 * stdout carries only fixed status codes (`EDF <index> <code>`); Chromium's console is never
 * forwarded, so no email content can reach logs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RenderJob, RenderOutcome } from "@edf/design";
import { launchChromium } from "../chromium";
import { LocalChromiumRenderer, closeBrowser, deadlineOutcome } from "../renderer";
import { type VmJobFile, jobFileName, toResultFile } from "./protocol";

function status(i: number, code: string): void {
  process.stdout.write(`EDF ${i} ${code}\n`);
}

function chromePath(appDir: string): string | undefined {
  if (process.env.EDF_CHROME_PATH) return process.env.EDF_CHROME_PATH;
  const file = join(appDir, "chrome-path.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

function readJob(path: string): VmJobFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VmJobFile;
    return parsed && parsed.v === 1 && typeof parsed.job?.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [jobDir, outDir] = argv;
  if (!jobDir || !outDir) {
    status(-1, "usage");
    return 2;
  }
  mkdirSync(outDir, { recursive: true });
  const names = readdirSync(jobDir)
    .filter((f) => /^\d{4}\.json$/.test(f))
    .sort();
  const files = names.map((n) => readJob(join(jobDir, n)));
  const appDir = process.env.EDF_APP_DIR ?? join(jobDir, "..");
  let browser;
  try {
    browser = await launchChromium({
      executablePath: chromePath(appDir),
      noSandbox: process.env.EDF_CHROME_NO_SANDBOX === "1",
    });
  } catch {
    names.forEach((_, i) => status(i, "browser_error"));
    return 1;
  }
  const renderer = new LocalChromiumRenderer({ browser });
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      let outcome: RenderOutcome;
      if (!f) {
        outcome = {
          id: `invalid-${i}`,
          ok: false,
          error: "parse_error",
          features: null,
          aiTiles: null,
          renderMs: 0,
          chromiumVersion: null,
        };
      } else {
        const remaining = f.deadlineAt - Date.now();
        const job: RenderJob = f.job;
        outcome =
          remaining <= 0
            ? deadlineOutcome(job, "deadline")
            : ((await renderer.renderBatch([job], { deadlineMs: remaining }))[0] ??
              deadlineOutcome(job, "crash"));
      }
      writeFileSync(join(outDir, jobFileName(i)), JSON.stringify(toResultFile(outcome)));
      status(i, outcome.ok ? "ok" : (outcome.error ?? "crash"));
    }
  } finally {
    await closeBrowser(browser);
  }
  return 0;
}

// Executed as the bundle entry (dist/render.js); inert when imported by tests.
if (process.env.EDF_RENDER_VM === "1" || (process.argv[1] ?? "").endsWith("render.js")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      status(-1, "crash");
      process.exit(1);
    },
  );
}
