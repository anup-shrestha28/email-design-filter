/**
 * R1-42: the static CSP that next.config.ts sends to public pages and 404s must allow 'unsafe-eval'
 * under the dev server (React's dev build calls eval(); without it the dev overlay reports an issue
 * on every public page), and must never allow it in production.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function staticCspFor(nodeEnv: string): Promise<string> {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.resetModules();
  const { default: config } = await import("../../next.config");
  const rules = await config.headers!();
  const value = rules
    .flatMap((r) => r.headers)
    .find((h) => h.key === "Content-Security-Policy")?.value;
  if (!value) throw new Error("no static CSP");
  return value;
}

function scriptSrc(csp: string): string {
  return csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("static CSP script-src", () => {
  it("allows 'unsafe-eval' in development", async () => {
    expect(scriptSrc(await staticCspFor("development"))).toBe(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
  });

  it("never allows 'unsafe-eval' in production", async () => {
    const csp = await staticCspFor("production");
    expect(scriptSrc(csp)).toBe("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });
});
