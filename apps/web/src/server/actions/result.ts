/** Uniform Server Action result: never leak internals to the client. */
import "server-only";
import { z } from "zod";
import { StaleSessionError, UnauthorizedError } from "../session";

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string; code?: "unauthorized" | "stale_session" | "invalid" | "limit" | "unavailable" | "not_found" };

export function ok(): ActionResult;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T): ActionResult<T> {
  return (data === undefined ? { ok: true } : { ok: true, data }) as ActionResult<T>;
}

export function fail(error: string, code?: Exclude<ActionResult, { ok: true }>["code"]): { ok: false; error: string; code?: typeof code } {
  return { ok: false, error, code };
}

/** Map thrown errors to safe messages; unexpected errors become a generic message. */
export function toFailure(err: unknown): { ok: false; error: string; code?: Exclude<ActionResult, { ok: true }>["code"] } {
  if (err instanceof UnauthorizedError) return fail("Please sign in.", "unauthorized");
  if (err instanceof StaleSessionError) return fail(err.message, "stale_session");
  if (err instanceof z.ZodError) return fail("That request wasn't valid.", "invalid");
  return fail("Something went wrong. Please try again.", "unavailable");
}
