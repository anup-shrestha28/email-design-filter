"use client";
import { BellOff, Bell, MailMinus, Minus, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { openUnsubscribe, setImportanceBias, setSenderMuted } from "@/server/actions/sender";
import type { SenderRow } from "@/server/queries/types";

const BIAS_LABEL: Record<number, string> = {
  [-2]: "Much less important",
  [-1]: "Less important",
  0: "Default importance",
  1: "More important",
  2: "Much more important",
};

/** −2…+2 importance nudge for a sender (±15 points per step). */
export function BiasStepper({
  senderId,
  value,
  onChange,
  size = "sm",
}: {
  senderId: string;
  value: number;
  onChange?: (v: number) => void;
  size?: "sm" | "md";
}) {
  const [bias, setBias] = useState(value);
  // Follow the saved value when it changes from outside (a refresh, or this instance now showing a
  // different sender) — adjusting state during render, as React recommends, keeps focus in place.
  const [synced, setSynced] = useState({ senderId, value });
  if (synced.senderId !== senderId || synced.value !== value) {
    setSynced({ senderId, value });
    setBias(value);
  }
  const [, startTransition] = useTransition();
  function update(next: number) {
    const prev = bias;
    setBias(next);
    onChange?.(next);
    startTransition(async () => {
      const r = await setImportanceBias(senderId, next);
      if (!r.ok) {
        setBias(prev);
        onChange?.(prev);
        toast.error(r.error);
      }
    });
  }
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
      role="group"
      aria-label={`Importance: ${BIAS_LABEL[bias]}`}
    >
      <Button
        variant="ghost"
        size={size === "sm" ? "icon-xs" : "icon-sm"}
        aria-label="Lower importance"
        disabled={bias <= -2}
        onClick={() => update(bias - 1)}
      >
        <Minus aria-hidden />
      </Button>
      <Tooltip content={BIAS_LABEL[bias] ?? ""}>
        <span
          tabIndex={0}
          className={cn(
            "tabular w-7 text-center text-xs font-semibold",
            bias > 0
              ? "text-accent"
              : bias < 0
                ? "text-muted-foreground"
                : "text-subtle-foreground",
          )}
          aria-live="polite"
        >
          {bias > 0 ? `+${bias}` : bias}
        </span>
      </Tooltip>
      <Button
        variant="ghost"
        size={size === "sm" ? "icon-xs" : "icon-sm"}
        aria-label="Raise importance"
        disabled={bias >= 2}
        onClick={() => update(bias + 1)}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}

export function MuteButton({
  sender,
  onChange,
  withLabel = false,
}: {
  sender: Pick<SenderRow, "id" | "muted" | "displayName" | "address">;
  onChange?: (muted: boolean) => void;
  withLabel?: boolean;
}) {
  const [muted, setMuted] = useState(sender.muted);
  const [synced, setSynced] = useState({ id: sender.id, muted: sender.muted });
  if (synced.id !== sender.id || synced.muted !== sender.muted) {
    setSynced({ id: sender.id, muted: sender.muted });
    setMuted(sender.muted);
  }
  const [pending, startTransition] = useTransition();
  const name = sender.displayName ?? sender.address;
  function toggle() {
    const next = !muted;
    setMuted(next);
    onChange?.(next);
    startTransition(async () => {
      const r = await setSenderMuted(sender.id, next);
      if (!r.ok) {
        setMuted(!next);
        onChange?.(!next);
        toast.error(r.error);
        return;
      }
      toast.success(next ? `Muted ${name}` : `Unmuted ${name}`, {
        description: next
          ? "Their mail is hidden everywhere in the app. Gmail isn't changed."
          : undefined,
      });
    });
  }
  const label = muted ? "Unmute" : "Mute";
  if (withLabel) {
    return (
      <Button
        variant={muted ? "soft" : "secondary"}
        size="sm"
        onClick={toggle}
        disabled={pending}
        aria-pressed={muted}
      >
        {muted ? <Bell aria-hidden /> : <BellOff aria-hidden />}
        {label}
      </Button>
    );
  }
  return (
    <Tooltip content={muted ? `Unmute ${name}` : `Mute ${name} — hides their mail in the app`}>
      <Button
        variant={muted ? "soft" : "ghost"}
        size="icon-sm"
        aria-label={`${label} ${name}`}
        aria-pressed={muted}
        onClick={toggle}
        disabled={pending}
      >
        {muted ? <BellOff aria-hidden /> : <Bell aria-hidden />}
      </Button>
    </Tooltip>
  );
}

export function UnsubscribeButton({
  sender,
  withLabel = false,
}: {
  sender: Pick<SenderRow, "id" | "hasUnsubscribe" | "displayName" | "address">;
  withLabel?: boolean;
}) {
  const [pending, setPending] = useState(false);
  if (!sender.hasUnsubscribe)
    return withLabel ? null : <span aria-hidden className="inline-block size-7" />;
  const name = sender.displayName ?? sender.address;
  async function go() {
    setPending(true);
    const r = await openUnsubscribe(sender.id);
    setPending(false);
    if (!r.ok) return toast.error(r.error);
    if (r.data.url) window.location.assign(r.data.url);
    else if (r.data.mailto)
      toast.info(`Unsubscribe by email: ${r.data.mailto.replace(/^mailto:/i, "")}`, {
        duration: 10_000,
      });
  }
  if (withLabel) {
    return (
      <Button variant="secondary" size="sm" onClick={go} loading={pending}>
        {pending ? null : <MailMinus aria-hidden />}
        Unsubscribe
      </Button>
    );
  }
  return (
    <Tooltip content="Open the unsubscribe page (after a safety check)">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Unsubscribe from ${name}`}
        onClick={go}
        loading={pending}
      >
        {pending ? null : <MailMinus aria-hidden />}
      </Button>
    </Tooltip>
  );
}
