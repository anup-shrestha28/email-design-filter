/**
 * Signed edf-view URLs (FREE-TIER.md §9.3). The only way the app shows email HTML: the viewer
 * origin serves it, never the app origin. Tokens are HMAC-signed for (user, email, mode, expiry).
 */
import "server-only";
import { signViewToken } from "@edf/crypto";
import { env } from "@/env";
import { viewKeys } from "./keys";

/** 240 s (not the 300 s maximum): edf-view's expiry gate allows no clock skew. */
export const VIEW_TOKEN_TTL_SEC = 240;

export type ViewMode = "img" | "noimg" | "card";

/** Expiry (unix seconds) for tokens minted now. */
export function viewTokenExpiry(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + VIEW_TOKEN_TTL_SEC;
}

/**
 * One signed viewer URL. "img" loads images through edf-view's privacy proxy; "noimg" never does;
 * "card" (gallery cards) proxies the same images as "img" (CSS hides a card's missing ones).
 */
export function viewerUrl(userId: string, emailId: string, mode: ViewMode, exp = viewTokenExpiry()): string {
  const base = `${env().VIEW_ORIGIN.replace(/\/$/, "")}/v`;
  return `${base}/${signViewToken(viewKeys(), { userId, emailId, exp, mode })}/${emailId}`;
}

/** Both viewer URLs for the email detail, sharing one expiry. */
export function viewerUrls(userId: string, emailId: string): { src: string; srcImagesOff: string; expiresAt: string } {
  const exp = viewTokenExpiry();
  return {
    src: viewerUrl(userId, emailId, "img", exp),
    srcImagesOff: viewerUrl(userId, emailId, "noimg", exp),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
