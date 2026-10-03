import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { ThemeScript } from "@/components/shell/theme-script";

/**
 * Public pages: static, no session, no database (FREE-TIER.md §8.4). The static CSP allows this
 * inline theme script; no nonce is needed.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeScript />
      <a
        href="#main"
        className="sr-only z-[100] rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
