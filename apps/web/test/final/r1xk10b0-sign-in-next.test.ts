/**
 * R1-41: a signed-out deep link keeps its destination. The proxy carries the path (never the query)
 * to /sign-in as `next`, and the sign-in page sends Google sign-in, the dev form and "Continue to
 * your mail" there — but only for a same-origin app path, so `next` cannot become an open redirect.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const cookieNames = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ has: (name: string) => cookieNames.value.includes(name) }),
}));

const { proxy } = await import("@/proxy");
const { default: SignInPage } = await import("@/app/(auth)/sign-in/page");
const { GoogleSignInButton } = await import("@/components/site/google-button");
const { DevSignIn } = await import("@/app/(auth)/sign-in/dev-sign-in");
const { LinkButton } = await import("@/components/ui/button");

function redirectOf(pathname: string): string | null {
  return proxy(new NextRequest(`https://app.test${pathname}`)).headers.get("location");
}

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const self = node.type === type ? [node as ReactElement<Record<string, unknown>>] : [];
  return [...self, ...find(node.props.children, type)];
}

async function destinations(params: Record<string, string | string[]>) {
  const tree = await SignInPage({ searchParams: Promise.resolve(params) });
  return {
    google: find(tree, GoogleSignInButton).map((e) => e.props.callbackURL),
    dev: find(tree, DevSignIn).map((e) => e.props.next),
    continue: find(tree, LinkButton).map((e) => e.props.href),
  };
}

describe("sign-in keeps a signed-out deep link's destination", () => {
  beforeEach(() => {
    vi.stubEnv("EDF_DEV_LOGIN", "1");
    cookieNames.value = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the proxy carries the path (not the query) as next", () => {
    expect(redirectOf("/email/0f0f-11")).toBe("https://app.test/sign-in?next=%2Femail%2F0f0f-11");
    expect(redirectOf("/senders/news.example?tab=all")).toBe(
      "https://app.test/sign-in?next=%2Fsenders%2Fnews.example",
    );
    expect(redirectOf("/inbox?q=secret")).toBe("https://app.test/sign-in?next=%2Finbox");
    // The default destination and /out (useless without its dropped query) add nothing.
    expect(redirectOf("/gallery")).toBe("https://app.test/sign-in");
    expect(redirectOf("/out?u=https://x.example&t=a")).toBe("https://app.test/sign-in");
  });

  it("the sign-in page sends every sign-in path to a valid next", async () => {
    const d = await destinations({ next: "/email/0f0f-11" });
    expect(d.google).toEqual(["/email/0f0f-11"]);
    expect(d.dev).toEqual(["/email/0f0f-11"]);

    cookieNames.value = ["edf.session_token"];
    expect((await destinations({ next: "/senders/news.example" })).continue).toEqual([
      "/senders/news.example",
    ]);
  });

  it("round-trips: the proxy's next is accepted by the page", async () => {
    const next = new URL(redirectOf("/settings/account")!).searchParams.get("next")!;
    expect((await destinations({ next })).google).toEqual(["/settings/account"]);
  });

  it("rejects anything that is not a same-origin app path (no open redirect)", async () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/today",
      "javascript:alert(1)",
      "/today//evil.example",
      "/email/x?y=1",
      "/email/x#frag",
      "/sign-in",
      "/api/auth/sign-out",
      "/out",
      "today",
      "",
      `/email/${"a".repeat(600)}`,
      // Encoded separators: Better Auth refuses them as a callbackURL, so they must fall back.
      "/email/%2F%2Fevil",
      "/email/%2fevil",
      "/email/a%5Cb",
      "/senders/a%2Fb",
      // Dot segments (plain or encoded) would leave the allowlisted section.
      "/email/../api/auth/sign-out",
      "/connect/../api/mailboxes/google/start",
      "/email/../../anything",
      "/email/..",
      "/email/./x",
      "/email/%2e%2e/api/auth/sign-out",
      "/email/.%2E/api",
    ]) {
      const d = await destinations({ next });
      expect(d.google, next).toEqual(["/gallery"]);
      expect(d.dev, next).toEqual(["/gallery"]);
    }
    expect((await destinations({ next: ["/email/a", "/email/b"] })).google).toEqual(["/gallery"]);
    // Dots inside a segment are not dot segments: sender domains and ids stay valid.
    for (const next of ["/senders/news.example", "/email/...", "/email/.well", "/email/a..b"]) {
      expect((await destinations({ next })).google, next).toEqual([next]);
      // ...and the browser resolves them to themselves (nothing escapes the section).
      expect(new URL(next, "https://app.test").pathname, next).toBe(next);
    }
  });

  it("reauth=connect still returns to /connect; no next goes to the gallery", async () => {
    expect((await destinations({ reauth: "connect", next: "/email/1" })).google).toEqual([
      "/connect",
    ]);
    expect((await destinations({})).google).toEqual(["/gallery"]);
    // The old landing page is now an ordinary deep link.
    expect((await destinations({ next: "/today" })).google).toEqual(["/today"]);
    expect((await destinations({ reauth: "session", next: "/insights" })).google).toEqual([
      "/insights",
    ]);
  });
});
