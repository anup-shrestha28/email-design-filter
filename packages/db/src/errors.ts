/**
 * Postgres error helpers. Drizzle wraps driver errors (DrizzleQueryError) with the pg error as
 * `cause`, so walk the cause chain instead of matching on the wrapper's message.
 */
export interface PgErrorInfo {
  code: string | undefined;
  message: string;
  constraint: string | undefined;
}

export function pgError(err: unknown): PgErrorInfo | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (typeof cur === "object" && cur !== null && "code" in cur && typeof (cur as { code: unknown }).code === "string") {
      const e = cur as { code: string; message?: string; constraint?: string };
      if (/^[0-9A-Z]{5}$/.test(e.code)) {
        return { code: e.code, message: e.message ?? "", constraint: e.constraint };
      }
    }
    cur = typeof cur === "object" && cur !== null && "cause" in cur ? (cur as { cause: unknown }).cause : undefined;
  }
  return null;
}

/** 23505 unique_violation */
export const isUniqueViolation = (err: unknown): boolean => pgError(err)?.code === "23505";
/** 23503 foreign_key_violation */
export const isForeignKeyViolation = (err: unknown): boolean => pgError(err)?.code === "23503";
/** 42501 insufficient_privilege (incl. RLS WITH CHECK failures) */
export const isInsufficientPrivilege = (err: unknown): boolean => pgError(err)?.code === "42501";
/** Connection-level failures (database suspended/unreachable): 08xxx, 57P0x, or socket errors. */
export function isDatabaseUnavailable(err: unknown): boolean {
  const code = pgError(err)?.code;
  if (code && (code.startsWith("08") || code.startsWith("57P") || code === "53300")) return true;
  const msg = err instanceof Error ? err.message : "";
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated|timeout expired/i.test(msg);
}
