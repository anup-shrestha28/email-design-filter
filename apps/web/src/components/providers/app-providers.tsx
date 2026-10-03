"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useEffect, useState, type ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import type { SyncStatus } from "@/server/queries/types";
import { ClockProvider } from "./clock";
import { SyncProvider } from "./sync";

export const TZ_COOKIE = "edf-tz";

/**
 * Keeps the server's idea of the device's time zone (cookie) in line with the browser. Rendered
 * times only need a fresh render when they follow the device (`followsDevice`); a zone chosen in
 * Settings wins over the device, so re-rendering then would change nothing (and never settle).
 */
function TimeZoneSync({ deviceTimeZone, followsDevice }: { deviceTimeZone: string; followsDevice: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || tz === deviceTimeZone) return;
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; SameSite=Lax`;
    if (!followsDevice) return;
    // Let the router finish initialising before asking for a fresh render.
    const t = setTimeout(() => router.refresh(), 300);
    return () => clearTimeout(t);
  }, [router, deviceTimeZone, followsDevice]);
  return null;
}

export function AppProviders({
  clock,
  deviceTimeZone = clock.timeZone,
  sync,
  children,
}: {
  /** `zoneKnown: false` = the zone is only the UTC fallback (see ClockProvider). */
  clock: { serverNow: number; locale: string; timeZone: string; zoneKnown?: boolean };
  /** The zone the device last reported (edf-tz cookie); defaults to `clock.timeZone` (no saved zone). */
  deviceTimeZone?: string;
  sync?: SyncStatus;
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  const content = sync ? <SyncProvider initial={sync}>{children}</SyncProvider> : children;
  return (
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        <ClockProvider value={clock}>
          <TooltipProvider delay={450}>
            {content}
            <TimeZoneSync deviceTimeZone={deviceTimeZone} followsDevice={clock.timeZone === deviceTimeZone} />
            <Toaster />
          </TooltipProvider>
        </ClockProvider>
      </QueryClientProvider>
    </NuqsAdapter>
  );
}
