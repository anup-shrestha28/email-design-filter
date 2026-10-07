import type { Metadata } from "next";
import { verifyInvite } from "@edf/crypto";
import { CalendarX2, Heart, LinkIcon, Lock, Mail } from "lucide-react";
import { GoogleSignInButton } from "@/components/site/google-button";
import { LinkButton } from "@/components/ui/button";
import { inviteKeys } from "@/server/keys";

export const metadata: Metadata = { title: "You're invited" };

/** Tells an expired invite from a broken one (for the message only; verification is the HMAC). */
function expiredButWellFormed(token: string, nowSec: number): boolean {
  const exp = Number(token.split(".")[1]);
  return Number.isSafeInteger(exp) && exp < nowSec;
}

function verify(token: string, nowSec: number): { email: string } | null {
  try {
    return verifyInvite(inviteKeys(), token, nowSec);
  } catch {
    return null;
  }
}

/** Invite landing: HMAC-verified without touching the database (FREE-TIER.md §8.4). */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = decodeURIComponent(raw);
  const nowSec = Math.floor(Date.now() / 1000);
  const invite = verify(token, nowSec);

  if (!invite) {
    const expired = expiredButWellFormed(token, nowSec);
    return (
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 text-center shadow-overlay sm:p-8">
        <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-warning-soft text-warning">
          {expired ? (
            <CalendarX2 className="size-5" aria-hidden />
          ) : (
            <LinkIcon className="size-5" aria-hidden />
          )}
        </div>
        <h1 className="mt-4 text-lg font-semibold text-foreground">
          {expired ? "This invite has expired" : "This invite link doesn't work"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {expired
            ? "Invites are valid for 14 days. Ask the person who invited you for a fresh link."
            : "It may have been copied incompletely. Ask the person who invited you to send it again."}
        </p>
        <LinkButton href="/sign-in" variant="secondary" className="mt-6">
          Already invited? Sign in
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-overlay sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-foreground">
          <Heart className="size-5" aria-hidden />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-foreground">
          You&apos;re invited
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Dearly Mail sorts the newsletters, deals and receipts you signed up for, and
          scores how well each one is designed.
        </p>
        <div className="mt-5 flex items-center gap-3 rounded-lg border border-border bg-surface-muted/60 px-3 py-2.5">
          <Mail className="size-4 text-subtle-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-2xs text-muted-foreground">Invite for</p>
            <p className="truncate text-sm font-medium text-foreground">{invite.email}</p>
          </div>
        </div>
        <div className="mt-5">
          <GoogleSignInButton loginHint={invite.email} callbackURL="/gallery" />
        </div>
        <p className="mt-3 text-center text-xs text-subtle-foreground">
          Sign in with exactly this Google account.
        </p>
      </div>
      <div className="mt-5 flex gap-3 rounded-xl border border-border bg-surface/70 p-4 text-xs leading-relaxed text-muted-foreground">
        <Lock className="mt-0.5 size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <p>
          The person who runs this app has technical access to the database, as any app owner does.
          They commit not to read your data unless you choose to share it with them. Nobody reads
          your mail, it&apos;s never sold, and it&apos;s never used for ads.{" "}
          <a className="text-accent underline underline-offset-2" href="/privacy">
            Privacy policy
          </a>
        </p>
      </div>
    </div>
  );
}
