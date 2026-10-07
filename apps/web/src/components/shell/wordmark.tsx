import { cn } from "@/lib/cn";

/**
 * Logo mark: Dearly Mail's pink envelope with a gold star (public/logo.png, cut out of the owner's
 * artwork on a transparent background; app/icon.png is the same picture for the browser tab).
 * Decorative: the name always sits beside it or in the link's label.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    // A 25 KB static file at a fixed small size: next/image's optimizer would add nothing.
    <img
      src="/logo.png"
      alt=""
      width={192}
      height={192}
      decoding="async"
      className={cn("size-7 shrink-0 object-contain", className)}
      aria-hidden
    />
  );
}

export function Wordmark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      {compact ? null : (
        <span className="text-[0.9375rem] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-foreground">
          Dearly Mail
        </span>
      )}
    </span>
  );
}
