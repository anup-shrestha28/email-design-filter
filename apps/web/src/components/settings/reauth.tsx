"use client";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { signOut } from "@/lib/auth-client";

/**
 * Sensitive actions need a sign-in from the last 10 minutes. When the server says the session is
 * too old, explain it and offer a fresh sign-in.
 */
export function useReauth() {
  const [what, setWhat] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dialog = (
    <ConfirmDialog
      open={what !== null}
      onOpenChange={(o) => !o && setWhat(null)}
      tone="primary"
      title="Please sign in again"
      description={
        <p>
          To {what ?? "do this"}, we need to know it&apos;s really you. Sign in again, then come
          back to Settings — it takes a few seconds.
        </p>
      }
      confirmLabel="Sign in again"
      pending={pending}
      onConfirm={async () => {
        setPending(true);
        await signOut().catch(() => undefined);
        window.location.assign("/sign-in");
      }}
    />
  );
  return { ask: (action: string) => setWhat(action), dialog };
}
