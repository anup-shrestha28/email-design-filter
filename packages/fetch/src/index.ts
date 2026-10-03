/**
 * SSRF-safe outbound fetcher (DESIGN.md §11.7; FREE-TIER.md §8.4, §9.2).
 *
 * Modules: policy.ts (URL/host/address rules), lookup.ts (DNS pin), safe-fetch.ts (the fetcher),
 * sniff.ts (magic bytes), image.ts (image fetch). Test hooks live in testing.ts and are
 * deliberately not exported here.
 */
export {
  safeFetch,
  SAFE_FETCH_MAX_BYTES,
  SAFE_FETCH_MAX_TIMEOUT_MS,
  SAFE_FETCH_MAX_REDIRECTS,
  SAFE_FETCH_MAX_PER_HOST,
  SAFE_FETCH_USER_AGENT,
  type SafeFetchError,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./safe-fetch";
export { sniffImage, type ImageFormat, type SniffResult } from "./sniff";
export { fetchImage, MAX_IMAGE_PIXELS, IMAGE_CONTENT_TYPES, type ImageFetchResult } from "./image";
export { isAllowedAddress, isAllowedHostname, validateTarget } from "./policy";
