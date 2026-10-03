/**
 * Local development server for edf-view on http://localhost:3001 (node:http), serving `/v/…` and
 * `/img/…`. Calls edf-app (APP_ORIGIN, e.g. http://localhost:3000) with a dev OIDC token minted
 * from `DEV_OIDC_PRIVATE_JWK` (see packages/crypto/scripts/gen-keys.ts --dev). Refuses to run in
 * any production-like environment.
 */
import { createServer, type IncomingMessage } from "node:http";
import { fetchImage } from "@edf/fetch";
import { createViewApp, defaultLog } from "./app";
import { loadViewConfig, productionLike } from "./config";
import { devTokenSource } from "./oidc";

if (productionLike(process.env)) {
  console.error("edf-view dev server refuses to run in a production-like environment");
  process.exit(1);
}
const env: NodeJS.ProcessEnv = {
  APP_ORIGIN: "http://localhost:3000",
  VIEW_ORIGIN: "http://localhost:3001",
  ...process.env,
};
const cfg = loadViewConfig(env, { dev: true });
if (!cfg.ok) {
  console.error(`edf-view dev config invalid: ${cfg.code}`);
  process.exit(1);
}
if (!env.DEV_OIDC_PRIVATE_JWK) {
  console.error("DEV_OIDC_PRIVATE_JWK is required (packages/crypto/scripts/gen-keys.ts --dev)");
  process.exit(1);
}
const app = createViewApp({
  config: cfg.config,
  // Shared dev issuer (gen-keys --dev); defaults mirror @edf/crypto DEV_OIDC_* constants.
  token: devTokenSource(env.DEV_OIDC_PRIVATE_JWK, {
    issuer: env.DEV_OIDC_ISSUER ?? "https://oidc.dev.invalid/edf-dev",
    subject: env.DEV_VIEW_SUB ?? "dev:edf-view",
    audience: env.DEV_OIDC_AUD ?? "https://vercel.com/edf-dev",
  }),
  fetchApp: fetch,
  fetchImage,
  now: Date.now,
  log: defaultLog,
});
const PORT = Number(new URL(cfg.config.viewOrigin).port || 3001);

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(`http://localhost:${PORT}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}

createServer((req, res) => {
  const request = toRequest(req);
  const path = new URL(request.url).pathname;
  if (path === "/health.gif") {
    res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
    res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
    return;
  }
  const handler = path.startsWith("/v/") ? app.view : path.startsWith("/img/") ? app.img : null;
  if (handler === null) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  // A long-lived process: the stats report runs in the background, like Vercel's waitUntil, so no
  // response waits for it (its promise never rejects).
  handler(request, (p) => void p.catch(() => undefined))
    .then(async (r) => {
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    })
    .catch(() => {
      res.writeHead(500);
      res.end();
    });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`edf-view dev server on ${cfg.config.viewOrigin} (app: ${cfg.config.appOrigin})`);
});
