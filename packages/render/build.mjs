/**
 * Bundles the in-VM entry (src/vm/main.ts) into dist/render.js for the Sandbox snapshot
 * (FREE-TIER.md §5.1). Native / large dependencies live in the snapshot's node_modules and are
 * external: puppeteer-core, sharp, axe-core, dompurify, jsdom.
 *
 *   pnpm --filter @edf/render build
 */
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "node:console";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "dist/render.js");
// css-tree 3.2.1 is shared by @edf/design and @edf/sanitize (same pinned version).
const cssTreeDist = createRequire(join(here, "../design/package.json")).resolve(
  "css-tree/dist/csstree.esm",
);
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(here, "src/vm/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "inline",
  external: ["puppeteer-core", "sharp", "axe-core", "dompurify", "jsdom", "@vercel/sandbox"],
  // Bundled CommonJS dependencies may call require() for Node built-ins.
  banner: {
    js: 'import { createRequire as __edfCreateRequire } from "node:module";\nconst require = __edfCreateRequire(import.meta.url);',
  },
  // css-tree's ESM entry loads its data JSON through createRequire with relative paths, which
  // a bundle can't satisfy; its prebuilt ESM dist embeds the data.
  alias: { "css-tree": cssTreeDist },
  logLevel: "warning",
});

log(`dist/render.js ${(statSync(outfile).size / 1024).toFixed(0)} KB`);
