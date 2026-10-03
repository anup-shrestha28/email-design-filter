import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { FlashToast } from "@/components/page/flash-toast";
import { PageContainer, PageHeader } from "@/components/page/page-header";
import { AiUsage } from "@/components/settings/ai-usage";
import { DataControls } from "@/components/settings/data-controls";
import { Invites } from "@/components/settings/invites";
import { MailboxCard } from "@/components/settings/mailbox-card";
import { Preferences } from "@/components/settings/preferences";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getSettings } from "@/server/queries/account";
import { requireUser } from "@/server/session";
import { Mail } from "lucide-react";

export const metadata: Metadata = { title: "Settings" };

const MAX_MAILBOXES = 2;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ reconnected?: string }>;
}) {
  const user = await requireUser();
  const { reconnected } = await searchParams;
  const data = await getSettings(user);
  const canAdd = data.mailboxes.length < MAX_MAILBOXES;

  const mailboxes = (
    <div className="flex flex-col gap-4">
      {data.mailboxes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong">
          <EmptyState
            icon={<Mail />}
            title="No mailbox connected"
            description="Connect Gmail (read-only) to start sorting and scoring your automated mail."
            action={
              <LinkButton href="/connect" variant="primary">
                Connect Gmail
              </LinkButton>
            }
          />
        </div>
      ) : (
        data.mailboxes.map((m) => <MailboxCard key={m.id} mailbox={m} />)
      )}
      {data.mailboxes.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border-strong p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Connect another mailbox</p>
            <p className="text-xs text-muted-foreground">
              {canAdd
                ? `You can connect up to ${MAX_MAILBOXES} Gmail accounts.`
                : `You've connected the maximum of ${MAX_MAILBOXES}.`}
            </p>
          </div>
          <LinkButton
            href="/connect"
            variant="secondary"
            size="sm"
            aria-disabled={!canAdd}
            tabIndex={canAdd ? undefined : -1}
          >
            <Plus aria-hidden />
            Add Gmail
          </LinkButton>
        </div>
      ) : null}
    </div>
  );

  return (
    <PageContainer width="narrow" className="max-w-4xl">
      {reconnected === "1" ? (
        <FlashToast title="Gmail reconnected" description="Syncing picks up where it left off." />
      ) : null}
      <PageHeader
        title="Settings"
        description={`Signed in as ${data.user.email}${data.user.role === "owner" ? " · owner" : ""}`}
      />
      <div className="mt-6">
        <SettingsTabs
          panels={{
            mailboxes,
            preferences: <Preferences settings={data.settings} role={data.user.role} />,
            ai: <AiUsage ai={data.ai} />,
            ...(data.invites
              ? {
                  invites: (
                    <Invites invites={data.invites} googleAccountsUsed={data.googleAccountsUsed} />
                  ),
                }
              : {}),
            data: <DataControls email={data.user.email} />,
          }}
        />
      </div>
    </PageContainer>
  );
}
