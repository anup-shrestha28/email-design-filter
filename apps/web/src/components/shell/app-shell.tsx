import type { ReactNode } from "react";
import { AppHeader } from "./app-header";
import { Banners } from "./banners";
import { CommandPalette } from "./command-palette";
import { ShellProvider } from "./shell-context";
import { GlobalHotkeys, ShortcutsDialog } from "./shortcuts";
import type { ShellUser } from "./user-menu";

/**
 * App frame: a slim top bar (logo, search, account menu), actionable banners, and one scroll
 * container for the page. No sidebar and no bottom tab bar: the design gallery is the home screen
 * and the other tools sit in the account menu.
 */
export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  return (
    <ShellProvider>
      <a
        href="#main"
        className="sr-only z-[100] rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <div className="flex h-dvh flex-col overflow-hidden">
        <AppHeader user={user} />
        <Banners />
        <main
          id="main"
          tabIndex={-1}
          className="relative min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] outline-none"
        >
          {children}
        </main>
      </div>
      <CommandPalette user={user} />
      <ShortcutsDialog />
      <GlobalHotkeys />
    </ShellProvider>
  );
}
