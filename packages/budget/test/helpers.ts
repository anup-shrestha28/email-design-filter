import { createPool } from "@edf/db";
import { appRwUrl, ownerUrl } from "./env";

export type Pool = ReturnType<typeof createPool>;

export function appPool(): Pool {
  return createPool({ connectionString: appRwUrl(), max: 10, applicationName: "edf-budget-test" });
}

/** Owner pool: only for resetting system tables between tests (app_rw can't DELETE them). */
export function ownerPool(): Pool {
  return createPool({
    connectionString: ownerUrl(),
    max: 2,
    applicationName: "edf-budget-test-owner",
  });
}
