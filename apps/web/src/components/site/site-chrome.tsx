import Link from "next/link";
import type { ReactNode } from "react";
import { LinkButton } from "@/components/ui/button";
import { Wordmark } from "@/components/shell/wordmark";

const NAV = [
  { href: "/how-we-score", label: "How we judge designs" },
  { href: "/privacy", label: "Privacy" },
  { href: "/security", label: "Security" },
  { href: "/help", label: "Help" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="rounded-md" aria-label="Dearly Mail home">
          <Wordmark />
        </Link>
        <nav aria-label="Site" className="ml-auto hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <LinkButton href="/sign-in" variant="primary" size="sm" className="ml-auto md:ml-2">
          Sign in
        </LinkButton>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.2fr_1fr]">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-md text-xs leading-relaxed text-muted-foreground">
            Dearly Mail&apos;s use and transfer of information received from Google APIs
            will adhere to the Google API Services User Data Policy, including the Limited Use
            requirements.
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {[...NAV, { href: "/terms", label: "Terms" }, { href: "/sign-in", label: "Sign in" }].map(
            (n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-muted-foreground hover:text-foreground"
              >
                {n.label}
              </Link>
            ),
          )}
        </nav>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-2xs text-subtle-foreground sm:px-6">
        A private, invite-only app. Not affiliated with Google or Anthropic.
      </p>
    </footer>
  );
}

/** Long-form page frame: title, summary, optional table of contents, prose body. */
export function ProsePage({
  eyebrow,
  title,
  summary,
  updated,
  toc,
  children,
}: {
  eyebrow?: string;
  title: string;
  summary: ReactNode;
  updated?: string;
  toc?: Array<{ id: string; label: string }>;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-12 sm:px-6 sm:pt-16">
      <div className="max-w-3xl">
        {eyebrow ? <p className="text-sm font-medium text-accent">{eyebrow}</p> : null}
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-balance text-foreground sm:text-4xl">
          {title}
        </h1>
        <div className="mt-4 text-lg leading-relaxed text-muted-foreground">{summary}</div>
        {updated ? (
          <p className="mt-4 text-xs text-subtle-foreground">Last updated {updated}</p>
        ) : null}
      </div>
      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_14rem]">
        <article className="prose-edf max-w-3xl">{children}</article>
        {toc?.length ? (
          <nav aria-label="On this page" className="hidden lg:block">
            <div className="sticky top-24">
              <p className="text-xs font-semibold text-foreground">On this page</p>
              <ul className="mt-3 flex flex-col gap-2 border-l border-border text-[0.8125rem]">
                {toc.map((t) => (
                  <li key={t.id}>
                    <a
                      href={`#${t.id}`}
                      className="-ml-px block border-l border-transparent pl-3 text-muted-foreground hover:border-foreground hover:text-foreground"
                    >
                      {t.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
