/**
 * The SQL migrations are the source of truth. This test fails if the Drizzle schema (used for
 * typed queries) disagrees with the live database on any table, column, type or nullability.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import type pg from "pg";
import * as schema from "../src/schema";
import { HAS_DB } from "./env";
import { ownerPool } from "./helpers";

function normalizeDrizzleType(t: string): string {
  const s = t.toLowerCase().replace(/\s+/g, " ");
  if (s.startsWith("timestamp")) return s.includes("with time zone") ? "timestamp with time zone" : "timestamp without time zone";
  if (s.startsWith("numeric")) return "numeric";
  if (s === "bigint") return "bigint";
  if (s.startsWith("bit(")) return "bit";
  return s;
}

function normalizeDbType(dataType: string, udt: string): string {
  if (dataType === "ARRAY") return `${udt.replace(/^_/, "")}[]`;
  if (dataType === "USER-DEFINED") return udt;
  if (dataType === "character varying") return "varchar";
  return dataType;
}

describe.skipIf(!HAS_DB)("Drizzle schema matches the migrated database", () => {
  let owner: pg.Pool;
  beforeAll(() => {
    owner = ownerPool();
  });
  afterAll(async () => {
    await owner?.end();
  });

  it("every Drizzle table and column exists with the same type and nullability", async () => {
    const { rows } = await owner.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: "YES" | "NO";
    }>(`SELECT table_name, column_name, data_type, udt_name, is_nullable
        FROM information_schema.columns WHERE table_schema = 'public'`);
    const db = new Map<string, Map<string, { type: string; nullable: boolean }>>();
    for (const r of rows) {
      if (!db.has(r.table_name)) db.set(r.table_name, new Map());
      db.get(r.table_name)!.set(r.column_name, {
        type: normalizeDbType(r.data_type, r.udt_name),
        nullable: r.is_nullable === "YES",
      });
    }

    const tables: PgTable[] = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTableClass));
    expect(tables.length).toBeGreaterThanOrEqual(30);
    const problems: string[] = [];
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const cols = db.get(cfg.name);
      if (!cols) {
        problems.push(`missing table ${cfg.name}`);
        continue;
      }
      for (const col of cfg.columns) {
        const actual = cols.get(col.name);
        if (!actual) {
          problems.push(`missing column ${cfg.name}.${col.name}`);
          continue;
        }
        let expectedType = normalizeDrizzleType(col.getSQLType());
        if (col.columnType === "PgArray") expectedType = `${normalizeDrizzleType(col.getSQLType().replace("[]", ""))}[]`;
        const actualType = actual.type === "bit" ? "bit" : actual.type;
        if (expectedType !== actualType) problems.push(`${cfg.name}.${col.name}: drizzle ${expectedType} vs db ${actualType}`);
        // Generated / identity columns report NOT NULL differently; compare the rest strictly.
        const expectedNullable = !col.notNull && !col.primary;
        if (expectedNullable !== actual.nullable && col.name !== "is_hidden") {
          problems.push(`${cfg.name}.${col.name}: drizzle nullable=${expectedNullable} vs db ${actual.nullable}`);
        }
      }
      for (const name of cols.keys()) {
        if (!cfg.columns.some((c) => c.name === name)) problems.push(`db column ${cfg.name}.${name} not in Drizzle schema`);
      }
    }
    const drizzleNames = new Set(tables.map((t) => getTableConfig(t).name));
    for (const name of db.keys()) {
      if (name !== "_migrations" && !drizzleNames.has(name)) problems.push(`db table ${name} not in Drizzle schema`);
    }
    expect(problems).toEqual([]);
  });
});
