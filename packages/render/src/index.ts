/**
 * `@edf/render` — the Chromium renderer (DESIGN.md §6.2; FREE-TIER.md §5.1–§5.2).
 *
 * - `renderEmail(browser, job, opts)`: one email, one fresh BrowserContext, five passes.
 * - `LocalChromiumRenderer`: puppeteer-core + $CHROME_PATH, ≤ 2 pages at a time.
 * - `SandboxRenderer`: one non-persistent, deny-all Vercel Sandbox VM per batch.
 * VM output is untrusted: `parseResultFile` validates it (`renderFeaturesSchema.safeParse`).
 */
export {
  renderEmail,
  DOCUMENT_CSP,
  DOCUMENT_URL,
  PAGE_DEADLINE_MS,
  SCREENSHOT_MAX_HEIGHT,
  type RenderOptions,
} from "./render-email";
export {
  type Renderer,
  LocalChromiumRenderer,
  MAX_CONCURRENT_PAGES,
  closeBrowser,
  type LocalRendererOptions,
} from "./renderer";
export {
  SandboxRenderer,
  SandboxHygieneError,
  assertSandboxHygiene,
  sandboxUsage,
  sweepSandboxes,
  vercelSandboxFactory,
  vercelSandboxOps,
  RENDER_VM_TAGS,
  SANDBOX_TIMEOUT_SLACK_MS,
  SANDBOX_VCPUS,
  SWEEP_OLDER_THAN_MS,
  type SandboxUsage,
  type SandboxHandle,
  type SandboxFactory,
  type SandboxRendererOptions,
  type SandboxStatus,
  type SandboxListing,
  type SandboxOps,
  type SweepResult,
} from "./sandbox";
export {
  CHROMIUM_ARGS,
  FORBIDDEN_ARGS,
  launchChromium,
  loadAxeSource,
  defaultChromePath,
  assertSafeArgs,
} from "./chromium";
export { RENDER_STATUS, RENDERER_VERSION, FONT_BUNDLE, type RenderStatus } from "./status";
export {
  parseResultFile,
  imageHeader,
  VM_APP_DIR,
  VM_BUNDLE_PATH,
  VM_JOB_DIR,
  VM_OUT_DIR,
  MAX_RESULT_BYTES,
} from "./vm/protocol";
export { stripMediaRules } from "./css";
