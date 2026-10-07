/**
 * Cryptography for tokens and signed URLs (DESIGN.md §4.4; FREE-TIER.md §4.2, §9.2, §9.3).
 *
 * Implemented in separate modules re-exported from here. All comparisons of MACs/signatures are
 * constant-time; verification functions never throw; configuration errors throw
 * `CryptoConfigError` without key material in the message. Design decisions: ../DECISIONS.md.
 */

export { CryptoConfigError, CryptoError, KeyServiceError } from "./errors";
export { constantTimeEqual, isProductionLikeEnv } from "./encoding";

// keyrings
export { parseKeyring, compareKids, KID_RE, type Keyring } from "./keyring";

// AEAD (AES-256-GCM)
export { encodeAad, seal, open, sealWithKeyring, openWithKeyring, keyringKidOf } from "./aead";

// mailbox key wrapping (KeyWrapper seam, §12 C)
export {
  KeyServiceWrapper,
  LocalKeyWrapper,
  dekWrapAad,
  DEK_WRAP_AAD_LABEL,
  DEK_LENGTH,
  WRAPPED_DEK_LENGTH,
  MAILBOX_ID_RE,
  KEYS_KEK_VERSION_RE,
  type WrapContext,
  type WrappedKey,
  type UnwrapResult,
  type KeyWrapper,
} from "./key-wrapper";

// HMAC-signed tokens
export { hmacSign, hmacVerify, canonicalJson, type HmacPart } from "./hmac";
export {
  signViewToken,
  parseViewToken,
  verifyViewToken,
  signInvite,
  verifyInvite,
  signOutLink,
  verifyOutLink,
  VIEW_TOKEN_MAX_TTL_SEC,
  INVITE_MAX_TTL_SEC,
  OUT_LINK_MAX_TTL_SEC,
  EMAIL_ID_RE,
  type ViewMode,
} from "./tokens";

// Ed25519 image tokens (FREE-TIER.md §9.3)
export {
  parseEd25519SigningRing,
  parseEd25519VerifyRing,
  signImageToken,
  verifyImageToken,
  imageTokenExpiry,
  IMAGE_TOKEN_MAX_BYTES,
  IMAGE_TOKEN_MAX_URL_LENGTH,
  IMAGE_TOKEN_MAX_LENGTH,
  IMAGE_TOKEN_MAX_LIFETIME_SEC,
  IMAGE_TOKEN_PERIOD_SEC,
  IMAGE_TOKEN_CLOCK_SKEW_SEC,
  type ImageTokenClaims,
  type Ed25519SigningRing,
  type Ed25519VerifyRing,
} from "./ed25519";

// Vercel OIDC verification (edf-app side) + local-development issuer
export {
  createOidcVerifier,
  OIDC_FUNCTION_TOKEN_TTL_SEC,
  type OidcExpectations,
  type OidcVerifierOptions,
} from "./oidc";
export {
  createDevOidcIssuer,
  importDevOidcIssuer,
  mintDevOidcToken,
  DEV_OIDC_ISSUER,
  DEV_OIDC_AUDIENCE,
  DEV_OIDC_SUBJECTS,
  type DevOidcIssuer,
} from "./dev-oidc";
