/**
 * System tables: no tenant data, no RLS (FREE-TIER.md §10). Mirrors migrations/0002_core.sql.
 */
import { boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bit1440 } from "./types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const aiBatch = pgTable("ai_batch", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  anthropicBatchId: text("anthropic_batch_id").unique(),
  purpose: text("purpose").$type<"design_review" | "classify">().notNull(),
  state: text("state").$type<"submitting" | "submitted" | "ended" | "failed">().notNull(),
  reservedUsd: numeric("reserved_usd", { precision: 10, scale: 4, mode: "number" }).notNull().default(0),
  settledUsd: numeric("settled_usd", { precision: 10, scale: 4, mode: "number" }),
  itemCount: integer("item_count").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  submittedAt: ts("submitted_at"),
  endedAt: ts("ended_at"),
});

export const llmBudgetGlobal = pgTable("llm_budget_global", {
  period: date("period", { mode: "string" }).primaryKey(),
  reservedUsd: numeric("reserved_usd", { precision: 10, scale: 4, mode: "number" }).notNull().default(0),
  capUsd: numeric("cap_usd", { precision: 10, scale: 4, mode: "number" }).notNull(),
});

export const usageLedger = pgTable(
  "usage_ledger",
  {
    day: date("day", { mode: "string" }).notNull(),
    resource: text("resource").notNull(),
    amount: numeric("amount", { precision: 18, scale: 6, mode: "number" }).notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.resource] })],
);

export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const appError = pgTable("app_error", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts("at").notNull().defaultNow(),
  job: text("job").notNull(),
  code: text("code").notNull(),
  mailboxHash: text("mailbox_hash"),
  detailCode: text("detail_code"),
});

export const oauthSubjectSeen = pgTable("oauth_subject_seen", {
  subHash: text("sub_hash").primaryKey(),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
});

/** Sandbox VMs already metered from the Sandbox API (one row per VM name; kept 14 days). */
export const sandboxMetered = pgTable("sandbox_metered", {
  name: text("name").primaryKey(),
  createdAt: ts("created_at").notNull(),
  meteredAt: ts("metered_at").notNull().defaultNow(),
});

export const systemState = pgTable("system_state", {
  id: boolean("id").primaryKey().default(true),
  lastTickAt: ts("last_tick_at"),
  lastMaintenanceAt: ts("last_maintenance_at"),
  lastRenderBatchAt: ts("last_render_batch_at"),
  lastCronAt: ts("last_cron_at"),
  inngestPaused: boolean("inngest_paused").notNull().default(false),
  backfillLeaseMailbox: uuid("backfill_lease_mailbox"),
  backfillLeaseUntil: ts("backfill_lease_until"),
  kickWindowStart: ts("kick_window_start"),
  kickCount: integer("kick_count").notNull().default(0),
  signinWakeDay: date("signin_wake_day", { mode: "string" }),
  signinWakeCount: integer("signin_wake_count").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const neonAwake = pgTable("neon_awake", {
  day: date("day", { mode: "string" }).primaryKey(),
  /** One bit per minute of the day (UTC), '0'/'1' string. Written only via mark_neon_awake(). */
  minutes: bit1440("minutes").notNull(),
});
