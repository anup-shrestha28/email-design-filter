/**
 * Local development server for edf-keys on http://localhost:3002 (node:http). Uses the dev OIDC
 * issuer (`DEV_OIDC_JWKS` to verify edf-app, `DEV_OIDC_PRIVATE_JWK` to sign its own audit calls;
 * generate both with `packages/crypto/scripts/gen-keys.ts --dev`). Refuses to run in production.
 */
import { createServer, type IncomingMessage } from "node:http";
import { loadDevConfig, productionLike } from "./config.js";
import { createKeysHandler } from "./handler.js";

if (productionLike(process.env)) {
  console.error("edf-keys dev server refuses to run in a production-like environment");
  process.exit(1);
}

const config = loadDevConfig(process.env);
if (!config.ok) {
  console.error(`edf-keys dev config invalid: ${config.code}`);
  process.exit(1);
}
const handle = createKeysHandler(config);
const PORT = Number(process.env.PORT ?? 3002);

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
  }
  const method = req.method ?? "GET";
  return new Request(`http://localhost:${PORT}${req.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > 64 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    handle(toRequest(req, Buffer.concat(chunks)))
      .then(async (r) => {
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`edf-keys dev server on http://localhost:${PORT}/unwrap`);
});
