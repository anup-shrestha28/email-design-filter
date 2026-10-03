import type { Metadata } from "next";
import { headers } from "next/headers";
import { ArrowLeft, Bot, Database, Eye, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { requireUser } from "@/server/session";
import { DisclosureForm } from "./disclosure-form";

export const metadata: Metadata = { title: "Connect Gmail" };

function Item({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-1 space-y-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </li>
  );
}

const CONNECT_ERRORS: Record<string, string> = {
  denied: "Google access wasn't granted. You can try again whenever you're ready.",
  consent_required:
    "Please allow read-only Gmail access on Google's screen — it's needed to sort your mail.",
  email_mismatch:
    "The Gmail account didn't match the one you chose. Please pick the same account on both screens.",
  email_unverified: "That Google account's email address isn't verified.",
  state: "That sign-in took too long or was opened twice. Please start again.",
  id_token: "Google's answer couldn't be verified. Please start again.",
  stale_session: "For your safety, please sign in again before connecting.",
  limit: "You've connected the maximum number of mailboxes.",
  not_invited: "Your invite to this app has been removed, so you can't connect mailboxes.",
  accounts_cap:
    "The app has reached its Google account limit, so new mailboxes can't be connected right now.",
  disconnecting: "This mailbox is still finishing its disconnect. Try again in a minute.",
  frozen: "Connecting is paused while the app is in saving mode. Please try again later.",
  not_configured: "Connecting Gmail isn't set up on this server yet.",
  failed: "Something went wrong while connecting. Please try again.",
};

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reconnect?: string }>;
}) {
  await requireUser("/connect");
  const { error, reconnect } = await searchParams;
  const errorText = error ? (CONNECT_ERRORS[error] ?? CONNECT_ERRORS.failed) : null;
  const isReconnect = reconnect === "1";
  const host = (await headers()).get("host") ?? "this app";
  return (
    <div className="w-full max-w-2xl">
      <LinkButton href="/settings" variant="ghost" size="sm" className="-ml-2 mb-4">
        <ArrowLeft aria-hidden />
        Back
      </LinkButton>
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-overlay sm:p-8">
        <p className="text-xs font-medium text-accent">Before you connect</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em] text-foreground">
          Connect your Gmail
        </h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted-foreground">
          Here&apos;s exactly what happens when you connect. Please read it — you&apos;ll confirm at
          the bottom.
        </p>

        {errorText ? (
          <p
            role="alert"
            className="mt-5 flex gap-2.5 rounded-lg border border-danger/30 bg-danger-soft p-3 text-[0.8125rem] leading-relaxed text-foreground"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            {errorText}
          </p>
        ) : null}

        <ol className="mt-8 flex flex-col gap-6">
          <Item icon={<Eye />} title="1. What we read, and why">
            <p>
              Gmail access is <strong className="text-foreground">read-only</strong>: we can&apos;t
              send, delete, label or change anything. We look at incoming mail to find the automated
              emails you signed up for — newsletters, promotions, receipts and alerts — so we can
              sort them, find deals and score their design.
            </p>
            <p>
              Personal emails may be processed briefly in memory to tell them apart. They are never
              stored.
            </p>
          </Item>
          <Item icon={<Bot />} title="2. AI processing by Anthropic">
            <p>
              Email content and screenshots are sent to Anthropic, PBC (USA) solely to generate your
              design review and classifications. Anthropic does not train on this data, deletes it
              within 30 days (29 days for batch jobs), and may retain content flagged for safety
              review for up to 2 years.
            </p>
            <p>Security emails (sign-in codes, password resets) are never sent to AI.</p>
          </Item>
          <Item icon={<ShieldCheck />} title="3. Google will warn you — that's expected">
            <p>
              This is a small, invite-only app, so Google hasn&apos;t verified it. You&apos;ll see
              “Google hasn&apos;t verified this app”. To continue, click{" "}
              <strong className="text-foreground">Advanced</strong>, then{" "}
              <strong className="text-foreground">Go to {host} (unsafe)</strong>, and allow
              read-only Gmail access.
            </p>
            <p>Only continue if the address shown is {host}.</p>
          </Item>
          <Item icon={<Database />} title="4. What we store">
            <p>
              For automated mail: sender, subject, date, a short preview (none for security emails),
              a search index made from a short excerpt, and the scores we compute.{" "}
              <strong className="text-foreground">No email bodies</strong> — emails open live from
              Gmail in a locked-down viewer. Your Google access key is stored encrypted.
            </p>
          </Item>
          <Item icon={<Trash2 />} title="5. Leaving is easy">
            <p>
              Disconnect any time in Settings: we revoke our Google access and delete that
              mailbox&apos;s data. You can also delete your whole account. Our use of Google data
              follows the Google API Services User Data Policy, including the Limited Use
              requirements — see the{" "}
              <a className="text-accent underline underline-offset-2" href="/privacy">
                privacy policy
              </a>
              .
            </p>
          </Item>
        </ol>

        <div className="mt-8 border-t border-border pt-6">
          <DisclosureForm reconnect={isReconnect} />
        </div>
      </div>
    </div>
  );
}
