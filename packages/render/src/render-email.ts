/**
 * `renderEmail(browser, job)` — one email in one fresh BrowserContext (DESIGN.md §6.2;
 * FREE-TIER.md §5.1 step 4, §5.2 passes):
 *
 *  raw HTML → `data-o` byte stamps → analysis sanitizer → `__default__` sentinel + inlined images
 *  → JS off and a light colour scheme before load → navigation answered by the interceptor with a CSP header
 *  (`script-src 'none'`, images only from `data:`) → every other request aborted
 *  → D (800: snapshot, screenshot ≤ 8,000px, axe) → D0 (paint test) → M (375, 1×)
 *  → M-nomq (@media removed) → M-off (images off) → features + AI tiles.
 *
 * Never logs email content; failures return fixed status codes only.
 */
import type { Browser, CDPSession, HTTPRequest, Page } from "puppeteer-core";
import type { RenderJob, RenderOutcome } from "@edf/design";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  RenderInputError,
  prepareRenderDocument,
  renderFeaturesSchema,
  stampByteOffsets,
  type PreparedDocument,
  type RenderFeatures,
} from "@edf/design/render-kit";
import { sanitizeForAnalysis } from "@edf/sanitize";
import { loadAxeSource } from "./chromium";
import { stripMediaRules } from "./css";
import { extractFeatures } from "./extract";
import { collectPageFacts } from "./page-facts";
import { decodeScreenshot, darkModeImage, makeTiles, paintMask, pngBytesPerPixel } from "./pixels";
import { type RawSnapshot, STYLE_PROPS, Snap } from "./snapshot";
import { RENDER_STATUS, type RenderStatus, RENDERER_VERSION, FONT_BUNDLE } from "./status";

/** Navigation URL answered by the interceptor (never resolved: `.invalid` is reserved). */
export const DOCUMENT_URL = "https://email.render.invalid/";
export const PAGE_DEADLINE_MS = 20_000;
export const SCREENSHOT_MAX_HEIGHT = 8_000;

/** CSP on the document response: no scripts, images only as data: URIs, nothing else loads. */
export const DOCUMENT_CSP =
  "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

/** Pass D0 (DESIGN-SCORE §2): make text transparent; everything else paints identically. */
const PAINT_TEST_CSS =
  "*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;text-decoration-color:transparent!important}";
const IMAGES_OFF_CSS = "*{background-image:none!important}";

export interface RenderOptions {
  /**
   * axe-core source (axe.min.js). Omitted → loaded from the installed axe-core; null skips axe
   * (A5 then falls back to the static heuristic).
   */
  axeSource?: string | null;
  /** Per-page deadline (default 20 s). */
  deadlineMs?: number;
}

class RenderAbort extends Error {
  constructor(readonly code: RenderStatus) {
    super(code);
  }
}

function fail(
  job: RenderJob,
  code: RenderStatus,
  started: number,
  chromiumVersion: string | null,
): RenderOutcome {
  return {
    id: job.id,
    ok: false,
    error: code,
    features: null,
    aiTiles: null,
    renderMs: Math.round(performance.now() - started),
    chromiumVersion,
  };
}

async function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new RenderAbort("timeout"));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Captured {
  d: RawSnapshot;
  m: RawSnapshot;
  nomq: RawSnapshot | null;
  off: RawSnapshot | null;
  dPng: Buffer;
  d0Png: Buffer;
  mPng: Buffer | null;
  facts: Awaited<ReturnType<typeof collectPageFacts>>;
  screenshotClipped: boolean;
  passes: RenderFeatures["meta"]["passes"];
}

async function snapshot(cdp: CDPSession): Promise<RawSnapshot> {
  const r = await cdp.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [...STYLE_PROPS],
    includeDOMRects: false,
    includePaintOrder: false,
  });
  return r as unknown as RawSnapshot;
}

async function screenshot(cdp: CDPSession, width: number, height: number): Promise<Buffer> {
  const r = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width, height, scale: 1 },
    captureBeyondViewport: true,
    optimizeForSpeed: true,
  });
  return Buffer.from(r.data, "base64");
}

/**
 * Viewport emulation. `mobile` stays false in every pass: a fixed layout viewport of exactly
 * `width` CSS px, no text autosizing and no shrink-to-fit, so `k` measures the email itself.
 * `screen` sets the device's screen: the phone passes report a 375×667 screen so
 * `max-device-width` / `device-width` media queries match as on a phone (they never did).
 */
async function setViewport(
  cdp: CDPSession,
  width: number,
  height: number,
  screen?: { width: number; height: number },
): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    ...(screen ? { screenWidth: screen.width, screenHeight: screen.height } : {}),
  });
}

/**
 * Light colour scheme in every pass, as Gmail shows mail by default. Headless Chromium otherwise
 * follows the host's theme: on a dark desktop it matched `prefers-color-scheme: dark`, so emails
 * with dark-mode styles were measured in their dark variant, and dark rules that set
 * `color` / `-webkit-text-fill-color` with `!important` beat pass D0's transparent text, so their
 * copy failed the paint test and counted as hidden (render-2026.4). Persists across loads.
 */
