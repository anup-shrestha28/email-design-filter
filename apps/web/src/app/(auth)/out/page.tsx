import type { Metadata } from "next";
import { ArrowUpRight, Globe, Link2Off, TriangleAlert } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { checkOutRequest } from "@/server/out";
import { requireUser } from "@/server/session";
import { GoBack } from "./go-back";

export const metadata: Metadata = { title: "Leaving Dearly Mail", referrer: "no-referrer" };

/** Link interstitial (DESIGN.md §11.5): shows the real host, flags trackers, never redirects by itself. */
export default async function OutPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string | string[]; t?: string | string[] }>;
}) {
  const user = await requireUser();
  const check = checkOutRequest(user, await searchParams);

  if (!check.ok) {
    return (
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 text-center shadow-overlay sm:p-8">
        <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-warning-soft text-warning">
          <Link2Off className="size-5" aria-hidden />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-foreground">We can&apos;t open this link</h1>
        <p className="mt-2 text-sm text-muted-foreground">{check.reason}</p>
        <div className="mt-6 flex justify-center gap-2">
          <GoBack />
          <LinkButton href="/inbox" variant="secondary">
            Inbox
          </LinkButton>
        </div>
      </div>
    );
  }

  const shownHost = check.hostUnicode ?? check.host;
  return (
    <div className="w-full max-w-lg">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-overlay sm:p-8">
        <p className="text-xs font-medium text-muted-foreground">
          You&apos;re about to leave Dearly Mail
        </p>
        <h1 className="mt-4 flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-muted-foreground">
            <Globe className="size-5" aria-hidden />
          </span>
          <span className="min-w-0 text-2xl font-semibold tracking-[-0.025em] break-all text-foreground">
            {shownHost}
          </span>
        </h1>
        {check.hostUnicode ? (
          <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-xs leading-relaxed text-foreground">
            <span className="font-semibold">Check the address:</span> this site&apos;s real address
            is <code className="font-mono font-semibold">{check.host}</code>. Some characters can
            look like others.
          </p>
        ) : null}
        <p className="mt-4 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
          Full link
        </p>
        <p className="mt-1 max-h-28 overflow-y-auto rounded-lg border border-border bg-surface-muted/50 px-3 py-2 font-mono text-xs leading-relaxed break-all text-muted-foreground">
          {check.url}
        </p>
        {check.trackingRedirect ? (
          <div className="mt-4 flex gap-3 rounded-lg border border-warning/30 bg-warning-soft/60 p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 text-xs leading-relaxed text-foreground">
              <p className="font-semibold">This goes through a click-tracking link</p>
              <p className="mt-0.5 text-foreground/80">
                The sender will know you clicked before you reach the page.
              </p>
              {check.embeddedDestination ? (
                <p className="mt-1.5 break-all text-foreground/80">
                  It says it leads to:{" "}
                  <span className="font-mono">{check.embeddedDestination}</span> (not checked by
                  us).
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <GoBack />
          <a
            href={check.url}
            rel="noopener noreferrer nofollow"
            target="_self"
            referrerPolicy="no-referrer"
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-[0.9375rem] font-medium text-accent-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.12)] transition-colors hover:bg-accent-hover"
          >
            Continue to site
            <ArrowUpRight className="size-4" aria-hidden />
          </a>
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-subtle-foreground">
        We never open links for you — not even unsubscribe links.
      </p>
    </div>
  );
}
