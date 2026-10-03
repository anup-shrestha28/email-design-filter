/**
 * Platform usage is metered only where it is real (packages/budget/DECISIONS.md, "Local
 * development"): Vercel on Vercel, Neon on Vercel or a Neon database, Inngest unless the SDK uses the
 * Dev Server; `EDF_METER_LOCAL=1` meters all three anywhere. "On Vercel" fails safe: `VERCEL` set,
 * or a production build whose database isn't on this machine. Pure: no database.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ALL_PLATFORMS,
  isHostedProduction,
  isLoopbackDatabaseUrl,
  isMetered,
  isNeonDatabaseUrl,
  platformMetering,
  platformOf,
  RESOURCES as R,
  usesInngestDevServer,
} from "../src/index";

const LOCAL_DB = "postgres://app_rw:pw@localhost:5433/edf";
const NEON_DB =
  "postgres://app_rw:pw@ep-cool-river-a1b2c3d4-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
const NONE = { vercel: false, neon: false, inngest: false };

describe("platformMetering", () => {
  it("pnpm dev (local Postgres, the Inngest Dev Server): no platform is metered", () => {
    expect(platformMetering({ DATABASE_URL: LOCAL_DB, INNGEST_DEV: "1" })).toEqual(NONE);
    expect(
      platformMetering({ DATABASE_URL: LOCAL_DB, INNGEST_DEV: "1", EDF_METER_LOCAL: "0" }),
    ).toEqual(NONE);
    // Only "1" opts in; a typo stays off (edf-app's env schema refuses it).
    expect(
      platformMetering({ DATABASE_URL: LOCAL_DB, INNGEST_DEV: "1", EDF_METER_LOCAL: "true" }),
    ).toEqual(NONE);
  });

  it("EDF_METER_LOCAL=1 meters every platform off Vercel (testing the governor locally)", () => {
    expect(
      platformMetering({ DATABASE_URL: LOCAL_DB, INNGEST_DEV: "1", EDF_METER_LOCAL: "1" }),
    ).toEqual(ALL_PLATFORMS);
  });

  it("on Vercel everything is metered, whatever else is set", () => {
    expect(
      platformMetering({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: NEON_DB }),
    ).toEqual(ALL_PLATFORMS);
    expect(
      platformMetering({
        VERCEL: "1",
        DATABASE_URL: LOCAL_DB,
        INNGEST_DEV: "1",
        EDF_METER_LOCAL: "0",
      }),
    ).toEqual(ALL_PLATFORMS);
    expect(platformMetering({ VERCEL: "1" })).toEqual(ALL_PLATFORMS);
  });

  it("production without VERCEL (System Environment Variables not exposed) still meters everything", () => {
    // Vercel sets VERCEL only while "Automatically expose System Environment Variables" is on.
    expect(platformMetering({ NODE_ENV: "production", DATABASE_URL: NEON_DB })).toEqual(ALL_PLATFORMS);
    // No DATABASE_URL, or one that doesn't parse: the safe side.
    expect(platformMetering({ NODE_ENV: "production" })).toEqual(ALL_PLATFORMS);
    expect(platformMetering({ NODE_ENV: "production", DATABASE_URL: "not a url" })).toEqual(ALL_PLATFORMS);
    // A remote non-Neon database too (only a database on this machine marks a local run).
    expect(
      platformMetering({ NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example:5432/edf", INNGEST_DEV: "1", EDF_METER_LOCAL: "0" }),
    ).toEqual(ALL_PLATFORMS);
  });

  it("`next build && next start` on a laptop (NODE_ENV=production, local Postgres) stays unmetered", () => {
    for (const url of [LOCAL_DB, "postgres://app_rw:pw@127.0.0.1:5433/edf", "postgres://app_rw:pw@[::1]:5433/edf"]) {
      expect(platformMetering({ NODE_ENV: "production", DATABASE_URL: url, INNGEST_DEV: "1" }), url).toEqual(NONE);
    }
    expect(
      platformMetering({ NODE_ENV: "production", DATABASE_URL: LOCAL_DB, INNGEST_DEV: "1", EDF_METER_LOCAL: "1" }),
    ).toEqual(ALL_PLATFORMS);
    // Development against a remote database is not production: the per-platform rules apply.
    expect(platformMetering({ NODE_ENV: "development", DATABASE_URL: NEON_DB, INNGEST_DEV: "1" })).toEqual({
      vercel: false,
      neon: true,
      inngest: false,
    });
  });

  it("off Vercel, a Neon database is metered as Neon and Inngest Cloud's executions as Inngest", () => {
    expect(platformMetering({ DATABASE_URL: NEON_DB, INNGEST_DEV: "1" })).toEqual({
      vercel: false,
      neon: true,
      inngest: false,
    });
    // No Dev Server: requests can only come from Inngest Cloud, which bills them.
    expect(platformMetering({ DATABASE_URL: LOCAL_DB })).toEqual({
      vercel: false,
      neon: false,
      inngest: true,
    });
    expect(platformMetering({ DATABASE_URL: LOCAL_DB, INNGEST_DEV: "0" })).toEqual({
      vercel: false,
      neon: false,
      inngest: true,
    });
  });

  it("reads process.env by default", () => {
    try {
      vi.stubEnv("VERCEL", undefined);
      vi.stubEnv("EDF_METER_LOCAL", undefined);
      vi.stubEnv("INNGEST_DEV", "1");
      vi.stubEnv("DATABASE_URL", LOCAL_DB);
      expect(platformMetering()).toEqual(NONE);
      vi.stubEnv("EDF_METER_LOCAL", "1");
      expect(platformMetering()).toEqual(ALL_PLATFORMS);
      vi.stubEnv("EDF_METER_LOCAL", undefined);
      vi.stubEnv("VERCEL", "1");
      expect(platformMetering()).toEqual(ALL_PLATFORMS);
      vi.stubEnv("VERCEL", undefined);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DATABASE_URL", NEON_DB);
      expect(platformMetering()).toEqual(ALL_PLATFORMS);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the rules' parts", () => {
  it("recognises Neon hosts only", () => {
    expect(isNeonDatabaseUrl(NEON_DB)).toBe(true);
    expect(isNeonDatabaseUrl("postgresql://u:p@ep-x-123.eu-central-1.aws.neon.tech:5432/db")).toBe(
      true,
    );
    expect(isNeonDatabaseUrl(LOCAL_DB)).toBe(false);
    expect(isNeonDatabaseUrl("postgres://u:p@neon.tech.evil.example/db")).toBe(false);
    expect(isNeonDatabaseUrl("postgres://u:p@notneon.tech/db")).toBe(false);
    expect(isNeonDatabaseUrl(undefined)).toBe(false);
    expect(isNeonDatabaseUrl("not a url")).toBe(false);
  });

  it("recognises a database on this machine (loopback or a Unix socket) only", () => {
    for (const url of [
      LOCAL_DB,
      "postgresql://u:p@LOCALHOST/db",
      "postgres://u:p@db.localhost:5432/db",
      "postgres://u:p@127.0.0.1:5433/db",
      "postgres://u:p@127.1.2.3/db",
      "postgres://u:p@[::1]:5433/db",
      "postgres:///edf",
    ])
      expect(isLoopbackDatabaseUrl(url), url).toBe(true);
    for (const url of [
      NEON_DB,
      "postgres://u:p@db.example:5432/db",
      "postgres://u:p@localhost.evil.example/db",
      "postgres://u:p@128.0.0.1/db",
      "postgres://u:p@10.0.0.5/db",
      undefined,
      "",
      "not a url",
    ])
      expect(isLoopbackDatabaseUrl(url), String(url)).toBe(false);
    expect(isHostedProduction({ NODE_ENV: "production", DATABASE_URL: NEON_DB })).toBe(true);
    expect(isHostedProduction({ NODE_ENV: "production", DATABASE_URL: LOCAL_DB })).toBe(false);
    expect(isHostedProduction({ NODE_ENV: "development", DATABASE_URL: NEON_DB })).toBe(false);
    expect(isHostedProduction({ NODE_ENV: "test" })).toBe(false);
  });

  it("reads INNGEST_DEV as the Inngest SDK does", () => {
    for (const v of ["1", "true", "TRUE", " 1 ", "http://localhost:8288", "localhost:8288"])
      expect(usesInngestDevServer(v), v).toBe(true);
    for (const v of [undefined, "", "  ", "0", "false", "undefined"])
      expect(usesInngestDevServer(v), String(v)).toBe(false);
  });

  it("maps resource codes to platforms; everything else is always recorded", () => {
    expect(platformOf(R.vercelCpuS)).toBe("vercel");
    expect(platformOf(R.vercelFotMb)).toBe("vercel");
    expect(platformOf(R.neonTransferMb)).toBe("neon");
    expect(platformOf(R.inngestExecutions)).toBe("inngest");
    for (const code of [
      R.sandboxCpuS,
      R.anthropicUsd,
      R.gmailUnits,
      R.viewUnsignableUrls,
      "keys.unwrap_ok",
      "backfill.started",
      "vercel",
    ]) {
      expect(platformOf(code), code).toBeNull();
      expect(isMetered(NONE, code), code).toBe(true);
    }
    expect(isMetered(NONE, R.vercelInvocations)).toBe(false);
    expect(isMetered({ ...NONE, inngest: true }, R.inngestSteps)).toBe(true);
    expect(isMetered(ALL_PLATFORMS, R.neonTransferMb)).toBe(true);
  });
});