async function emulateLightScheme(cdp: CDPSession): Promise<void> {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
}

/** The phone the M passes emulate (FREE-TIER.md §5.2: 375 CSS px, 1×). */
export const PHONE_SCREEN = { width: MOBILE_WIDTH, height: 667 } as const;

function contentSize(raw: RawSnapshot): { width: number; height: number } {
  const doc = raw.documents[0];
  return { width: doc?.contentWidth ?? 0, height: doc?.contentHeight ?? 0 };
}

interface LoadState {
  html: string;
  /** The main-frame document request has been answered for the current load. */
  loaded: boolean;
}

/** Load `html` through the intercepted navigation and wait for `load`. */
async function load(page: Page, state: LoadState, html: string, timeoutMs: number): Promise<void> {
  state.html = html;
  state.loaded = false;
  const res = await page.goto(DOCUMENT_URL, { waitUntil: "load", timeout: timeoutMs });
  if (!res || res.status() !== 200) throw new RenderAbort("navigation_error");
}

/** The page must still show our document (nothing navigated it away). */
function assertOnDocument(page: Page): void {
  if (page.url() !== DOCUMENT_URL) throw new RenderAbort("navigation_error");
}

async function capture(
  page: Page,
  prep: PreparedDocument,
  job: RenderJob,
  opts: RenderOptions,
  budgetMs: number,
): Promise<Captured> {
  const state: LoadState = { html: prep.html, loaded: false };
  page.on("request", (req: HTTPRequest) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = req.url();
    const navigation = req.isNavigationRequest();
    if (url === DOCUMENT_URL && navigation && req.frame() === page.mainFrame() && !state.loaded) {
      state.loaded = true;
      void req.respond({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy": DOCUMENT_CSP,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
        body: state.html,
      });
    } else if (navigation) {
      // Any other navigation (meta refresh, frames, a second load of the document URL) gets
      // 204 No Content: the browser keeps the current document. Aborting would replace it with
      // an error page.
      void req.respond({ status: 204, body: "" });
    } else if (url.startsWith("data:")) {
      void req.continue();
    } else {
      void req.abort("blockedbyclient");
    }
  });
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  const cdp = await page.createCDPSession();
  await cdp.send("Page.enable");
  await setViewport(cdp, DESKTOP_WIDTH, 1000);
  await emulateLightScheme(cdp);
  await load(page, state, prep.html, budgetMs);

  const frameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const sheets: Array<{ id: string; origin: string }> = [];
  cdp.on("CSS.styleSheetAdded", (e) =>
    sheets.push({ id: e.header.styleSheetId, origin: e.header.origin }),
  );
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  // Pass D
  assertOnDocument(page);
  const d = await snapshot(cdp);
  const size = contentSize(d);
  const height = Math.max(1, Math.min(SCREENSHOT_MAX_HEIGHT, Math.ceil(size.height)));
  const dPng = await screenshot(cdp, DESKTOP_WIDTH, height);
  const facts = await collectPageFacts(cdp, frameId, opts.axeSource);

  // Pass D0 (paint test)
  const { styleSheetId } = await cdp.send("CSS.createStyleSheet", { frameId });
  await cdp.send("CSS.setStyleSheetText", { styleSheetId, text: PAINT_TEST_CSS });
  const d0Png = await screenshot(cdp, DESKTOP_WIDTH, height);
  await cdp.send("CSS.setStyleSheetText", { styleSheetId, text: "" });

  // Pass M (375, 1×, a 375×667 phone screen; FREE-TIER.md §5.2)
  await setViewport(cdp, PHONE_SCREEN.width, PHONE_SCREEN.height, PHONE_SCREEN);
  assertOnDocument(page);
  const m = await snapshot(cdp);
  const mPng = job.wantAiTiles ? await screenshot(cdp, MOBILE_WIDTH, PHONE_SCREEN.height) : null;
  const passes: RenderFeatures["meta"]["passes"] = ["D", "D0", "M"];

  let nomq: RawSnapshot | null = null;
  let off: RawSnapshot | null = null;
  if (!job.lite) {
    // Pass M-nomq: re-layout with every @media block removed from the author stylesheets.
    const originals: Array<{ id: string; text: string }> = [];
    for (const sh of sheets) {
      if (sh.origin !== "regular") continue;
      const { text } = await cdp.send("CSS.getStyleSheetText", { styleSheetId: sh.id });
      const stripped = stripMediaRules(text);
      if (stripped !== text) {
        originals.push({ id: sh.id, text });
        await cdp.send("CSS.setStyleSheetText", { styleSheetId: sh.id, text: stripped });
      }
    }
    nomq = originals.length > 0 ? await snapshot(cdp) : m;
    passes.push("M-nomq");

    // Pass M-off: images off (a fresh load of the images-off document, backgrounds removed).
    await load(page, state, prep.htmlImagesOff, budgetMs);
    const offFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    const offSheet = await cdp.send("CSS.createStyleSheet", { frameId: offFrame });
    await cdp.send("CSS.setStyleSheetText", {
      styleSheetId: offSheet.styleSheetId,
      text: IMAGES_OFF_CSS,
    });
    assertOnDocument(page);
    off = await snapshot(cdp);
    passes.push("M-off");
  }
  return {
    d,
    m,
    nomq,
    off,
    dPng,
    d0Png,
    mPng,
    facts,
    screenshotClipped: size.height > SCREENSHOT_MAX_HEIGHT,
    passes,
  };
}

