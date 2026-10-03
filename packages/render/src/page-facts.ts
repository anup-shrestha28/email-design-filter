/**
 * Facts read inside the page with page JavaScript disabled (DESIGN.md §6.2 "axe is injected via
 * CDP evaluation … needs a week-1 spike").
 *
 * Verified with Chrome 148 + puppeteer-core 25.12 (see packages/design/DECISIONS.md):
 * - `Emulation.setScriptExecutionDisabled` (JS off) blocks page scripts, but `Runtime.evaluate`
 *   still runs — both in the main world and in an isolated world from `Page.createIsolatedWorld`.
 * - Microtasks run; timers (`setTimeout`) never fire, so `axe.run()` never resolves. A
 *   microtask-based `setTimeout` shim installed in the isolated world fixes that without
 *   touching the page's own world.
 * - Everything runs in an isolated world, so email markup can't tamper with axe's globals, and
 *   CSP (`script-src 'none'`) doesn't apply to DevTools evaluation.
 */
import type { CDPSession } from "puppeteer-core";
import type { PageFacts } from "./extract";

const SHIM = `(() => {
  let id = 0;
  const cancelled = new Set();
  globalThis.setTimeout = (fn, _ms, ...args) => {
    const handle = ++id;
    queueMicrotask(() => { if (!cancelled.has(handle)) { try { fn(...args); } catch (e) {} } });
    return handle;
  };
  globalThis.clearTimeout = (handle) => { cancelled.add(handle); };
  globalThis.requestAnimationFrame = (fn) => globalThis.setTimeout(() => fn(0), 0);
  return true;
})()`;

const COLLECT = `(async () => {
  const naturals = [];
  for (const img of Array.from(document.querySelectorAll("img[data-edf-i]")).slice(0, 2000)) {
    naturals.push([Number(img.getAttribute("data-edf-i")), img.naturalWidth || 0, img.naturalHeight || 0]);
  }
  let axeOut = null;
  if (typeof axe === "object" && axe) {
    try {
      const res = await axe.run(document, { resultTypes: ["violations"], elementRef: false, selectors: false, ancestry: false, xpath: false });
      const violations = res.violations.slice(0, 30).map((v) => [String(v.id).slice(0, 48), v.nodes.length]);
      axe.setup(document);
      let layout = 0;
      let presentational = 0;
      for (const t of Array.from(document.querySelectorAll("table")).slice(0, 2000)) {
        let data = false;
        try { data = axe.commons.table.isDataTable(t); } catch (e) { data = false; }
        if (!data) {
          layout++;
          const role = (t.getAttribute("role") || "").trim().toLowerCase();
          if (role === "presentation" || role === "none") presentational++;
        }
      }
      axe.teardown();
      axeOut = { layoutTables: layout, presentationalLayoutTables: presentational, violations };
    } catch (e) {
      axeOut = null;
    }
  }
  return { naturals, axe: axeOut };
})()`;

interface CollectResult {
  naturals: Array<[number, number, number]>;
  axe: {
    layoutTables: number;
    presentationalLayoutTables: number;
    violations: Array<[string, number]>;
  } | null;
}

function isCollectResult(v: unknown): v is CollectResult {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as { naturals?: unknown }).naturals)
  );
}

/** Run axe and read natural image sizes in an isolated world (pass D). */
export async function collectPageFacts(
  cdp: CDPSession,
  frameId: string,
  axeSource: string | null | undefined,
): Promise<PageFacts> {
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "edf-facts",
    grantUniveralAccess: false,
  });
  const evaluate = async (expression: string, awaitPromise: boolean): Promise<unknown> => {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise,
      silent: true,
    });
    if (r.exceptionDetails) throw new Error("page_facts_exception");
    return r.result.value;
  };
  await evaluate(SHIM, false);
  if (axeSource) {
    try {
      await evaluate(`${axeSource}\n;true`, false);
    } catch {
      // axe failed to load: facts without axe.
    }
  }
  const raw = await evaluate(COLLECT, true);
  const naturals = new Map<number, { w: number; h: number }>();
  if (!isCollectResult(raw)) return { naturals, axe: null };
  for (const [i, w, h] of raw.naturals) {
    if (Number.isInteger(i) && i >= 0) naturals.set(i, { w: Number(w) || 0, h: Number(h) || 0 });
  }
  const axe = raw.axe
    ? {
        layoutTables: Math.max(0, Math.floor(Number(raw.axe.layoutTables) || 0)),
        presentationalLayoutTables: Math.max(
          0,
          Math.floor(Number(raw.axe.presentationalLayoutTables) || 0),
        ),
        violations: raw.axe.violations
          .filter((v): v is [string, number] => Array.isArray(v) && typeof v[0] === "string")
          .map(
            ([id, n]) =>
              [id.slice(0, 48), Math.max(0, Math.floor(Number(n) || 0))] as [string, number],
          ),
      }
    : null;
  return { naturals, axe };
}
