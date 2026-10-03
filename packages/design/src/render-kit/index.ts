/**
 * `@edf/design/render-kit` — everything the renderer (and the render VM bundle) needs from the
 * design engine, without pulling in static extraction (juice/cheerio) or the scorer.
 */
export * from "./html";
export * from "../constants";
export * from "../features/render";
export * from "../features/fonts";
export * from "../util/color";
export * from "../util/math";
export * from "../util/text";
export * from "../util/images";
export {
  UNSUBSCRIBE_TEXT,
  PREFERENCES_TEXT,
  VIEW_ONLINE_TEXT,
  RECEIVING_TEXT,
  SOCIAL_HOST,
  ESP_UNSUB_PATH,
  NAV_SEPARATORS,
  BUTTON_IMAGE_HINT,
  hasMergeTag,
  looksLikePostalAddress,
} from "../util/patterns";
export { urlHost, urlPath, registrableDomain, decodedTarget } from "../util/url";
export {
  isUnsubscribeLink,
  matchesListUnsubscribe,
  brandOf,
  isOwnBrandHost,
  isAppStoreLink,
  isOtherBrandLink,
} from "../util/links";
export { analyzeStack, isIconFamily, DEFAULT_SENTINEL } from "../fonts/normalize";
export { lookupFamily } from "../fonts/catalog";
