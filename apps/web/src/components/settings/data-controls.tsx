"use client";
import { Download, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { deleteAccount } from "@/server/actions/settings";
import { useReauth } from "./reauth";

/** Download every export page (gzipped JSONL members concatenate into one valid .gz file). */
async function downloadExport(
  onProgress: (pages: number) => void,
): Promise<"ok" | "stale" | "error"> {
  const parts: Blob[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= 500; page++) {
    const res: Response = await fetch(
      cursor ? `/api/export?cursor=${encodeURIComponent(cursor)}` : "/api/export",
      {
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    if (res.status === 401) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return body?.error === "stale_session" ? "stale" : "error";
    }
    if (!res.ok) return "error";
    parts.push(await res.blob());
    onProgress(page);
    cursor = res.headers.get("X-Export-Next");
    if (!cursor) break;
  }
  const url = URL.createObjectURL(new Blob(parts, { type: "application/gzip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `email-design-filter-export-${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "ok";
}

/** Export (JSONL download) and account deletion with typed-email confirmation. */
export function DataControls({ email }: { email: string }) {
  const [exporting, setExporting] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();
  const reauth = useReauth();
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-raised sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Export your data</h3>
          <p className="mt-1 max-w-xl text-[0.8125rem] text-muted-foreground">
            Download everything we store about your mail — senders, classifications, scores and
            deals — as one compressed JSON Lines file.
          </p>
          {exporting !== null ? (
            <p className="mt-1 text-xs text-subtle-foreground" role="status">
              Preparing… {exporting} {exporting === 1 ? "part" : "parts"} so far
            </p>
          ) : null}
        </div>
        <Button
          variant="secondary"
          loading={exporting !== null}
          onClick={async () => {
            setExporting(0);
            const r = await downloadExport(setExporting);
            setExporting(null);
            if (r === "ok") toast.success("Export downloaded");
            else if (r === "stale") reauth.ask("export your data");
            else toast.error("The export didn't finish. Please try again.");
          }}
        >
          {exporting !== null ? null : <Download aria-hidden />}
          Export
        </Button>
      </section>

      <section className="rounded-xl border border-danger/30 bg-surface p-4 shadow-raised sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-danger">
          <TriangleAlert className="size-4" aria-hidden />
          Delete account
        </h3>
        <p className="mt-1 max-w-xl text-[0.8125rem] leading-relaxed text-muted-foreground">
          Disconnects every mailbox, revokes our Google access and permanently deletes your account
          and all stored data. Your Gmail is not touched.
        </p>
        <Button variant="danger" className="mt-4" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      </section>

      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped("");
        }}
        title="Delete your account?"
        description={<p>This can&apos;t be undone. Type your account email to confirm.</p>}
        confirmLabel="Delete everything"
        confirmDisabled={!matches}
        pending={pending}
        onConfirm={() =>
          startTransition(async () => {
            const r = await deleteAccount(typed);
            if (r.ok) {
              if ("data" in r && r.data?.revokeFailed) {
                // A toast would be lost on the redirect below, so this one blocks until read.
                window.alert(
                  "Your account was deleted, but Google didn't confirm that this app's access was removed. To be sure, remove it at myaccount.google.com/permissions.",
                );
              }
              window.location.assign("/");
              return;
            }
            if (r.code === "stale_session") {
              setOpen(false);
              reauth.ask("delete your account");
              return;
            }
            toast.error(r.error);
          })
        }
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-email">Account email</Label>
          <Input
            id="confirm-email"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={email}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </ConfirmDialog>
      {reauth.dialog}
    </div>
  );
}
