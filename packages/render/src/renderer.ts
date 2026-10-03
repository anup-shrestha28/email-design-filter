/**
 * The renderer interface the pipeline calls, and the local-Chromium implementation
 * (development, tests, and the code that runs inside the Sandbox VM).
 */
import type { Browser } from "puppeteer-core";
import type { RenderJob, RenderOutcome } from "@edf/design";
import { type LaunchOptions, launchChromium, loadAxeSource } from "./chromium";
import { PAGE_DEADLINE_MS, renderEmail } from "./render-email";

export interface Renderer {
  /**
   * Render a batch. Resolves with one outcome per job, in order; jobs that can't start before
   * the deadline get `error: "deadline"`. Never rejects for a single email's failure.
   */
  renderBatch(jobs: RenderJob[], opts: { deadlineMs: number }): Promise<RenderOutcome[]>;
}

/** At most 2 pages per browser (DESIGN.md §6.2 in-process semaphore). */
export const MAX_CONCURRENT_PAGES = 2;
/** Don't start an email with less than this left before the batch deadline. */
export const MIN_START_BUDGET_MS = 8_000;

export function deadlineOutcome(
  job: RenderJob,
  error: "deadline" | "crash" | "browser_error" | "sandbox_error",
): RenderOutcome {
  return {
    id: job.id,
    ok: false,
    error,
    features: null,
    aiTiles: null,
    renderMs: 0,
    chromiumVersion: null,
  };
}

export interface LocalRendererOptions extends LaunchOptions {
  /** Use an existing browser (not closed by the renderer). */
  browser?: Browser;
  /** Clock for deadline accounting (tests). */
  now?: () => number;
}

/** Renders with a local Chromium via puppeteer-core ($CHROME_PATH). */
export class LocalChromiumRenderer implements Renderer {
  constructor(private readonly opts: LocalRendererOptions = {}) {}

  async renderBatch(jobs: RenderJob[], opts: { deadlineMs: number }): Promise<RenderOutcome[]> {
    const now = this.opts.now ?? (() => Date.now());
    const end = now() + opts.deadlineMs;
    const owned = !this.opts.browser;
    let browser: Browser;
    try {
      browser = this.opts.browser ?? (await launchChromium(this.opts));
    } catch {
      return jobs.map((j) => deadlineOutcome(j, "browser_error"));
    }
    const axeSource = loadAxeSource();
    const results: RenderOutcome[] = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const job = jobs[i]!;
        const remaining = end - now();
        if (remaining < MIN_START_BUDGET_MS) {
          results[i] = deadlineOutcome(job, "deadline");
          continue;
        }
        try {
          results[i] = await renderEmail(browser, job, {
            axeSource,
            deadlineMs: Math.min(PAGE_DEADLINE_MS, remaining - 2_000),
          });
        } catch {
          results[i] = deadlineOutcome(job, "crash");
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_PAGES, jobs.length) }, () => worker()),
      );
    } finally {
      if (owned) await closeBrowser(browser);
    }
    return results;
  }
}

/** Close the browser; kill the process if it doesn't exit within 5 s (DESIGN.md §6.2). */
export async function closeBrowser(browser: Browser): Promise<void> {
  const proc = browser.process();
  const timer = setTimeout(() => {
    try {
      proc?.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  try {
    await browser.close();
  } catch {
    proc?.kill("SIGKILL");
  } finally {
    clearTimeout(timer);
  }
}
