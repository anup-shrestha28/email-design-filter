import Link from "next/link";
import { AppProviders } from "@/components/providers/app-providers";
import { ThemeScript } from "@/components/shell/theme-script";
import { Wordmark } from "@/components/shell/wordmark";
import { requestContext } from "@/lib/request-context";

/** Focused, centered layout for sign-in, invites, the Gmail disclosure and the link interstitial. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { nonce, clock } = await requestContext();
  return (
    <>
      <ThemeScript nonce={nonce} />
      <AppProviders clock={clock}>
        <div className="relative flex min-h-dvh flex-col overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(ellipse_60%_60%_at_50%_-10%,color-mix(in_oklch,var(--accent)_14%,transparent),transparent)]"
          />
          <header className="relative flex h-16 items-center px-5 sm:px-8">
            <Link href="/" className="rounded-md" aria-label="Email Design Filter home">
              <Wordmark />
            </Link>
          </header>
          <main
            id="main"
            className="relative flex flex-1 flex-col items-center px-4 pt-6 pb-16 sm:pt-12"
          >
            {children}
          </main>
          <footer className="relative flex flex-wrap items-center justify-center gap-x-5 gap-y-2 px-4 pb-6 text-xs text-subtle-foreground">
            <a href="/privacy" className="hover:text-foreground">
              Privacy
            </a>
            <a href="/terms" className="hover:text-foreground">
              Terms
            </a>
            <a href="/security" className="hover:text-foreground">
              Security
            </a>
            <a href="/help" className="hover:text-foreground">
              Help
            </a>
          </footer>
        </div>
      </AppProviders>
    </>
  );
}
