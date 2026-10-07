import Link from "next/link";
import { Wordmark } from "@/components/shell/wordmark";

/** Static 404 for unmatched URLs (never touches the database). */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <Link href="/" className="rounded-md" aria-label="Dearly Mail home">
        <Wordmark />
      </Link>
      <p className="mt-12 font-mono text-sm font-medium text-accent">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-foreground">
        This page doesn&apos;t exist
      </h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The link may be old or mistyped.
      </p>
      <div className="mt-6 flex gap-2">
        <Link
          href="/gallery"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
        >
          Go to your designs
        </Link>
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-foreground hover:bg-surface-muted"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
