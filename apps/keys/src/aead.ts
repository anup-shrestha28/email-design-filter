/**
 * AES-256-GCM DEK wrapping for edf-keys (FREE-TIER.md §9.2). Byte-compatible with @edf/crypto's
 * `seal`/`open` v1 envelope and `dekWrapAad` (edf-keys may depend on `jose` only, so the ~40 lines
 * are mirrored here; test/handler.test.ts proves both directions interoperate):
 *
 *   wrapped = 0x01 ‖ nonce(12) ‖ AES-256-GCM(KEK, dek) ‖ tag(16)            (61 bytes)
 *   GCM AAD = 0x01 ‖ len32(label) ‖ label ‖ len32(mailboxId) ‖ mailboxId ‖ len32(kekVersion) ‖ kekVersion
 *   label   = "edf/dek-wrap/v1"
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const DEK_WRAP_AAD_LABEL = "edf/dek-wrap/v1";
export const DEK_LENGTH = 32;
export const WRAPPED_DEK_LENGTH = 61;
const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;

function aad(mailboxId: string, kekVersion: string): Buffer {
  const parts = [DEK_WRAP_AAD_LABEL, mailboxId, kekVersion];
  const chunks: Buffer[] = [Buffer.from([VERSION])];
  for (const p of parts) {
    const bytes = Buffer.from(p, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/** Wrap a 32-byte DEK for (mailboxId, kekVersion). */
export function wrapDek(kek: Buffer, dek: Buffer, mailboxId: string, kekVersion: string): Buffer {
  if (kek.length !== 32 || dek.length !== DEK_LENGTH) throw new Error("wrap: bad key length");
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(aad(mailboxId, kekVersion));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, cipher.getAuthTag()]);
}

/** Unwrap; returns null on any failure (tampering, wrong KEK, wrong mailbox or version). */
export function unwrapDek(
  kek: Buffer,
  wrapped: Buffer,
  mailboxId: string,
  kekVersion: string,
): Buffer | null {
  if (kek.length !== 32 || wrapped.length !== WRAPPED_DEK_LENGTH || wrapped[0] !== VERSION)
    return null;
  try {
    const nonce = wrapped.subarray(1, 1 + NONCE_LEN);
    const ct = wrapped.subarray(1 + NONCE_LEN, wrapped.length - TAG_LEN);
    const tag = wrapped.subarray(wrapped.length - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", kek, nonce, { authTagLength: TAG_LEN });
    decipher.setAAD(aad(mailboxId, kekVersion));
    decipher.setAuthTag(tag);
    const dek = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dek.length === DEK_LENGTH ? dek : null;
  } catch {
    return null;
  }
}
