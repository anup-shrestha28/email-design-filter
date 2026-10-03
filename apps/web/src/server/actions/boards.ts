"use server";
/**
 * Boards: save gallery designs into your own named collections (migration 0018). Every action:
 * Zod input, session, RLS-scoped transaction — a board or email of someone else simply isn't
 * there (ownership by construction; the composite foreign keys refuse another user's email).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withUser } from "@edf/db";
import { stripControlChars } from "@/lib/gallery";
import { getPool } from "../db";
import { boardChoices, BOARD_NAME_MAX, MAX_BOARDS, type BoardChoice } from "../queries/boards";
import { requireUserOrThrow } from "../session";
import { fail, ok, toFailure, type ActionResult } from "./result";

const id = z.string().uuid();
/** Trimmed, inner whitespace collapsed, control characters dropped; 1–60 characters. */
const boardName = z
  .string()
  .transform((s) => stripControlChars(s).replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1).max(BOARD_NAME_MAX));

const NAME_TAKEN = "You already have a board with that name.";

/** Thrown inside a transaction to roll it back when the design to save isn't the user's (or is gone). */
class DesignGone extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

/** The Save picker's boards for one email (whether it's saved in each). */
export async function getBoardChoices(emailId: string): Promise<ActionResult<BoardChoice[]>> {
  try {
    const user = await requireUserOrThrow();
    const input = id.parse(emailId);
    return ok(await boardChoices(user.userId, input));
  } catch (err) {
    return toFailure(err);
  }
}

/**
 * A new board, with `emailId` saved in it when given (the Save picker's "Create board"). Board
 * names are unique per user, ignoring case.
 */
export async function createBoard(
  name: string,
  emailId?: string | null,
): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const user = await requireUserOrThrow();
    const input = z
      .object({ name: boardName, emailId: id.nullable() })
      .parse({ name, emailId: emailId ?? null });
    const pool = await getPool();
    const result = await withUser(pool, user.userId, async (_db, c) => {
      const n = await c.query<{ n: string }>("SELECT count(*) AS n FROM board WHERE user_id = $1", [user.userId]);
      if (Number(n.rows[0]?.n ?? 0) >= MAX_BOARDS) return "limit" as const;
      const dupe = await c.query("SELECT 1 FROM board WHERE user_id = $1 AND lower(name) = lower($2)", [
        user.userId,
        input.name,
      ]);
      if (dupe.rowCount) return "taken" as const;
      const b = await c.query<{ id: string; name: string }>(
        "INSERT INTO board (user_id, name) VALUES ($1, $2) RETURNING id, name",
        [user.userId, input.name],
      );
      const board = b.rows[0]!;
      if (input.emailId) {
        const saved = await c.query(
          `INSERT INTO board_item (board_id, user_id, email_id)
           SELECT $1, $2, e.id FROM email e WHERE e.id = $3 AND e.user_id = $2
           ON CONFLICT DO NOTHING`,
          [board.id, user.userId, input.emailId],
        );
        // Roll the new board back too: "Create" in the picker is one step, all or nothing.
        if (!saved.rowCount) throw new DesignGone();
      }
      return board;
    });
    if (result === "limit") return fail(`You can have up to ${MAX_BOARDS} boards.`, "limit");
    if (result === "taken") return fail(NAME_TAKEN, "invalid");
    revalidatePath("/boards");
    return ok(result);
  } catch (err) {
    if (err instanceof DesignGone) return fail("That design isn't there any more.", "not_found");
    if (isUniqueViolation(err)) return fail(NAME_TAKEN, "invalid");
    return toFailure(err);
  }
}

/**
 * Save `emailId` in `boardId` (or take it out). Returns whether the email is still saved in any
 * board, for the card's Save button.
 */
export async function setSaved(
  emailId: string,
  boardId: string,
  saved: boolean,
): Promise<ActionResult<{ savedAnywhere: boolean }>> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ emailId: id, boardId: id, saved: z.boolean() }).parse({ emailId, boardId, saved });
    const pool = await getPool();
    const result = await withUser(pool, user.userId, async (_db, c) => {
      const board = await c.query("SELECT 1 FROM board WHERE id = $1 AND user_id = $2", [input.boardId, user.userId]);
      if (!board.rowCount) return "no_board" as const;
      if (input.saved) {
        const email = await c.query("SELECT 1 FROM email WHERE id = $1 AND user_id = $2", [input.emailId, user.userId]);
        if (!email.rowCount) return "no_email" as const;
        await c.query(
          "INSERT INTO board_item (board_id, user_id, email_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [input.boardId, user.userId, input.emailId],
        );
      } else {
        await c.query("DELETE FROM board_item WHERE board_id = $1 AND email_id = $2", [input.boardId, input.emailId]);
      }
      await c.query("UPDATE board SET updated_at = now() WHERE id = $1", [input.boardId]);
      const any = await c.query("SELECT 1 FROM board_item WHERE email_id = $1 LIMIT 1", [input.emailId]);
      return { savedAnywhere: Boolean(any.rowCount) };
    });
    if (result === "no_board") return fail("That board isn't there any more.", "not_found");
    if (result === "no_email") return fail("That design isn't there any more.", "not_found");
    return ok(result);
  } catch (err) {
    return toFailure(err);
  }
}

export async function renameBoard(boardId: string, name: string): Promise<ActionResult<{ name: string }>> {
  try {
    const user = await requireUserOrThrow();
    const input = z.object({ boardId: id, name: boardName }).parse({ boardId, name });
    const pool = await getPool();
    const result = await withUser(pool, user.userId, async (_db, c) => {
      const dupe = await c.query("SELECT 1 FROM board WHERE user_id = $1 AND lower(name) = lower($2) AND id <> $3", [
        user.userId,
        input.name,
        input.boardId,
      ]);
      if (dupe.rowCount) return "taken" as const;
      const r = await c.query("UPDATE board SET name = $2, updated_at = now() WHERE id = $1 AND user_id = $3", [
        input.boardId,
        input.name,
        user.userId,
      ]);
      return r.rowCount ? ("ok" as const) : ("not_found" as const);
    });
    if (result === "taken") return fail(NAME_TAKEN, "invalid");
    if (result === "not_found") return fail("That board isn't there any more.", "not_found");
    revalidatePath("/boards");
    return ok({ name: input.name });
  } catch (err) {
    if (isUniqueViolation(err)) return fail(NAME_TAKEN, "invalid");
    return toFailure(err);
  }
}

/** Deletes the board and its saves (the designs themselves stay in the gallery). */
export async function deleteBoard(boardId: string): Promise<ActionResult> {
  try {
    const user = await requireUserOrThrow();
    const input = id.parse(boardId);
    const pool = await getPool();
    const removed = await withUser(pool, user.userId, async (_db, c) =>
      (await c.query("DELETE FROM board WHERE id = $1 AND user_id = $2", [input, user.userId])).rowCount,
    );
    if (!removed) return fail("That board isn't there any more.", "not_found");
    revalidatePath("/boards");
    return ok();
  } catch (err) {
    return toFailure(err);
  }
}
