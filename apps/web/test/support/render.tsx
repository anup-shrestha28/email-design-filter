/**
 * A small render harness for component tests (jsdom): React 19's createRoot + act(), wrapped in the
 * providers the app shell gives every page (react-query, tooltips, clock) and a stand-in App Router
 * whose calls are recorded. No @testing-library dependency; queries are plain DOM.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClockProvider } from "@/components/providers/clock";
import { TooltipProvider } from "@/components/ui/tooltip";

export interface Rendered {
  container: HTMLElement;
  router: AppRouterInstance & { calls: string[] };
  queryClient: QueryClient;
  rerender(ui: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

const mounted = new Set<Rendered>();

export function stubRouter(): AppRouterInstance & { calls: string[] } {
  const calls: string[] = [];
  const record = (call: string) => {
    calls.push(call);
  };
  return {
    calls,
    bfcacheId: "test",
    back: () => record("back"),
    forward: () => record("forward"),
    refresh: () => record("refresh"),
    push: (href: string) => record(`push:${href}`),
    replace: (href: string) => record(`replace:${href}`),
    prefetch: () => {},
  };
}

export async function render(ui: ReactNode, opts: { now?: number } = {}): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const router = stubRouter();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const clock = { serverNow: opts.now ?? Date.now(), locale: "en-US", timeZone: "UTC" };
  const wrap = (node: ReactNode) => (
    <AppRouterContext.Provider value={router}>
      <QueryClientProvider client={queryClient}>
        <ClockProvider value={clock}>
          <TooltipProvider delay={0}>{node}</TooltipProvider>
        </ClockProvider>
      </QueryClientProvider>
    </AppRouterContext.Provider>
  );
  await act(async () => root.render(wrap(ui)));
  const r: Rendered = {
    container,
    router,
    queryClient,
    rerender: async (next) => {
      await act(async () => root.render(wrap(next)));
    },
    unmount: async () => {
      if (!mounted.delete(r)) return;
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    },
  };
  mounted.add(r);
  return r;
}

export async function cleanup(): Promise<void> {
  for (const r of [...mounted]) await r.unmount();
  document.body.innerHTML = "";
}

/** Click an element inside act() and let the resulting transitions (server action calls) settle. */
export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Wait (inside act) until `check` stops throwing, e.g. for a transition's awaited action. */
export async function waitFor<T>(check: () => T, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      return check();
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeoutMs) throw last;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

/** Buttons by their accessible text (icons are aria-hidden, so this is the visible label). */
export function buttonByText(root: ParentNode, text: string | RegExp): HTMLButtonElement {
  const all = [...root.querySelectorAll("button")];
  const hit = all.find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
  if (!hit) throw new Error(`no button ${String(text)} among: ${all.map((b) => JSON.stringify(b.textContent)).join(", ")}`);
  return hit;
}

export function queryButtonByText(root: ParentNode, text: string | RegExp): HTMLButtonElement | null {
  try {
    return buttonByText(root, text);
  } catch {
    return null;
  }
}

/** The text of each id in an element's aria-describedby (what a screen reader reads after its name). */
export function describedByText(el: Element): string[] {
  const ids = el.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => {
    const target = el.ownerDocument.getElementById(id);
    if (!target) throw new Error(`aria-describedby points at a missing id "${id}"`);
    return target.textContent ?? "";
  });
}
