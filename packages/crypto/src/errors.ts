/**
 * Error types for @edf/crypto. Messages never contain key material, tokens, plaintext or
 * identifiers that came from untrusted input; they carry short, fixed codes only.
 */

/** Misconfiguration (bad env JSON, wrong key length, dev-only helper used in production, …). */
export class CryptoConfigError extends Error {
  override readonly name = "CryptoConfigError";
}

/** A cryptographic operation failed (authentication failure, malformed envelope, …). */
export class CryptoError extends Error {
  override readonly name = "CryptoError";
  constructor(readonly code: "decrypt_failed" | "bad_input") {
    super(code);
  }
}

/** Failure talking to edf-keys (FREE-TIER.md §9.2). `code` is content-free. */
export class KeyServiceError extends Error {
  override readonly name = "KeyServiceError";
  constructor(readonly code: string) {
    super(`key service: ${code}`);
  }
}
