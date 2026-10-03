"use client";
import "./globals.css";

/** Last-resort boundary (root layout failed). Keeps styling minimal and self-contained. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div>
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Please try again. Your mail is safe — nothing was changed.
          </p>
          {error.digest ? (
            <p className="mt-2 font-mono text-xs text-subtle-foreground">
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={retry}
            className="mt-5 h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
