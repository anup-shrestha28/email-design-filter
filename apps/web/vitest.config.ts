import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = {
  alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    // `server-only` throws outside a React Server Components bundle; tests run server code directly.
    "server-only": fileURLToPath(new URL("./test/support/server-only.ts", import.meta.url)),
  },
};

// Component tests (*.dom.test.tsx) compile JSX with React's automatic runtime, as Next.js does.
// Vite 8 transforms TS/TSX with Oxc (its `esbuild` option is ignored), and Oxc would otherwise follow
// tsconfig's `"jsx": "preserve"` (that setting is for Next's own compiler) and leave JSX untransformed.
const oxc = { jsx: { runtime: "automatic" } } as const;

// Options every test file shares. The per-run database is created once, by the root's globalSetup;
// the projects don't inherit it (`extends: false`), so it isn't dropped and re-migrated per project.
const shared = {
  setupFiles: ["./test/support/setup.ts"],
  testTimeout: 30_000,
  hookTimeout: 60_000,
  // Files share one database (and its global app_setting rows), so they run one at a time.
  fileParallelism: false,
};

export default defineConfig({
  resolve,
  oxc,
  test: {
    ...shared,
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./test/support/global-setup.ts"],
    projects: [
      {
        extends: false,
        resolve,
        oxc,
        test: { ...shared, name: "node", include: ["test/**/*.test.ts"], environment: "node" },
      },
      {
        extends: false,
        resolve,
        oxc,
        test: {
          ...shared,
          name: "dom",
          include: ["test/**/*.dom.test.tsx"],
          environment: "jsdom",
          setupFiles: [...shared.setupFiles, "./test/support/dom-setup.ts"],
        },
      },
    ],
  },
});
