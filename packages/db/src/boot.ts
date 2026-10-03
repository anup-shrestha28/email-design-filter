/**
 * Boot assertions for the runtime role (DATA-MODEL.md §4.1; FREE-TIER.md §11 step 9).
 * The app refuses to run if its database role could bypass RLS.
 */
import type pg from "pg";

export class UnsafeDatabaseRoleError extends Error {
  constructor(role: string) {
    super(`Refusing to run: database role "${role}" can bypass row-level security`);
    this.name = "UnsafeDatabaseRoleError";
  }
}

export async function assertRuntimeRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ role: string; unsafe: boolean }>(`
    SELECT current_user AS role,
           (r.rolsuper OR r.rolbypassrls
            OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
                AND pg_has_role(current_user, 'neon_superuser', 'MEMBER'))) AS unsafe
    FROM pg_roles r WHERE r.rolname = current_user`);
  const row = rows[0];
  if (!row || row.unsafe) throw new UnsafeDatabaseRoleError(row?.role ?? "unknown");
}
