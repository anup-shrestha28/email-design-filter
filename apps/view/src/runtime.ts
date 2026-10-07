/**
 * Lazily built production runtime shared by the two function entry points (each bundle has its
 * own copy). `fetchImage` and `shrinkImage` are injected by the entry point so that api/v.js doesn't
 * bundle the image fetcher or sharp (smaller cold start). Misconfiguration fails closed: every request gets a 503.
 */
import type { fetchImage as FetchImage } from "@edf/fetch";
import type { ShrinkImage } from "./resize";
import { createViewApp, defaultLog, type ViewApp } from "./app";
import { loadViewConfig } from "./config";
import { vercelTokenSource } from "./oidc";

let built: { app: ViewApp } | { code: string } | null = null;

export function runtime(
  fetchImage: typeof FetchImage,
  shrinkImage?: ShrinkImage,
): { app: ViewApp } | { code: string } {
  if (built !== null) return built;
  const cfg = loadViewConfig(process.env);
  if (!cfg.ok) {
    defaultLog({ ev: "misconfigured", code: cfg.code });
    built = { code: cfg.code };
    return built;
  }
  built = {
    app: createViewApp({
      config: cfg.config,
      token: vercelTokenSource,
      fetchApp: fetch,
      fetchImage,
      ...(shrinkImage === undefined ? {} : { shrinkImage }),
      now: Date.now,
      log: defaultLog,
    }),
  };
  return built;
}

/** The view route never fetches images. */
export const noImageFetch: typeof FetchImage = async () => ({ ok: false, reason: "network" });

export function unavailable(): Response {
  return new Response("Service unavailable", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
