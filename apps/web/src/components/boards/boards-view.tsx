"use client";
import { Bookmark, LayoutGrid, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { SenderAvatar } from "@/components/ui/avatar";
import { Button, LinkButton } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/input";
import { Time } from "@/components/ui/time";
import { galleryHref } from "@/lib/gallery";
import { formatNumber } from "@/lib/format";
import { createBoard, deleteBoard, renameBoard } from "@/server/actions/boards";
import type { BoardSummary } from "@/server/queries/boards";

/** The longest board name (server/queries/boards.ts BOARD_NAME_MAX). */
const NAME_MAX = 60;

/**
 * Your boards as tiles: open one to see its designs in the gallery (`/gallery?board=<id>`, with
 * every filter still at hand), make a new one, rename or delete one (its designs stay in the
 * gallery). Saving happens on the gallery cards ("Save").
 */
export function BoardsView({ boards }: { boards: BoardSummary[] }) {
  const router = useRouter();
  const [naming, setNaming] = useState<{ mode: "create" } | { mode: "rename"; board: BoardSummary } | null>(null);
  const [deleting, setDeleting] = useState<BoardSummary | null>(null);
  const [pendingDelete, startDelete] = useTransition();

  const confirmDelete = () => {
    const board = deleting;
    if (!board) return;
    startDelete(async () => {
      const r = await deleteBoard(board.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDeleting(null);
      toast.success(`Deleted ${board.name}`);
      router.refresh();
    });
  };

  return (
    <div className="mt-6">
      <div className="mb-4 flex justify-end">
        <Button variant="primary" onClick={() => setNaming({ mode: "create" })}>
          <Plus aria-hidden />
          New board
        </Button>
      </div>
      {boards.length === 0 ? (
        <EmptyState
          className="rounded-xl border border-dashed border-border py-20"
          icon={<Bookmark aria-hidden />}
          title="No boards yet"
          description="In the gallery, hover over a design and click Save to keep it in a board."
          action={
            <LinkButton href="/gallery" variant="secondary">
              <LayoutGrid aria-hidden />
              Go to the gallery
            </LinkButton>
          }
        />
      ) : (
        <ul role="list" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {boards.map((b) => (
            <BoardTile
              key={b.id}
              board={b}
              onRename={() => setNaming({ mode: "rename", board: b })}
              onDelete={() => setDeleting(b)}
            />
          ))}
        </ul>
      )}
      <NameDialog
        state={naming}
        onClose={() => setNaming(null)}
        onDone={() => {
          setNaming(null);
          router.refresh();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete board?"}
        description="The board goes away. The designs in it stay in your gallery."
        confirmLabel="Delete board"
        pending={pendingDelete}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function BoardTile({
  board,
  onRename,
  onDelete,
}: {
  board: BoardSummary;
  onRename: () => void;
  onDelete: () => void;
}) {
  const href = galleryHref({ board: board.id }) as Route;
  const nameId = useId();
  return (
    <li className="group relative flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 shadow-xs transition-[box-shadow,border-color] duration-200 hover:border-border-strong hover:shadow-overlay">
      <div className="flex h-12 items-center">
        {board.recent.length ? (
          <div className="flex -space-x-2">
            {board.recent.map((r, i) => (
              <SenderAvatar
                key={i}
                name={r.name}
                domain={r.domain}
                size="lg"
                className="rounded-full ring-2 ring-surface"
              />
            ))}
          </div>
        ) : (
          <span className="flex size-10 items-center justify-center rounded-full bg-surface-muted text-subtle-foreground">
            <Bookmark aria-hidden className="size-4" />
          </span>
        )}
      </div>
      <p id={nameId} className="mt-3 truncate pr-8 text-[0.9375rem] font-semibold text-foreground">
        {board.name}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <span className="tabular">{formatNumber(board.count)}</span>{" "}
        {board.count === 1 ? "design" : "designs"} · updated{" "}
        <Time iso={board.updatedAt} variant="relative" withTitle={false} />
      </p>
      <Link
        href={href}
        aria-labelledby={nameId}
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More for ${board.name}`}
          className="absolute top-3 right-3 z-20 flex size-8 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Pencil aria-hidden />} onClick={onRename}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Trash2 aria-hidden />} tone="danger" onClick={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function NameDialog({
  state,
  onClose,
  onDone,
}: {
  state: { mode: "create" } | { mode: "rename"; board: BoardSummary } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = state !== null;
  const renaming = state?.mode === "rename" ? state.board : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent title={renaming ? "Rename board" : "New board"} size="sm">
        {/* Keyed, so each opening starts from the board's current name (or empty). */}
        {open ? <NameForm key={renaming?.id ?? "new"} renaming={renaming} onDone={onDone} onCancel={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({
  renaming,
  onDone,
  onCancel,
}: {
  renaming: BoardSummary | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(renaming?.name ?? "");
  const [pending, start] = useTransition();
  const inputId = useId();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    start(async () => {
      const r = renaming ? await renameBoard(renaming.id, trimmed) : await createBoard(trimmed);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(renaming ? "Board renamed" : `Created ${trimmed}`);
      onDone();
    });
  };
  return (
    <form onSubmit={submit}>
      <DialogBody className="space-y-1.5">
        <Label htmlFor={inputId}>Board name</Label>
        <Input
          id={inputId}
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Great welcome emails"
          autoComplete="off"
          autoFocus
        />
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
          {renaming ? "Save" : "Create board"}
        </Button>
      </DialogFooter>
    </form>
  );
}
