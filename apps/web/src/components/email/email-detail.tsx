"use client";
import { useRouter } from "next/navigation";
import { DesignPanel } from "@/components/design/design-panel";
import { FontsCard } from "@/components/design/fonts-card";
import { cn } from "@/lib/cn";
import type { EmailDetail } from "@/server/queries/types";
import { ClassificationCard } from "./classification-card";
import { DealCard } from "./deal-card";
import { EmailActions } from "./email-actions";
import { EmailHeader } from "./email-header";
import { EmailViewer, type ViewerIssue } from "./email-viewer";
import { MarkOpened } from "./mark-opened";
import { TrustCard } from "./trust-card";

function viewerIssues(detail: EmailDetail): ViewerIssue[] {
  const items = detail.design.result?.needsImprovement ?? [];
  return items.map((n, i) => ({ index: i + 1, title: n.title, regions: n.regions ?? [] }));
}

/**
 * The full email view. `compact` renders it for the inbox preview pane (single column, capped
 * viewer height); layout adapts with container queries, so the same component fits both.
 */
export function EmailDetailView({
  detail,
  compact = false,
  onChanged,
  onRemoved,
  onViewerExpired,
}: {
  detail: EmailDetail;
  compact?: boolean;
  onChanged?: () => void;
  /** The email was deleted ("This is personal"); see EmailActions. */
  onRemoved?: () => void;
  onViewerExpired?: () => void;
}) {
  const router = useRouter();
  const refresh = onViewerExpired ?? (() => router.refresh());
  const sampleDate = detail.design.renderRef?.renderedAt ?? null;
  return (
    <article className="@container" aria-label={detail.subject ?? "Email"}>
      <MarkOpened
        emailId={detail.id}
        already={detail.state.openedInAppAt !== null}
        delayMs={compact ? 1500 : 0}
      />
      <div className="flex flex-col gap-4">
        <EmailHeader detail={detail} compact={compact} />
        {/* compact is the inbox preview pane: only InboxView registers the e / p hotkeys. */}
        <EmailActions
          detail={detail}
          compact={compact}
          shortcuts={compact}
          onChanged={onChanged}
          onRemoved={onRemoved}
        />
      </div>
      <div className={cn("mt-6 grid gap-5", !compact && "@5xl:grid-cols-[minmax(0,1fr)_26rem]")}>
        <div
          className={cn(
            "flex min-w-0 flex-col gap-5",
            !compact && "@5xl:sticky @5xl:top-6 @5xl:self-start",
          )}
        >
          {detail.classification.securitySensitive ? null : (
            <EmailViewer
              viewer={detail.viewer}
              layout={detail.design.layout}
              issues={viewerIssues(detail)}
              suspicious={detail.classification.suspicious}
              clickToLoad={detail.imagesClickToLoad === true}
              onExpired={refresh}
              maxHeight={compact ? 720 : undefined}
            />
          )}
          {!compact ? (
            <div className="grid gap-5 @2xl:grid-cols-2 @5xl:hidden">
              <DealCard deals={detail.deals} />
              <FontsCard fonts={detail.fonts} sampleDate={sampleDate} />
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <DesignPanel emailId={detail.id} design={detail.design} actions={detail.actions} />
          <div className={cn("flex flex-col gap-5", !compact && "hidden @5xl:flex")}>
            <DealCard deals={detail.deals} />
            <FontsCard fonts={detail.fonts} sampleDate={sampleDate} />
          </div>
          <ClassificationCard detail={detail} />
          <TrustCard detail={detail} />
        </div>
      </div>
    </article>
  );
}
