"use client";
import Link from "next/link";
import {
  ChartColumn,
  CircleHelp,
  Gauge,
  Inbox,
  Keyboard,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Server,
  Settings,
  Sun,
  Sunrise,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useDateContext } from "@/components/providers/clock";
import { useSync } from "@/components/providers/sync";
import { toast } from "sonner";
import { SenderAvatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/format";
import type { ThemePreference } from "@/lib/theme";
import { isActionableBanner } from "./banners";
import { useShell } from "./shell-context";

export interface ShellUser {
  name: string;
  email: string;
  role: "owner" | "friend";
}

export function useSignOut() {
  const [pending, setPending] = useState(false);
  return {
    pending,
    signOutNow: async () => {
      setPending(true);
      try {
        await signOut();
        window.location.assign("/sign-in");
      } catch {
        setPending(false);
        toast.error("Couldn't sign you out. Please try again.");
      }
    },
  };
}

export function ThemeRadioItems() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePreference)}>
        <DropdownMenuRadioItem value="system" icon={<Monitor aria-hidden />} closeOnClick={false}>
          System
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="light" icon={<Sun aria-hidden />} closeOnClick={false}>
          Light
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark" icon={<Moon aria-hidden />} closeOnClick={false}>
          Dark
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** Pages that still work but stay out of the way: the everyday screen is the design gallery. */
const MORE_TOOLS = [
  { href: "/inbox", label: "Inbox list", icon: Inbox },
  { href: "/senders", label: "Senders", icon: Users },
  { href: "/insights", label: "Insights", icon: ChartColumn },
  { href: "/today", label: "Today", icon: Sunrise },
] as const;

/** Sync status and any informational notice, kept here so the gallery stays calm. */
function StatusItems() {
  const { status, syncing, refresh } = useSync();
  const c = useDateContext();
  const note = status.banner && !isActionableBanner(status.banner) ? status.banner.text : null;
  const synced =
    status.mailboxes.length === 0
      ? "No Gmail connected yet"
      : syncing
        ? "Checking for new mail…"
        : status.lastSyncedAt
          ? `Synced ${formatRelative(status.lastSyncedAt, c)}`
          : "Waiting for the first sync";
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Status</DropdownMenuLabel>
      <div className="px-2 pb-1.5 text-xs leading-relaxed text-muted-foreground" role="status">
        <p className="flex items-center gap-1.5">
          {syncing ? (
            <LoaderCircle className="size-3.5 animate-spin text-accent" aria-hidden />
          ) : (
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                status.mailboxes.length ? "bg-success" : "bg-border-strong",
              )}
            />
          )}
          {synced}
        </p>
        {note ? <p className="mt-1 max-w-[16rem] text-2xs text-subtle-foreground">{note}</p> : null}
      </div>
      {status.mailboxes.length > 0 && !syncing ? (
        <DropdownMenuItem icon={<RefreshCw aria-hidden />} onClick={refresh} closeOnClick={false}>
          Check for new mail
        </DropdownMenuItem>
      ) : null}
    </DropdownMenuGroup>
  );
}

/** The one menu in the top bar: account, settings, the other tools, help, theme, sign out. */
export function UserMenu({ user, className }: { user: ShellUser; className?: string }) {
  const { setShortcutsOpen } = useShell();
  const { signOutNow } = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${user.name}`}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full transition-shadow hover:ring-2 hover:ring-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-popup-open:ring-2 data-popup-open:ring-border",
          className,
        )}
      >
        <SenderAvatar name={user.name} domain={user.email} size="md" className="rounded-full" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-64">
        <div className="px-2 pt-1.5 pb-2">
          <p className="truncate text-[0.8125rem] font-medium text-foreground">{user.name}</p>
          <p className="truncate text-2xs text-subtle-foreground">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem render={<Link href="/settings" />} icon={<Settings aria-hidden />}>
          Settings
        </DropdownMenuLinkItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>More tools</DropdownMenuLabel>
          {MORE_TOOLS.map((t) => (
            <DropdownMenuLinkItem
              key={t.href}
              render={<Link href={t.href} />}
              icon={<t.icon aria-hidden />}
            >
              {t.label}
            </DropdownMenuLinkItem>
          ))}
          {user.role === "owner" ? (
            <DropdownMenuLinkItem render={<Link href="/system" />} icon={<Server aria-hidden />}>
              System
            </DropdownMenuLinkItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="/help" icon={<CircleHelp aria-hidden />}>
          Help
        </DropdownMenuLinkItem>
        <DropdownMenuLinkItem href="/how-we-score" icon={<Gauge aria-hidden />}>
          How we judge designs
        </DropdownMenuLinkItem>
        <DropdownMenuItem
          icon={<Keyboard aria-hidden />}
          shortcut="?"
          onClick={() => setShortcutsOpen(true)}
          className="hidden sm:flex"
        >
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ThemeRadioItems />
        <DropdownMenuSeparator />
        <StatusItems />
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<LogOut aria-hidden />} onClick={signOutNow}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
