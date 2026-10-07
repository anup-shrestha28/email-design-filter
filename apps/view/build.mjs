// Bundles the two edf-view functions for Vercel (FREE-TIER.md §3: plain Node functions, no
// framework): src/v.ts → api/v.js, src/img.ts → api/img.js. Workspace code (@edf/fetch) and its
// dependencies (undici, ipaddr.js, tldts) are bundled in; only node: built-ins and sharp stay external.
// public/ (robots.txt and health.gif) is the static output directory, so the project root (sources) is
// never served as static files. Commit api/*.js: Vercel discovers functions from repository
// files; CI should rebuild and fail on a diff (see packages/crypto/DECISIONS.md D-V5).
import { build } from "esbuild";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
  // CommonJS dependencies call require() for node built-ins; give the ESM bundle a real require.
  banner: {
    js: "import { createRequire as __edfCreateRequire } from 'node:module'; const require = __edfCreateRequire(import.meta.url);",
  },
};

await build({
  ...common,
  entryPoints: { v: "src/v.ts", img: "src/img.ts" },
  // sharp (img.js only, resize.ts) loads its native libvips binary at run time: left as an import
  // that Vercel's file tracing resolves in node_modules (@img/sharp-linux-x64).
  external: ["sharp"],
  outdir: "api",
  outExtension: { ".js": ".js" },
});
await mkdir("public", { recursive: true });
await writeFile("public/robots.txt", "User-agent: *\nDisallow: /\n");
// Reachability probe for edf-app's email viewer: a static 1x1 transparent GIF (no function call).
await writeFile("public/health.gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
