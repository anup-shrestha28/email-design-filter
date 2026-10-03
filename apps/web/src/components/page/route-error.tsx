"use client";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/button";

/** Shared error boundary body: calm, specific, recoverable. Never shows internals. */
export function RouteError({
  error,
  retry,
  title = "This page didn't load",
  home = true,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  title?: string;
  /** Offer a way back to the designs (off on the gallery itself). */
  home?: boolean;
}) {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center"
    >
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-surface text-warning shadow-raised">
        <TriangleAlert className="size-5" aria-hidden />
      </div>
      <h1 className="mt-4 text-base font-semibold text-foreground">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Something went wrong on our side while loading it. Your mail is safe — nothing was changed.
      </p>
      {error.digest ? (
        <p className="mt-2 font-mono text-2xs text-subtle-foreground">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={retry}>
          <RotateCw aria-hidden />
          Try again
        </Button>
        {home ? (
          <LinkButton href="/gallery" variant="secondary">
            Back to designs
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}
