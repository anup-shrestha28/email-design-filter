/**
 * SCRAM-SHA-256 password verifier (RFC 5802/7677, PostgreSQL's stored format), so the runtime
 * role's password is set without the plaintext ever reaching the server or its logs:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (base64).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export function scramSha256Verifier(password: string, iterations = 4096): string {
  // SASLprep is the identity for printable ASCII; generated passwords are always ASCII.
  if (!/^[\x21-\x7e]{16,}$/.test(password)) {
    throw new Error("password must be ≥ 16 printable ASCII characters without spaces");
  }
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
