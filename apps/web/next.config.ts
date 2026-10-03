import type { NextConfig } from "next";

/**
 * Security headers (DESIGN.md §11.2; FREE-TIER.md §9.1). App pages get a per-request nonce CSP
 * from src/proxy.ts; public pages are static and get the static CSP below (they carry no user
 * data and never touch the database — FREE-TIER.md §8.4).
 */
const baseHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), interest-cohort=()",
  },
];

// React's development build uses eval() (debug stacks, the Flight client's eval check), so the dev
// server needs 'unsafe-eval', as proxy.ts's nonce CSP already allows; production never gets it.
const dev = process.env.NODE_ENV !== "production";

const staticCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: [
    "@edf/budget",
    "@edf/core",
    "@edf/crypto",
    "@edf/db",
    "@edf/design",
    "@edf/fetch",
    "@edf/gmail",
    "@edf/pipeline",
    "@edf/render",
    "@edf/sanitize",
  ],
  // Native / heavy server-only dependencies stay external (loaded lazily inside jobs).
  serverExternalPackages: [
    "pg",
    "jsdom",
    "dompurify",
    "puppeteer-core",
    "sharp",
    "axe-core",
    "@vercel/sandbox",
    "google-auth-library",
    "postal-mime",
    "juice",
    "franc-min",
  ],
  // The Sandbox VM's render bundle is read at runtime by the Inngest function (pipeline-deps.ts).
  outputFileTracingIncludes: { "/api/inngest": ["../../packages/render/dist/render.js"] },
  images: { unoptimized: true }, // next/image is never used for sender images (DESIGN.md §11.5)
  async headers() {
    return [
      { source: "/:path*", headers: baseHeaders },
      {
        // Everything that proxy.ts does not handle: static public pages, 404s.
        source:
          "/((?!gallery|today|inbox|email|senders|insights|settings|system|connect|sign-in|invite|out|api|_next).*)",
        headers: [{ key: "Content-Security-Policy", value: staticCsp }],
      },
    ];
  },
};

export default nextConfig;
