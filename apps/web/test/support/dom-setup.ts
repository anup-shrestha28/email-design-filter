/**
 * Per-file setup for component tests (*.dom.test.tsx, jsdom): tell React it runs under act(), and
 * unmount whatever a test rendered so the next test starts from an empty document.
 */
import { afterEach } from "vitest";
import { cleanup } from "./render";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await cleanup();
});
