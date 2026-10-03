"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ScanEye, Sparkles } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { requestAnalyze } from "@/server/actions/email";
import type { EmailDetail } from "@/server/queries/types";
import { ALLOWANCE_USED, analyzeNotice, fromClick, rerunBar, type FromClick } from "./analyze-copy";

type Actions = EmailDetail["actions"];

/**
 * The inbox preview pane's react-query key (`previewQueryKey` in components/inbox/preview-pane.tsx;
 * importing it here would make an import cycle). The pane doesn't see `router.refresh()`.
 */
const PREVIEW_QUERY = "email-preview";

/**
 * Renders paused, as the page's data says or as a click on a page loaded before the pause found out
 * (until the next refresh brings new data, which then wins).
 */
function usePauseFromClick(actions: Actions) {
  const [click, setClick] = useState<FromClick<string> | null>(null);
  return {
    paused: actions.rendersPaused ?? fromClick(click, actions),
    notePaused: (reason: string, seen: Actions) => setClick({ value: reason, seen }),
  };
}

/**
 * "Analyze" (render on demand) and "Run AI review", with today's remaining allowance. While the
 * governor has renders paused the button is disabled and says why underneath (nothing is queued);
 * `showStatus={false}` leaves that line to the caller, which passes the pause in and names its note
 * with `describedBy` (two buttons side by side).
 */
export function AnalyzeButton({
  emailId,
  actions,
  withAi = false,
  label,
  variant = "primary",
  size = "md",
  showStatus = true,
  pausedReason,
  onPaused,
  describedBy,
}: {
  emailId: string;
  actions: Actions;
  withAi?: boolean;
  label?: string;
  variant?: "primary" | "secondary" | "soft";
  size?: "sm" | "md";
  showStatus?: boolean;
  /** The pause as the caller tracks it (shared by sibling buttons); defaults to this button's own. */
  pausedReason?: string | null;
  onPaused?: (reason: string, seen: Actions) => void;
  describedBy?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const noteId = useId();
  const [pending, startTransition] = useTransition();
  const [queuedClick, setQueuedClick] = useState<FromClick<true> | null>(null);
  const own = usePauseFromClick(actions);
  const paused = pausedReason === undefined ? own.paused : pausedReason;
  const queued = actions.renderQueued || fromClick(queuedClick, actions) === true;
  const allowed = (withAi ? actions.canRunAiReview : actions.canAnalyze) && !paused;
  const remaining = withAi ? actions.aiReviewRemainingToday : actions.analyzeRemainingToday;
  const text = label ?? (withAi ? "Run AI review" : "Analyze this email");
  // Suspicious mail can be analysed but never sent to AI: say so rather than "N left today".
  const blocked = actions.reason ?? (withAi ? (actions.aiReason ?? null) : null);
  const disabledReason =
    paused ??
    (queued
      ? "Already queued — results usually arrive within a couple of minutes."
      : (blocked ??
        (remaining === 0 ? ALLOWANCE_USED : null)));
  const ownNote = showStatus && paused ? noteId : undefined;
  const described = ownNote ?? (paused ? describedBy : undefined);

  const button = (
    <Button
      variant={variant}
      size={size}
      loading={pending}
      disabled={!allowed || queued}
      aria-describedby={described}
      onClick={() =>
        startTransition(async () => {
          const r = await requestAnalyze(emailId, withAi);
          if (!r.ok) {
            toast.error(r.error);
            return;
          }
          const notice = analyzeNotice(r.data, withAi);
          if (r.data.status === "paused") {
            // Nothing was queued: say why here, and refresh so the rest of the panel says it too.
            (onPaused ?? own.notePaused)(r.data.reason, actions);
            toast.info(notice.title, { description: notice.description });
          } else {
            setQueuedClick({ value: true, seen: actions });
            toast.success(notice.title, { description: notice.description });
          }
          router.refresh();
          void queryClient.invalidateQueries({ queryKey: [PREVIEW_QUERY, emailId] });
        })
      }
    >
      {withAi ? <Sparkles aria-hidden /> : <ScanEye aria-hidden />}
      {queued ? "Queued" : text}
    </Button>
  );

  return (
    <span className="inline-flex flex-col items-start gap-1">
      {disabledReason && (!allowed || queued) ? (
        <Tooltip content={disabledReason}>
          {
            // A disabled button can't take focus; this wrapper does, and carries the reason.
            <span tabIndex={0} className="rounded-md" aria-describedby={described}>
              {button}
            </span>
          }
        </Tooltip>
      ) : (
        button
      )}
      {!showStatus ? null : paused ? (
        <RendersPausedNote id={noteId} reason={paused} />
      ) : blocked && !allowed ? (
        <span className="max-w-72 text-2xs leading-snug text-subtle-foreground">{blocked}</span>
      ) : !allowed && !queued && remaining === 0 ? (
        // The reason, not just "0 left today", where it can be read without hovering.
        <span className="max-w-72 text-2xs leading-snug text-subtle-foreground">{ALLOWANCE_USED}</span>
      ) : (
        <span className="text-2xs text-subtle-foreground">{remaining} left today</span>
      )}
    </span>
  );
}

/** The governor's plain-English reason, shown next to the disabled Analyze buttons. */
export function RendersPausedNote({ id, reason }: { id?: string; reason: string }) {
  return (
    <span id={id} role="status" className="max-w-72 text-2xs leading-snug text-warning">
      {reason}
    </span>
  );
}

/**
 * The re-run bar under a score: "Run AI review" / "Run fresh AI review" and "Analyze again". Hidden
 * only for emails that can never be analysed; while renders are paused (including when one button's
 * click finds out) both stay, disabled, with one shared note that each button is described by.
 */
export function RerunBar({
  emailId,
  actions,
  hasAi,
}: {
  emailId: string;
  actions: Actions;
  hasAi: boolean;
}) {
  const noteId = useId();
  const { paused, notePaused } = usePauseFromClick(actions);
  const bar = rerunBar(actions, paused);
  if (bar === "hidden") return null;
  const shown = bar === "paused" ? paused : null;
  const shared = {
    emailId,
    actions,
    variant: "secondary",
    size: "sm",
    showStatus: !shown,
    pausedReason: paused,
    onPaused: notePaused,
    describedBy: shown ? noteId : undefined,
  } as const;
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-surface-muted/40 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start gap-3">
        <AnalyzeButton {...shared} withAi label={hasAi ? "Run fresh AI review" : "Run AI review"} />
        <AnalyzeButton {...shared} label="Analyze again" />
      </div>
      {shown ? <RendersPausedNote id={noteId} reason={shown} /> : null}
    </div>
  );
}