/**
 * Render one email and measure its render features. Always resolves (fixed error codes).
 */
export async function renderEmail(
  browser: Browser,
  job: RenderJob,
  options: RenderOptions = {},
): Promise<RenderOutcome> {
  const opts: RenderOptions = {
    ...options,
    axeSource: options.axeSource === undefined ? loadAxeSource() : options.axeSource,
  };
  const started = performance.now();
  let chromiumVersion: string;
  try {
    chromiumVersion = (await browser.version()).slice(0, 80);
  } catch {
    return fail(job, "browser_error", started, null);
  }
  let prep: PreparedDocument;
  try {
    const stamped = stampByteOffsets(job.html);
    let sanitized: string;
    try {
      sanitized = sanitizeForAnalysis(stamped);
    } catch {
      return fail(job, "sanitize_error", started, chromiumVersion);
    }
    const images = job.imagesAllowed
      ? { images: job.images, cid: job.cid }
      : { images: {}, cid: {} };
    prep = prepareRenderDocument(sanitized, images);
  } catch (e) {
    if (e instanceof RenderInputError)
      return fail(
        job,
        e.code === "too_large"
          ? "too_large"
          : e.code === "too_many_nodes"
            ? "too_many_nodes"
            : "parse_error",
        started,
        chromiumVersion,
      );
    return fail(job, "parse_error", started, chromiumVersion);
  }

  const deadline = opts.deadlineMs ?? PAGE_DEADLINE_MS;
  let captured: Captured;
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    captured = await withDeadline(capture(page, prep, job, opts, deadline), deadline, () => {
      void page.close().catch(() => undefined);
    });
  } catch (e) {
    const code: RenderStatus = e instanceof RenderAbort ? e.code : "crash";
    await closeQuietly(context);
    return fail(job, code, started, chromiumVersion);
  }
  await closeQuietly(context);

  try {
    const [dImg, d0Img] = await Promise.all([
      decodeScreenshot(captured.dPng),
      decodeScreenshot(captured.d0Png),
    ]);
    const mask = paintMask(dImg, d0Img);
    const d = new Snap(captured.d);
    const m = new Snap(captured.m);
    if (d.count > 25_000 || m.count > 25_000)
      return fail(job, "too_many_nodes", started, chromiumVersion);
    const extracted = extractFeatures({
      d,
      m,
      nomq: captured.nomq ? new Snap(captured.nomq) : null,
      off: captured.off ? new Snap(captured.off) : null,
      dImg,
      d0Img,
      mask,
      job,
      imageTable: prep.imageTable,
      refByDataUri: prep.refByDataUri,
      page: captured.facts,
      meta: {
        chromium: (chromiumVersion ?? "unknown").slice(0, 80),
        rendererVersion: RENDERER_VERSION,
        fontBundle: FONT_BUNDLE,
        lite: job.lite,
        passes: captured.passes,
        domNodes: d.count,
        screenshotClipped: captured.screenshotClipped,
      },
    });
    const features = extracted.features;
    features.pixels.pngBytesPerPixel = await pngBytesPerPixel(dImg, extracted.crop).catch(
      () => null,
    );
    const uriByRef = new Map<string, string>();
    for (const [uri, ref] of prep.refByDataUri) if (!uriByRef.has(ref)) uriByRef.set(ref, uri);
    for (const c of extracted.darkCandidates) {
      const uri = c.ref.startsWith("data:") ? c.ref : uriByRef.get(c.ref);
      if (!uri) continue;
      const r = await darkModeImage(uri, c.bg).catch(() => null);
      if (r) features.images.darkMode.push(r);
    }
    const parsed = renderFeaturesSchema.safeParse(features);
    if (!parsed.success) return fail(job, "invalid_features", started, chromiumVersion);
    const aiTiles = job.wantAiTiles ? await makeTiles(captured.dPng, dImg, captured.mPng) : null;
    return {
      id: job.id,
      ok: true,
      error: null,
      features: parsed.data,
      aiTiles,
      renderMs: Math.round(performance.now() - started),
      chromiumVersion,
    };
  } catch {
    return fail(job, "extract_error", started, chromiumVersion);
  }
}

async function closeQuietly(context: { close(): Promise<void> }): Promise<void> {
  try {
    await context.close();
  } catch {
    // The browser may already be gone; the renderer recreates it.
  }
}

export { RENDER_STATUS };
