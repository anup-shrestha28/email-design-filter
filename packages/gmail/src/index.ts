/**
 * @edf/gmail — Gmail REST client, quota bucket, connector OAuth, token store with refresh
 * leases, history polling (no-lost-mail cursor rule), backfill listing helpers and the Gmail
 * payload adapter. See DECISIONS.md for the readings chosen where the spec was ambiguous.
 */
export * from "./errors";
export { UNITS, Semaphore, compareUint64, maxUint64, isUint64, decodeBase64Url } from "./util";
export * from "./schemas";
export * from "./client";
export * from "./quota";
export * from "./oauth";
export * from "./tokens";
export * from "./history";
export * from "./listing";
export * from "./payload";
export {
  decodeEncodedWords,
  decodeHeaderValue,
  parseAddressList,
  parseParams,
  parseMailDate,
  decodeCharset,
  decodeSnippetEntities,
} from "./mime";
