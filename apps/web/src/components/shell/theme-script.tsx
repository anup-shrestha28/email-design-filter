import { THEME_SCRIPT } from "@/lib/theme";

/**
 * Applies the saved theme before first paint. Public pages run it without a nonce (their static
 * CSP allows inline scripts); app pages pass the per-request nonce from proxy.ts.
 * The script type flips to text/plain on the client so React never re-executes it.
 */
export function ThemeScript({ nonce }: { nonce?: string }) {
  return (
    <script
      nonce={nonce}
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
    />
  );
}
