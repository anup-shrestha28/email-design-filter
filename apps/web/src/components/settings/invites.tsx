"use client";
import { Link2, Trash2, UserPlus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/email/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { MeterBar } from "@/components/ui/progress";
import { Time } from "@/components/ui/time";
import { addInvite, removeInvite } from "@/server/actions/settings";
import type { SettingsData } from "@/server/queries/types";

/** Owner-only invite management + the unverified app's lifetime Google-account counter. */
export function Invites({
  invites,
  googleAccountsUsed,
}: {
  invites: NonNullable<SettingsData["invites"]>;
  googleAccountsUsed: number;
}) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const paused = googleAccountsUsed >= 90;

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border border-border bg-surface p-4 shadow-raised sm:p-5">
        <h3 className="text-sm font-semibold text-foreground">Invite a friend</h3>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          They sign in with this exact Google address. The link works for 14 days — send it
          yourself.
        </p>
        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const r = await addInvite(email);
              if (!r.ok) {
                toast.error(r.error);
                return;
              }
              setLink({ email: email.trim().toLowerCase(), url: r.data.link });
              setEmail("");
              toast.success("Invite created");
            });
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="invite-email">Their Google email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="friend@gmail.com"
              disabled={paused}
            />
          </div>
          <Button type="submit" variant="primary" loading={pending} disabled={paused || !email}>
            <UserPlus aria-hidden />
            Create invite link
          </Button>
        </form>
        {link ? (
          <div className="mt-4 rounded-lg border border-accent/30 bg-accent-soft/50 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Link2 className="size-3.5 text-accent" aria-hidden />
              Invite link for {link.email}
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {link.url}
              </code>
              <CopyButton value={link.url} label="Copy link" />
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4 shadow-raised sm:p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Google accounts</h3>
          <span className="tabular text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{googleAccountsUsed}</span> of 100
            lifetime
          </span>
        </div>
        <MeterBar
          className="mt-3"
          value={googleAccountsUsed}
          max={100}
          label="Google accounts used"
          valueText={`${googleAccountsUsed} of 100`}
          marker={{ at: 90, label: "Invites stop at 90" }}
          tone={
            googleAccountsUsed >= 90 ? "danger" : googleAccountsUsed >= 70 ? "warning" : "accent"
          }
        />
        <p className="mt-2 text-xs text-subtle-foreground">
          An unverified Google app can be used by 100 accounts, ever. Invites stop at 90 to leave
          room for you.
        </p>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-raised">
        <h3 className="px-4 pt-4 pb-2 text-sm font-semibold text-foreground sm:px-5">Invited</h3>
        {invites.length === 0 ? (
          <p className="px-4 pb-5 text-[0.8125rem] text-muted-foreground sm:px-5">
            No invites yet.
          </p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {invites.map((i) => (
              <li key={i.email} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] font-medium text-foreground">{i.email}</p>
                  <p className="text-xs text-subtle-foreground">
                    Invited <Time iso={i.createdAt} variant="short" />
                    {i.usedAt ? (
                      <>
                        {" · "}joined <Time iso={i.usedAt} variant="short" />
                      </>
                    ) : null}
                  </p>
                </div>
                {i.role === "owner" ? (
                  <Badge tone="accent" size="sm">
                    Owner
                  </Badge>
                ) : i.usedAt ? (
                  <Badge tone="success" size="sm">
                    Joined
                  </Badge>
                ) : (
                  <Badge size="sm">Not used yet</Badge>
                )}
                {i.role !== "owner" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove invite for ${i.email}`}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await removeInvite(i.email);
                        if (r.ok) toast.success(`Removed ${i.email}`);
                        else toast.error(r.error);
                      })
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
