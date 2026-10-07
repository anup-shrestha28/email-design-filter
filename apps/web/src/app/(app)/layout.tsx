import type { Metadata } from "next";
import { AppProviders } from "@/components/providers/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { ThemeScript } from "@/components/shell/theme-script";
import { requestContext } from "@/lib/request-context";
import { getSyncStatus } from "@/server/queries/account";
import type { SyncStatus } from "@/server/queries/types";
import { requireUser } from "@/server/session";

export const metadata: Metadata = {
  title: { default: "Dearly Mail", template: "%s · Dearly Mail" },
};

const NO_SYNC: SyncStatus = { mailboxes: [], syncing: false, lastSyncedAt: null, banner: null };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [{ nonce, clock, deviceTimeZone }, sync] = await Promise.all([
    requestContext(user.userId),
    getSyncStatus(user.userId).catch((): SyncStatus => NO_SYNC),
  ]);
  return (
    <>
      <ThemeScript nonce={nonce} />
      <AppProviders clock={clock} deviceTimeZone={deviceTimeZone} sync={sync}>
        <AppShell user={{ name: user.name, email: user.email, role: user.role }}>
          {children}
        </AppShell>
      </AppProviders>
    </>
  );
}
