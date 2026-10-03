/**
 * Unsubscribe-link matching shared by static extraction and the renderer (DESIGN-SCORE §2.1
 * footer markers, §5.9 U1): link text patterns, the List-Unsubscribe https host + path prefix,
 * or a known ESP unsubscribe path.
 */
import { ESP_UNSUB_PATH, SOCIAL_HOST, UNSUBSCRIBE_TEXT } from "./patterns";
import { decodedTarget, registrableDomain, urlHost, urlPath } from "./url";

/** Host/path prefix of a List-Unsubscribe https URI (unique trailing tokens dropped). */
function listUnsubPrefix(uri: string): { host: string; path: string } | null {
  const host = urlHost(uri);
  const path = urlPath(uri);
  if (!host || !path) return null;
  const segs = path.split("/").filter(Boolean);
  if (segs.length > 1) {
    const last = segs[segs.length - 1]!;
    if (last.length >= 16 || (/\d/.test(last) && /[a-z]/i.test(last) && last.length >= 8))
      segs.pop();
  }
  return { host, path: `/${segs.join("/")}` };
}

export function matchesListUnsubscribe(href: string | null, listUnsub: string[]): boolean {
  if (!href) return false;
  const host = urlHost(href);
  const path = urlPath(href);
  if (!host || !path) return false;
  for (const uri of listUnsub.slice(0, 5)) {
    const pre = listUnsubPrefix(uri);
    if (!pre) continue;
    if (pre.host === host && pre.path.length >= 2 && path.startsWith(pre.path)) return true;
  }
  return false;
}

export function isUnsubscribeLink(
  text: string,
  href: string | null,
  listUnsub: string[],
): { match: boolean; byHeader: boolean } {
  const byHeader = matchesListUnsubscribe(href, listUnsub);
  if (byHeader) return { match: true, byHeader };
  if (UNSUBSCRIBE_TEXT.test(text)) return { match: true, byHeader: false };
  const path = urlPath(href);
  return {
    match: !!path && /unsub|opt-?out/i.test(path) && ESP_UNSUB_PATH.test(path),
    byHeader: false,
  };
}

// ─────────── other brands' links: social icons and store badges (static ∥ render) ───────────

/** Brand label of a host or domain: the label before its (heuristic) public suffix. */
export function brandOf(host: string | null | undefined): string | null {
  const reg = registrableDomain(host ? host.toLowerCase() : null);
  return reg?.split(".")[0] || null;
}

/**
 * The link goes to the sender's own brand (LinkedIn's "Connect" → linkedin.com, a Facebook notice
 * from facebookmail.com → facebook.com, a Google Play receipt → play.google.com): the email's
 * content, not a social icon or a store badge. Same brand label, or the sender's label extends a
 * label of ≥ 4 letters (facebookmail / facebook, youtube / youtu — never xbox / x).
 */
export function isOwnBrandHost(host: string, senderBrand: string | null): boolean {
  const brand = brandOf(host);
  if (!brand || !senderBrand) return false;
  return senderBrand === brand || (brand.length >= 4 && senderBrand.startsWith(brand));
}

/** App-store hosts: a store badge links to the app's listing (render-2026.4 review). */
const APP_STORE_HOST =
  /(?:^|\.)(?:apps\.apple\.com|itunes\.apple\.com|play\.google\.com|apps\.microsoft\.com|appgallery\.huawei\.com|galaxystore\.samsung\.com)$/i;
/** The words on store badges ("Download on the App Store", "Get it on Google Play"). */
const APP_STORE_BADGE =
  /\b(?:app ?store|google play|play store|microsoft store|windows store|app ?gallery|galaxy store)\b/i;

/**
 * An app-store badge: a link to an app store (directly or through a click tracker's `url=`
 * parameter), or an image link whose alt text is a store badge's. Standard artwork from Apple,
 * Google or Microsoft, not the sender's call to action (a badge had become the "main button" of an
 * email whose real button was elsewhere) — unless the store is the sender.
 */
export function isAppStoreLink(
  href: string,
  label: string,
  imageOnly: boolean,
  senderBrand: string | null,
): boolean {
  const inner = decodedTarget(href);
  for (const host of [urlHost(href), inner ? urlHost(inner) : null])
    if (host && APP_STORE_HOST.test(host) && !isOwnBrandHost(host, senderBrand)) return true;
  return imageOnly && APP_STORE_BADGE.test(label);
}

/**
 * A link that is never a call to action of the email because it promotes another brand: a social
 * network's link (unless the network is the sender) or an app-store badge (unless the store is).
 * One rule for the static pass and the renderer's CTA candidates. `senderBrand` is
 * `brandOf(senderDomain)`; `imageOnly` = the link shows no text (its label is alt / aria text).
 */
export function isOtherBrandLink(
  href: string,
  label: string,
  imageOnly: boolean,
  senderBrand: string | null,
): boolean {
  const host = urlHost(href);
  if (host && SOCIAL_HOST.test(host) && !isOwnBrandHost(host, senderBrand)) return true;
  return isAppStoreLink(href, label, imageOnly, senderBrand);
}
