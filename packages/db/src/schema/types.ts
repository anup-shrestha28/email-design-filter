import { customType } from "drizzle-orm/pg-core";

/** citext (case-insensitive text). Values are plain strings in JS. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => "citext",
});

/** bytea as a Node Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** tsvector: only ever written via sql`to_tsvector(...)`; never selected by the app. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/** bit(1440): one bit per minute of a day, as a '0'/'1' string. */
export const bit1440 = customType<{ data: string; driverData: string }>({
  dataType: () => "bit(1440)",
});
