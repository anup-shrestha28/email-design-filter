import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// R1-30: with `framework: null`, no build command and no output directory, Vercel publishes the
// project root (src/, test/, tsconfig.json, …) as static files. edf-keys must serve only
// `public/` (robots.txt), like edf-view (DECISIONS D-V5, D-K7).
const root = fileURLToPath(new URL("..", import.meta.url));

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("edf-keys static output", () => {
  const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as Record<
    string,
    unknown
  >;

  it("publishes only the public directory, not the project root", () => {
    expect(config.outputDirectory).toBe("public");
    expect(config.framework).toBeNull();
    expect(config.buildCommand).toBeUndefined();
  });

  it("has a public directory containing only robots.txt that disallows crawling", () => {
    const publicDir = join(root, "public");
    expect(existsSync(publicDir)).toBe(true);
    expect(listFiles(publicDir).map((p) => p.slice(publicDir.length + 1))).toEqual(["robots.txt"]);
    expect(readFileSync(join(publicDir, "robots.txt"), "utf8")).toBe(
      "User-agent: *\nDisallow: /\n",
    );
  });

  it("keeps the /unwrap rewrite and the function outside the output directory", () => {
    expect(config.rewrites).toEqual([{ source: "/unwrap", destination: "/api/unwrap" }]);
    expect(Object.keys(config.functions as object)).toEqual(["api/unwrap.ts"]);
  });
});
