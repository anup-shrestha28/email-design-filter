/**
 * src/proxy.ts (DESIGN.md §4.1, §11.2; FREE-TIER.md §8.4): optimistic sign-in redirects, a fresh
 * nonce CSP per request (forwarded to the render via the request headers), the dev/prod policy
 * differences, no-referrer on email and /out pages, and a matcher that covers every app page.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

const VIEW = "https://view.test";

function run(pathname: string, cookie?: string) {
  vi.stubEnv("VIEW_ORIGIN", VIEW);
  return proxy(new NextRequest(`https://app.test${pathname}`, { headers: cookie ? { cookie } : {} }));
}

const directives = (policy: string) => new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

describe("proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects app pages to /sign-in without a session cookie, keeping only the path as next", () => {
    for (const [p, loc] of [
      ["/gallery", "https://app.test/sign-in"],
      ["/gallery?category=promotions&open=1", "https://app.test/sign-in"],
      ["/today", "https://app.test/sign-in?next=%2Ftoday"],
      ["/inbox?q=secret", "https://app.test/sign-in?next=%2Finbox"],
      ["/email/123", "https://app.test/sign-in?next=%2Femail%2F123"],
      ["/settings", "https://app.test/sign-in?next=%2Fsettings"],
      ["/system", "https://app.test/sign-in?next=%2Fsystem"],
      ["/connect", "https://app.test/sign-in?next=%2Fconnect"],
      ["/out?u=https://x.example&t=a", "https://app.test/sign-in"],
    ] as const) {
      const res = run(p);
      expect([307, 308], p).toContain(res.status);
      expect(res.headers.get("location"), p).toBe(loc);
    }
    // A cookie with a similar name is not a session cookie.
    expect(run("/gallery", "edf.session_token_x=1").headers.get("location")).toBe("https://app.test/sign-in");
    expect(run("/gallery", "session_token=1").headers.get("location")).toBe("https://app.test/sign-in");
  });

  it("lets public dynamic pages and session holders through (it is not the auth boundary)", () => {
    for (const [p, c] of [
      ["/sign-in", undefined],
      ["/invite/abc", undefined],
      ["/gallery", "edf.session_token=anything"],
      ["/today", "edf.session_token=anything"],
      ["/today", "__Secure-edf.session_token=anything"],
    ] as const) {
      const res = run(p, c);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
    }
    // "/sign-inx" is not the public page.
    expect(run("/sign-inx").headers.get("location")).toBe("https://app.test/sign-in?next=%2Fsign-inx");
  });

  it("sets a fresh nonce CSP per request on the response and on the forwarded request", () => {
    const a = run("/today", "edf.session_token=t");
    const b = run("/today", "edf.session_token=t");
    const pa = a.headers.get("content-security-policy")!;
    const pb = b.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(pa)![1]!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(nonce, "base64").toString()).toMatch(/^[0-9a-f-]{36}$/);
    expect(pb).not.toContain(nonce);
    // Forwarded to the render (NextResponse.next({ request: { headers } })).
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(pa);
    const d = directives(pa);
    expect(d.get("script-src")).toEqual(expect.arrayContaining(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]));
    expect(d.get("script-src")).not.toContain("'unsafe-inline'");
    expect(d.get("frame-src")).toEqual([VIEW]);
    expect(d.get("img-src")).toContain(VIEW);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'none'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'self'", "https://accounts.google.com"]);
  });

  it("development allows eval + websockets for HMR; production forbids them and upgrades insecure requests", () => {
    const dev = directives(run("/today", "edf.session_token=t").headers.get("content-security-policy")!);
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toEqual(["'self'", "ws:", "wss:"]);
    expect(dev.has("upgrade-insecure-requests")).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    const prod = directives(proxy(new NextRequest("https://app.test/today", { headers: { cookie: "__Secure-edf.session_token=t" } })).headers.get("content-security-policy")!);
    expect(prod.get("script-src")).not.toContain("'unsafe-eval'");
    expect(prod.get("connect-src")).toEqual(["'self'"]);
    expect(prod.has("upgrade-insecure-requests")).toBe(true);
  });

  it("no-referrer on email and /out pages only", () => {
    expect(run("/email/0f0f", "edf.session_token=t").headers.get("referrer-policy")).toBe("no-referrer");
    expect(run("/out", "edf.session_token=t").headers.get("referrer-policy")).toBe("no-referrer");
    expect(run("/inbox", "edf.session_token=t").headers.get("referrer-policy")).toBeNull();
  });

  it("the matcher covers every app page (public static pages are the only ones left out)", () => {
    const appDir = fileURLToPath(new URL("../../src/app", import.meta.url));
    const pages: string[] = [];
    const walk = (dir: string, segs: string[]) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "api" || name.startsWith("_")) continue;
          walk(full, /^\(.*\)$/.test(name) ? segs : [...segs, name]);
        } else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) pages.push(`/${segs.join("/")}`);
      }
    };
    walk(appDir, []);
    expect(pages.length).toBeGreaterThan(10);
    const matched = config.matcher.map((m) => m.replace("/:path*", ""));
    const STATIC_PUBLIC = new Set(["/", "/help", "/how-we-score", "/privacy", "/security", "/terms"]);
    const uncovered = pages.filter((p) => {
      const top = `/${p.split("/")[1] ?? ""}`;
      return !STATIC_PUBLIC.has(p) && !matched.includes(top) && top !== "/dev";
    });
    expect(uncovered).toEqual([]);
  });
});
