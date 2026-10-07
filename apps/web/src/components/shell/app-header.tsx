"use client";
import { Bookmark } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { GallerySearch } from "@/components/gallery/gallery-search";
import { cn } from "@/lib/cn";
import { UserMenu, type ShellUser } from "./user-menu";
import { LogoMark } from "./wordmark";

/**
 * The slim top bar on every app page: the logo (home is the design gallery), the search (on phones
 * it moves into the gallery's filter bar), your boards (saved designs) and the account menu, which
 * holds everything else.
 */
export function AppHeader({ user }: { user: ShellUser }) {
  const pathname = usePathname();
  const onGallery = pathname === "/gallery";
  const onBoards = pathname === "/boards";
  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6 lg:px-8">
      <Link
        href="/gallery"
        aria-label="Dearly Mail — all designs"
        aria-current={onGallery ? "page" : undefined}
        className="flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <LogoMark className="size-7" />
        <span className="text-[0.9375rem] font-semibold tracking-[-0.02em] whitespace-nowrap text-foreground">
          Dearly Mail
        </span>
      </Link>
      <div className="flex min-w-0 flex-1 justify-center">
        <GallerySearch className={cn("hidden w-full max-w-md md:block")} />
      </div>
      <Link
        href="/boards"
        aria-current={onBoards ? "page" : undefined}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          onBoards && "bg-surface-muted text-foreground",
        )}
      >
        <Bookmark aria-hidden className="size-4" />
        Boards
      </Link>
      <UserMenu user={user} />
    </header>
  );
}
