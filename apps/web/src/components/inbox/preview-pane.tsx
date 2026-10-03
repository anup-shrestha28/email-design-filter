"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MailOpen, TriangleAlert } from "lucide-react";
import { getEmailPreview } from "@/app/(app)/inbox/actions";
import { EmailDetailSkeleton } from "@/components/email/detail-skeleton";
import { EmailDetailView } from "@/components/email/email-detail";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyCombo } from "@/components/ui/kbd";
import type { EmailDetail } from "@/server/queries/types";

export function previewQueryKey(id: string) {
  return ["email-preview", id] as const;
}

export async function fetchPreview(id: string): Promise<EmailDetail> {
  const r = await getEmailPreview(id);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** Desktop preview pane: the email detail in compact mode (react-query → Server Action). */
export function PreviewPane({
  emailId,
  onChanged,
  onRemoved,
}: {
  emailId: string | null;
  onChanged: () => void;
  /** The previewed email was deleted ("This is personal"): the parent closes the pane. */
  onRemoved?: (detail: EmailDetail) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: previewQueryKey(emailId ?? ""),
    queryFn: () => fetchPreview(emailId ?? ""),
    enabled: emailId !== null,
    // Viewer URLs are signed for 5 minutes; refetch well before they expire.
    staleTime: 120_000,
    gcTime: 240_000,
  });

  if (!emailId) {
    return (
      <EmptyState
        className="h-full"
        icon={<MailOpen />}
        title="Select an email to preview it"
        description={
          <span className="flex flex-col items-center gap-2">
            <span>Its Design Score, fonts, deals and trust details appear here.</span>
            <span className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
              <span className="flex items-center gap-1">
                <KeyCombo keys="j" /> <KeyCombo keys="k" /> move
              </span>
              <span className="flex items-center gap-1">
                <KeyCombo keys="e" /> done
              </span>
              <span className="flex items-center gap-1">
                <KeyCombo keys="p" /> pin
              </span>
              <span className="flex items-center gap-1">
                <KeyCombo keys="↵" /> open
              </span>
            </span>
          </span>
        }
      />
    );
  }
  if (query.isPending) {
    return (
      <div className="p-5">
        <EmailDetailSkeleton compact />
      </div>
    );
  }
  if (query.isError) {
    return (
      <EmptyState
        className="h-full"
        icon={<TriangleAlert />}
        title="This email didn't load"
        description={query.error.message}
        action={
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="p-5">
      <EmailDetailView
        key={query.data.id}
        detail={query.data}
        compact
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: previewQueryKey(emailId) });
          onChanged();
        }}
        onRemoved={() => {
          const removed = query.data;
          onRemoved?.(removed);
          // Drop the cached copy so nothing shows (or refetches) the deleted email again.
          queryClient.removeQueries({ queryKey: previewQueryKey(emailId) });
        }}
        onViewerExpired={() => void query.refetch()}
      />
    </div>
  );
}
