"use client";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export const Dialog = BaseDialog.Root;

const backdropClass =
  "fixed inset-0 z-[80] bg-[oklch(0.18_0.01_270/0.45)] backdrop-blur-[2px] transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/60";

interface DialogContentProps extends Omit<ComponentProps<typeof BaseDialog.Popup>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Visually hide the title (it is still announced). */
  hideTitle?: boolean;
  showClose?: boolean;
  size?: "sm" | "md" | "lg";
}

export function DialogContent({
  title,
  description,
  hideTitle = false,
  showClose = true,
  size = "md",
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={backdropClass} />
      <BaseDialog.Viewport className="fixed inset-0 z-[81] flex items-start justify-center overflow-y-auto px-4 pt-[12vh] pb-8">
        <BaseDialog.Popup
          className={cn(
            "relative w-full rounded-xl border border-border bg-surface-overlay text-foreground shadow-overlay outline-none transition-[transform,opacity] duration-200 ease-out-quint data-ending-style:translate-y-1 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            size === "sm" && "max-w-sm",
            size === "md" && "max-w-lg",
            size === "lg" && "max-w-2xl",
            className,
          )}
          {...props}
        >
          <div className={cn("px-5 pt-5", hideTitle && "sr-only")}>
            <BaseDialog.Title className="pr-8 text-base font-semibold tracking-[-0.01em]">
              {title}
            </BaseDialog.Title>
            {description ? (
              <BaseDialog.Description className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {description}
              </BaseDialog.Description>
            ) : null}
          </div>
          {children}
          {showClose ? (
            <BaseDialog.Close
              aria-label="Close"
              className="absolute top-3.5 right-3.5 flex size-7 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </BaseDialog.Close>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  pending?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

/** A modal confirmation for destructive or consequential actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  pending = false,
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={backdropClass} />
        <BaseAlertDialog.Viewport className="fixed inset-0 z-[81] flex items-start justify-center overflow-y-auto px-4 pt-[14vh] pb-8">
          <BaseAlertDialog.Popup className="w-full max-w-md rounded-xl border border-border bg-surface-overlay shadow-overlay outline-none transition-[transform,opacity] duration-200 ease-out-quint data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <div className="px-5 pt-5">
              <BaseAlertDialog.Title className="text-base font-semibold tracking-[-0.01em]">
                {title}
              </BaseAlertDialog.Title>
              <BaseAlertDialog.Description
                render={<div />}
                className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground"
              >
                {description}
              </BaseAlertDialog.Description>
            </div>
            {children ? <div className="px-5 pt-4">{children}</div> : null}
            <div className="mt-5 flex flex-col-reverse gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:justify-end">
              <BaseAlertDialog.Close render={<Button variant="secondary" />}>
                {cancelLabel}
              </BaseAlertDialog.Close>
              <Button
                variant={tone === "danger" ? "danger" : "primary"}
                loading={pending}
                disabled={confirmDisabled}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            </div>
          </BaseAlertDialog.Popup>
        </BaseAlertDialog.Viewport>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right" | "bottom";
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
}

/** Edge panel: filters on tablets, navigation drawer and bottom sheets on phones. */
export function Sheet({
  open,
  onOpenChange,
  side = "right",
  title,
  hideTitle,
  children,
  className,
}: SheetProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClass} />
        <BaseDialog.Popup
          className={cn(
            "fixed z-[81] flex flex-col bg-surface-overlay text-foreground shadow-overlay outline-none transition-transform duration-300 ease-out-quint",
            side === "left" &&
              "inset-y-0 left-0 w-[min(20rem,88vw)] border-r border-border data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
            side === "right" &&
              "inset-y-0 right-0 w-[min(22rem,92vw)] border-l border-border data-ending-style:translate-x-full data-starting-style:translate-x-full",
            side === "bottom" &&
              "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-border pb-[env(safe-area-inset-bottom)] data-ending-style:translate-y-full data-starting-style:translate-y-full",
            className,
          )}
        >
          {side === "bottom" ? (
            <div
              aria-hidden
              className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong"
            />
          ) : null}
          <div
            className={cn(
              "flex items-center justify-between gap-2 px-4 pt-3 pb-2",
              hideTitle && "sr-only",
            )}
          >
            <BaseDialog.Title className="text-sm font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close
              aria-label="Close"
              className="flex size-7 items-center justify-center rounded-md text-subtle-foreground hover:bg-surface-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </BaseDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
