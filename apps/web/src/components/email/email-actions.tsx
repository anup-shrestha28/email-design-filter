"use client";
import type { EmailType } from "@edf/core/types";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  ArrowUpRight,
  Check,
  Ellipsis,
  MailMinus,
  Pin,
  PinOff,
  Tags,
  Undo2,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogBody, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuContent,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { senderLabel } from "@/lib/avatar";
import { cn } from "@/lib/cn";
import { EMAIL_TYPE_ORDER } from "@/lib/labels";
import { TYPE_LABELS } from "@/lib/types-display";
import { correctType, markPersonal, setDone, setPinned } from "@/server/actions/email";
import { openUnsubscribe } from "@/server/actions/sender";
import type { EmailDetail } from "@/server/queries/types";
import { CopyButton } from "./copy-button";

/** Triage and corrections for one email. Gmail itself is never changed. */
export function EmailActions({
  detail,
  compact = false,
  shortcuts = false,
  onChanged,
  onRemoved,
}: {
  detail: EmailDetail;
  compact?: boolean;
  /** Show the e / p key hints: only where those hotkeys exist (the inbox, around its preview pane). */
  shortcuts?: boolean;
  onChanged?: () => void;
  /** "This is personal" deleted the email. Without it, the page navigates back to the inbox. */
  onRemoved?: () => void;
}) {
  const router = useRouter();
  const propDone = detail.state.doneAt !== null;
  const propPinned = detail.state.pinnedAt !== null;
  const propType = detail.classification.primaryType;
  const [done, setDoneState] = useState(propDone);
  const [pinned, setPinnedState] = useState(propPinned);
  const [alwaysForSender, setAlwaysForSender] = useState(false);
  const [type, setType] = useState<EmailType>(propType);
  // The buttons change optimistically, but the email can also change elsewhere (e / p in the
  // inbox list on the email being previewed), which hands us a refetched `detail`: follow it.
  const [seen, setSeen] = useState({ done: propDone, pinned: propPinned, type: propType });
  if (seen.done !== propDone || seen.pinned !== propPinned || seen.type !== propType) {
    setSeen({ done: propDone, pinned: propPinned, type: propType });
    if (seen.done !== propDone) setDoneState(propDone);
    if (seen.pinned !== propPinned) setPinnedState(propPinned);
    if (seen.type !== propType) setType(propType);
  }
  const [personalOpen, setPersonalOpen] = useState(false);
  const [mailto, setMailto] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [unsubPending, setUnsubPending] = useState(false);
  const refresh = onChanged ?? (() => router.refresh());
  const sender = senderLabel(detail.fromName, detail.fromAddress);
  const canUnsubscribe = Boolean(
    detail.senderId && (detail.unsubscribe.https || detail.unsubscribe.mailto),
  );

  function toggleDone() {
    const next = !done;
    setDoneState(next);
    startTransition(async () => {
      const r = await setDone(detail.id, next);
      if (!r.ok) {
        setDoneState(!next);
        toast.error(r.error);
        return;
      }
      toast.success(next ? "Marked done" : "Marked not done", {
        action: {
          label: "Undo",
          onClick: () =>
            void setDone(detail.id, !next).then(() => {
              setDoneState(!next);
              refresh();
            }),
        },
      });
      refresh();
    });
  }

  function togglePin() {
    const next = !pinned;
    setPinnedState(next);
    startTransition(async () => {
      const r = await setPinned(detail.id, next);
      if (!r.ok) {
        setPinnedState(!next);
        toast.error(r.error);
        return;
      }
      toast.success(next ? "Pinned — it stays at the top of your inbox" : "Unpinned");
      refresh();
    });
  }

  async function unsubscribe() {
    if (!detail.senderId) return;
    setUnsubPending(true);
    const r = await openUnsubscribe(detail.senderId);
    setUnsubPending(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (r.data.url) window.location.assign(r.data.url);
    else if (r.data.mailto) setMailto(r.data.mailto.replace(/^mailto:/i, ""));
    else toast.error("This sender doesn't offer an unsubscribe link.");
  }

  function changeType(next: EmailType) {
    const previous = type;
    setType(next);
    startTransition(async () => {
      const r = await correctType(detail.id, next, alwaysForSender);
      if (!r.ok) {
        setType(previous);
        toast.error(r.error);
        return;
      }
      toast.success(`Now filed as ${TYPE_LABELS[next]}`, {
        description: alwaysForSender
          ? `Future mail from ${sender} will be filed the same way.`
          : undefined,
      });
      refresh();
    });
  }

  function confirmPersonal() {
    startTransition(async () => {
      const r = await markPersonal(detail.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setPersonalOpen(false);
      toast.success(`Deleted and blocked mail from ${sender}`);
      // In the inbox preview the list (and its filters, in the URL) stays; the pane closes.
      if (onRemoved) onRemoved();
      else router.push("/inbox");
    });
  }

  const size = compact ? "sm" : "md";

  return (
    <div className="flex flex-wrap items-center gap-2 max-sm:gap-1.5 max-sm:[&>button]:px-2.5">
      <Tooltip
        content={done ? "Mark not done" : "Done — clears it from Needs attention"}
        shortcut={shortcuts ? "e" : undefined}
      >
        <Button
          variant={done ? "soft" : "secondary"}
          size={size}
          onClick={toggleDone}
          disabled={pending}
          aria-pressed={done}
        >
          {done ? <Undo2 aria-hidden /> : <Check aria-hidden />}
          {done ? "Done" : "Mark done"}
        </Button>
      </Tooltip>
      <Tooltip
        content={pinned ? "Unpin" : "Pin — keeps it on top"}
        shortcut={shortcuts ? "p" : undefined}
      >
        <Button
          variant={pinned ? "soft" : "secondary"}
          size={size}
          onClick={togglePin}
          disabled={pending}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          {pinned ? "Pinned" : "Pin"}
        </Button>
      </Tooltip>
      {canUnsubscribe ? (
        <Tooltip content="Opens the sender's own unsubscribe page after a safety check. We never click it for you.">
          <Button variant="secondary" size={size} onClick={unsubscribe} loading={unsubPending}>
            {unsubPending ? null : <MailMinus aria-hidden />}
            Unsubscribe
          </Button>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More actions"
          className={cn(
            buttonVariants({ variant: "secondary", size: compact ? "icon-sm" : "icon" }),
          )}
        >
          <Ellipsis aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuSubmenu>
            <DropdownMenuSubmenuTrigger icon={<Tags aria-hidden />}>
              Correct type
            </DropdownMenuSubmenuTrigger>
            <DropdownMenuSubmenuContent className="w-60">
              <DropdownMenuCheckboxItem
                checked={alwaysForSender}
                onCheckedChange={setAlwaysForSender}
                closeOnClick={false}
              >
                Always for this sender
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>File this email as</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={type}
                  onValueChange={(v) => changeType(v as EmailType)}
                >
                  {EMAIL_TYPE_ORDER.map((t) => (
                    <DropdownMenuRadioItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuSubmenuContent>
          </DropdownMenuSubmenu>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<UserX aria-hidden />}
            tone="danger"
            onClick={() => setPersonalOpen(true)}
          >
            This is personal…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {compact ? (
        <Link
          href={`/email/${detail.id}` as Route}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "ml-auto")}
        >
          Open full page
          <ArrowUpRight aria-hidden />
        </Link>
      ) : null}

      <ConfirmDialog
        open={personalOpen}
        onOpenChange={setPersonalOpen}
        title="Mark as personal?"
        description={
          <>
            <p>
              We&apos;ll delete this email and every stored email from{" "}
              <strong className="text-foreground">{sender}</strong>, and stop storing mail from
              them.
            </p>
            <p>Nothing changes in your Gmail. This can&apos;t be undone.</p>
          </>
        }
        confirmLabel="Delete and stop storing"
        pending={pending}
        onConfirm={confirmPersonal}
      />
      <Dialog open={mailto !== null} onOpenChange={(o) => !o && setMailto(null)}>
        <DialogContent
          title="Unsubscribe by email"
          description={`${sender} only offers unsubscribing by email. Send an empty message to this address from your mail app:`}
          size="sm"
        >
          <DialogBody>
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-muted px-3 py-2">
              <code className="truncate font-mono text-[0.8125rem] text-foreground">{mailto}</code>
              {mailto ? <CopyButton value={mailto} /> : null}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              We never send email from your mailbox.
            </p>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
