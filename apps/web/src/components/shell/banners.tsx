"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useSync } from "@/components/providers/sync";
import { cn } from "@/lib/cn";
import type { SyncStatus } from "@/server/queries/types";

const STYLE = {
  info: { icon: Info, className: "bg-info-soft text-info", ring: "border-info/20" },
  warning: {
    icon: TriangleAlert,
    className: "bg-warning-soft text-warning",
    ring: "border-warning/25",
  },
  error: { icon: CircleAlert, className: "bg-danger-soft text-danger", ring: "border-danger/25" },
} as const;

type Banner = NonNullable<SyncStatus["banner"]>;

/**
 * Something the reader can act on (connect or reconnect Gmail) or an app-wide stop (error level).
 * Anything else is status: it lives in the account menu, and the gallery shows no banner for it.
 */
export function isActionableBanner(banner: Banner): boolean {
  return banner.level === "error" || banner.id === "connect" || banner.id.startsWith("reauth:");
}

/** Sync / governor banners ("What users see", FREE-TIER.md §8.3). */
export function Banners() {
  const { status } = useSync();
  const pathname = usePathname();
  // Keyed on the banner's id, not its text: an import's text carries a live count that changes on
  // every sync poll, and a dismissed banner must not come back because a number went up.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const banner = status.banner;
  if (!banner || dismissed === banner.id) return null;
  // The gallery stays calm: purely informational status is in the account menu instead.
  if (pathname === "/gallery" && !isActionableBanner(banner)) return null;
  // Those pages carry their own "connect" call to action (on the gallery, its empty state);
  // app-wide banners (a frozen app) still show.
  if (banner.id === "connect" && ["/gallery", "/today", "/connect"].includes(pathname)) return null;
  const s = STYLE[banner.level];
  const Icon = s.icon;
  const action =
    banner.id === "connect"
      ? { href: "/connect" as const, label: "Connect Gmail" }
      : banner.id.startsWith("reauth:")
        ? { href: "/settings" as const, label: "Reconnect" }
        : null;
  return (
    <div
      role={banner.level === "error" ? "alert" : "status"}
      className={cn("border-b px-3 py-2 sm:px-4", s.className, s.ring)}
    >
      <div className="flex items-center gap-2.5 text-[0.8125rem]">
        <Icon className="size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 font-medium text-foreground">{banner.text}</p>
        {action ? (
          <Link
            href={action.href}
            className="shrink-0 rounded-md px-2 py-1 font-semibold underline-offset-4 hover:underline"
          >
            {action.label}
          </Link>
        ) : null}
        {banner.level === "info" ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissed(banner.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
