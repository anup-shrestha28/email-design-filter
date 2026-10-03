"use client";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { acceptDisclosure } from "@/server/actions/settings";

/** The affirmative checkbox immediately before the Google redirect (FREE-TIER.md §9.4). */
export function DisclosureForm({ reconnect = false }: { reconnect?: boolean }) {
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!agreed) return;
        setPending(true);
        const r = await acceptDisclosure();
        if (!r.ok) {
          setPending(false);
          toast.error(r.error);
          return;
        }
        window.location.assign(
          reconnect ? "/api/mailboxes/google/start?reconnect=1" : "/api/mailboxes/google/start",
        );
      }}
    >
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface-muted/50 p-4 text-[0.8125rem] leading-relaxed text-foreground transition-colors has-[[data-checked]]:border-accent/40 has-[[data-checked]]:bg-accent-soft/40">
        <Checkbox
          checked={agreed}
          onCheckedChange={setAgreed}
          className="mt-0.5"
          aria-describedby="consent-text"
        />
        <span id="consent-text">
          I&apos;ve read this and I want to connect my Gmail with <strong>read-only</strong> access,
          including processing of automated emails by Anthropic as described above.
        </span>
      </label>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 text-warning" aria-hidden />
          Next, Google shows a warning screen — see step 3.
        </p>
        <Button type="submit" variant="primary" size="lg" disabled={!agreed} loading={pending}>
          Continue to Google
          {pending ? null : <ArrowRight aria-hidden />}
        </Button>
      </div>
    </form>
  );
}
