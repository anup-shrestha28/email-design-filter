import { avatarHue, initialsOf } from "@/lib/avatar";
import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-5 text-[0.5625rem] rounded-[5px]",
  sm: "size-6 text-2xs rounded-md",
  md: "size-8 text-xs rounded-lg",
  lg: "size-10 text-sm rounded-[10px]",
  xl: "size-14 text-lg rounded-xl",
} as const;

/** Sender avatar: initials on a colour derived from the domain. Remote images are never loaded. */
export function SenderAvatar({
  name,
  domain,
  size = "md",
  className,
}: {
  name: string | null;
  domain: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const hue = avatarHue(domain ?? name ?? "?");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold tracking-tight select-none",
        "bg-[oklch(0.93_0.045_var(--h))] text-[oklch(0.42_0.11_var(--h))] ring-1 ring-inset ring-[oklch(0.85_0.06_var(--h)/0.6)]",
        "dark:bg-[oklch(0.32_0.06_var(--h))] dark:text-[oklch(0.88_0.08_var(--h))] dark:ring-[oklch(0.45_0.07_var(--h)/0.5)]",
        SIZES[size],
        className,
      )}
      style={{ "--h": hue } as React.CSSProperties}
    >
      {initialsOf(name, domain)}
    </span>
  );
}
