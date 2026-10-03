"use client";
import { Bookmark, BookmarkCheck, Check, LayoutGrid, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { createBoard, getBoardChoices, setSaved } from "@/server/actions/boards";
import type { BoardChoice } from "@/server/queries/boards";

/** The longest board name (server/queries/boards.ts BOARD_NAME_MAX). */
const NAME_MAX = 60;

/**
 * "Save" on a gallery card (Pinterest style): shows on hover (always on touch screens, and while
 * the design is saved somewhere), opens a list of your boards — tick one to save the design there,
 * untick to take it out — and makes a new board with the design already in it.
 */
export function SaveToBoard({
  emailId,
  saved: initialSaved,
  className,
}: {
  emailId: string;
  saved: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSavedState] = useState(initialSaved);
  // A new page of results (or a live refresh) may know better than this card's last click.
  useEffect(() => setSavedState(initialSaved), [initialSaved]);
  const [boards, setBoards] = useState<BoardChoice[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    const r = await getBoardChoices(emailId);
    if (r.ok) setBoards(r.data);
    else setLoadError(true);
  }, [emailId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={saved ? "Saved — change boards" : "Save to a board"}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold shadow-sm ring-1 ring-black/5 transition-[opacity,background-color] duration-150",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          saved
            ? "bg-[oklch(0.22_0.01_270)] text-white hover:bg-[oklch(0.3_0.01_270)]"
            : "bg-accent text-accent-foreground hover:bg-accent-hover",
          // On hover / keyboard focus; always on touch screens, while open, and once saved.
          !saved && !open && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
          className,
        )}
      >
        {saved ? <BookmarkCheck aria-hidden className="size-3.5" /> : <Bookmark aria-hidden className="size-3.5" />}
        {saved ? "Saved" : "Save"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <BoardPicker
          emailId={emailId}
          boards={boards}
          loadError={loadError}
          onRetry={load}
          onChange={(next, savedAnywhere) => {
            setBoards(next);
            setSavedState(savedAnywhere);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function BoardPicker({
  emailId,
  boards,
  loadError,
  onRetry,
  onChange,
}: {
  emailId: string;
  boards: BoardChoice[] | null;
  loadError: boolean;
  onRetry: () => void;
  onChange: (boards: BoardChoice[], savedAnywhere: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, startCreate] = useTransition();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = async (b: BoardChoice) => {
    if (!boards || busy) return;
    setBusy(b.id);
    const want = !b.saved;
    const r = await setSaved(emailId, b.id, want);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const next = boards.map((x) =>
      x.id === b.id ? { ...x, saved: want, count: Math.max(0, x.count + (want ? 1 : -1)) } : x,
    );
    onChange(next, r.data.savedAnywhere);
    toast.success(want ? `Saved to ${b.name}` : `Removed from ${b.name}`);
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    startCreate(async () => {
      const r = await createBoard(trimmed, emailId);
      if (!r.ok) {
        toast.error(r.error);
        inputRef.current?.focus();
        return;
      }
      setName("");
      onChange([{ id: r.data.id, name: r.data.name, count: 1, saved: true }, ...(boards ?? [])], true);
      toast.success(`Saved to ${r.data.name}`);
    });
  };

  return (
    <div className="flex flex-col">
      <p className="px-3 pt-3 pb-2 text-xs font-semibold text-foreground">Save to board</p>
      <div className="max-h-64 overflow-y-auto px-1.5">
        {boards === null ? (
          loadError ? (
            <div className="flex items-center justify-between gap-2 px-1.5 py-2 text-xs text-muted-foreground">
              Couldn&apos;t load your boards.
              <Button size="xs" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5 px-1.5 py-1" aria-busy="true" aria-label="Loading your boards">
              <div className="skeleton h-7 rounded-md" />
              <div className="skeleton h-7 rounded-md" />
            </div>
          )
        ) : boards.length === 0 ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">
            No boards yet. Name your first one below.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 py-0.5">
            {boards.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  aria-pressed={b.saved}
                  disabled={busy !== null}
                  onClick={() => void toggle(b)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-[0.8125rem] text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default",
                    busy === b.id && "opacity-60",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                      b.saved ? "border-accent bg-accent text-accent-foreground" : "border-border-strong",
                    )}
                  >
                    {b.saved ? <Check className="size-3" strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  <span className="shrink-0 text-xs text-subtle-foreground tabular">
                    {formatNumber(b.count)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form onSubmit={create} className="mt-1 flex items-center gap-1.5 border-t border-border p-2">
        <label htmlFor={inputId} className="sr-only">
          New board name
        </label>
        <Input
          ref={inputRef}
          id={inputId}
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder="New board name"
          autoComplete="off"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim()} loading={creating}>
          <Plus aria-hidden />
          Create
        </Button>
      </form>
      <Link
        href="/boards"
        className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground hover:bg-surface-muted hover:text-foreground"
      >
        <LayoutGrid aria-hidden className="size-3.5" />
        See all your boards
      </Link>
    </div>
  );
}
