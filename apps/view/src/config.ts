/**
 * edf-view configuration (FREE-TIER.md §11 step 8): `IMG_PUBKEYS` (Ed25519 public keys only),
 * `APP_ORIGIN`, `VIEW_ORIGIN`. No secrets. (`APP_VIEW_SOURCE_AUD` is not needed at runtime:
 * edf-view sends its plain function token and edf-app pins the audience; DECISIONS.md D-O1.)
 */
import type { KeyObject } from "node:crypto";
import { parseImagePublicKeys } from "./tokens";

export interface ViewConfig {
  imgKeys: ReadonlyMap<string, KeyObject>;
  appOrigin: string;
  viewOrigin: string;
}

export type ViewConfigResult = { ok: true; config: ViewConfig } | { ok: false; code: string };

export function productionLike(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "production" ||
    (typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV !== "") ||
    env.VERCEL === "1"
  );
}

function origin(v: string | undefined, dev: boolean): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.origin !== v) return null; // no path, query, credentials or trailing slash
    if (u.protocol === "https:") return u.origin;
    if (dev && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))
      return u.origin;
  } catch {
    // fall through
  }
  return null;
}

export function loadViewConfig(
  env: NodeJS.ProcessEnv,
  opts: { dev?: boolean } = {},
): ViewConfigResult {
  const dev = opts.dev === true;
  if (dev && productionLike(env)) return { ok: false, code: "dev_in_production" };
  // FREE-TIER.md §1.3 rule 7 and §3: edf-view holds no secrets at all.
  if (env.VERCEL_TOKEN || env.VERCEL_API_TOKEN || env.VERCEL_ACCESS_TOKEN)
    return { ok: false, code: "vercel_token_present" };
  const imgKeys = parseImagePublicKeys(env.IMG_PUBKEYS);
  if (imgKeys === null) return { ok: false, code: "img_pubkeys" };
  const appOrigin = origin(env.APP_ORIGIN, dev);
  const viewOrigin = origin(env.VIEW_ORIGIN, dev);
  if (appOrigin === null) return { ok: false, code: "app_origin" };
  if (viewOrigin === null) return { ok: false, code: "view_origin" };
  if (
    appOrigin === viewOrigin ||
    (!dev && new URL(appOrigin).hostname === new URL(viewOrigin).hostname)
  ) {
    return { ok: false, code: "origins_not_separate" };
  }
  return { ok: true, config: { imgKeys, appOrigin, viewOrigin } };
}
